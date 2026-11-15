import { LANGUAGES, findLanguage } from './languages.js';
import { initI18n, t, langName, setUiLang, getUiLang, onUiLangChange, UI_LANGS } from './i18n.js';
import { censor, stripMaskForSpeech } from './profanity.js';
import { initCamera } from './camera.js';
import { createVideoMesh } from './video.js';

// Online oda modulu (online-relay.js) karsiya gidecek metni de filtrelesin
window.CeviriCensor = censor;

const IS_NATIVE_APP = Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// Davet linki / QR ile web sitesinden gelen kisi (misafir): yalnizca Online Oda gorur.
// Kamera, Canli Dongu ve Yuz Yuze sekmeleri yalnizca uygulamada (APK) vardir.
const IS_GUEST = !IS_NATIVE_APP;
if (IS_GUEST) document.documentElement.classList.add('guest-mode');

let cameraCtl = null; // kamera sekmesi (yalnizca uygulamada)

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

const STORAGE_KEYS = {
  myLang: 'ceviri_my_lang',
  partnerLang: 'ceviri_partner_lang',
  myName: 'ceviri_my_name',
  settings: 'ceviri_settings',
};

function getTabClientId() {
  let id = sessionStorage.getItem('ceviri_client_id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
    sessionStorage.setItem('ceviri_client_id', id);
  }
  return id;
}

const state = {
  mode: 'loop', // 'loop' | 'face' | 'online'
  isActive: false,
  phase: 'idle', // 'idle' | 'listening' | 'translating' | 'speaking'
  activeSpeaker: 'me', // 'me' | 'partner'
  myLang: localStorage.getItem(STORAGE_KEYS.myLang) || 'tr-TR',
  partnerLang: localStorage.getItem(STORAGE_KEYS.partnerLang) || 'en-US',
  myName: localStorage.getItem(STORAGE_KEYS.myName) || '',
  partnerName: '',
  clientId: getTabClientId(),
  roomCode: '',
  activeMicClientId: null,
  activeMicName: null,
  pendingTranscript: '',
  eventSource: null,
  onlineInfo: { onlineMode: false, status: 'disabled', publicUrl: null },
  onlinePollTimer: null,
  seenMessageIds: new Set(),
  messages: [],
  voices: [],
  settings: {
    autoSpeak: true,
    autoLoop: true,
    flipPartner: false,
    speechRate: 1.0,
    ...loadSavedSettings(),
  },
  recognition: null,
  recognitionGen: 0,
  mediaStream: null,
  audioCtx: null,
  analyser: null,
  rafId: null,
  speakWatchdog: null,
  speakKeepAlive: null,
  resumeTimer: null,
  // Online oda: 3+ kisi grup modu (soz sirasi), katilimcilar, kamera
  group: false,
  queue: [],
  participants: [],
  handRaised: false,
  turnTimer: null,
  turnStartedAt: 0, // benim konusmamin baslangici (geri sayim)
  holderSince: 0, // su anki konusanin baslangici (yerel saat)
  ownerId: null,
  roomLocked: false,
  incomingChain: Promise.resolve(),
  videoMesh: null,
};

function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

// DOM Elements
const els = {
  myLangSelect: document.getElementById('myLangSelect'),
  partnerLangSelect: document.getElementById('partnerLangSelect'),
  swapLangsBtn: document.getElementById('swapLangsBtn'),
  modeCameraBtn: document.getElementById('modeCameraBtn'),
  cameraStage: document.getElementById('cameraStage'),
  modeLoopBtn: document.getElementById('modeLoopBtn'),
  modeFaceBtn: document.getElementById('modeFaceBtn'),
  modeOnlineBtn: document.getElementById('modeOnlineBtn'),
  onlineBar: document.getElementById('onlineBar'),
  onlineJoinView: document.getElementById('onlineJoinView'),
  onlineActiveView: document.getElementById('onlineActiveView'),
  onlineNameInput: document.getElementById('onlineNameInput'),
  onlineRoomInput: document.getElementById('onlineRoomInput'),
  joinRoomBtn: document.getElementById('joinRoomBtn'),
  createRoomBtn: document.getElementById('createRoomBtn'),
  roomCodeBadge: document.getElementById('roomCodeBadge'),
  tunnelStatusBadge: document.getElementById('tunnelStatusBadge'),
  partnerPresenceText: document.getElementById('partnerPresenceText'),
  inviteLinkInput: document.getElementById('inviteLinkInput'),
  copyInviteBtn: document.getElementById('copyInviteBtn'),
  leaveRoomBtn: document.getElementById('leaveRoomBtn'),
  myLangCardLabel: document.getElementById('myLangCardLabel'),
  partnerLangCardLabel: document.getElementById('partnerLangCardLabel'),
  turnControls: document.querySelector('.turn-controls'),
  loopStage: document.getElementById('loopStage'),
  faceStage: document.getElementById('faceStage'),
  statusPill: document.getElementById('statusPill'),
  statusText: document.getElementById('statusText'),
  alertBanner: document.getElementById('alertBanner'),
  alertMessage: document.getElementById('alertMessage'),
  alertCloseBtn: document.getElementById('alertCloseBtn'),
  mainToggleBtn: document.getElementById('mainToggleBtn'),
  orbLabel: document.getElementById('orbLabel'),
  turnMeBtn: document.getElementById('turnMeBtn'),
  turnPartnerBtn: document.getElementById('turnPartnerBtn'),
  turnMeLabel: document.getElementById('turnMeLabel'),
  turnPartnerLabel: document.getElementById('turnPartnerLabel'),
  swapTurnBtn: document.getElementById('swapTurnBtn'),
  interimText: document.getElementById('interimText'),
  visualizerCanvas: document.getElementById('visualizerCanvas'),
  facePartnerCard: document.getElementById('facePartnerCard'),
  faceMeCard: document.getElementById('faceMeCard'),
  facePartnerLangBadge: document.getElementById('facePartnerLangBadge'),
  faceMeLangBadge: document.getElementById('faceMeLangBadge'),
  facePartnerText: document.getElementById('facePartnerText'),
  faceMeText: document.getElementById('faceMeText'),
  facePartnerBtn: document.getElementById('facePartnerBtn'),
  faceMeBtn: document.getElementById('faceMeBtn'),
  chatStream: document.getElementById('chatStream'),
  emptyState: document.getElementById('emptyState'),
  messageCount: document.getElementById('messageCount'),
  textTranslateForm: document.getElementById('textTranslateForm'),
  textSpeakerSelect: document.getElementById('textSpeakerSelect'),
  textInput: document.getElementById('textInput'),
  attachBtn: document.getElementById('attachBtn'),
  participantsGrid: document.getElementById('participantsGrid'),
  roomTools: document.getElementById('roomTools'),
  lockRoomBtn: document.getElementById('lockRoomBtn'),
  lockedBadge: document.getElementById('lockedBadge'),
  videoReceiveBtn: document.getElementById('videoReceiveBtn'),
  attachInput: document.getElementById('attachInput'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsModal: document.getElementById('settingsModal'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  autoSpeakToggle: document.getElementById('autoSpeakToggle'),
  autoLoopToggle: document.getElementById('autoLoopToggle'),
  flipPartnerToggle: document.getElementById('flipPartnerToggle'),
  speechRateRange: document.getElementById('speechRateRange'),
  rateValueLabel: document.getElementById('rateValueLabel'),
};

function showAlert(msg) {
  els.alertMessage.textContent = msg;
  els.alertBanner.classList.remove('hidden');
}

function hideAlert() {
  els.alertBanner.classList.add('hidden');
}

// Tek varyantli dillerde bolge adini gosterme: "Turkish (Turkey)" yerine "Turkish"
const LANG_BASE_COUNT = LANGUAGES.reduce((acc, l) => {
  const base = l.code.split('-')[0];
  acc[base] = (acc[base] || 0) + 1;
  return acc;
}, {});

function displayLangName(code, fallback) {
  const base = String(code || '').split('-')[0];
  return langName(LANG_BASE_COUNT[base] === 1 ? base : code, fallback);
}

function populateLanguageSelects() {
  const buildOptions = (selectEl, selectedCode) => {
    selectEl.innerHTML = '';
    for (const lang of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      const localName = displayLangName(lang.code, lang.name);
      opt.textContent = localName.toLocaleLowerCase() === lang.nativeName.toLocaleLowerCase()
        ? lang.nativeName
        : `${localName} (${lang.nativeName})`;
      if (lang.code === selectedCode) opt.selected = true;
      selectEl.appendChild(opt);
    }
  };
  buildOptions(els.myLangSelect, state.myLang);
  buildOptions(els.partnerLangSelect, state.partnerLang);
  updateLanguageBadges();
}

function updateLanguageBadges() {
  const myLangObj = findLanguage(state.myLang);
  const partnerLangObj = findLanguage(state.partnerLang);
  const meDisplay = state.mode === 'online' && state.myName ? state.myName : t('who.me');
  const partnerDisplay = state.mode === 'online' && state.partnerName ? state.partnerName : t('who.partner');

  els.turnMeLabel.textContent = `${meDisplay} (${myLangObj.short})`;
  els.turnPartnerLabel.textContent = `${partnerDisplay} (${partnerLangObj.short})`;
  els.faceMeLangBadge.textContent = myLangObj.short;
  els.facePartnerLangBadge.textContent = partnerLangObj.short;

  if (state.mode === 'online') {
    els.myLangCardLabel.textContent = state.myName
      ? t('lang.mineNamed', { name: state.myName.toLocaleUpperCase() })
      : t('lang.mine');
    els.partnerLangCardLabel.textContent = state.partnerName
      ? t('lang.partnerNamed', { name: state.partnerName.toLocaleUpperCase() })
      : t('lang.partner');
  } else {
    els.myLangCardLabel.textContent = t('lang.mine');
    els.partnerLangCardLabel.textContent = t('lang.partner');
  }
  if (cameraCtl) cameraCtl.updateDirection();
}

function setPhase(phase) {
  state.phase = phase;
  els.statusPill.dataset.state = phase;

  const labels = {
    idle: t('status.idle'),
    listening: t('status.listening'),
    translating: t('status.translating'),
    speaking: t('status.speaking'),
  };
  els.statusText.textContent = labels[phase] || t('status.idle');
}

function updateTurnUI() {
  const isMe = state.activeSpeaker === 'me';
  const lockedByRemote =
    state.mode === 'online' &&
    Boolean(state.activeMicClientId) &&
    state.activeMicClientId !== state.clientId;

  els.turnMeBtn.classList.toggle('active', isMe);
  els.turnPartnerBtn.classList.toggle('active', !isMe);
  els.mainToggleBtn.dataset.active = String(state.isActive);
  els.mainToggleBtn.dataset.speaker = state.activeSpeaker;
  const groupWait = lockedByRemote && state.group;
  const inQueue = groupWait && state.queue.includes(state.clientId);
  // 2 kisi: karsidaki konusurken dugme kilitli (bugunku davranis).
  // 3+ kisi: dugme "Soz Iste" / "Siradan Cik" olur.
  els.mainToggleBtn.disabled = lockedByRemote && !state.group;
  els.mainToggleBtn.classList.toggle('locked-remote', lockedByRemote && !state.group);
  els.mainToggleBtn.classList.toggle('raise-hand', groupWait);
  els.mainToggleBtn.classList.toggle('in-queue', inQueue);
  els.orbLabel.textContent = groupWait
    ? inQueue
      ? t('group.cancelHand')
      : t('group.raiseHand')
    : lockedByRemote
      ? t('orb.locked')
      : state.isActive
        ? state.mode === 'online' && state.group && state.turnStartedAt
          ? `${t('orb.stop')} · ${turnSecondsLeft(state.turnStartedAt)}`
          : t('orb.stop')
        : t('orb.start');

  els.faceMeCard.classList.toggle('active-me', state.isActive && isMe);
  els.facePartnerCard.classList.toggle('active-partner', state.isActive && !isMe);
  els.faceMeBtn.querySelector('span').textContent =
    state.isActive && isMe ? t('orb.stop') : t('face.speak');
  els.facePartnerBtn.querySelector('span').textContent =
    state.isActive && !isMe ? t('orb.stop') : t('face.speak');
}

// Dil degisince yeniden yazilabilmesi icin anahtarla ayarlanan metinler
const i18nSlots = { interim: null, badge: null, presence: null };

function renderSlot(slot) {
  const v = i18nSlots[slot];
  if (!v) return;
  const vars = { ...(v.vars || {}) };
  if (vars.lang && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(vars.lang)) vars.lang = displayLangName(vars.lang, vars.langFallback);
  const text = t(v.key, vars);
  if (slot === 'interim') {
    if (v.html) els.interimText.innerHTML = text;
    else els.interimText.textContent = text;
    els.interimText.classList.remove('live');
  } else if (slot === 'badge') {
    els.tunnelStatusBadge.textContent = text;
  } else if (slot === 'presence') {
    els.partnerPresenceText.textContent = text;
  }
}

function setInterimKey(key, vars, html = false) {
  i18nSlots.interim = { key, vars, html };
  renderSlot('interim');
}

function setBadgeKey(key, vars) {
  i18nSlots.badge = { key, vars };
  renderSlot('badge');
}

function setPresenceKey(key, vars) {
  i18nSlots.presence = { key, vars };
  renderSlot('presence');
}

function setInterimMessage(text, isLive = false) {
  i18nSlots.interim = null;
  els.interimText.textContent = text;
  els.interimText.classList.toggle('live', isLive);
}

// Speech Synthesis (TTS)
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  state.voices = window.speechSynthesis.getVoices();
}

function pickBestVoice(langCode) {
  if (!state.voices.length) loadVoices();
  const exact = state.voices.find((v) => v.lang.toLowerCase() === langCode.toLowerCase());
  if (exact) return exact;
  const prefix = langCode.split('-')[0].toLowerCase();
  return state.voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) || null;
}

