const vm = require('vm'); const fs = require('fs'); const assert = require('assert');
const startBroker = require('./broker.js');
const W = require('path').join(__dirname, '..', 'www') + '/';
const libs = ['mqtt.min.js', 'online-relay.js', 'android-shim.js'].map(f => [f, fs.readFileSync(W + f, 'utf8')]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeDevice(name, brokers) {
  const g = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Response, TextEncoder, TextDecoder,
    WebSocket, crypto: globalThis.crypto, btoa, atob, Uint8Array, Uint32Array, Map, Set, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, Symbol, ArrayBuffer, DataView, Buffer, queueMicrotask, performance, Blob, EventTarget, Event, AbortController,
    navigator: {}, location: { href: 'https://localhost/', origin: 'https://localhost', protocol: 'https:' },
    document: { createElement: () => ({}), documentElement: { appendChild() {} }, addEventListener() {}, getElementById() { return null; } },
    CEVIRI_BROKERS: brokers,
    Capacitor: { isNativePlatform: () => true },
    capacitorExports: { registerPlugin: () => ({ addListener: () => Promise.resolve({ remove() {} }) }) },
    fetch: async (url) => {
      const u = new URL(url); const q = u.searchParams.get('q'); const tl = u.searchParams.get('tl');
      return new Response(JSON.stringify([[[`[${tl}] ${q}`, q]], null, u.searchParams.get('sl')]), { status: 200 });
    },
  };
  for (const k of Object.getOwnPropertyNames(globalThis)) { if (!(k in g) && !['global','globalThis','process','require','module'].includes(k)) { try { g[k] = globalThis[k]; } catch {} } }
  g.window = g; g.self = g; g.globalThis = g;
  vm.createContext(g);
  for (const [f, src] of libs) vm.runInContext(src, g, { filename: f });
  return g;
}

