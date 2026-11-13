/*
 * CEVIRI - Sunucusuz Online Oda Modu
 *
 * Masaustu surumde odalari server.js yonetir (/api/rooms..., SSE /events).
 * Telefonda sunucu olmadigi icin bu dosya ayni HTTP/SSE arayuzunu tarayici
 * icinde taklit eder ve cihazlar arasi iletisimi herkese acik ucretsiz MQTT
 * araci (broker) uzerinden yapar. app.js'in oda kodu degismeden calisir.
 *
 * Guvenlik: Oda kodu hem konu (topic) adinin hem de sifreleme anahtarinin
 * kaynagidir. Konu adi kodun SHA-256 ozetidir (kod gorunmez), tum mesajlar
 * AES-GCM ile sifrelenir: araci veya ayni konuyu dinleyen biri icerigi okuyamaz.
 *
 * Dayaniklilik: Ayni anda birden fazla araciya baglanilir, her mesaj hepsine
 * gonderilir, gelenler mesaj kimligiyle tekillestirilir. Biri cokerse oteki calisir.
 *
 * Kullanim: window.CeviriRelay.install({ translate }) - translate(text, src, tgt)
 * => Promise<{ translatedText, latencyMs }>
 */
(function () {
  'use strict';

  var BROKERS = window.CEVIRI_BROKERS || [
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
  ];
  var TOPIC_PREFIX = 'ceviri/v1/';
  var KDF_SALT = 'ceviri-relay-v1';
  var HEARTBEAT_MS = 8000;
  var PARTICIPANT_TTL_MS = 25000;
  var HISTORY_LIMIT = 50;
  var ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function sanitizeRoomCode(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
  }

  function generateRoomCode() {
    var out = '';
    var rnd = new Uint32Array(8);
    crypto.getRandomValues(rnd);
    for (var i = 0; i < 8; i++) out += ROOM_CODE_CHARS[rnd[i] % ROOM_CODE_CHARS.length];
    return out;
  }

  function randomId() {
    var b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  function toHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  function b64(bytes) {
    var s = '';
    var arr = new Uint8Array(bytes);
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  }

  function unb64(str) {
    var s = atob(str);
    var arr = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
    return arr;
  }

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  async function deriveRoomSecrets(code) {
    var topicHash = await crypto.subtle.digest('SHA-256', enc.encode('topic:' + code));
    var baseKey = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(KDF_SALT), iterations: 100000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return { topic: TOPIC_PREFIX + toHex(topicHash).slice(0, 40), key: key };
  }

  async function seal(key, obj) {
    var iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(obj)));
    return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
  }

  async function open(key, text) {
    var env = JSON.parse(text);
    if (!env || env.v !== 1) throw new Error('bad envelope');
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct));
    return JSON.parse(dec.decode(pt));
  }

  // ---------------------------------------------------------------------------
  // Araci baglantilari (tum odalar icin ortak)
  // ---------------------------------------------------------------------------
  var transport = {
    clients: [],
    started: false,
    startedAt: 0,
    subscriptions: {}, // topic -> handler(payloadString)
    seen: new Map(),

    start: function () {
      if (this.started) return;
      this.started = true;
      this.startedAt = Date.now();
      var self = this;
      var mqttLib = window.mqtt;
      if (!mqttLib || typeof mqttLib.connect !== 'function') {
        this.error = 'MQTT kutuphanesi yuklenemedi';
        return;
      }
      BROKERS.forEach(function (url) {
        var c;
        try {
          c = mqttLib.connect(url, {
            clientId: 'ceviri_' + randomId(),
            clean: true,
            keepalive: 30,
            reconnectPeriod: 3000,
            connectTimeout: 10000,
            protocolVersion: 4,
            timerVariant: 'native', // Worker tabanli zamanlayici yerine (WebView'de daha guvenli)
          });
        } catch (e) {
          return;
        }
        c.on('connect', function () {
          Object.keys(self.subscriptions).forEach(function (t) { c.subscribe(t, { qos: 0 }); });
          self.emitStatus();
        });
        c.on('close', function () { self.emitStatus(); });
        c.on('offline', function () { self.emitStatus(); });
        c.on('error', function () { /* yeniden baglanma otomatik */ });
        c.on('message', function (topic, payload) {
          var h = self.subscriptions[topic];
          if (h) h(typeof payload === 'string' ? payload : dec.decode(payload));
        });
        self.clients.push(c);
      });
    },

    connectedCount: function () {
      return this.clients.filter(function (c) { return c.connected; }).length;
    },

    statusListeners: [],
    emitStatus: function () {
      this.statusListeners.forEach(function (fn) { try { fn(); } catch (e) { /* yoksay */ } });
    },

    subscribe: function (topic, handler) {
      this.start();
      this.subscriptions[topic] = handler;
      this.clients.forEach(function (c) { if (c.connected) c.subscribe(topic, { qos: 0 }); });
    },

    unsubscribe: function (topic) {
      delete this.subscriptions[topic];
      this.clients.forEach(function (c) { if (c.connected) c.unsubscribe(topic); });
    },

    publish: function (topic, text) {
      var sent = 0;
      this.clients.forEach(function (c) {
        if (c.connected) { c.publish(topic, text, { qos: 0 }); sent++; }
      });
      return sent;
    },

    // Ayni mesaj birden fazla aracidan gelir: kimlikle tekillestir
    isDuplicate: function (mid) {
      if (this.seen.has(mid)) return true;
      this.seen.set(mid, Date.now());
      if (this.seen.size > 2000) {
        var cutoff = Date.now() - 120000;
        this.seen.forEach(function (t, k, m) { if (t < cutoff) m.delete(k); });
      }
      return false;
    },
  };

  // ---------------------------------------------------------------------------
  // Oda oturumu: sunucudaki "room" + bu cihazin "participant" kaydi
  // ---------------------------------------------------------------------------
  var rooms = {}; // code -> RoomSession
  var translateFn = null;

  function RoomSession(code) {
    this.code = code;
    this.ready = null; // Promise<secrets>
    this.secrets = null;
    this.self = null; // {clientId,name,lang,joinedAt}
    this.participants = new Map(); // clientId -> {clientId,name,lang,joinedAt,lastSeen}
    this.messages = [];
    this.activeMic = null; // {clientId, ts}
    this.sink = null; // FakeEventSource
    this.heartbeat = null;
    var self = this;
    this.ready = deriveRoomSecrets(code).then(function (s) {
      self.secrets = s;
      transport.subscribe(s.topic, function (text) { self.onRaw(text); });
      return s;
    });
  }

  RoomSession.prototype.send = async function (payload) {
    // Gonderen bilgisi beklemeden once alinir (leave() hemen self'i siler)
    payload.mid = randomId();
    payload.from = this.self ? this.self.clientId : '';
    payload.ts = Date.now();
    await this.ready;
    transport.isDuplicate(payload.mid); // kendi yankimizi yok say
    var text = await seal(this.secrets.key, payload);
    return transport.publish(this.secrets.topic, text);
  };

  RoomSession.prototype.onRaw = async function (text) {
    var msg;
    try { msg = await open(this.secrets.key, text); } catch (e) { return; }
    if (!msg || !msg.mid || transport.isDuplicate(msg.mid)) return;
    if (!this.self || msg.from === this.self.clientId) return;
    this.handle(msg);
  };

  RoomSession.prototype.handle = function (msg) {
    var now = Date.now();
    if (msg.type === 'presence' || msg.type === 'hello') {
      var isNew = !this.participants.has(msg.from);
      this.participants.set(msg.from, {
        clientId: msg.from,
        name: String(msg.name || 'Misafir').slice(0, 40),
        lang: String(msg.lang || 'tr-TR').slice(0, 16),
        joinedAt: msg.joinedAt || now,
        lastSeen: now,
      });
      if (msg.micActive) {
        this.applyRemoteMic(msg.from, true, msg.micTs || msg.ts);
      } else if (this.activeMic && this.activeMic.clientId === msg.from) {
        this.activeMic = null;
      }
      if (isNew || msg.type === 'hello') {
        // Yeni gelene kendimizi ve gecmisi hemen bildir
        this.sendPresence('presence');
        if (this.messages.length) {
          this.send({ type: 'history', messages: this.messages.slice(-HISTORY_LIMIT) });
        }
      }
      this.broadcastState();
      return;
    }

    if (msg.type === 'leave') {
      this.participants.delete(msg.from);
      if (this.activeMic && this.activeMic.clientId === msg.from) this.activeMic = null;
      this.broadcastState();
      return;
    }

    if (msg.type === 'mic') {
      var p = this.participants.get(msg.from);
      if (p) p.lastSeen = now;
      this.applyRemoteMic(msg.from, Boolean(msg.active), msg.ts);
      this.broadcastState();
      return;
    }

    if (msg.type === 'chat' && msg.message) {
      var m = sanitizeChat(msg.message, this.code);
      if (m) this.addMessage(m);
      return;
    }

    if (msg.type === 'history' && Array.isArray(msg.messages)) {
      var fresh = [];
      var self = this;
      msg.messages.forEach(function (raw) {
        var m2 = sanitizeChat(raw, self.code);
        if (m2 && !self.messages.some(function (x) { return x.id === m2.id; })) fresh.push(m2);
      });
      if (!fresh.length) return;
      fresh.forEach(function (m3) { self.messages.push(m3); });
      this.messages.sort(function (a, b) { return a.timestamp - b.timestamp; });
      if (this.messages.length > HISTORY_LIMIT) this.messages = this.messages.slice(-HISTORY_LIMIT);
      if (this.sink) this.sink._emit('history', { messages: fresh });
    }
  };

  // Ayni anda iki kisi mikrofonu alirsa: once alan kazanir, esitlikte kucuk kimlik
  RoomSession.prototype.applyRemoteMic = function (clientId, active, ts) {
    if (!active) {
      if (this.activeMic && this.activeMic.clientId === clientId) this.activeMic = null;
      return;
    }
    var mine = this.activeMic && this.self && this.activeMic.clientId === this.self.clientId;
    if (mine) {
      var myTs = this.activeMic.ts;
      var theyWin = ts < myTs || (ts === myTs && clientId < this.self.clientId);
      if (!theyWin) {
        this.send({ type: 'mic', active: true }); // sahipligi yeniden duyur
        return;
      }
    }
    this.activeMic = { clientId: clientId, ts: ts || Date.now() };
  };

  RoomSession.prototype.addMessage = function (m) {
    if (this.messages.some(function (x) { return x.id === m.id; })) return;
    this.messages.push(m);
    if (this.messages.length > HISTORY_LIMIT) this.messages.shift();
    if (this.sink) this.sink._emit('chat_message', m);
  };

  RoomSession.prototype.sendPresence = function (type) {
    if (!this.self) return Promise.resolve(0);
    var micActive = Boolean(this.activeMic && this.activeMic.clientId === this.self.clientId);
    return this.send({
      type: type || 'presence',
      name: this.self.name,
      lang: this.self.lang,
      joinedAt: this.self.joinedAt,
      micActive: micActive,
      micTs: micActive ? this.activeMic.ts : 0,
    });
  };

  RoomSession.prototype.prune = function () {
    var now = Date.now();
    var changed = false;
    var self = this;
    this.participants.forEach(function (p, id) {
      if (self.self && id === self.self.clientId) return;
      if (now - p.lastSeen > PARTICIPANT_TTL_MS) {
        self.participants.delete(id);
        if (self.activeMic && self.activeMic.clientId === id) self.activeMic = null;
        changed = true;
      }
    });
    if (changed) this.broadcastState();
  };

  RoomSession.prototype.participantList = function () {
    var list = [];
    this.participants.forEach(function (p) {
      list.push({ clientId: p.clientId, name: p.name, lang: p.lang, joinedAt: p.joinedAt });
    });
    list.sort(function (a, b) { return a.joinedAt - b.joinedAt; });
    return list;
  };

  RoomSession.prototype.broadcastState = function () {
    if (!this.sink) return;
    var holder = this.activeMic ? this.participants.get(this.activeMic.clientId) : null;
    if (this.activeMic && !holder) this.activeMic = null;
    this.sink._emit('room_state', {
      roomCode: this.code,
      participants: this.participantList(),
      activeMicClientId: this.activeMic ? this.activeMic.clientId : null,
      activeMicName: holder ? holder.name : null,
    });
  };

  RoomSession.prototype.join = function (sink, clientId, name, lang) {
    var self = this;
    this.sink = sink;
    this.self = { clientId: clientId, name: name, lang: lang, joinedAt: Date.now(), lastSeen: Infinity };
    this.participants.set(clientId, this.self);
    sink._emit('history', { messages: this.messages.slice() });
    this.broadcastState();
    this.sendPresence('hello');
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(function () {
      self.sendPresence('presence');
      self.prune();
    }, HEARTBEAT_MS);
  };

  RoomSession.prototype.leave = function (sink) {
    if (this.sink !== sink) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.self) {
      if (this.activeMic && this.activeMic.clientId === this.self.clientId) this.activeMic = null;
      this.send({ type: 'leave' });
      this.participants.delete(this.self.clientId);
    }
    this.sink = null;
    this.self = null;
  };

  function sanitizeChat(raw, code) {
    if (!raw || typeof raw !== 'object') return null;
    var text = typeof raw.originalText === 'string' ? raw.originalText.slice(0, 4000) : '';
    if (!text || typeof raw.id !== 'string') return null;
    return {
      id: raw.id.slice(0, 64),
      roomCode: code,
      senderId: String(raw.senderId || '').slice(0, 64),
      senderName: String(raw.senderName || 'Kullanici').slice(0, 40),
      sourceLang: String(raw.sourceLang || 'tr-TR').slice(0, 16),
      targetLang: String(raw.targetLang || 'en-US').slice(0, 16),
      originalText: text,
      translatedText: typeof raw.translatedText === 'string' ? raw.translatedText.slice(0, 8000) : '',
      latencyMs: typeof raw.latencyMs === 'number' ? raw.latencyMs : undefined,
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
    };
  }

  function getRoom(code) {
    if (!rooms[code]) rooms[code] = new RoomSession(code);
    return rooms[code];
  }

  // ---------------------------------------------------------------------------
  // EventSource taklidi: /api/rooms/:code/events
  // ---------------------------------------------------------------------------
  function RelayEventSource(url) {
    this.url = url;
    this.readyState = 0;
    this.onerror = null;
    this.onopen = null;
    this.onmessage = null;
    this._listeners = {};
    var u = new URL(url, window.location.href);
    var m = u.pathname.match(/^\/api\/rooms\/([A-Za-z0-9-]+)\/events$/);
    var code = sanitizeRoomCode(m ? m[1] : '');
    var clientId = (u.searchParams.get('clientId') || '').trim().slice(0, 64);
    var name = (u.searchParams.get('name') || 'Misafir').trim().slice(0, 40) || 'Misafir';
    var lang = (u.searchParams.get('lang') || 'tr-TR').trim().slice(0, 16);
    var self = this;
    this._room = getRoom(code);
    this._statusFn = function () {
      if (self.readyState === 2) return;
      if (transport.connectedCount() === 0 && typeof self.onerror === 'function') self.onerror({});
    };
    transport.statusListeners.push(this._statusFn);
    setTimeout(function () {
      if (self.readyState === 2) return;
      self.readyState = 1;
      if (typeof self.onopen === 'function') self.onopen({});
      self._room.join(self, clientId, name, lang);
    }, 0);
  }

  RelayEventSource.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };

  RelayEventSource.prototype.removeEventListener = function (type, fn) {
    var arr = this._listeners[type] || [];
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };

  RelayEventSource.prototype._emit = function (type, data) {
    if (this.readyState === 2) return;
    var ev = { type: type, data: JSON.stringify(data) };
    (this._listeners[type] || []).slice().forEach(function (fn) {
      try { fn(ev); } catch (e) { setTimeout(function () { throw e; }); }
    });
  };

  RelayEventSource.prototype.close = function () {
    if (this.readyState === 2) return;
    this.readyState = 2;
    var i = transport.statusListeners.indexOf(this._statusFn);
    if (i >= 0) transport.statusListeners.splice(i, 1);
    this._room.leave(this);
  };

  // ---------------------------------------------------------------------------
  // fetch taklidi: /api/rooms, /api/rooms/:code/mic, /api/rooms/:code/message
  // ---------------------------------------------------------------------------
  function json(status, obj) {
    return new Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json' } });
  }

  function normBase(lang) {
    return String(lang || '').toLowerCase().split('-')[0];
  }

  async function handleRoomApi(path, init) {
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { return json(400, { error: 'Invalid JSON body' }); }

    if (path === '/api/rooms') {
      transport.start();
      var requested = sanitizeRoomCode(body.roomCode);
      return json(200, { roomCode: requested.length >= 4 ? requested : generateRoomCode() });
    }

    var mic = path.match(/^\/api\/rooms\/([A-Za-z0-9-]+)\/mic$/);
    if (mic) {
      var room = rooms[sanitizeRoomCode(mic[1])];
      if (!room || !room.self) return json(404, { error: 'Oda bulunamadi' });
      var clientId = String(body.clientId || '').trim();
      if (!clientId) return json(400, { error: 'clientId is required' });
      if (body.active) {
        var holder = room.activeMic && room.activeMic.clientId !== clientId ? room.participants.get(room.activeMic.clientId) : null;
        if (holder) {
          return json(409, { error: 'Mikrofon su anda karsi tarafta aktif', activeMicClientId: holder.clientId, activeMicName: holder.name });
        }
        room.activeMic = { clientId: clientId, ts: Date.now() };
        room.send({ type: 'mic', active: true });
      } else if (room.activeMic && room.activeMic.clientId === clientId) {
        room.activeMic = null;
        room.send({ type: 'mic', active: false });
      }
      room.broadcastState();
      return json(200, { activeMicClientId: room.activeMic ? room.activeMic.clientId : null });
    }

    var msgMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9-]+)\/message$/);
    if (msgMatch) {
      var r = rooms[sanitizeRoomCode(msgMatch[1])];
      if (!r || !r.self) return json(404, { error: 'Oda bulunamadi' });
      var text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return json(400, { error: 'text is required' });
      if (transport.connectedCount() === 0) return json(503, { error: 'Online baglanti yok, internetinizi kontrol edin' });

      var sourceLang = (typeof body.sourceLang === 'string' && body.sourceLang.trim()) || r.self.lang || 'tr-TR';
      var partner = r.participantList().filter(function (p) { return p.clientId !== r.self.clientId; })[0] || null;
      var targetLang = (partner && partner.lang) ||
        (typeof body.fallbackTargetLang === 'string' && body.fallbackTargetLang) ||
        (normBase(sourceLang) === 'tr' ? 'en-US' : 'tr-TR');

      var result;
      try {
        result = await translateFn(text, sourceLang, targetLang);
      } catch (err) {
        return json(502, { error: 'Translation failed', detail: String(err && err.message || err) });
      }
      var m = {
        id: Date.now() + '-' + randomId().slice(0, 5),
        roomCode: r.code,
        senderId: r.self.clientId,
        senderName: r.self.name || String(body.senderName || 'Kullanici'),
        sourceLang: sourceLang,
        targetLang: targetLang,
        originalText: text,
        translatedText: result.translatedText,
        latencyMs: result.latencyMs,
        timestamp: Date.now(),
      };
      r.addMessage(m);
      await r.send({ type: 'chat', message: m });
      return json(200, m);
    }

    return json(404, { error: 'Not found' });
  }

  function onlineInfo() {
    transport.start();
    var n = transport.connectedCount();
    if (transport.error) return { onlineMode: true, status: 'error', publicUrl: null, error: transport.error };
    if (n > 0) return { onlineMode: true, status: 'ready', publicUrl: 'relay', error: null, brokers: n };
    if (Date.now() - transport.startedAt > 20000) {
      return { onlineMode: true, status: 'error', publicUrl: null, error: 'Online sunucuya ulasilamadi - internetinizi kontrol edin' };
    }
    return { onlineMode: true, status: 'starting', publicUrl: null, error: null };
  }

  window.CeviriRelay = {
    install: function (opts) {
      translateFn = opts.translate;
      window.EventSource = RelayEventSource;
    },
    handleRoomApi: handleRoomApi,
    onlineInfo: onlineInfo,
    // testler icin
    _transport: transport,
    _rooms: rooms,
  };
})();