function clearSpeechTimers() {
  if (state.speakWatchdog) {
    clearTimeout(state.speakWatchdog);
    state.speakWatchdog = null;
  }
  if (state.speakKeepAlive) {
    clearInterval(state.speakKeepAlive);
    state.speakKeepAlive = null;
  }
}

function stopSpeaking() {
  clearSpeechTimers();
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

function speakText(text, langCode) {
  text = stripMaskForSpeech(censor(text, langCode));
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) {
      resolve();
      return;
    }

    stopSpeaking();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = langCode;
    utterance.rate = state.settings.speechRate;
    const voice = pickBestVoice(langCode);
    if (voice) utterance.voice = voice;

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearSpeechTimers();
      resolve();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    // Chrome bug workaround: keep speechSynthesis alive and add safety watchdog
    state.speakKeepAlive = setInterval(() => {
      if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }, 8000);

    const maxMs = Math.max(6000, text.length * 145);
    state.speakWatchdog = setTimeout(() => {
      window.speechSynthesis.cancel();
      finish();
    }, maxMs);

    window.speechSynthesis.speak(utterance);
  });
}

// Audio Visualizer (uses speech activity pulses so it never competes with SpeechRecognition for mic hardware)
function startAudioVisualizer() {
  if (state.rafId) return;
  drawVisualizer();
}

function stopAudioVisualizer() {
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  drawIdleOrb();
}

