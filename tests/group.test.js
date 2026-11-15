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
    CEVIRI_WEB_URL: 'https://example.github.io/ceviri-android/',
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
  for (const t of ['room_state', 'history', 'chat_message', 'file_message', 'file_progress', 'file_ready', 'file_failed', 'rtc_signal', 'kicked']) es.addEventListener(t, (e) => events.push({ type: t, data: JSON.parse(e.data) }));
  return { es, events, last: (t) => events.filter(e => e.type === t).slice(-1)[0] };
}
const post = async (dev, path, body) => { const r = await dev.fetch(path, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };

// Grup odasi: 3-6 kisi, soz sirasi (bas-konus), alicida ceviri, oda dolu, 2 kisiye donus, kamera sinyali
(async () => {
  const b1 = await startBroker(18885);
  const brokers = ['ws://127.0.0.1:18885/mqtt'];
  const names = ['Ali', 'John', 'Hans', 'Yuki', 'Ana', 'Ivan', 'Zoe', 'Lea'];
  const langs = ['tr-TR', 'en-US', 'de-DE', 'ja-JP', 'es-ES', 'ru-RU', 'fr-FR', 'it-IT'];
  const devs = names.map((n) => makeDevice(n, brokers));
  for (const d of devs) await d.fetch('/api/online-info');
  await sleep(600);
  const { data: { roomCode } } = await post(devs[0], '/api/rooms', {});
  const rooms = [];
  const ids = names.map((n, i) => 'id' + i + n);
  const last = (i) => rooms[i].last('room_state').data;

  // 2 kisi: bugunku davranis (gonderen cevirir)
  for (let i = 0; i < 2; i++) { rooms.push(openRoom(devs[i], roomCode, ids[i], names[i], langs[i])); await sleep(300); }
  await sleep(700);
  assert.equal(last(0).group, false); assert.equal(last(0).participants.length, 2);
  let m = await post(devs[0], `/api/rooms/${roomCode}/message`, { clientId: ids[0], text: 'merhaba', sourceLang: 'tr-TR' });
  assert.equal(m.data.translatedText, '[en] merhaba');
  console.log('ok 2 kisi: bugunku davranis');

  // 4 kisi: grup
  for (let i = 2; i < 4; i++) { rooms.push(openRoom(devs[i], roomCode, ids[i], names[i], langs[i])); await sleep(300); }
  await sleep(900);
  for (let i = 0; i < 4; i++) { assert.equal(last(i).group, true, 'grup ' + i); assert.equal(last(i).participants.length, 4); }
  m = await post(devs[1], `/api/rooms/${roomCode}/message`, { clientId: ids[1], text: 'hello all', sourceLang: 'en-US' });
  assert.equal(m.data.translatedText, ''); // gonderen cevirmez
  await sleep(400);
  const got = rooms[3].events.filter((e) => e.type === 'chat_message' && e.data.originalText === 'hello all');
  assert.equal(got.length, 1); assert.equal(got[0].data.translatedText, ''); assert.equal(got[0].data.sourceLang, 'en-US');
  console.log('ok 4 kisi: grup modu, ceviriyi alici yapar');

  // Soz sirasi: John konusuyor, Hans ve Yuki el kaldirir
  let r = await post(devs[1], `/api/rooms/${roomCode}/mic`, { clientId: ids[1], active: true }); assert.equal(r.status, 200);
  await sleep(400);
  r = await post(devs[2], `/api/rooms/${roomCode}/mic`, { clientId: ids[2], active: true }); assert.equal(r.status, 409);
  await post(devs[2], `/api/rooms/${roomCode}/hand`, { clientId: ids[2], raise: true }); await sleep(150);
  await post(devs[3], `/api/rooms/${roomCode}/hand`, { clientId: ids[3], raise: true }); await sleep(500);
  assert.deepEqual(last(0).queue, [ids[2], ids[3]], 'sira: Hans, Yuki');
  assert.equal(last(0).activeMicClientId, ids[1]);
  // John birakir -> Hans otomatik soz alir
  await post(devs[1], `/api/rooms/${roomCode}/mic`, { clientId: ids[1], active: false }); await sleep(700);
  for (let i = 0; i < 4; i++) assert.equal(last(i).activeMicClientId, ids[2], 'Hans konusuyor (' + names[i] + ' gorusu)');
  assert.deepEqual(last(0).queue, [ids[3]]);
  // Hans birakir -> Yuki
  await post(devs[2], `/api/rooms/${roomCode}/mic`, { clientId: ids[2], active: false }); await sleep(700);
  assert.equal(last(0).activeMicClientId, ids[3]); assert.deepEqual(last(0).queue, []);
  // Sirada bekleyen vazgecebilir
  await post(devs[0], `/api/rooms/${roomCode}/hand`, { clientId: ids[0], raise: true }); await sleep(300);
  assert.deepEqual(last(1).queue, [ids[0]]);
  await post(devs[0], `/api/rooms/${roomCode}/hand`, { clientId: ids[0], raise: false }); await sleep(300);
  assert.deepEqual(last(1).queue, []);
  await post(devs[3], `/api/rooms/${roomCode}/mic`, { clientId: ids[3], active: false }); await sleep(400);
  assert.equal(last(0).activeMicClientId, null);
  console.log('ok soz sirasi: el kaldir, otomatik soz, vazgec');

  // Konusan odadan cikarsa soz siradakine gecer
  await post(devs[0], `/api/rooms/${roomCode}/mic`, { clientId: ids[0], active: true }); await sleep(300);
  await post(devs[1], `/api/rooms/${roomCode}/hand`, { clientId: ids[1], raise: true }); await sleep(400);
  rooms[0].es.close(); await sleep(700);
  assert.equal(last(1).activeMicClientId, ids[1], 'cikan konusmacidan sonra siradaki');
  await post(devs[1], `/api/rooms/${roomCode}/mic`, { clientId: ids[1], active: false });
  rooms[0] = openRoom(devs[0], roomCode, ids[0], names[0], langs[0]); await sleep(800);
  console.log('ok konusan cikinca soz siradakine gecer');

  // 6 kisi dolu, 7. kisi "oda dolu"
  for (let i = 4; i < 7; i++) { rooms.push(openRoom(devs[i], roomCode, ids[i], names[i], langs[i])); await sleep(350); }
  await sleep(1200);
  assert.equal(last(0).participants.length, 6);
  assert.equal(last(6).full, true, '7. kisi dolu gorur');
  assert.ok(!last(0).participants.some((p) => p.clientId === ids[6]), 'uyeler 7. kisiyi saymaz');
  console.log('ok 6 kisi siniri, 7. kisi oda dolu');

  // Kamera durumu ve WebRTC sinyali (yalniz hedefe gider)
  devs[2].CeviriRelay.setCam(roomCode, true); await sleep(400);
  assert.equal(last(0).participants.find((p) => p.clientId === ids[2]).cam, true);
  await devs[2].CeviriRelay.sendSignal(roomCode, ids[3], { description: { type: 'offer', sdp: 'x' } }); await sleep(400);
  assert.equal(rooms[3].events.filter((e) => e.type === 'rtc_signal').length, 1);
  assert.equal(rooms[1].events.filter((e) => e.type === 'rtc_signal').length, 0);
  assert.equal(rooms[3].events.find((e) => e.type === 'rtc_signal').data.from, ids[2]);
  console.log('ok kamera durumu ve hedefli sinyal');

  // Oda sahibi: ilk kuran (Ali). Sahip olmayan cikaramaz; sahip cikarir.
  for (let i = 0; i < 6; i++) assert.equal(last(i).ownerId, ids[0], 'herkes Ali\'yi sahip gorur');
  assert.equal(devs[1].CeviriRelay.kick(roomCode, ids[2]), false, 'sahip olmayan cikaramaz');
  assert.equal(devs[0].CeviriRelay.kick(roomCode, ids[5]), true);
  await sleep(1200);
  assert.equal(rooms[5].events.filter((e) => e.type === 'kicked').length, 1, 'cikarilan haber alir');
  assert.ok(!last(1).participants.some((p) => p.clientId === ids[5]), 'cikarilan listeden duser');
  assert.ok(last(1).participants.some((p) => p.clientId === ids[6]), 'bosalan yere bekleyen girer');
  rooms[5].es.close();
  console.log('ok sahip cikarir, sahip olmayan cikaramaz');

  // Kilit: yeni gelen giremez, kilit acilinca bilgi herkese gider
  assert.equal(devs[1].CeviriRelay.setLocked(roomCode, true), false, 'sahip olmayan kilitleyemez');
  rooms[6].es.close(); await sleep(600);
  assert.equal(devs[0].CeviriRelay.setLocked(roomCode, true), true); await sleep(500);
  assert.equal(last(2).locked, true);
  rooms[7] = openRoom(devs[7], roomCode, ids[7], names[7], langs[7]); await sleep(1500);
  assert.equal(last(7).lockedOut, true, 'kilitli odaya giremez');
  assert.ok(!last(0).participants.some((p) => p.clientId === ids[7]), 'uyeler onu saymaz');
  rooms[7].es.close();
  devs[0].CeviriRelay.setLocked(roomCode, false); await sleep(500);
  assert.equal(last(2).locked, false);
  console.log('ok oda kilidi');

  // 2 kisiye dus: grup kalkar, gonderen yine cevirir
  for (let i = 4; i >= 2; i--) rooms[i].es.close();
  await sleep(900);
  assert.equal(last(0).group, false); assert.equal(last(0).participants.length, 2); assert.deepEqual(last(0).queue, []);
  m = await post(devs[0], `/api/rooms/${roomCode}/message`, { clientId: ids[0], text: 'tekrar iki kisiyiz', sourceLang: 'tr-TR' });
  assert.equal(m.data.translatedText, '[en] tekrar iki kisiyiz');
  console.log('ok 2 kisiye donunce bugunku davranis');

  // Sahip ayrilinca yetki siradakine gecer
  rooms[0].es.close(); await sleep(800);
  assert.equal(last(1).ownerId, ids[1], 'yetki John\'a gecti');
  assert.equal(devs[1].CeviriRelay.setLocked(roomCode, true), true);
  console.log('ok sahiplik devri');
  console.log('ALL GROUP TESTS PASS'); process.exit(0);
})().catch((e) => { console.error('FAIL', String(e && e.message).slice(0, 300), String(e && e.stack).split('\n').slice(1, 3).join(' | ')); process.exit(1); });