function openRoom(dev, code, clientId, name, lang) {
  const events = [];
  const es = new dev.EventSource(`/api/rooms/${code}/events?clientId=${clientId}&name=${encodeURIComponent(name)}&lang=${lang}`);
  for (const t of ['room_state', 'history', 'chat_message']) es.addEventListener(t, (e) => events.push({ type: t, data: JSON.parse(e.data) }));
  return { es, events, last: (t) => events.filter(e => e.type === t).slice(-1)[0] };
}
const post = async (dev, path, body) => { const r = await dev.fetch(path, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };

(async () => {
  const b1 = await startBroker(18881), b2 = await startBroker(18882);
  const brokers = ['ws://127.0.0.1:18881/mqtt', 'ws://127.0.0.1:18882/mqtt'];
  const A = makeDevice('A', brokers), B = makeDevice('B', brokers);

  // online-info -> ready
  let info; for (let i = 0; i < 50; i++) { info = await (await A.fetch('/api/online-info')).json(); if (info.status === 'ready') break; await sleep(100); }
  assert.equal(info.status, 'ready'); assert.ok(info.publicUrl); console.log('ok online-info ready, brokers=', info.brokers);
  await B.fetch('/api/online-info');

  // A creates room
  const { data: { roomCode } } = await post(A, '/api/rooms', {});
  assert.match(roomCode, /^[A-Z0-9]{8}$/); console.log('ok room', roomCode);
  const ra = openRoom(A, roomCode, 'aaa', 'Kerem', 'tr-TR');
  await sleep(300);
  assert.deepEqual(ra.last('history').data.messages, []);
  assert.equal(ra.last('room_state').data.participants.length, 1);

  // A sends message before partner joins -> fallback target
  let m0 = await post(A, `/api/rooms/${roomCode}/message`, { clientId: 'aaa', senderName: 'Kerem', text: 'ilk mesaj', sourceLang: 'tr-TR', fallbackTargetLang: 'en-US' });
  assert.equal(m0.status, 200); assert.equal(m0.data.translatedText, '[en] ilk mesaj');

  // B joins
  await sleep(1500);
  const rb = openRoom(B, roomCode, 'bbb', 'John', 'de-DE');
  await sleep(800);
  const sa = ra.last('room_state').data, sb = rb.last('room_state').data;
  assert.equal(sa.participants.length, 2, 'A sees 2'); assert.equal(sb.participants.length, 2, 'B sees 2');
  assert.equal(sa.participants.find(p => p.clientId === 'bbb').lang, 'de-DE');
  assert.equal(sb.participants.find(p => p.clientId === 'aaa').name, 'Kerem');
  const hist = rb.events.filter(e => e.type === 'history').flatMap(e => e.data.messages);
  assert.ok(hist.some(m => m.originalText === 'ilk mesaj'), 'B got history');
  console.log('ok join + presence + history');

  // A -> B chat, translated to B's language, delivered exactly once (two brokers)
  const m1 = await post(A, `/api/rooms/${roomCode}/message`, { clientId: 'aaa', text: 'merhaba', sourceLang: 'tr-TR', fallbackTargetLang: 'en-US' });
  assert.equal(m1.data.translatedText, '[de] merhaba');
  await sleep(500);
  const bChats = rb.events.filter(e => e.type === 'chat_message' && e.data.originalText === 'merhaba');
  const aChats = ra.events.filter(e => e.type === 'chat_message' && e.data.originalText === 'merhaba');
  assert.equal(bChats.length, 1, 'B got exactly one'); assert.equal(aChats.length, 1, 'A appended own once');
  assert.equal(bChats[0].data.senderId, 'aaa');
  // B -> A
  const m2 = await post(B, `/api/rooms/${roomCode}/message`, { clientId: 'bbb', text: 'hallo', sourceLang: 'de-DE' });
  assert.equal(m2.data.translatedText, '[tr] hallo'); await sleep(400);
  assert.equal(ra.events.filter(e => e.type === 'chat_message' && e.data.originalText === 'hallo').length, 1);
  console.log('ok chat both ways, dedup across 2 brokers');

  // Mic lock
  let r1 = await post(A, `/api/rooms/${roomCode}/mic`, { clientId: 'aaa', active: true }); assert.equal(r1.status, 200);
  await sleep(400);
  assert.equal(rb.last('room_state').data.activeMicClientId, 'aaa'); assert.equal(rb.last('room_state').data.activeMicName, 'Kerem');
  let r2 = await post(B, `/api/rooms/${roomCode}/mic`, { clientId: 'bbb', active: true }); assert.equal(r2.status, 409); assert.equal(r2.data.activeMicName, 'Kerem');
  await post(A, `/api/rooms/${roomCode}/mic`, { clientId: 'aaa', active: false }); await sleep(400);
  assert.equal(rb.last('room_state').data.activeMicClientId, null);
  r2 = await post(B, `/api/rooms/${roomCode}/mic`, { clientId: 'bbb', active: true }); assert.equal(r2.status, 200);
  await sleep(400); assert.equal(ra.last('room_state').data.activeMicClientId, 'bbb');
  await post(B, `/api/rooms/${roomCode}/mic`, { clientId: 'bbb', active: false }); await sleep(300);
  console.log('ok mic lock');

  // One broker dies -> still works
  b1.close(); await sleep(500);
  const m3 = await post(A, `/api/rooms/${roomCode}/message`, { clientId: 'aaa', text: 'tek araci', sourceLang: 'tr-TR' });
  assert.equal(m3.status, 200); await sleep(500);
  assert.equal(rb.events.filter(e => e.type === 'chat_message' && e.data.originalText === 'tek araci').length, 1);
  console.log('ok survives broker failure');

  // Language change = reconnect (close + new EventSource), partner sees new lang
  ra.es.close();
  const ra2 = openRoom(A, roomCode, 'aaa', 'Kerem', 'en-US'); await sleep(800);
  const p = rb.last('room_state').data.participants.find(x => x.clientId === 'aaa');
  assert.ok(p, 'A back in room for B'); assert.equal(p.lang, 'en-US');
  console.log('ok reconnect with new language');

  // Wrong room code cannot read: C in other room sees nothing
  const C = makeDevice('C', brokers.slice(1)); await C.fetch('/api/online-info'); await sleep(500);
  const rc = openRoom(C, 'WRONG123', 'ccc', 'Eve', 'fr-FR'); await sleep(500);
  await post(A, `/api/rooms/${roomCode}/message`, { clientId: 'aaa', text: 'gizli', sourceLang: 'tr-TR' }); await sleep(400);
  assert.equal(rc.events.filter(e => e.type === 'chat_message').length, 0);
  assert.equal(rc.last('room_state').data.participants.length, 1);
  console.log('ok isolation between rooms');

  // Leave -> partner sees 1 participant
  rb.es.close(); await sleep(500);
  assert.equal(ra2.last('room_state').data.participants.length, 1);
  console.log('ok leave');

  console.log('ALL RELAY TESTS PASS'); process.exit(0);
})().catch(e => { console.error('FAIL', String(e && e.message).slice(0,300), String(e && e.stack).split('\n').slice(-4).join(' | ').slice(-300)); process.exit(1); });