function drawIdleOrb() {
  const canvas = els.visualizerCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 80, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawVisualizer() {
  const canvas = els.visualizerCanvas;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  const render = (now) => {
    if (!state.isActive) {
      drawIdleOrb();
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sinceSpeech = now - (state.lastSpeechPulseAt || 0);
    const speechBoost = sinceSpeech < 450 ? (1 - sinceSpeech / 450) * 14 : 0;
    const breath = state.phase === 'listening' ? (Math.sin(now / 260) + 1) * 4 : 0;
    const radius = 78 + breath + speechBoost;
    const color =
      state.activeSpeaker === 'me' ? 'rgba(16, 185, 129, 0.55)' : 'rgba(129, 140, 248, 0.55)';

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
    ctx.strokeStyle = color.replace('0.55', '0.18');
    ctx.lineWidth = 1.5;
    ctx.stroke();

    state.rafId = requestAnimationFrame(render);
  };

  state.rafId = requestAnimationFrame(render);
}

// Speech Recognition (STT)
function abortRecognition() {
  state.recognitionGen += 1;
  if (state.resumeTimer) {
    clearTimeout(state.resumeTimer);
    state.resumeTimer = null;
  }
  if (state.recognition) {
    try {
      state.recognition.onresult = null;
      state.recognition.onerror = null;
      state.recognition.onend = null;
      state.recognition.abort();
    } catch {
      // Ignore abort errors
    }
    state.recognition = null;
  }
}

function startListening() {
  if (!SpeechRecognitionAPI) {
    showAlert(
      t('err.noSR')
    );
    stopLiveSession();
    return;
  }

  abortRecognition();
  if (!state.isActive) return;

  const gen = ++state.recognitionGen;
  const isMe = state.mode === 'online' ? true : state.activeSpeaker === 'me';
  if (state.mode === 'online') {
    state.activeSpeaker = 'me';
  }
  const listenLang = isMe ? state.myLang : state.partnerLang;
  const langInfo = findLanguage(listenLang);

  const recognition = new SpeechRecognitionAPI();
  recognition.lang = listenLang;
  // Online odada da cumle sonu/duraksama beklenir: konusma bitince TEK mesaj gider
  // (surekli modda kisa parcalar ayri ayri ve mobil Chrome'da tekrarli gidiyordu)
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  state.recognition = recognition;

  setPhase('listening');
  const listenName = displayLangName(listenLang, langInfo.name);
  const promptMsg = t(isMe ? 'listen.mine' : 'listen.partner', { lang: listenName });
  setInterimMessage(promptMsg, false);
  if (state.mode === 'face') {
    (isMe ? els.faceMeText : els.facePartnerText).textContent = t('listen.short', { lang: listenName });
  }

  let finalTranscript = '';
  state.pendingTranscript = '';

  recognition.onspeechstart = () => {
    state.lastSpeechPulseAt = performance.now();
  };

  recognition.onresult = (event) => {
    if (gen !== state.recognitionGen) return;
    state.lastSpeechPulseAt = performance.now();

    let interim = '';
    let newFinalChunk = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        newFinalChunk += res[0].transcript + ' ';
        finalTranscript += res[0].transcript + ' ';
      } else {
        interim += res[0].transcript;
      }
    }

    if (state.mode === 'online') {
      // Tum sonuclari bastan birlestir: mobil Chrome her sonucu oncekileri de
      // icerecek sekilde tekrar gonderebiliyor ("merhaba", "merhaba nasilsin"...)
      let finals = '';
      let interims = '';
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        const tx = String(res[0].transcript || '').trim();
        if (!tx) continue;
        if (res.isFinal) finals = mergeTranscript(finals, tx);
        else interims = mergeTranscript(interims, tx);
      }
      finalTranscript = finals;
      const full = mergeTranscript(finals, interims);
      state.pendingTranscript = full;
      if (full) setInterimMessage(censor(full, listenLang), true);
      return;
    }

    const display = censor((finalTranscript + interim).trim(), listenLang);
    state.pendingTranscript = display;
    if (display) {
      setInterimMessage(display, true);
      if (state.mode === 'face') {
        (isMe ? els.faceMeText : els.facePartnerText).textContent = display;
      }
    }
  };

  recognition.onerror = (event) => {
    if (gen !== state.recognitionGen) return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      showAlert(t(IS_NATIVE_APP ? 'err.micDeniedApp' : 'err.micDeniedWeb'));
      stopLiveSession();
      return;
    }
    if (event.error === 'audio-capture') {
      showAlert(t('err.micMissing'));
      stopLiveSession();
      return;
    }
    // 'no-speech' or 'aborted' are normal when silent; onend will handle restart
  };

  recognition.onend = async () => {
    if (gen !== state.recognitionGen) return;
    state.recognition = null;

    if (state.mode === 'online') {
      const trailing = state.pendingTranscript.trim();
      state.pendingTranscript = '';
      if (trailing) {
        await handleUtterance(trailing, 'me');
      } else if (state.group && state.queue.length && state.activeMicClientId === state.clientId && state.isActive) {
        // Grup: sirada bekleyen varken konusan sustu (tanima "ses yok" ile bitti)
        // -> soz hemen siradakine gecer (konusmanin ortasinda kesmez)
        stopLiveSession();
        return;
      }
      if (state.isActive && gen === state.recognitionGen) {
        state.resumeTimer = setTimeout(() => {
          if (state.isActive && gen === state.recognitionGen) {
            startListening();
          }
        }, 350);
      }
      return;
    }

    const cleanText = (finalTranscript || state.pendingTranscript).trim();
    state.pendingTranscript = '';
    if (cleanText) {
      await handleUtterance(cleanText, state.activeSpeaker);
      if (!state.isActive || gen !== state.recognitionGen) return;

      if (state.mode === 'face') {
        // In Face-to-Face mode, one tap = one utterance
        stopLiveSession();
        return;
      }

      if (state.settings.autoLoop) {
        state.activeSpeaker = state.activeSpeaker === 'me' ? 'partner' : 'me';
        updateTurnUI();
      }
    }

    if (state.isActive && gen === state.recognitionGen) {
      // Short acoustic tail delay to prevent TTS echo pickup
      state.resumeTimer = setTimeout(() => {
        if (state.isActive && gen === state.recognitionGen) {
          startListening();
        }
      }, 250);
    }
  };

  try {
    recognition.start();
  } catch {
    if (state.isActive) {
      state.resumeTimer = setTimeout(() => startListening(), 300);
    }
  }
}

/**
 * Iki konusma tanima parcasini tekrarsiz birlestirir.
 * "merhaba" + "merhaba nasilsin" -> "merhaba nasilsin";
 * "bugun hava" + "hava cok guzel" -> "bugun hava cok guzel"
 */
function mergeTranscript(a, b) {
  a = String(a || '').trim();
  b = String(b || '').trim();
  if (!a) return b;
  if (!b) return a;
  const la = a.toLocaleLowerCase();
  const lb = b.toLocaleLowerCase();
  if (lb.startsWith(la)) return b;
  if (la.endsWith(lb) || la.includes(lb)) return a;
  const aw = a.split(/\s+/);
  const bw = b.split(/\s+/);
  for (let k = Math.min(aw.length, bw.length); k > 0; k--) {
    const tail = aw.slice(-k).join(' ').toLocaleLowerCase();
    const head = bw.slice(0, k).join(' ').toLocaleLowerCase();
    if (tail === head) return [...aw, ...bw.slice(k)].join(' ');
  }
  return `${a} ${b}`;
}

async function handleUtterance(text, speaker) {
  // Kufurler karsiya hic gitmesin: cevirmeden once kaynak dilde filtrele
  text = censor(text, state.mode === 'online' || speaker === 'me' ? state.myLang : state.partnerLang);
  if (!text.replace(/[\s*.,!?]+/g, '')) return;
  if (state.mode === 'online') {
    if (!state.roomCode) {
      showAlert(t('err.needRoom'));
      return;
    }

    setPhase('translating');
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(state.roomCode)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: state.clientId,
          senderName: state.myName || t('who.me'),
          text,
          sourceLang: state.myLang,
          fallbackTargetLang: state.partnerLang,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const msg = await res.json();
      setInterimMessage(censor(msg.translatedText || text, msg.targetLang || state.partnerLang), true);
      // SSE chat_message will append to stream for both participants
    } catch (err) {
      showAlert(t('err.sendFailed', { err: err.message }));
    } finally {
      if (state.isActive) {
        setPhase('listening');
      } else {
        setPhase('idle');
      }
    }
    return;
  }

  const sourceLang = speaker === 'me' ? state.myLang : state.partnerLang;
  const targetLang = speaker === 'me' ? state.partnerLang : state.myLang;

  setPhase('translating');

  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sourceLang, targetLang }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const translatedText = censor(data.translatedText || '', targetLang);

    appendMessage({
      speaker,
      sourceLang,
      targetLang,
      originalText: text,
      translatedText,
      latencyMs: data.latencyMs,
    });

    if (state.mode === 'face') {
      // Show translation on the opposite person's card
      const targetEl = speaker === 'me' ? els.facePartnerText : els.faceMeText;
      targetEl.textContent = translatedText;
      els.faceMeText.dataset.untouched = 'false';
      els.facePartnerText.dataset.untouched = 'false';
    } else {
      setInterimMessage(translatedText, true);
    }

    if (state.settings.autoSpeak && translatedText) {
      setPhase('speaking');
      await speakText(translatedText, targetLang);
    }
  } catch (err) {
    showAlert(t('err.translate', { err: err.message }));
  } finally {
    if (!state.isActive) {
      setPhase('idle');
    }
  }
}

function appendMessage({
  id,
  speaker,
  senderName,
  sourceLang,
  targetLang,
  originalText,
  translatedText,
  latencyMs,
}) {
  if (id && state.seenMessageIds.has(id)) return;
  if (id) state.seenMessageIds.add(id);
  originalText = censor(originalText, sourceLang);
  translatedText = censor(translatedText, targetLang);

  els.emptyState.classList.add('hidden');

  const msg = {
    id: id || Date.now() + Math.random(),
    speaker,
    senderName: senderName || (speaker === 'me' ? t('who.meUpper') : t('who.partnerUpper')),
    sourceLang,
    targetLang,
    originalText,
    translatedText,
    time: new Date().toLocaleTimeString(getUiLang(), { hour: '2-digit', minute: '2-digit' }),
  };
  state.messages.push(msg);
  els.messageCount.textContent = t('stream.count', { n: state.messages.length });

  const card = document.createElement('article');
  card.className = `msg-card ${speaker}`;

  const srcShort = findLanguage(sourceLang).short;
  const tgtShort = findLanguage(targetLang).short;
  const whoLabel = msg.senderName.toUpperCase();

  card.innerHTML = `
    <div class="msg-top">
      <span class="msg-speaker"></span>
      <span class="msg-time"></span>
    </div>
    <div class="msg-original" dir="auto"></div>
    <div class="msg-translated" dir="auto"></div>
    <div class="msg-actions">
      <button class="mini-btn replay-btn" type="button"></button>
      <button class="mini-btn copy-btn" type="button"></button>
    </div>
  `;

  card.querySelector('.msg-original').textContent = originalText;
  card.querySelector('.msg-translated').textContent = translatedText;
  card.querySelector('.msg-speaker').textContent = targetLang && translatedText
    ? `${whoLabel} · ${srcShort} → ${tgtShort}`
    : `${whoLabel} · ${srcShort}`;
  card.querySelector('.msg-time').textContent = `${msg.time}${typeof latencyMs === 'number' ? ` · ${latencyMs}ms` : ''}`;
  if (!translatedText) card.querySelector('.msg-translated').classList.add('hidden');

  card.querySelector('.replay-btn').textContent = t('msg.replay');
  card.querySelector('.copy-btn').textContent = t('msg.copy');

  card.querySelector('.replay-btn').addEventListener('click', () => {
    speakText(translatedText, targetLang);
  });

  card.querySelector('.copy-btn').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(translatedText);
      const btn = e.currentTarget;
      btn.textContent = t('msg.copied');
      setTimeout(() => (btn.textContent = t('msg.copy')), 1400);
    } catch {
      // Ignore clipboard errors
    }
  });

  els.chatStream.appendChild(card);
  els.chatStream.scrollTop = els.chatStream.scrollHeight;
}

