import { LANGUAGES, findLanguage } from './languages.js';
import { drawQrCode } from './qr.js';

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
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
  qrBtn: document.getElementById('qrBtn'),
  qrModal: document.getElementById('qrModal'),
  closeQrBtn: document.getElementById('closeQrBtn'),
  qrCanvas: document.getElementById('qrCanvas'),
  qrUrlInput: document.getElementById('qrUrlInput'),
  qrHintText: document.getElementById('qrHintText'),
  copyQrUrlBtn: document.getElementById('copyQrUrlBtn'),
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

function populateLanguageSelects() {
  const buildOptions = (selectEl, selectedCode) => {
    selectEl.innerHTML = '';
    for (const lang of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = `${lang.name} (${lang.nativeName})`;
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
  const meDisplay = state.mode === 'online' && state.myName ? state.myName : 'Ben';
  const partnerDisplay = state.mode === 'online' && state.partnerName ? state.partnerName : 'Karşıdaki';

  els.turnMeLabel.textContent = `${meDisplay} (${myLangObj.short})`;
  els.turnPartnerLabel.textContent = `${partnerDisplay} (${partnerLangObj.short})`;
  els.faceMeLangBadge.textContent = myLangObj.short;
  els.facePartnerLangBadge.textContent = partnerLangObj.short;

  if (state.mode === 'online') {
    els.myLangCardLabel.textContent = state.myName
      ? `BENİM DİLİM · ${state.myName.toUpperCase()}`
      : 'BENİM DİLİM';
    els.partnerLangCardLabel.textContent = state.partnerName
      ? `KARŞIDAKİ · ${state.partnerName.toUpperCase()}`
      : 'KARŞIDAKİNİN DİLİ';
  } else {
    els.myLangCardLabel.textContent = 'BENİM DİLİM';
    els.partnerLangCardLabel.textContent = 'KARŞIDAKİNİN DİLİ';
  }
}

function setPhase(phase) {
  state.phase = phase;
  els.statusPill.dataset.state = phase;

  const labels = {
    idle: 'Hazır',
    listening: 'Dinleniyor...',
    translating: 'Çevriliyor...',
    speaking: 'Seslendiriliyor...',
  };
  els.statusText.textContent = labels[phase] || 'Hazır';
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
  els.mainToggleBtn.disabled = lockedByRemote;
  els.mainToggleBtn.classList.toggle('locked-remote', lockedByRemote);
  els.orbLabel.textContent = lockedByRemote
    ? 'Sıra Karşıda'
    : state.isActive
      ? 'Durdur'
      : 'Başlat';

  els.faceMeCard.classList.toggle('active-me', state.isActive && isMe);
  els.facePartnerCard.classList.toggle('active-partner', state.isActive && !isMe);
  els.faceMeBtn.querySelector('span').textContent =
    state.isActive && isMe ? 'Durdur' : 'Konuş';
  els.facePartnerBtn.querySelector('span').textContent =
    state.isActive && !isMe ? 'Durdur' : 'Konuş';
}

function setInterimMessage(text, isLive = false) {
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
      'Tarayıcınız canlı ses tanımayı desteklemiyor. Lütfen Google Chrome veya Microsoft Edge kullanın ya da alttaki metin kutusunu kullanın.'
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
  recognition.continuous = state.mode === 'online';
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  state.recognition = recognition;

  setPhase('listening');
  const promptMsg = `${isMe ? 'Sizin sıranız' : 'Karşıdakinin sırası'} — ${langInfo.name} dinleniyor...`;
  setInterimMessage(promptMsg, false);
  if (state.mode === 'face') {
    (isMe ? els.faceMeText : els.facePartnerText).textContent = `${langInfo.name} dinleniyor...`;
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
      const chunk = newFinalChunk.trim();
      if (chunk) {
        state.pendingTranscript = interim.trim();
        handleUtterance(chunk, 'me');
      } else {
        state.pendingTranscript = interim.trim();
      }
      if (interim.trim()) {
        setInterimMessage(interim.trim(), true);
      }
      return;
    }

    const display = (finalTranscript + interim).trim();
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
      showAlert('Mikrofon izni reddedildi veya ses tanıma servisi yok. Ayarlar > Uygulamalar > CEVIRI > İzinler bölümünden mikrofona izin verin ve Google uygulamasının yüklü olduğundan emin olun.');
      stopLiveSession();
      return;
    }
    if (event.error === 'audio-capture') {
      showAlert('Mikrofon bulunamadı veya başka bir uygulama tarafından kullanılıyor.');
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

async function handleUtterance(text, speaker) {
  if (state.mode === 'online') {
    if (!state.roomCode) {
      showAlert('Lütfen önce bir Online Oda oluşturun veya oda koduyla katılın.');
      return;
    }

    setPhase('translating');
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(state.roomCode)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: state.clientId,
          senderName: state.myName || 'Ben',
          text,
          sourceLang: state.myLang,
          fallbackTargetLang: state.partnerLang,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const msg = await res.json();
      setInterimMessage(msg.translatedText || text, true);
      // SSE chat_message will append to stream for both participants
    } catch (err) {
      showAlert(`Mesaj gönderilemedi: ${err.message}`);
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
    const translatedText = data.translatedText || '';

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
    } else {
      setInterimMessage(translatedText, true);
    }

    if (state.settings.autoSpeak && translatedText) {
      setPhase('speaking');
      await speakText(translatedText, targetLang);
    }
  } catch (err) {
    showAlert(`Çeviri hatası: ${err.message}. İnternet bağlantınızı kontrol edin.`);
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

  els.emptyState.classList.add('hidden');

  const msg = {
    id: id || Date.now() + Math.random(),
    speaker,
    senderName: senderName || (speaker === 'me' ? 'BEN' : 'KARŞIDAKİ'),
    sourceLang,
    targetLang,
    originalText,
    translatedText,
    time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
  };
  state.messages.push(msg);
  els.messageCount.textContent = `${state.messages.length} mesaj`;

  const card = document.createElement('article');
  card.className = `msg-card ${speaker}`;

  const srcShort = findLanguage(sourceLang).short;
  const tgtShort = findLanguage(targetLang).short;
  const whoLabel = msg.senderName.toUpperCase();

  card.innerHTML = `
    <div class="msg-top">
      <span class="msg-speaker">${whoLabel} · ${srcShort} → ${tgtShort}</span>
      <span>${msg.time}${typeof latencyMs === 'number' ? ` · ${latencyMs}ms` : ''}</span>
    </div>
    <div class="msg-original"></div>
    <div class="msg-translated"></div>
    <div class="msg-actions">
      <button class="mini-btn replay-btn" type="button">🔊 Seslendir</button>
      <button class="mini-btn copy-btn" type="button">📋 Kopyala</button>
    </div>
  `;

  card.querySelector('.msg-original').textContent = originalText;
  card.querySelector('.msg-translated').textContent = translatedText;

  card.querySelector('.replay-btn').addEventListener('click', () => {
    speakText(translatedText, targetLang);
  });

  card.querySelector('.copy-btn').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(translatedText);
      const btn = e.currentTarget;
      btn.textContent = '✓ Kopyalandı';
      setTimeout(() => (btn.textContent = '📋 Kopyala'), 1400);
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
      showAlert(`${state.activeMicName || 'Karşı taraf'} şu anda konuşuyor. Mikrofonunu kapatmasını bekleyin.`);
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
      showAlert('Lütfen önce bir Online Oda oluşturun veya oda koduyla katılın.');
      return;
    }
    if (state.activeMicClientId && state.activeMicClientId !== state.clientId) {
      showAlert(`${state.activeMicName || 'Karşı taraf'} şu anda konuşuyor. Bitirmesini bekleyin.`);
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
}

async function stopLiveSession() {
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
  setInterimMessage(
    "Canlı çeviri durduruldu. Devam etmek için Başlat'a basın.",
    false
  );
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

  els.modeLoopBtn.classList.toggle('active', mode === 'loop');
  els.modeLoopBtn.setAttribute('aria-selected', String(mode === 'loop'));
  els.modeFaceBtn.classList.toggle('active', mode === 'face');
  els.modeFaceBtn.setAttribute('aria-selected', String(mode === 'face'));
  els.modeOnlineBtn.classList.toggle('active', mode === 'online');
  els.modeOnlineBtn.setAttribute('aria-selected', String(mode === 'online'));

  els.loopStage.classList.toggle('hidden', mode === 'face');
  els.faceStage.classList.toggle('hidden', mode !== 'face');
  els.onlineBar.classList.toggle('hidden', mode !== 'online');
  els.turnControls.classList.toggle('hidden', mode === 'online');
  els.textSpeakerSelect.classList.toggle('hidden', mode === 'online');
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
          els.tunnelStatusBadge.textContent = window.CeviriRelay ? 'Online Bağlantı Hazır (şifreli)' : 'Genel Bağlantı Hazır';
          updateInviteLink();
          return;
        }
        if (info.status === 'error') {
          els.tunnelStatusBadge.textContent = info.error || 'Tünel hatası';
          updateInviteLink();
          if (window.CeviriRelay) state.onlinePollTimer = setTimeout(pollOnlineInfo, 4000);
          return;
        }
        els.tunnelStatusBadge.textContent = 'Genel davet linki oluşturuluyor...';
        state.onlinePollTimer = setTimeout(pollOnlineInfo, 2000);
      } else {
        els.tunnelStatusBadge.textContent = window.location.protocol === 'https:'
          ? 'Online Bağlantı'
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
  els.onlineJoinView.classList.add('hidden');
  els.onlineActiveView.classList.remove('hidden');
  updateInviteLink();

  const params = new URLSearchParams({
    clientId: state.clientId,
    name: state.myName || 'Ben',
    lang: state.myLang,
  });

  const es = new EventSource(`/api/rooms/${encodeURIComponent(roomCode)}/events?${params.toString()}`);
  state.eventSource = es;

  es.addEventListener('room_state', (event) => {
    const data = JSON.parse(event.data);
    const partner = (data.participants || []).find((p) => p.clientId !== state.clientId);

    state.activeMicClientId = data.activeMicClientId || null;
    state.activeMicName = data.activeMicName || null;

    if (partner) {
      state.partnerName = partner.name;
      state.partnerLang = partner.lang;
      els.partnerLangSelect.value = partner.lang;
      els.partnerLangSelect.disabled = true;
      const partnerLangInfo = findLanguage(partner.lang);
      els.partnerPresenceText.textContent = `${partner.name} (${partnerLangInfo.name}) bağlı`;
    } else {
      state.partnerName = '';
      els.partnerLangSelect.disabled = false;
      els.partnerPresenceText.textContent = 'Karşı taraf bekleniyor...';
    }

    updateLanguageBadges();
    updateTurnUI();

    if (!state.isActive) {
      if (state.activeMicClientId && state.activeMicClientId !== state.clientId) {
        setInterimMessage(
          `${state.activeMicName || 'Karşı taraf'} konuşuyor... Mikrofonu kapattığında sıranız açılacak.`,
          false
        );
      } else if (partner && state.phase === 'idle') {
        setInterimMessage("Sıra sizde. Konuşmak için Başlat'a basın.", false);
      }
    }
  });

  es.addEventListener('history', (event) => {
    const data = JSON.parse(event.data);
    for (const msg of data.messages || []) {
      const speaker = msg.senderId === state.clientId ? 'me' : 'partner';
      appendMessage({ ...msg, speaker });
    }
  });

  es.addEventListener('chat_message', async (event) => {
    const msg = JSON.parse(event.data);
    const speaker = msg.senderId === state.clientId ? 'me' : 'partner';
    appendMessage({ ...msg, speaker });

    // Speak incoming partner message on this PC without mic echo
    if (speaker === 'partner' && state.settings.autoSpeak && msg.translatedText) {
      const wasActive = state.isActive;
      if (wasActive) abortRecognition();
      setPhase('speaking');
      setInterimMessage(`${msg.senderName}: ${msg.translatedText}`, true);
      await speakText(msg.translatedText, state.myLang);
      if (wasActive && state.isActive) {
        state.resumeTimer = setTimeout(() => {
          if (state.isActive) startListening();
        }, 250);
      } else if (!state.isActive) {
        setPhase('idle');
      }
    }
  });

  es.onerror = () => {
    els.partnerPresenceText.textContent = 'Bağlantı yenileniyor...';
  };
}

async function createOnlineRoom() {
  const name = els.onlineNameInput.value.trim();
  if (!name) {
    showAlert('Lütfen önce adınızı girin.');
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
    showAlert(`Oda oluşturulamadı: ${err.message}`);
  }
}

function joinOnlineRoom() {
  const name = els.onlineNameInput.value.trim();
  const code = els.onlineRoomInput.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!name) {
    showAlert('Lütfen adınızı girin.');
    els.onlineNameInput.focus();
    return;
  }
  if (!code || code.length < 4) {
    showAlert('Lütfen geçerli bir oda kodu girin.');
    els.onlineRoomInput.focus();
    return;
  }
  hideAlert();
  state.myName = name;
  localStorage.setItem(STORAGE_KEYS.myName, name);
  connectToRoom(code);
  updateLanguageBadges();
}

function leaveOnlineRoom() {
  if (state.isActive) stopLiveSession();
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
  updateLanguageBadges();
  updateTurnUI();
}

function exportTranscript() {
  if (!state.messages.length) return;
  const lines = state.messages.map(
    (m) =>
      `[${m.time}] ${m.speaker === 'me' ? 'BEN' : 'KARŞIDAKİ'} (${findLanguage(m.sourceLang).short} -> ${findLanguage(m.targetLang).short})\nOrjinal: ${m.originalText}\nÇeviri: ${m.translatedText}\n`
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
      els.copyInviteBtn.textContent = '✓ Kopyalandı';
      setTimeout(() => (els.copyInviteBtn.textContent = 'Davet Linkini Kopyala'), 1600);
    } catch {
      els.inviteLinkInput.select();
    }
  });

  els.mainToggleBtn.addEventListener('click', () => {
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
    els.messageCount.textContent = '0 mesaj';
  });

  els.exportBtn.addEventListener('click', exportTranscript);
  els.alertCloseBtn.addEventListener('click', hideAlert);

  // QR modal
  els.qrBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/online-info');
      if (res.ok) state.onlineInfo = await res.json();
    } catch {
      // Fallback to current origin
    }

    const baseUrl = state.onlineInfo.publicUrl || window.location.origin;
    const targetUrl =
      state.mode === 'online' && state.roomCode
        ? `${baseUrl}/?room=${encodeURIComponent(state.roomCode)}`
        : baseUrl;

    els.qrUrlInput.value = targetUrl;
    drawQrCode(els.qrCanvas, targetUrl, 240);

    if (targetUrl.startsWith('http://localhost') || targetUrl.startsWith('http://127.0.0.1')) {
      els.qrHintText.innerHTML =
        'Telefondan bağlanmak ve uygulama olarak yüklemek için <strong>CEVIRI-Baslat-online.bat</strong> ile açın; oluşan HTTPS adresinin QR kodu telefonunuzda doğrudan açılır.';
    } else {
      els.qrHintText.innerHTML =
        'Telefon kameranızla okutun, açılan sayfada tarayıcı menüsünden <strong>Ana Ekrana Ekle / Uygulamayı Yükle</strong> seçeneğine dokunun.';
    }

    els.qrModal.classList.remove('hidden');
  });

  els.closeQrBtn.addEventListener('click', () => {
    els.qrModal.classList.add('hidden');
  });

  els.qrModal.addEventListener('click', (e) => {
    if (e.target === els.qrModal) {
      els.qrModal.classList.add('hidden');
    }
  });

  els.copyQrUrlBtn.addEventListener('click', async () => {
    if (!els.qrUrlInput.value) return;
    try {
      await navigator.clipboard.writeText(els.qrUrlInput.value);
      els.copyQrUrlBtn.textContent = '✓ Kopyalandı';
      setTimeout(() => (els.copyQrUrlBtn.textContent = 'Kopyala'), 1500);
    } catch {
      els.qrUrlInput.select();
    }
  });

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

function init() {
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
  } else if (modeFromUrl === 'online') {
    setMode('online');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  if (!SpeechRecognitionAPI) {
    showAlert(
      'Bilgi: Canlı ses tanıma için Google Chrome veya Microsoft Edge önerilir. Bu tarayıcıda alttaki metin kutusundan anlık sesli çeviri yapabilirsiniz.'
    );
  }
}

init();
