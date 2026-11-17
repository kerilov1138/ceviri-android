// Tek kullanimlik davet linki: misafir oda kuramaz; link ilk kullanana baglanir,
// baskasina iletilen ayni link calismaz; gecersiz link reddedilir.
const vm = require('vm'); const fs = require('fs'); const assert = require('assert');
const startBroker = require('./broker.js');
const W = require('path').join(__dirname, '..', 'www') + '/';
const libs = ['mqtt.min.js', 'online-relay.js', 'android-shim.js'].map(f => [f, fs.readFileSync(W + f, 'utf8')]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeDevice(brokers, native) {
  const store = new Map();
  const g = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Response, TextEncoder, TextDecoder,
    WebSocket, crypto: globalThis.crypto, btoa, atob, Uint8Array, Uint32Array, Map, Set, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, Symbol, ArrayBuffer, DataView, Buffer, queueMicrotask, performance, Blob, EventTarget, Event, AbortController,
    navigator: {}, location: { href: 'https://localhost/', origin: 'https://localhost', protocol: 'https:' },
    document: { createElement: () => ({}), documentElement: { appendChild() {} }, addEventListener() {}, getElementById() { return null; } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    CEVIRI_BROKERS: brokers,
    CEVIRI_WEB_URL: 'https://example.github.io/ceviri-android/',
    Capacitor: native ? { isNativePlatform: () => true } : undefined,
    capacitorExports: { registerPlugin: () => ({ addListener: () => Promise.resolve({ remove() {} }) }) },
    fetch: async (url) => {
      const u = new URL(url); const q = u.searchParams.get('q'); const tl = u.searchParams.get('tl');
      return new Response(JSON.stringify([[[`[${tl}] ${q}`, q]], null, u.searchParams.get('sl')]), { status: 200 });
    },
  };
  for (const k of Object.getOwnPropertyNames(globalThis)) { if (!(k in g) && !['global','globalThis','process','require','module','localStorage'].includes(k)) { try { g[k] = globalThis[k]; } catch {} } }
  g.window = g; g.self = g; g.globalThis = g;
  vm.createContext(g);
  for (const [f, src] of libs) vm.runInContext(src, g, { filename: f });
  return g;
}

function openRoom(dev, code, clientId, name, lang, token) {
  const events = [];
  const tk = token ? `&token=${encodeURIComponent(token)}` : '';
  const es = new dev.EventSource(`/api/rooms/${code}/events?clientId=${clientId}&name=${encodeURIComponent(name)}&lang=${lang}${tk}`);
  for (const t of ['room_state', 'history', 'chat_message']) es.addEventListener(t, (e) => events.push({ type: t, data: JSON.parse(e.data) }));
  return { es, events, last: (t) => events.filter(e => e.type === t).slice(-1)[0] };
}
const post = async (dev, path, body) => { const r = await dev.fetch(path, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };

(async () => {
  const b1 = await startBroker(18886);
  const brokers = ['ws://127.0.0.1:18886/mqtt'];
  const host = makeDevice(brokers, true);
  const guestA = makeDevice(brokers, false);
  const guestB = makeDevice(brokers, false);
  const guestC = makeDevice(brokers, false);
  for (const d of [host, guestA, guestB, guestC]) await d.fetch('/api/online-info');
  await sleep(600);

  // Misafir oda kuramaz
  const denied = await post(guestA, '/api/rooms', {});
  assert.equal(denied.status, 403, 'misafir oda kuramaz');
  assert.equal(guestA.CeviriRelay.createInvite('ABCD1234'), '', 'misafir davet uretemez');
  console.log('ok misafir oda kuramaz, davet uretemez');

  const { data: { roomCode } } = await post(host, '/api/rooms', {});
  const H = openRoom(host, roomCode, 'idHost', 'Kerem', 'tr-TR');
  await sleep(500);
  const token = host.CeviriRelay.createInvite(roomCode);
  assert.ok(token.length >= 20);
  await sleep(300);
  await post(host, `/api/rooms/${roomCode}/message`, { clientId: 'idHost', text: 'gizli gecmis', sourceLang: 'tr-TR' });

  // Linki ilk kullanan girer
  const A = openRoom(guestA, roomCode, 'idA', 'Anna', 'en-US', token);
  await sleep(1500);
  assert.equal(A.last('room_state').data.invite, 'ok');
  assert.equal(H.last('room_state').data.participants.length, 2, 'ev sahibi misafiri gorur');
  assert.ok(A.events.some((e) => e.type === 'history' && (e.data.messages || []).some((m) => m.originalText === 'gizli gecmis')), 'kabul edilen gecmisi alir');
  console.log('ok linki ilk kullanan girer');

  // Ayni link baskasina iletildi: girmez, hicbir sey goremez
  const B = openRoom(guestB, roomCode, 'idB', 'Bob', 'de-DE', token);
  await sleep(1500);
  assert.equal(B.last('room_state').data.invite, 'used', 'iletilen link kullanilmis sayilir');
  assert.ok(!H.last('room_state').data.participants.some((p) => p.clientId === 'idB'), 'odadakiler onu saymaz');
  assert.ok(!B.events.some((e) => e.type === 'history' && (e.data.messages || []).length), 'gecmisi goremez');
  await post(guestB, `/api/rooms/${roomCode}/message`, { clientId: 'idB', text: 'merhaba', sourceLang: 'de-DE' });
  await post(host, `/api/rooms/${roomCode}/message`, { clientId: 'idHost', text: 'yeni mesaj', sourceLang: 'tr-TR' });
  await sleep(800);
  assert.ok(!H.events.some((e) => e.type === 'chat_message' && e.data.originalText === 'merhaba'), 'mesaji yok sayilir');
  assert.ok(!B.events.some((e) => e.type === 'chat_message'), 'mesajlari almaz');
  assert.ok(A.events.some((e) => e.type === 'chat_message' && e.data.originalText === 'yeni mesaj'), 'kabul edilen almaya devam eder');
  B.es.close();
  console.log('ok iletilen link calismaz');

  // Uydurma / eski link gecersiz
  const C = openRoom(guestC, roomCode, 'idC', 'Cem', 'fr-FR', 'uydurma-anahtar-1234567890');
  await sleep(6500);
  assert.equal(C.last('room_state').data.invite, 'invalid', 'gecersiz link');
  assert.ok(!H.last('room_state').data.participants.some((p) => p.clientId === 'idC'));
  C.es.close();
  console.log('ok gecersiz link reddedilir');

  // Ilk misafir sayfayi yenileyip ayni linkle donebilir (ayni cihaz)
  A.es.close(); await sleep(400);
  const A2 = openRoom(guestA, roomCode, 'idA', 'Anna', 'en-US', token);
  await sleep(1500);
  assert.equal(A2.last('room_state').data.invite, 'ok', 'ayni kisi geri donebilir');
  console.log('ok ayni kisi yeniden baglanabilir');

  A2.es.close(); H.es.close();
  await sleep(200);
  console.log('ALL INVITE TESTS PASS');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