async function setRemoteMicLock(active) {
  if (state.mode !== 'online' || !state.roomCode) return true;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(state.roomCode)}/mic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: state.clientId, active }),
    });
    if (res.status === 409) {
      const errData = await res.json().catch(() => ({}));
      state.activeMicClientId = errData.activeMicClientId || 'remote';
      state.activeMicName = errData.activeMicName || null;
      updateTurnUI();
      showAlert(t('err.partnerSpeaking', { name: state.activeMicName || t('online.otherSide') }));
      return false;
    }
    if (res.ok) {
      const data = await res.json();
      state.activeMicClientId = data.activeMicClientId || null;
      if (!active) state.activeMicName = null;
      updateTurnUI();
    }
    return true;
  } catch {
    return true;
  }
}

async function startLiveSession(speaker = state.activeSpeaker) {
  hideAlert();
  if (state.mode === 'online') {
    if (!state.roomCode) {
      showAlert(t('err.needRoom'));
      return;
    }
    if (state.activeMicClientId && state.activeMicClientId !== state.clientId) {
      showAlert(t('err.partnerSpeaking', { name: state.activeMicName || t('online.otherSide') }));
      return;
    }
    const acquired = await setRemoteMicLock(true);
    if (!acquired) return;
  }

  stopSpeaking();
  state.activeSpeaker = speaker;
  state.isActive = true;
  updateTurnUI();
  startAudioVisualizer();
  startListening();

  startTurnClock();
}

// Grup odasinda bir konusma en fazla 45 saniye: sonra soz siradakine gecer
function startTurnClock() {
  clearTimeout(state.turnTimer);
  state.turnTimer = null;
  state.turnStartedAt = Date.now();
  if (state.mode === 'online' && state.group) {
    state.turnTimer = setTimeout(() => {
      if (state.isActive && state.mode === 'online' && state.group) stopLiveSession();
    }, GROUP_TURN_MS);
  }
}

function turnSecondsLeft(since) {
  if (!since) return Math.round(GROUP_TURN_MS / 1000);
  return Math.max(0, Math.ceil((GROUP_TURN_MS - (Date.now() - since)) / 1000));
}

