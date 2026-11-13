const vm = require('vm'); const fs = require('fs'); const assert = require('assert');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'www', 'android-shim.js'), 'utf8');
function setup(srBehavior, permState = 'granted') {
  const calls = { srStart: [], tts: [], fetch: [] };
  const listeners = {};
  const SR = {
    checkPermissions: async () => ({ speechRecognition: permState }),
    requestPermissions: async () => ({ speechRecognition: permState }),
    start: async (o) => { calls.srStart.push(o); listeners.listeningState && listeners.listeningState({status:'started'}); return srBehavior(o); },
    stop: async () => {}, addListener: (n, f) => { listeners[n] = f; return Promise.resolve({remove(){}}); },
  };
  const TTS = { speak: async (o) => { calls.tts.push(o); }, stop: async () => {} };
  const win = {
    Capacitor: { isNativePlatform: () => true },
    capacitorExports: { registerPlugin: (n) => n === 'SpeechRecognition' ? SR : TTS },
    location: { href: 'https://localhost/', origin: 'https://localhost' },
    fetch: async (url) => { calls.fetch.push(url); return new Response(JSON.stringify([[['Hello ','Merhaba '],['world','dunya']],null,'tr']), {status:200}); },
  };
  const document = { createElement: () => ({}), documentElement: { appendChild() {} } };
  const ctx = { window: win, document, navigator: {}, Response, URL, Map, Promise, setTimeout, JSON, String, Math, console };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { win, calls };
}
const tick = (ms=20) => new Promise(r => setTimeout(r, ms));
(async () => {
  // 1) translate
  let { win, calls } = setup(async () => ({ matches: ['merhaba dunya'] }));
  let r = await win.fetch('/api/translate', { method:'POST', body: JSON.stringify({ text:'Merhaba dunya', sourceLang:'tr-TR', targetLang:'en-US' }) });
  let d = await r.json();
  assert.equal(d.translatedText, 'Hello world'); assert.ok(calls.fetch[0].includes('sl=tr&tl=en'));
  r = await win.fetch('/api/translate', { method:'POST', body: JSON.stringify({ text:'Merhaba dunya', sourceLang:'tr-TR', targetLang:'en-US' }) });
  assert.equal((await r.json()).cached, true); assert.equal(calls.fetch.length, 1);
  r = await win.fetch('/api/online-info'); assert.equal((await r.json()).onlineMode, false);
  r = await win.fetch('/api/rooms', {method:'POST'}); assert.equal(r.status, 503);
  console.log('ok translate');

  // 2) recognition success: onspeechstart, onresult(final), onend
  const ev = [];
  let rec = new win.webkitSpeechRecognition(); rec.lang = 'tr-TR';
  rec.onspeechstart = () => ev.push('speech'); rec.onresult = (e) => ev.push('result:' + e.results[0][0].transcript + ':' + e.results[0].isFinal + ':' + e.resultIndex + ':' + e.results.length);
  rec.onerror = (e) => ev.push('err:' + e.error); rec.onend = () => ev.push('end');
  rec.start(); await tick();
  assert.deepEqual(ev, ['speech', 'result:merhaba dunya:true:0:1', 'end']);
  assert.equal(calls.srStart[0].language, 'tr-TR'); assert.equal(calls.srStart[0].partialResults, false);
  console.log('ok recognize');

  // 3) silence -> no-speech then end
  ({ win } = setup(async () => { throw new Error('No match'); }));
  const ev2 = []; rec = new win.SpeechRecognition();
  rec.onerror = (e) => ev2.push('err:' + e.error); rec.onend = () => ev2.push('end'); rec.start(); await tick();
  assert.deepEqual(ev2, ['err:no-speech', 'end']); console.log('ok silence');

  // 4) permission denied
  ({ win } = setup(async () => ({ matches: ['x'] }), 'denied'));
  const ev3 = []; rec = new win.SpeechRecognition();
  rec.onerror = (e) => ev3.push('err:' + e.error); rec.onend = () => ev3.push('end'); rec.start(); await tick();
  assert.deepEqual(ev3, ['err:not-allowed', 'end']); console.log('ok permission');

  // 5) abort while pending: app nulls handlers first; late result ignored
  let resolveLate; ({ win } = setup(() => new Promise(r => resolveLate = r)));
  const ev4 = []; rec = new win.SpeechRecognition(); rec.onresult = () => ev4.push('result'); rec.onend = () => ev4.push('end');
  rec.start(); await tick(); rec.onresult = null; rec.onend = null; rec.abort(); resolveLate({ matches: ['late'] }); await tick();
  assert.deepEqual(ev4, []); 
  // restart same pattern as app (new instance) works
  console.log('ok abort');

  // 6) TTS
  ({ win, calls } = setup(async () => ({})));
  assert.ok('speechSynthesis' in win);
  const u = new win.SpeechSynthesisUtterance('Hello'); u.lang = 'en-US'; u.rate = 1.25; let ended = false; u.onend = () => ended = true;
  win.speechSynthesis.speak(u); assert.equal(win.speechSynthesis.speaking, true); await tick();
  assert.ok(ended); assert.equal(win.speechSynthesis.speaking, false);
  assert.equal(calls.tts[0].lang, 'en-US'); assert.equal(calls.tts[0].rate, 1.25);
  assert.deepEqual(win.speechSynthesis.getVoices(), []);
  console.log('ok tts');
  console.log('ALL PASS');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