// Grup odasinda soz iste / siradan cik
async function toggleHand() {
  if (!state.roomCode) return;
  const raise = !state.queue.includes(state.clientId);
  state.handRaised = raise;
  try {
    await fetch(`/api/rooms/${encodeURIComponent(state.roomCode)}/hand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: state.clientId, raise }),
    });
  } catch {
    // yoksay
  }
}

async function stopLiveSession() {
  clearTimeout(state.turnTimer);
  state.turnTimer = null;
  state.turnStartedAt = 0;
  const pending = state.pendingTranscript.trim();
  state.pendingTranscript = '';
  state.isActive = false;
  abortRecognition();
  stopSpeaking();
  stopAudioVisualizer();

  if (pending) {
    await handleUtterance(pending, state.activeSpeaker);
  }

  if (state.mode === 'online' && state.roomCode) {
    await setRemoteMicLock(false);
  }

  setPhase('idle');
  updateTurnUI();
  setInterimKey('hint.stopped');
}

function switchTurn(newSpeaker) {
  state.activeSpeaker = newSpeaker;
  updateTurnUI();
  if (state.isActive) {
    stopSpeaking();
    startListening();
  }
}

function setMode(mode) {
  if (state.isActive) stopLiveSession();
  state.mode = mode;

  els.modeCameraBtn.classList.toggle('active', mode === 'camera');
  els.modeCameraBtn.setAttribute('aria-selected', String(mode === 'camera'));
  els.modeLoopBtn.classList.toggle('active', mode === 'loop');
  els.modeLoopBtn.setAttribute('aria-selected', String(mode === 'loop'));
  els.modeFaceBtn.classList.toggle('active', mode === 'face');
  els.modeFaceBtn.setAttribute('aria-selected', String(mode === 'face'));
  els.modeOnlineBtn.classList.toggle('active', mode === 'online');
  els.modeOnlineBtn.setAttribute('aria-selected', String(mode === 'online'));

  els.loopStage.classList.toggle('hidden', mode === 'face' || mode === 'camera');
  els.cameraStage.classList.toggle('hidden', mode !== 'camera');
  els.faceStage.classList.toggle('hidden', mode !== 'face');
  els.onlineBar.classList.toggle('hidden', mode !== 'online');
  els.turnControls.classList.toggle('hidden', mode === 'online');
  els.textSpeakerSelect.classList.toggle('hidden', mode === 'online');
  updateAttachVisibility();
  els.partnerLangSelect.disabled = mode === 'online' && Boolean(state.partnerName);
  els.swapLangsBtn.classList.toggle('hidden', mode === 'online');
  els.clearBtn.disabled = mode === 'online';

  if (mode === 'online') {
    if (!els.onlineNameInput.value && state.myName) {
      els.onlineNameInput.value = state.myName;
    }
    pollOnlineInfo();
  }

  updateLanguageBadges();
}

function getShareBaseUrl() {
  if (state.onlineInfo.publicUrl) return state.onlineInfo.publicUrl;
  return window.location.origin;
}

function updateInviteLink() {
  if (!state.roomCode) return;
  const inviteUrl = `${getShareBaseUrl()}/?room=${encodeURIComponent(state.roomCode)}`;
  els.inviteLinkInput.value = inviteUrl;
}

async function pollOnlineInfo() {
  if (state.onlinePollTimer) {
    clearTimeout(state.onlinePollTimer);
    state.onlinePollTimer = null;
  }

  try {
    const res = await fetch('/api/online-info');
    if (res.ok) {
      const info = await res.json();
      state.onlineInfo = info;

      if (info.onlineMode) {
        if (info.status === 'ready' && info.publicUrl) {
          setBadgeKey('online.ready');
          updateInviteLink();
          return;
        }
        if (info.status === 'error') {
          if (window.CeviriRelay) setBadgeKey('online.unreachable');
          else els.tunnelStatusBadge.textContent = info.error || 'Tünel hatası';
          updateInviteLink();
          if (window.CeviriRelay) state.onlinePollTimer = setTimeout(pollOnlineInfo, 4000);
          return;
        }
        setBadgeKey('online.connecting');
        state.onlinePollTimer = setTimeout(pollOnlineInfo, 2000);
      } else {
        els.tunnelStatusBadge.textContent = window.location.protocol === 'https:'
          ? t('online.connected')
          : 'Yerel Ağ (Farklı PC için CEVIRI-Baslat-online.bat kullanın)';
        updateInviteLink();
      }
    }
  } catch {
    // Ignore transient poll errors
  }
}

function connectToRoom(roomCode) {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  state.roomCode = roomCode;
  els.roomCodeBadge.textContent = roomCode;
  // Kamera baglantilari: ayni odada dil degisince (yeniden baglanma) korunur
  if (state.videoMesh && state.videoMesh.roomCode !== roomCode) {
    state.videoMesh.destroy();
    state.videoMesh = null;
  }
  if (!state.videoMesh && window.CeviriRelay && window.RTCPeerConnection) {
    state.videoMesh = createVideoMesh({
      selfId: state.clientId,
      roomCode,
      sendSignal: (to, data) => window.CeviriRelay.sendSignal(roomCode, to, data),
      onRemoteStream: (id, stream) => {
        remoteStreams.set(id, stream);
        renderParticipants();
      },
      onPeerState: (id, connState) => {
        peerStates.set(id, connState);
        renderParticipants();
      },
    });
  }
  els.onlineJoinView.classList.add('hidden');
  els.onlineActiveView.classList.remove('hidden');
  updateInviteLink();

  updateAttachVisibility();

  const params = new URLSearchParams({
    clientId: state.clientId,
    name: state.myName || t('who.me'),
    lang: state.myLang,
  });

  const es = new EventSource(`/api/rooms/${encodeURIComponent(roomCode)}/events?${params.toString()}`);
  state.eventSource = es;

  es.addEventListener('room_state', (event) => {
    const data = JSON.parse(event.data);
    const others = (data.participants || []).filter((p) => p.clientId !== state.clientId);
    const partner = others[0];

    const newHolder = data.activeMicClientId || null;
    if (newHolder !== state.activeMicClientId) state.holderSince = newHolder ? Date.now() : 0;
    state.activeMicClientId = newHolder;
    state.activeMicName = data.activeMicName || null;
    state.group = Boolean(data.group);
    state.ownerId = data.ownerId || null;
    state.roomLocked = Boolean(data.locked);
    state.queue = Array.isArray(data.queue) ? data.queue : [];
    state.participants = data.participants || [];

    if (data.full) {
      showAlert(t('room.full', { n: data.maxParticipants || 6 }));
      leaveOnlineRoom();
      return;
    }
    if (data.lockedOut) {
      showAlert(t('room.lockedOut'));
      leaveOnlineRoom();
      return;
    }
    // Oda 2 kisiden gruba gecerken mikrofonu tutan kisiye de 45 sn siniri baslar
    // (yoksa 2 kisilik aliskanlikla acik birakilan mikrofon sozu hic birakmiyordu)
    if (state.group && state.isActive && state.activeMicClientId === state.clientId && !state.turnTimer) {
      startTurnClock();
    }

    renderParticipants();
    if (state.videoMesh) state.videoMesh.syncPeers(state.participants.map((p) => p.clientId));

    if (state.group) {
      // 3+ kisi: herkes kendi dilinde okur; tek "karsidaki" yok
      state.partnerName = '';
      els.partnerLangSelect.disabled = true;
      setPresenceKey('group.people', { n: state.participants.length });
      updateLanguageBadges();
      updateTurnUI();
      const pos = state.queue.indexOf(state.clientId);
      if (state.activeMicClientId === state.clientId && !state.isActive && state.handRaised) {
        // Sira geldi: mikrofon otomatik acilir
        state.handRaised = false;
        if (navigator.vibrate) navigator.vibrate(200);
        setInterimKey('group.yourTurnNow');
        startLiveSession('me');
      } else if (!state.isActive) {
        if (state.activeMicClientId && state.activeMicClientId !== state.clientId) {
          if (pos >= 0) setInterimKey('group.inQueue', { n: pos + 1 });
          else setInterimKey('group.speakingRaise', { name: state.activeMicName || t('online.otherSide') });
        } else if (state.phase === 'idle') {
          setInterimKey('online.yourTurn');
        }
      }
      return;
    }
    state.handRaised = false;

    if (partner) {
      state.partnerName = partner.name;
      state.partnerLang = partner.lang;
      els.partnerLangSelect.value = partner.lang;
      els.partnerLangSelect.disabled = true;
      const partnerLangInfo = findLanguage(partner.lang);
      setPresenceKey('online.partnerConnected', { name: partner.name, lang: partner.lang, langFallback: partnerLangInfo.name });
    } else {
      state.partnerName = '';
      els.partnerLangSelect.disabled = false;
      setPresenceKey('online.waiting');
    }

    updateLanguageBadges();
    updateTurnUI();

    if (!state.isActive) {
      if (state.activeMicClientId && state.activeMicClientId !== state.clientId) {
        setInterimKey('online.partnerSpeaking', { name: state.activeMicName || t('online.otherSide') });
      } else if (partner && state.phase === 'idle') {
        setInterimKey('online.yourTurn');
      }
    }
  });

  es.addEventListener('history', (event) => {
    const data = JSON.parse(event.data);
    state.incomingChain = state.incomingChain
      .then(async () => {
        for (const raw of data.messages || []) {
          const speaker = raw.senderId === state.clientId ? 'me' : 'partner';
          const msg = speaker === 'partner' ? await ensureMyLanguage(raw) : raw;
          appendMessage({ ...msg, speaker });
        }
      })
      .catch(() => {});
  });

  es.addEventListener('file_message', (event) => onFileMessage(JSON.parse(event.data), roomCode));
  es.addEventListener('file_progress', (event) => onFileProgress(JSON.parse(event.data)));
  es.addEventListener('file_ready', (event) => onFileReady(JSON.parse(event.data)));
  es.addEventListener('file_failed', (event) => onFileFailed(JSON.parse(event.data)));

  es.addEventListener('chat_message', (event) => {
    const raw = JSON.parse(event.data);
    // Mesajlar geldikleri sirayla islenir (ceviri + seslendirme ust uste binmesin)
    state.incomingChain = state.incomingChain.then(() => handleIncomingChat(raw)).catch(() => {});
  });

  es.addEventListener('kicked', () => {
    showAlert(t('owner.kicked'));
    leaveOnlineRoom();
  });

  es.addEventListener('rtc_signal', (event) => {
    const { from, data } = JSON.parse(event.data);
    if (state.videoMesh) state.videoMesh.handleSignal(from, data);
  });

  async function handleIncomingChat(raw) {
    const speaker = raw.senderId === state.clientId ? 'me' : 'partner';
    const msg = speaker === 'partner' ? await ensureMyLanguage(raw) : raw;
    appendMessage({ ...msg, speaker });

    // Speak incoming partner message on this PC without mic echo
    if (speaker === 'partner' && state.settings.autoSpeak && msg.translatedText) {
      const wasActive = state.isActive;
      if (wasActive) abortRecognition();
      setPhase('speaking');
      setInterimMessage(`${msg.senderName}: ${censor(msg.translatedText, state.myLang)}`, true);
      await speakText(msg.translatedText, state.myLang);
      if (wasActive && state.isActive) {
        state.resumeTimer = setTimeout(() => {
          if (state.isActive) startListening();
        }, 250);
      } else if (!state.isActive) {
        setPhase('idle');
      }
    }
  }

  es.onerror = () => {
    setPresenceKey('online.reconnecting');
  };
}

async function createOnlineRoom() {
  const name = els.onlineNameInput.value.trim();
  if (!name) {
    showAlert(t('err.needName'));
    els.onlineNameInput.focus();
    return;
  }
  hideAlert();
  state.myName = name;
  localStorage.setItem(STORAGE_KEYS.myName, name);

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    connectToRoom(data.roomCode);
    updateLanguageBadges();
  } catch (err) {
    showAlert(t('err.roomCreate', { err: err.message }));
  }
}

function joinOnlineRoom() {
  const name = els.onlineNameInput.value.trim();
  const code = els.onlineRoomInput.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!name) {
    showAlert(t('err.needName'));
    els.onlineNameInput.focus();
    return;
  }
  if (!code || code.length < 4) {
    showAlert(t('err.badRoom'));
    els.onlineRoomInput.focus();
    return;
  }
  hideAlert();
  state.myName = name;
  localStorage.setItem(STORAGE_KEYS.myName, name);
  connectToRoom(code);
  updateLanguageBadges();
}

// ---------------------------------------------------------------------------
// Online odada fotograf / PDF paylasimi
// ---------------------------------------------------------------------------
const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const FILE_MAX_MB = 10;
const IMAGE_SHRINK_OVER = 2 * 1024 * 1024; // 2 MB ustu fotograflar kucultulur
const IMAGE_MAX_SIDE = 2560;
const fileCards = new Map(); // dosya id -> { meta, roomCode, el, state, p, thumbDone }

function updateAttachVisibility() {
  if (!els.attachBtn) return;
  els.attachBtn.classList.toggle('hidden', !(state.mode === 'online' && state.roomCode && window.CeviriRelay));
}

function fileTypeOf(file) {
  const type = String(file.type || '').toLowerCase();
  if (FILE_TYPES.includes(type)) return type;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[ext] || '';
}

function formatSize(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function prepareFile(file, type) {
  if (type.startsWith('image/') && file.size > IMAGE_SHRINK_OVER) {
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = url;
      });
      const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (blob && blob.size < file.size) {
        const base = String(file.name || 'foto').replace(/\.[^.]+$/, '');
        return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', name: `${base}.jpg` };
      }
    } catch {
      // kucultme olmazsa asli gonderilir
    }
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()), type, name: file.name || (type === 'application/pdf' ? 'belge.pdf' : 'foto.jpg') };
}

async function handleAttach(file) {
  if (!file) return;
  if (state.mode !== 'online' || !state.roomCode || !window.CeviriRelay) {
    showAlert(t('err.needRoom'));
    return;
  }
  const type = fileTypeOf(file);
  if (!type) {
    showAlert(t('file.badType'));
    return;
  }
  els.attachBtn.classList.add('busy');
  try {
    const prepared = await prepareFile(file, type);
    if (prepared.bytes.length > FILE_MAX_MB * 1024 * 1024) {
      showAlert(t('file.tooBig', { mb: FILE_MAX_MB }));
      return;
    }
    await window.CeviriRelay.sendFile(state.roomCode, prepared.name, prepared.type, prepared.bytes);
  } catch (err) {
    showAlert(t('file.sendFailed', { err: (err && err.message) || String(err) }));
  } finally {
    els.attachBtn.classList.remove('busy');
  }
}

function renderFileCard(entry) {
  const stateEl = entry.el.querySelector('.file-state');
  const labels = {
    sending: t('file.sending', { p: entry.p || 0 }),
    receiving: t('file.receiving', { p: entry.p || 0 }),
    ready: t('file.tapToSave'),
    available: t('file.tapToDownload'),
    failed: t('file.unavailable'),
  };
  stateEl.textContent = labels[entry.state] || '';
  entry.el.classList.toggle('failed', entry.state === 'failed');
}

async function loadFileThumb(entry) {
  if (entry.thumbDone || !entry.meta.type.startsWith('image/')) return;
  entry.thumbDone = true;
  try {
    const blob = await window.CeviriRelay.getFile(entry.roomCode, entry.meta.id);
    const img = document.createElement('img');
    img.className = 'file-thumb';
    img.alt = '';
    img.src = URL.createObjectURL(blob);
    entry.el.querySelector('.file-thumb').replaceWith(img);
  } catch {
    entry.thumbDone = false;
  }
}

function onFileMessage(meta, roomCode) {
  const existing = fileCards.get(meta.id);
  if (existing) {
    if (meta.state === 'ready' && existing.state !== 'ready') onFileReady({ id: meta.id });
    return;
  }
  const speaker = meta.senderId === state.clientId ? 'me' : 'partner';
  const name = censor(meta.name, speaker === 'me' ? state.myLang : state.partnerLang);
  const time = new Date(meta.timestamp || Date.now()).toLocaleTimeString(getUiLang(), { hour: '2-digit', minute: '2-digit' });
  const who = censor(meta.senderName || '', state.myLang) || (speaker === 'me' ? t('who.meUpper') : t('who.partnerUpper'));

  els.emptyState.classList.add('hidden');
  const card = document.createElement('article');
  card.className = `msg-card file-card ${speaker}`;
  card.dataset.fileId = meta.id;
  card.innerHTML = `
    <div class="msg-top">
      <span class="msg-speaker"></span>
      <span class="msg-time"></span>
    </div>
    <button class="file-body" type="button">
      <span class="file-thumb" aria-hidden="true"></span>
      <span class="file-info">
        <span class="file-name" dir="auto"></span>
        <span class="file-meta"></span>
        <span class="file-state"></span>
      </span>
    </button>
  `;
  card.querySelector('.msg-speaker').textContent = `📎 ${who.toLocaleUpperCase()}`;
  card.querySelector('.msg-time').textContent = time;
  card.querySelector('.file-thumb').textContent = meta.type === 'application/pdf' ? '📄' : '🖼️';
  card.querySelector('.file-name').textContent = name;
  card.querySelector('.file-meta').textContent = `${meta.type === 'application/pdf' ? 'PDF' : meta.type.split('/')[1].toUpperCase()} · ${formatSize(meta.size)}`;

  const entry = { meta: { ...meta, name }, roomCode, el: card, state: meta.state || 'available', p: 0, thumbDone: false };
  fileCards.set(meta.id, entry);
  card.querySelector('.file-body').addEventListener('click', () => saveRoomFile(entry));
  renderFileCard(entry);

  state.messages.push({
    id: meta.id,
    speaker,
    senderName: who,
    sourceLang: state.myLang,
    targetLang: state.myLang,
    originalText: `📎 ${name}`,
    translatedText: '',
    time,
  });
  els.messageCount.textContent = t('stream.count', { n: state.messages.length });
  els.chatStream.appendChild(card);
  els.chatStream.scrollTop = els.chatStream.scrollHeight;
  if (entry.state === 'ready') loadFileThumb(entry);
}

function onFileProgress({ id, received, total, sending }) {
  const entry = fileCards.get(id);
  if (!entry || entry.state === 'ready') return;
  entry.state = sending ? 'sending' : 'receiving';
  entry.p = total ? Math.round((received / total) * 100) : 0;
  renderFileCard(entry);
}

function onFileReady({ id }) {
  const entry = fileCards.get(id);
  if (!entry) return;
  entry.state = 'ready';
  renderFileCard(entry);
  loadFileThumb(entry);
}

function onFileFailed({ id }) {
  const entry = fileCards.get(id);
  if (!entry || entry.state === 'ready') return;
  entry.state = 'failed';
  renderFileCard(entry);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('read'));
    reader.readAsDataURL(blob);
  });
}

async function saveBlob(blob, name, type) {
  if (IS_NATIVE_APP) {
    // Uygulama: Belgeler/CEVIRI klasorune kaydet ve ac
    const reg = (window.capacitorExports && window.capacitorExports.registerPlugin) || window.Capacitor.registerPlugin;
    const Filesystem = reg('Filesystem');
    const FileOpener = reg('FileOpener');
    const data = await blobToBase64(blob);
    const path = `CEVIRI/${name}`;
    let uri;
    try {
      uri = (await Filesystem.writeFile({ path, data, directory: 'DOCUMENTS', recursive: true })).uri;
      showAlert(t('file.saved', { path: `Documents/${path}` }));
    } catch {
      // Eski Android / izin yok: gecici klasore yaz, yine de ac
      uri = (await Filesystem.writeFile({ path, data, directory: 'CACHE', recursive: true })).uri;
    }
    try {
      await FileOpener.open({ filePath: uri, contentType: type, openWithDefault: true });
    } catch {
      // Acacak uygulama yoksa dosya yine de kaydedildi
    }
    return;
  }
  // Tarayici: dosyayi indir
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function saveRoomFile(entry) {
  if (entry.saving || !window.CeviriRelay) return;
  entry.saving = true;
  try {
    if (entry.state !== 'ready' && entry.state !== 'sending') {
      entry.state = 'receiving';
      renderFileCard(entry);
    }
    const blob = await window.CeviriRelay.getFile(entry.roomCode, entry.meta.id);
    entry.state = 'ready';
    renderFileCard(entry);
    loadFileThumb(entry);
    await saveBlob(blob, entry.meta.name, entry.meta.type);
  } catch (err) {
    if (err && err.message === 'unavailable') {
      entry.state = 'failed';
      renderFileCard(entry);
      showAlert(t('file.unavailable'));
    } else {
      showAlert(t('file.saveFailed', { err: (err && err.message) || String(err) }));
    }
  } finally {
    entry.saving = false;
  }
}

// ---------------------------------------------------------------------------
// Online oda: alicinin kendi diline ceviri, katilimci kutulari, kamera
// ---------------------------------------------------------------------------
const GROUP_TURN_MS = 45000;
const remoteStreams = new Map(); // katilimci id -> MediaStream
const peerStates = new Map(); // katilimci id -> WebRTC baglanti durumu
const tiles = new Map(); // katilimci id -> kutu elemani

function baseLang(code) {
  return String(code || '').toLowerCase().split('-')[0];
}

/** Gelen mesaj benim dilimde degilse (grup odasi) kendi cihazimda cevir. */
async function ensureMyLanguage(msg) {
  if (msg.translatedText && msg.targetLang && baseLang(msg.targetLang) === baseLang(state.myLang)) return msg;
  if (baseLang(msg.sourceLang) === baseLang(state.myLang)) {
    return { ...msg, translatedText: msg.originalText, targetLang: state.myLang };
  }
  try {
    const translated = await translateViaApi(msg.originalText, msg.sourceLang, state.myLang);
    return { ...msg, translatedText: censor(translated, state.myLang), targetLang: state.myLang };
  } catch {
    return { ...msg, translatedText: '', targetLang: '' };
  }
}

function renderRoomTools() {
  const tools = els.roomTools;
  if (!tools) return;
  const inRoom = Boolean(state.roomCode && state.participants.length);
  tools.classList.toggle('hidden', !inRoom);
  const amOwner = inRoom && state.ownerId === state.clientId;
  els.lockRoomBtn.classList.toggle('hidden', !amOwner);
  els.lockRoomBtn.textContent = state.roomLocked ? t('owner.unlock') : t('owner.lock');
  els.lockedBadge.classList.toggle('hidden', !(inRoom && state.roomLocked && !amOwner));
  els.lockedBadge.textContent = t('room.lockedInfo');
  const receiving = !state.videoMesh || state.videoMesh.receiveVideo;
  els.videoReceiveBtn.textContent = receiving ? t('video.receiveOff') : t('video.receiveOn');
  els.videoReceiveBtn.classList.toggle('active', !receiving);
  els.videoReceiveBtn.disabled = !state.videoMesh;
}

function kickParticipant(clientId) {
  if (state.ownerId !== state.clientId || !window.CeviriRelay) return;
  const p = state.participants.find((x) => x.clientId === clientId);
  const name = censor((p && p.name) || '', state.myLang) || '?';
  if (!window.confirm(t('owner.kickConfirm', { name }))) return;
  window.CeviriRelay.kick(state.roomCode, clientId);
}

function renderParticipants() {
  renderRoomTools();
  // Grup odasinda tek bir "karsidakinin dili" yok: o kutu gizlenir
  const partnerCard = els.partnerLangSelect.closest('.lang-card');
  if (partnerCard) partnerCard.classList.toggle('hidden', Boolean(state.roomCode && state.group));
  const grid = els.participantsGrid;
  if (!grid) return;
  const list = state.roomCode ? state.participants : [];
  grid.classList.toggle('hidden', list.length === 0);
  const ids = new Set(list.map((p) => p.clientId));
  for (const [id, tile] of tiles) {
    if (!ids.has(id)) {
      tile.remove();
      tiles.delete(id);
      remoteStreams.delete(id);
      peerStates.delete(id);
    }
  }
  list.forEach((p, index) => {
    const isMe = p.clientId === state.clientId;
    let tile = tiles.get(p.clientId);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'p-tile';
      tile.innerHTML = `
        <video class="p-video hidden" autoplay playsinline muted></video>
        <div class="p-avatar" aria-hidden="true"></div>
        <div class="p-badges"><span class="p-owner hidden">👑</span><span class="p-speaking hidden">🎙️</span><span class="p-hand hidden"></span></div>
        <div class="p-footer">
          <span class="p-name" dir="auto"></span>
          <span class="p-lang"></span>
        </div>
        <div class="p-note hidden"></div>
      `;
      if (isMe) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'p-cam-btn';
        btn.addEventListener('click', toggleMyCamera);
        tile.appendChild(btn);
      } else {
        // Oda sahibi icin: bu kisiyi odadan cikar
        const kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'p-kick-btn hidden';
        kick.textContent = '✕';
        kick.addEventListener('click', () => kickParticipant(p.clientId));
        tile.appendChild(kick);
      }
      tiles.set(p.clientId, tile);
    }
    if (grid.children[index] !== tile) grid.insertBefore(tile, grid.children[index] || null);

    const name = censor(p.name || '', state.myLang) || '?';
    tile.classList.toggle('me', isMe);
    tile.querySelector('.p-name').textContent = isMe ? `${name} (${t('tile.you')})` : name;
    tile.querySelector('.p-lang').textContent = findLanguage(p.lang).short;
    tile.querySelector('.p-avatar').textContent = name.trim().charAt(0).toLocaleUpperCase();
    const speaking = state.activeMicClientId === p.clientId;
    tile.classList.toggle('speaking', speaking);
    const spk = tile.querySelector('.p-speaking');
    spk.classList.toggle('hidden', !speaking);
    // Grup odasinda konusanin kalan suresi herkese gorunur
    spk.textContent = speaking && state.group
      ? `🎙️ ${turnSecondsLeft(isMe && state.turnStartedAt ? state.turnStartedAt : state.holderSince)}`
      : '🎙️';
    const isOwnerTile = state.ownerId === p.clientId;
    const own = tile.querySelector('.p-owner');
    own.classList.toggle('hidden', !isOwnerTile);
    own.title = t('owner.badge');
    const kickBtn = tile.querySelector('.p-kick-btn');
    if (kickBtn) {
      kickBtn.classList.toggle('hidden', state.ownerId !== state.clientId);
      kickBtn.title = t('owner.kick');
      kickBtn.setAttribute('aria-label', `${t('owner.kick')}: ${p.name || ''}`);
    }
    const qpos = state.group ? state.queue.indexOf(p.clientId) : -1;
    const hand = tile.querySelector('.p-hand');
    hand.classList.toggle('hidden', qpos < 0);
    hand.textContent = qpos >= 0 ? `✋ ${qpos + 1}` : '';

    // Goruntu: benim kameram yerel akistan, digerleri baglantidan
    const video = tile.querySelector('.p-video');
    const stream = isMe ? (state.videoMesh && state.videoMesh.localStream) : remoteStreams.get(p.clientId);
    const camOn = isMe ? Boolean(state.videoMesh && state.videoMesh.cameraOn) : Boolean(p.cam);
    // "Goruntuleri alma" acikken baskalarinin goruntusu gelmez (veri tasarrufu)
    const receiving = isMe || !state.videoMesh || state.videoMesh.receiveVideo;
    const show = Boolean(camOn && stream && receiving);
    if (show && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
    if (!show && video.srcObject) video.srcObject = null;
    video.classList.toggle('hidden', !show);
    video.classList.toggle('mirror', isMe);
    tile.querySelector('.p-avatar').classList.toggle('hidden', show);

    // Kamerasi acik: goruntu gelene kadar "Baglaniyor...", kurulamazsa uyari
    const connState = peerStates.get(p.clientId);
    const failed = !isMe && camOn && connState === 'failed';
    const connecting = !isMe && camOn && !show && !failed && receiving;
    const note = tile.querySelector('.p-note');
    note.classList.toggle('hidden', !failed && !connecting);
    note.textContent = failed ? t('video.noConn') : connecting ? t('online.connecting') : '';

    if (isMe) {
      const btn = tile.querySelector('.p-cam-btn');
      const on = Boolean(state.videoMesh && state.videoMesh.cameraOn);
      btn.textContent = on ? '📷 ✕' : '📷';
      btn.classList.toggle('on', on);
      btn.title = on ? t('video.off') : t('video.on');
      btn.setAttribute('aria-label', btn.title);
      btn.disabled = !state.videoMesh;
    }
  });
}

async function toggleMyCamera() {
  const mesh = state.videoMesh;
  if (!mesh || !state.roomCode) return;
  if (mesh.cameraOn) {
    mesh.stopCamera();
    window.CeviriRelay.setCam(state.roomCode, false);
  } else {
    try {
      await mesh.startCamera();
      window.CeviriRelay.setCam(state.roomCode, true);
    } catch {
      showAlert(t('video.denied'));
    }
  }
  renderParticipants();
}

function leaveOnlineRoom() {
  if (state.isActive) stopLiveSession();
  if (state.videoMesh) {
    state.videoMesh.destroy();
    state.videoMesh = null;
  }
  state.group = false;
  state.queue = [];
  state.participants = [];
  state.handRaised = false;
  state.ownerId = null;
  state.roomLocked = false;
  state.holderSince = 0;
  renderParticipants();
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.roomCode = '';
  state.partnerName = '';
  state.activeMicClientId = null;
  state.activeMicName = null;
  els.partnerLangSelect.disabled = false;
  els.onlineActiveView.classList.add('hidden');
  els.onlineJoinView.classList.remove('hidden');
  updateAttachVisibility();
  updateLanguageBadges();
  updateTurnUI();
}

function exportTranscript() {
  if (!state.messages.length) return;
  const lines = state.messages.map(
    (m) =>
      `[${m.time}] ${m.senderName || (m.speaker === 'me' ? t('who.meUpper') : t('who.partnerUpper'))} (${findLanguage(m.sourceLang).short} -> ${findLanguage(m.targetLang).short})\n${t('export.original')}: ${m.originalText}\n${t('export.translation')}: ${m.translatedText}\n`
  );
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ceviri-sohbet-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// Event Listeners
function bindEvents() {
  els.myLangSelect.addEventListener('change', (e) => {
    state.myLang = e.target.value;
    localStorage.setItem(STORAGE_KEYS.myLang, state.myLang);
    updateLanguageBadges();
    if (state.mode === 'online' && state.roomCode) {
      connectToRoom(state.roomCode);
    }
    if (state.isActive && state.activeSpeaker === 'me') startListening();
  });

  els.partnerLangSelect.addEventListener('change', (e) => {
    state.partnerLang = e.target.value;
    localStorage.setItem(STORAGE_KEYS.partnerLang, state.partnerLang);
    updateLanguageBadges();
    if (state.isActive && state.activeSpeaker === 'partner') startListening();
  });

  els.swapLangsBtn.addEventListener('click', () => {
    const prevMy = state.myLang;
    state.myLang = state.partnerLang;
    state.partnerLang = prevMy;
    localStorage.setItem(STORAGE_KEYS.myLang, state.myLang);
    localStorage.setItem(STORAGE_KEYS.partnerLang, state.partnerLang);
    els.myLangSelect.value = state.myLang;
    els.partnerLangSelect.value = state.partnerLang;
    updateLanguageBadges();
    if (state.isActive) startListening();
  });

  els.modeCameraBtn.addEventListener('click', () => setMode('camera'));
  els.modeLoopBtn.addEventListener('click', () => setMode('loop'));
  els.modeFaceBtn.addEventListener('click', () => setMode('face'));
  els.modeOnlineBtn.addEventListener('click', () => setMode('online'));

  els.createRoomBtn.addEventListener('click', createOnlineRoom);
  els.joinRoomBtn.addEventListener('click', joinOnlineRoom);
  els.leaveRoomBtn.addEventListener('click', leaveOnlineRoom);
  els.copyInviteBtn.addEventListener('click', async () => {
    if (!els.inviteLinkInput.value) return;
    try {
      await navigator.clipboard.writeText(els.inviteLinkInput.value);
      els.copyInviteBtn.textContent = t('msg.copied');
      setTimeout(() => (els.copyInviteBtn.textContent = t('online.copyInvite')), 1600);
    } catch {
      els.inviteLinkInput.select();
    }
  });

  els.mainToggleBtn.addEventListener('click', () => {
    if (
      !state.isActive &&
      state.mode === 'online' &&
      state.group &&
      state.activeMicClientId &&
      state.activeMicClientId !== state.clientId
    ) {
      toggleHand();
      return;
    }
    if (state.isActive) {
      stopLiveSession();
    } else {
      startLiveSession(state.activeSpeaker);
    }
  });

  els.turnMeBtn.addEventListener('click', () => switchTurn('me'));
  els.turnPartnerBtn.addEventListener('click', () => switchTurn('partner'));
  els.swapTurnBtn.addEventListener('click', () => {
    switchTurn(state.activeSpeaker === 'me' ? 'partner' : 'me');
  });

  els.faceMeBtn.addEventListener('click', () => {
    if (state.isActive && state.activeSpeaker === 'me') {
      stopLiveSession();
    } else {
      startLiveSession('me');
    }
  });

  els.facePartnerBtn.addEventListener('click', () => {
    if (state.isActive && state.activeSpeaker === 'partner') {
      stopLiveSession();
    } else {
      startLiveSession('partner');
    }
  });

  els.lockRoomBtn.addEventListener('click', () => {
    if (state.roomCode && window.CeviriRelay) window.CeviriRelay.setLocked(state.roomCode, !state.roomLocked);
  });
  els.videoReceiveBtn.addEventListener('click', () => {
    if (!state.videoMesh) return;
    state.videoMesh.setReceiveVideo(!state.videoMesh.receiveVideo);
    renderParticipants();
  });
  // Grup odasinda konusma geri sayimi her saniye yenilenir
  setInterval(() => {
    if (state.mode === 'online' && state.roomCode && state.group && state.activeMicClientId) {
      renderParticipants();
      updateTurnUI();
    }
  }, 1000);

  els.attachInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    handleAttach(file);
  });

  els.textTranslateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.textInput.value.trim();
    if (!text) return;
    const speaker = els.textSpeakerSelect.value;
    els.textInput.value = '';
    const wasActive = state.isActive;
    if (wasActive) abortRecognition();
    await handleUtterance(text, speaker);
    if (wasActive) startListening();
  });

  els.clearBtn.addEventListener('click', () => {
    if (state.mode === 'online') return;
    state.messages = [];
    els.chatStream.querySelectorAll('.msg-card').forEach((n) => n.remove());
    els.emptyState.classList.remove('hidden');
    els.messageCount.textContent = t('stream.count', { n: 0 });
  });

  els.exportBtn.addEventListener('click', exportTranscript);
  els.alertCloseBtn.addEventListener('click', hideAlert);

  // Settings modal
  els.settingsBtn.addEventListener('click', () => {
    els.settingsModal.classList.remove('hidden');
  });

  els.closeSettingsBtn.addEventListener('click', () => {
    els.settingsModal.classList.add('hidden');
  });

  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) {
      els.settingsModal.classList.add('hidden');
    }
  });

  els.autoSpeakToggle.checked = state.settings.autoSpeak;
  els.autoLoopToggle.checked = state.settings.autoLoop;
  els.flipPartnerToggle.checked = state.settings.flipPartner;
  els.speechRateRange.value = String(state.settings.speechRate);
  els.rateValueLabel.textContent = `${state.settings.speechRate.toFixed(2).replace(/\.00$/, '.0')}x`;
  els.facePartnerCard.classList.toggle('flipped', state.settings.flipPartner);

  els.autoSpeakToggle.addEventListener('change', (e) => {
    state.settings.autoSpeak = e.target.checked;
    saveSettings();
  });

  els.autoLoopToggle.addEventListener('change', (e) => {
    state.settings.autoLoop = e.target.checked;
    saveSettings();
  });

  els.flipPartnerToggle.addEventListener('change', (e) => {
    state.settings.flipPartner = e.target.checked;
    els.facePartnerCard.classList.toggle('flipped', state.settings.flipPartner);
    saveSettings();
  });

  els.speechRateRange.addEventListener('input', (e) => {
    state.settings.speechRate = parseFloat(e.target.value);
    els.rateValueLabel.textContent = `${state.settings.speechRate.toFixed(2).replace(/\.00$/, '.0')}x`;
    saveSettings();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!els.settingsModal.classList.contains('hidden')) return;

    if (e.code === 'Space' && state.mode === 'loop') {
      e.preventDefault();
      els.mainToggleBtn.click();
    } else if (e.code === 'Tab' && state.mode === 'loop' && state.isActive) {
      e.preventDefault();
      els.swapTurnBtn.click();
    }
  });
}

// Arayuz dili secimi (ust bardaki 🌐 ve Ayarlar)
function populateUiLangSelect() {
  const sel = document.getElementById('uiLangSelect');
  if (!sel) return;
  sel.innerHTML = '';
  for (const l of UI_LANGS) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.name;
    opt.dir = 'auto';
    if (l.code === getUiLang()) opt.selected = true;
    sel.appendChild(opt);
  }
  const code = document.getElementById('uiLangBtnCode');
  if (code) code.textContent = getUiLang().split('-')[0].toUpperCase();
}

function rerenderForUiLang() {
  populateUiLangSelect();
  populateLanguageSelects();
  setPhase(state.phase);
  updateTurnUI();
  els.messageCount.textContent = t('stream.count', { n: state.messages.length });
  els.chatStream.querySelectorAll('.replay-btn').forEach((b) => (b.textContent = t('msg.replay')));
  els.chatStream.querySelectorAll('.copy-btn').forEach((b) => (b.textContent = t('msg.copy')));
  renderSlot('interim');
  renderSlot('badge');
  renderSlot('presence');
  fileCards.forEach((entry) => renderFileCard(entry));
  renderParticipants();
  // Henuz konusulmamis yuz yuze kartlari yeni dilde goster
  [els.faceMeText, els.facePartnerText].forEach((el) => {
    if (!state.isActive && el.dataset.untouched !== 'false') el.textContent = t('face.tap');
  });
}

function bindUiLang() {
  initI18n();
  populateUiLangSelect();
  setInterimKey('hint.start', null, true);
  els.faceMeText.textContent = t('face.tap');
  els.facePartnerText.textContent = t('face.tap');
  els.messageCount.textContent = t('stream.count', { n: 0 });
  const sel = document.getElementById('uiLangSelect');
  if (sel) sel.addEventListener('change', (e) => setUiLang(e.target.value));
  onUiLangChange(rerenderForUiLang);
}

async function translateViaApi(text, sourceLang, targetLang) {
  const res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sourceLang, targetLang }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.translatedText || '';
}

function setupCamera() {
  if (IS_GUEST) return; // Misafirde kamera sekmesi yok
  cameraCtl = initCamera({
    t,
    censor,
    showAlert,
    langName: (code) => displayLangName(code, findLanguage(code).name),
    getLangs: () => ({ from: state.partnerLang, to: state.myLang }),
    translate: translateViaApi,
    speak: (text, lang) => speakText(text, lang),
  });
}

function init() {
  bindUiLang();
  setupCamera();
  populateLanguageSelects();
  updateTurnUI();
  drawIdleOrb();
  bindEvents();

  if ('speechSynthesis' in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = (urlParams.get('room') || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const modeFromUrl = urlParams.get('mode');

  if (roomFromUrl) {
    setMode('online');
    els.onlineRoomInput.value = roomFromUrl;
    if (state.myName) {
      els.onlineNameInput.value = state.myName;
    }
    els.onlineNameInput.focus();
  } else if (modeFromUrl === 'online' || IS_GUEST) {
    setMode('online');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  if (!SpeechRecognitionAPI) {
    showAlert(
      t('err.noSRInfo')
    );
  }
}

init();
