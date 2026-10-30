import { SpeechEngine, SPEECH_STATES, isBraveBrowser } from './src/speech.js';
import { SentenceBuffer } from './src/buffer.js';
import { translateText, testGeminiConnection } from './src/translator.js';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './src/storage.js';

let isSessionActive = false;
let autoScrollEnabled = true;
let isAppCollapsed = false;
let activeSessionAbortController = null;

let transcriptUnits = [];
let nextSeqIndex = 0;

let translationQueue = [];
let isTranslating = false;
let currentSessionId = 0;
let recentTranslationContext = [];
const MAX_CONTEXT_SENTENCES = 3;

let liveInterimTimer = null;
let liveInterimAbortCtrl = null;
let currentLiveEnglish = '';
let currentLiveVi = '';

let isUserAtBottom = true;
const SCROLL_THRESHOLD = 60;

let speechEngine = null;
let sentenceBuffer = null;
let appSettings = { ...DEFAULT_SETTINGS };
let toastHideTimer = null;

function setAppCollapseState(collapsed, save = true) {
  isAppCollapsed = !!collapsed;
  DOM.body.classList.toggle('app-collapsed', isAppCollapsed);
  if (DOM.switchAppPower) {
    DOM.switchAppPower.checked = !isAppCollapsed;
  }
  if (save) {
    saveSettings({ appCollapsed: isAppCollapsed });
  }
}

function ensurePermissionBanner() {
  let banner = document.getElementById('permissionBanner');
  if (!banner) {
    console.warn('[NgheGiang] Tự động tạo phần tử #permissionBanner trong control-box');
    banner = document.createElement('div');
    banner.className = 'permission-banner hidden';
    banner.id = 'permissionBanner';
    banner.innerHTML = `
      <div class="banner-content">
        <span class="banner-icon">⚠️</span>
        <span class="banner-text">Cần cấp quyền micro cho tiện ích để bắt đầu nghe.</span>
      </div>
      <button id="btnRequestPermission" class="btn-banner-action">Cấp quyền Micro</button>
    `;
    const controlBox = document.querySelector('.control-box');
    if (controlBox) {
      const vuMeter = controlBox.querySelector('.vu-meter');
      if (vuMeter && vuMeter.nextSibling) {
        controlBox.insertBefore(banner, vuMeter.nextSibling);
      } else {
        controlBox.appendChild(banner);
      }
    }
    const btn = banner.querySelector('#btnRequestPermission');
    if (btn) {
      btn.addEventListener('click', () => SpeechEngine.openPermissionTab());
    }
  }
  return banner;
}

const DOM = {
  get body() { return document.body; },
  get switchAppPower() { return document.getElementById('switchAppPower'); },
  get switchAutoScroll() { return this.switchAppPower; },
  get btnThemeToggle() { return document.getElementById('btnThemeToggle'); },
  get btnHeaderSettings() { return document.getElementById('btnHeaderSettings'); },
  get btnHeaderPopout() { return document.getElementById('btnHeaderPopout'); },

  get tabSubtitles() { return document.getElementById('tabSubtitles'); },
  get tabSettings() { return document.getElementById('tabSettings'); },
  get paneSubtitles() { return document.getElementById('paneSubtitles'); },
  get paneSettings() { return document.getElementById('paneSettings'); },

  get btnToggleListening() { return document.getElementById('btnToggleListening'); },
  get btnText() { return document.querySelector('#btnToggleListening .btn-text'); },
  get vuBar() { return document.getElementById('vuBar'); },
  get permissionBanner() { return document.getElementById('permissionBanner') || ensurePermissionBanner(); },
  get btnRequestPermission() { return document.getElementById('btnRequestPermission'); },

  get networkNoticeBanner() { return document.getElementById('networkNoticeBanner'); },
  get networkNoticeTitle() { return document.getElementById('networkNoticeTitle'); },
  get networkNoticeDesc() { return document.getElementById('networkNoticeDesc'); },
  get networkNoticeActions() { return document.getElementById('networkNoticeActions'); },
  get btnSwitchToGeminiSTT() { return document.getElementById('btnSwitchToGeminiSTT'); },
  get btnRetryWebSpeech() { return document.getElementById('btnRetryWebSpeech'); },
  get btnDismissNetworkNotice() { return document.getElementById('btnDismissNetworkNotice'); },

  get selectMicDevice() { return document.getElementById('selectMicDevice'); },
  get checkShowEnglish() { return document.getElementById('checkShowEnglish'); },
  get btnFontDec() { return document.getElementById('btnFontDec'); },
  get btnFontInc() { return document.getElementById('btnFontInc'); },
  get btnCopyAll() { return document.getElementById('btnCopyAll'); },
  get btnExport() { return document.getElementById('btnExport'); },
  get btnClear() { return document.getElementById('btnClear'); },

  get subtitlesViewport() { return document.getElementById('subtitlesViewport'); },
  get btnScrollToLatest() { return document.getElementById('btnScrollToLatest'); },
  get skippedToast() { return document.getElementById('skippedToast'); },
  get emptyState() { return document.getElementById('emptyState'); },
  get continuousTranscript() { return document.getElementById('continuousTranscript'); },
  get liveSpeakingIndicator() { return document.getElementById('liveSpeakingIndicator'); },
  get liveSpeakingText() { return document.getElementById('liveSpeakingText'); },
  get queueStatusBadge() { return document.getElementById('queueStatusBadge'); },

  get selectSpeechEngine() { return document.getElementById('selectSpeechEngine'); },
  get selectEngine() { return document.getElementById('selectEngine'); },
  get geminiKeyWrapper() { return document.getElementById('geminiKeyWrapper'); },
  get inputGeminiKey() { return document.getElementById('inputGeminiKey'); },
  get btnTestGeminiKey() { return document.getElementById('btnTestGeminiKey'); },
  get btnClearGeminiKey() { return document.getElementById('btnClearGeminiKey'); },
  get geminiKeyStatus() { return document.getElementById('geminiKeyStatus'); },
  get selectDialect() { return document.getElementById('selectDialect'); },
  get checkSaveHistory() { return document.getElementById('checkSaveHistory'); },
  get btnSaveConfig() { return document.getElementById('btnSaveConfig'); }
};

async function initApp() {
  await initSettings();
  initEngines();
  await refreshMicrophoneList();
  bindEvents();
  checkPopoutMode();
  listenRuntimeMessages();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.body.classList.toggle('dark-theme', isDark);
  if (DOM.btnThemeToggle) {
    DOM.btnThemeToggle.setAttribute('title', isDark ? 'Chuyển sang Giao diện Sáng' : 'Chuyển sang Giao diện Tối');
    DOM.btnThemeToggle.setAttribute('aria-label', isDark ? 'Giao diện Sáng' : 'Giao diện Tối');
    DOM.btnThemeToggle.innerHTML = isDark
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"></circle>
          <line x1="12" y1="1" x2="12" y2="3"></line>
          <line x1="12" y1="21" x2="12" y2="23"></line>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
          <line x1="1" y1="12" x2="3" y2="12"></line>
          <line x1="21" y1="12" x2="23" y2="12"></line>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
        </svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>`;
  }
}

async function initSettings() {
  appSettings = await loadSettings();

  applyTheme(appSettings.theme || 'light');

  applyFontSize(appSettings.fontSize);

  const collapsed = appSettings.appCollapsed === true;
  setAppCollapseState(collapsed, false);

  autoScrollEnabled = appSettings.autoScroll !== false;
  DOM.switchAutoScroll.checked = autoScrollEnabled;

  const showEn = appSettings.showEnglishParallel === true;
  updateShowEnglishUI(showEn);

  updateActionButtonsState();

  if (DOM.selectSpeechEngine) {
    DOM.selectSpeechEngine.value = appSettings.speechEngine || 'web-speech';
  }
  DOM.selectEngine.value = appSettings.translationEngine || 'google-gtx';
  DOM.inputGeminiKey.value = appSettings.geminiApiKey || '';
  DOM.selectDialect.value = appSettings.englishDialect || 'en-US';
  DOM.checkSaveHistory.checked = !!appSettings.saveHistoryToDisk;
  toggleGeminiKeyVisibility();
}

function updateActionButtonsState() {
  const hasContent = transcriptUnits.length > 0;
  if (DOM.btnCopyAll) DOM.btnCopyAll.disabled = !hasContent;
  if (DOM.btnExport) DOM.btnExport.disabled = !hasContent;
  if (DOM.btnClear) DOM.btnClear.disabled = !hasContent;
}

function updateShowEnglishUI(show) {
  appSettings.showEnglishParallel = show;
  if (DOM.checkShowEnglish) {
    DOM.checkShowEnglish.checked = show;
  }
  if (DOM.continuousTranscript) {
    DOM.continuousTranscript.classList.toggle('show-english', show);
    DOM.continuousTranscript.dataset.showEnglish = show ? 'true' : 'false';
  }
  if (DOM.subtitlesViewport) {
    DOM.subtitlesViewport.classList.toggle('show-english', show);
  }
}

function scrollViewportToBottomIfAtBottom(force = false) {
  if (!autoScrollEnabled && !force) return;

  if (isUserAtBottom || force) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = DOM.subtitlesViewport;
        if (el) {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          isUserAtBottom = true;
          if (DOM.btnScrollToLatest) {
            DOM.btnScrollToLatest.classList.add('hidden');
          }
        }
      });
    });
  }
}

function updateQueueStatusIndicator() {
  if (!DOM.queueStatusBadge) return;
  const pendingCount = translationQueue.length;
  if (pendingCount > 1) {
    DOM.queueStatusBadge.textContent = `(Chờ dịch ${pendingCount
} câu...)`;
    DOM.queueStatusBadge.classList.remove('hidden');
  } else if (pendingCount === 1) {
    DOM.queueStatusBadge.textContent = `(Đang dịch...)`;
    DOM.queueStatusBadge.classList.remove('hidden');
  } else {
    DOM.queueStatusBadge.classList.add('hidden');
    DOM.queueStatusBadge.textContent = '';
  }
}

function applyFontSize(size) {
  DOM.body.classList.remove('font-small', 'font-medium', 'font-large', 'font-xlarge');
  DOM.body.classList.add(`font-${size
}`);
}

function initEngines() {
  sentenceBuffer = new SentenceBuffer({
    onInterimUpdate: ({ english, isEnglish }) => {
      handleInterimUpdate(english, isEnglish);
    },
    onSentenceFinalized: async (sentence) => {
      await handleSentenceFinalized(sentence);
    },
    onSkipped: ({ text, reason }) => {
      showSkippedNotification(reason);
    }
  });

  speechEngine = new SpeechEngine({
    engineType: appSettings.speechEngine || 'web-speech',
    onRecognitionEnd: () => {
      if (sentenceBuffer && isSessionActive) {
        sentenceBuffer.handleRecognitionEnd();
      }
    },
    onStateChange: (state, message) => {
      if (state === SPEECH_STATES.PERMISSION_DENIED) {
        DOM.permissionBanner.classList.remove('hidden');
      } else if (state === SPEECH_STATES.LISTENING) {
        DOM.permissionBanner.classList.add('hidden');
        DOM.networkNoticeBanner.classList.add('hidden');
      } else if (state === SPEECH_STATES.NETWORK_ERROR) {
        handleNetworkErrorState(message);
      }
    },
    onVolumeChange: (level) => {
      DOM.vuBar.style.width = `${Math.round(level * 100)
}%`;
    },
    onResult: (event) => {
      if (sentenceBuffer && isSessionActive) {
        sentenceBuffer.handleSpeechResult(event);
      }
    },
    onTextTranscript: (text) => {
      if (sentenceBuffer && isSessionActive) {
        sentenceBuffer.handleTranscriptText(text, true);
      }
    },
    onError: (err) => {
      console.warn('[NgheGiang-Diag][2.SpeechRecog] SpeechEngine error:', err);
      if (err.type === 'network') {
        handleNetworkErrorState(err.message, err.isBrave);
      }
    }
  });
}

function handleNetworkErrorState(message, isBrave = false) {
  DOM.networkNoticeBanner.classList.remove('hidden');
  DOM.networkNoticeActions.classList.remove('hidden');

  if (isBrave) {
    DOM.networkNoticeTitle.textContent = 'Brave không hỗ trợ Web Speech của Google';
    DOM.networkNoticeDesc.textContent = 'Trình duyệt Brave chặn dịch vụ nhận dạng Web Speech của Google. Bạn có thể bấm nút bên dưới để chuyển sang dùng Gemini Audio STT miễn phí.';
  } else {
    DOM.networkNoticeTitle.textContent = 'Lỗi kết nối Web Speech';
    DOM.networkNoticeDesc.textContent = message || 'Không thể kết nối máy chủ nhận dạng Web Speech của Google.';
  }
}

async function refreshMicrophoneList() {
  const devices = await SpeechEngine.getMicrophoneDevices();
  DOM.selectMicDevice.innerHTML = '<option value="">Micro mặc định</option>';

  devices.forEach((dev) => {
    const opt = document.createElement('option');
    opt.value = dev.deviceId;
    opt.textContent = dev.label;
    if (appSettings.selectedMicId && appSettings.selectedMicId === dev.deviceId) {
      opt.selected = true;
    }
    DOM.selectMicDevice.appendChild(opt);
  });
}

async function toggleListeningSession() {
  if (!isSessionActive) {
    try {
      DOM.btnToggleListening.disabled = true;
      DOM.btnText.textContent = 'Đang kết nối...';
      DOM.permissionBanner.classList.add('hidden');
      DOM.networkNoticeBanner.classList.add('hidden');

      if (transcriptUnits.length === 0 && DOM.emptyState) {
        DOM.emptyState.style.display = 'none';
      }

      const deviceId = DOM.selectMicDevice.value || appSettings.selectedMicId;
      const dialect = appSettings.englishDialect || 'en-US';

      const currentEngine = DOM.selectEngine?.value || appSettings.translationEngine;
      const currentGeminiKey = (appSettings.geminiApiKey || (DOM.inputGeminiKey ? DOM.inputGeminiKey.value.trim() : '')).trim().replace(/^["']|["']$/g, '');
      if (currentEngine === 'gemini' && !currentGeminiKey) {
        DOM.btnToggleListening.disabled = false;
        DOM.btnText.textContent = 'Bắt đầu nghe';
        switchTab('settings');
        alert('Bạn đang chọn công cụ dịch Google Gemini AI nhưng chưa nhập API Key. Vui lòng dán khóa miễn phí từ Google AI Studio vào ô cài đặt.');
        return;
      }

      currentSessionId++;
      translationQueue = [];
      recentTranslationContext = [];
      isUserAtBottom = true;
      activeSessionAbortController = new AbortController();

      await speechEngine.start({
        deviceId: deviceId,
        language: dialect,
        engineType: appSettings.speechEngine || 'web-speech',
        geminiApiKey: currentGeminiKey
      });

      isSessionActive = true;
      DOM.btnToggleListening.disabled = false;
      DOM.btnToggleListening.className = 'primary-btn btn-red';
      DOM.btnText.textContent = 'Dừng nghe (Tắt Micro)';

      await refreshMicrophoneList();
    } catch (err) {
      console.warn('[NgheGiang-Diag][2.SpeechRecog] Startup aborted:', err.message || err.type);
      isSessionActive = false;
      if (activeSessionAbortController) {
        activeSessionAbortController.abort();
        activeSessionAbortController = null;
      }
      DOM.btnToggleListening.disabled = false;
      DOM.btnToggleListening.className = 'primary-btn btn-purple';
      DOM.btnText.textContent = 'Bắt đầu nghe';

      if (transcriptUnits.length === 0 && DOM.emptyState) {
        DOM.emptyState.style.display = 'flex';
      }

      if (err.message === 'PERMISSION_REQUIRED') {
        DOM.permissionBanner.classList.remove('hidden');
        SpeechEngine.openPermissionTab();
      } else if (err.type === 'network' || err.message === 'network') {
        handleNetworkErrorState(err.message, err.isBrave);
      } else if (err.message === 'MISSING_GEMINI_KEY') {
        DOM.networkNoticeBanner.classList.remove('hidden');
        DOM.networkNoticeActions.classList.add('hidden');
        DOM.networkNoticeTitle.textContent = 'Chưa có Gemini API Key';
        DOM.networkNoticeDesc.textContent = 'Chế độ Gemini Audio STT cần API Key miễn phí từ Google AI Studio. Vui lòng vào Cài đặt để dán khóa.';
      }
    }
  } else {

    isSessionActive = false;
    currentSessionId++;
    if (activeSessionAbortController) {
      activeSessionAbortController.abort();
      activeSessionAbortController = null;
    }

    clearTimeout(liveInterimTimer);
    if (liveInterimAbortCtrl) {
      liveInterimAbortCtrl.abort();
      liveInterimAbortCtrl = null;
    }
    const liveSlot = document.getElementById('liveInterimSlot');
    if (liveSlot) liveSlot.remove();
    currentLiveEnglish = '';
    currentLiveVi = '';

    translationQueue = [];
    isTranslating = false;
    DOM.btnToggleListening.disabled = false;
    DOM.btnToggleListening.className = 'primary-btn btn-purple';
    DOM.btnText.textContent = 'Bắt đầu nghe';

    if (sentenceBuffer) {
      sentenceBuffer.flush();
    }
    if (speechEngine) {
      speechEngine.stop();
    }

    DOM.liveSpeakingIndicator.classList.add('hidden');
    DOM.liveSpeakingText.textContent = '';
    if (DOM.queueStatusBadge) {
      DOM.queueStatusBadge.classList.add('hidden');
      DOM.queueStatusBadge.textContent = '';
    }

    if (transcriptUnits.length === 0 && DOM.emptyState) {
      DOM.emptyState.style.display = 'flex';
    }
  }
}

function handleInterimUpdate(english, isEnglish) {
  if (!isSessionActive || !english || !isEnglish) {
    DOM.liveSpeakingIndicator.classList.add('hidden');
    DOM.liveSpeakingText.textContent = '';
    const liveSlot = document.getElementById('liveInterimSlot');
    if (liveSlot && !currentLiveVi) {
      liveSlot.remove();
    }
    return;
  }

  if (DOM.emptyState) {
    DOM.emptyState.style.display = 'none';
  }

  DOM.liveSpeakingIndicator.classList.remove('hidden');
  DOM.liveSpeakingText.textContent = english;

  let liveSlot = document.getElementById('liveInterimSlot');
  if (!liveSlot) {
    liveSlot = document.createElement('span');
    liveSlot.id = 'liveInterimSlot';
    liveSlot.className = 'transcript-unit live-unit';
    liveSlot.innerHTML = `
      <span class="unit-en">(${escapeHtml(english)
}) </span>
      <span class="unit-vi live-streaming">${currentLiveVi ? escapeHtml(currentLiveVi) + '...' : '...'
}</span>
      <span class="unit-spacer"> </span>
    `;
    DOM.continuousTranscript.appendChild(liveSlot);
  } else {
    const enSpan = liveSlot.querySelector('.unit-en');
    if (enSpan) enSpan.textContent = `(${escapeHtml(english)
}) `;
  }

  scrollViewportToBottomIfAtBottom();

  const trimmed = english.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2) return;

  clearTimeout(liveInterimTimer);
  liveInterimTimer = setTimeout(async () => {
    if (!isSessionActive || !trimmed) return;
    if (trimmed === currentLiveEnglish && currentLiveVi) return;

    if (liveInterimAbortCtrl) {
      liveInterimAbortCtrl.abort();
    }
    liveInterimAbortCtrl = new AbortController();

    currentLiveEnglish = trimmed;
    const activeKey = (appSettings.geminiApiKey || (DOM.inputGeminiKey ? DOM.inputGeminiKey.value.trim() : '')).trim().replace(/^["']|["']$/g, '');
    const activeEngine = DOM.selectEngine?.value || appSettings.translationEngine || 'google-gtx';

    try {
      const res = await translateText(trimmed, {
        engine: activeEngine,
        geminiApiKey: activeKey,
        context: recentTranslationContext.slice(-2).join(' '),
        timeoutMs: 3500,
        signal: liveInterimAbortCtrl.signal
      });

      if (!isSessionActive) return;

      currentLiveVi = res.translatedText.trim();
      const slot = document.getElementById('liveInterimSlot');
      if (slot) {
        const viSpan = slot.querySelector('.unit-vi');
        if (viSpan) {
          viSpan.textContent = currentLiveVi + '...';
          viSpan.className = 'unit-vi live-streaming';
        }
        scrollViewportToBottomIfAtBottom();
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[NgheGiang-Diag][5.Translator] Live interim translation notice:', err.message);
    }
  }, 280);
}

async function handleSentenceFinalized(sentence) {
  if (!sentence.english) return;

  clearTimeout(liveInterimTimer);
  if (DOM.emptyState) {
    DOM.emptyState.style.display = 'none';
  }
  DOM.liveSpeakingIndicator.classList.add('hidden');
  DOM.liveSpeakingText.textContent = '';

  const seqIndex = nextSeqIndex++;
  let unitEl = document.getElementById('liveInterimSlot');
  let previewVi = '';

  if (unitEl && currentLiveVi) {
    previewVi = currentLiveVi;
    unitEl.removeAttribute('id');
    unitEl.id = `unit-${seqIndex
}`;
    unitEl.className = 'transcript-unit';
    unitEl.dataset.seq = seqIndex;

    const enSpan = unitEl.querySelector('.unit-en');
    if (enSpan) enSpan.textContent = `(${escapeHtml(sentence.english)
}) `;

    const viSpan = unitEl.querySelector('.unit-vi');
    if (viSpan) {
      viSpan.className = 'unit-vi';
      viSpan.textContent = previewVi;
    }
  } else {
    if (unitEl) unitEl.remove();
    unitEl = document.createElement('span');
    unitEl.className = 'transcript-unit';
    unitEl.id = `unit-${seqIndex
}`;
    unitEl.dataset.seq = seqIndex;
    unitEl.innerHTML = `
      <span class="unit-en">(${escapeHtml(sentence.english)
}) </span>
      <span class="unit-vi loading">...</span>
      <span class="unit-spacer"> </span>
    `;
    DOM.continuousTranscript.appendChild(unitEl);
  }

  currentLiveEnglish = '';
  currentLiveVi = '';

  const unitRecord = {
    seqIndex,
    english: sentence.english,
    vietnamese: previewVi,
    timestamp: sentence.timestamp
  };
  transcriptUnits.push(unitRecord);
  updateActionButtonsState();

  translationQueue.push({
    sentence,
    seqIndex,
    sessionId: currentSessionId,
    previewVi
  });

  updateQueueStatusIndicator();
  scrollViewportToBottomIfAtBottom();

  processTranslationQueue();
}

async function processTranslationQueue() {
  if (isTranslating || translationQueue.length === 0) return;
  isTranslating = true;
  updateQueueStatusIndicator();

  try {
    while (translationQueue.length > 0 && isSessionActive) {
      if (translationQueue.length > 25) {
        console.warn(`[NgheGiang] Hàng đợi dịch đang dồn ${translationQueue.length
} câu, đang tăng tốc xử lý...`);
      }

      const item = translationQueue.shift();
      updateQueueStatusIndicator();

      const { sentence, seqIndex, sessionId } = item;

      if (!isSessionActive || sessionId !== currentSessionId) {
        continue;
      }

      const contextText = recentTranslationContext.join(' ');
      const startTime = performance.now();
      let translatedVietnamese = '';

      const rawKey = appSettings.geminiApiKey || (DOM.inputGeminiKey ? DOM.inputGeminiKey.value.trim() : '');
      const activeGeminiKey = rawKey.trim().replace(/^["']|["']$/g, '');
      const activeEngine = DOM.selectEngine?.value || appSettings.translationEngine || 'google-gtx';

      try {
        const res = await translateText(sentence.english, {
          engine: activeEngine,
          geminiApiKey: activeGeminiKey,
          context: contextText,
          timeoutMs: 8500,
          signal: activeSessionAbortController?.signal
        });
        translatedVietnamese = res.translatedText;
        const elapsedMs = Math.round(performance.now() - startTime);
        console.log(`[NgheGiang-Diag][5.Translator] Success seq=${seqIndex
} in ${elapsedMs
}ms: engine=${res.engineUsed
}`);

        recentTranslationContext.push(sentence.english);
        if (recentTranslationContext.length > MAX_CONTEXT_SENTENCES) {
          recentTranslationContext.shift();
        }
      } catch (err) {
        if (!isSessionActive || sessionId !== currentSessionId) {
          break;
        }

        console.warn(`[NgheGiang-Diag][5.Translator] Failed seq=${seqIndex
}:`, err.message);

        const retryCount = item.retryCount || 0;
        const isTransientError = err.message.includes('fetch') || err.message.includes('network') || err.message.includes('429') || err.message.includes('Timeout');
        if (retryCount < 2 && isTransientError && isSessionActive && sessionId === currentSessionId) {
          item.retryCount = retryCount + 1;
          console.log(`[NgheGiang-Diag][5.Translator] Đang thử lại câu seq=${seqIndex
} (${item.retryCount
}/2)...`);
          await new Promise(r => setTimeout(r, 600 * item.retryCount));
          translationQueue.unshift(item);
          continue;
        }

        translatedVietnamese = `(${err.message
})`;
      }

      let formattedVi = translatedVietnamese.trim();
      if (formattedVi.length > 0 && !formattedVi.startsWith('(')) {
        formattedVi = formattedVi.charAt(0).toUpperCase() + formattedVi.slice(1);

        const enTrimmed = sentence.english.trim();
        const enEndsWithPunct = /[.?!,]$/.test(enTrimmed);
        const viEndsWithPunct = /[.?!,]$/.test(formattedVi);

        if (!viEndsWithPunct) {
          if (enEndsWithPunct) {
            formattedVi += enTrimmed.slice(-1);
          } else if (enTrimmed.split(/\s+/).length >= 4) {
            formattedVi += '.';
          }
        }

        formattedVi = formattedVi.replace(/\.{2,}/g, '.').replace(/,\./g, '.');
      }

      const record = transcriptUnits.find(u => u.seqIndex === seqIndex);
      if (record) {
        record.vietnamese = formattedVi;
      }

      const targetUnit = document.getElementById(`unit-${seqIndex
}`);
      if (targetUnit) {
        const viEl = targetUnit.querySelector('.unit-vi');
        if (viEl) {
          viEl.className = 'unit-vi';
          viEl.textContent = formattedVi;
        }
      }

      scrollViewportToBottomIfAtBottom();

      if (translationQueue.length > 0) {
        await new Promise(r => setTimeout(r, 20));
      }
    }
  } catch (fatalQueueErr) {
    console.error('[NgheGiang] Lỗi không mong muốn trong hàng đợi dịch:', fatalQueueErr);
  } finally {
    isTranslating = false;
    updateQueueStatusIndicator();
  }
}

function showSkippedNotification(reason) {
  clearTimeout(toastHideTimer);
  DOM.skippedToast.classList.remove('hidden');

  let reasonMsg = 'Đã bỏ qua đoạn không phải tiếng Anh';
  if (reason === 'vietnamese_detected' || reason === 'vietnamese_unaccented') {
    reasonMsg = 'Phát hiện tiếng Việt — Đã tự động bỏ qua theo yêu cầu';
  }

  DOM.skippedToast.querySelector('span').textContent = reasonMsg;

  toastHideTimer = setTimeout(() => {
    DOM.skippedToast.classList.add('hidden');
  }, 2200);
}

async function copyAllTranscript() {
  if (transcriptUnits.length === 0) {
    alert('Chưa có nội dung bản dịch nào để sao chép.');
    return;
  }

  const showEn = appSettings.showEnglishParallel === true;
  let fullText = '';

  if (showEn) {
    fullText = transcriptUnits
      .map(u => `${u.vietnamese
} (${u.english
})`)
      .filter(Boolean)
      .join(' ');
  } else {
    fullText = transcriptUnits
      .map(u => u.vietnamese || u.english)
      .filter(Boolean)
      .join(' ');
  }

  await navigator.clipboard.writeText(fullText);

  const span = DOM.btnCopyAll.querySelector('span');
  if (span) {
    span.textContent = 'Đã chép!';
    setTimeout(() => {
      span.textContent = 'Sao chép';
    }, 1500);
  }
}

function clearAllSubtitles() {
  if (transcriptUnits.length === 0) return;

  if (confirm('Bạn có chắc muốn xóa toàn bộ nội dung phụ đề bài giảng trong phiên hiện tại không?')) {
    clearTimeout(liveInterimTimer);
    if (liveInterimAbortCtrl) {
      liveInterimAbortCtrl.abort();
      liveInterimAbortCtrl = null;
    }
    const liveSlot = document.getElementById('liveInterimSlot');
    if (liveSlot) liveSlot.remove();
    currentLiveEnglish = '';
    currentLiveVi = '';

    transcriptUnits = [];
    translationQueue = [];
    recentTranslationContext = [];
    nextSeqIndex = 0;
    DOM.continuousTranscript.innerHTML = '';
    DOM.liveSpeakingIndicator.classList.add('hidden');
    DOM.liveSpeakingText.textContent = '';
    if (DOM.btnScrollToLatest) {
      DOM.btnScrollToLatest.classList.add('hidden');
    }
    if (DOM.queueStatusBadge) {
      DOM.queueStatusBadge.classList.add('hidden');
    }
    isUserAtBottom = true;

    if (!isSessionActive && DOM.emptyState) {
      DOM.emptyState.style.display = 'flex';
    }
    if (sentenceBuffer) {
      sentenceBuffer.reset();
    }
    updateActionButtonsState();
  }
}

function exportSubtitlesToText() {
  if (transcriptUnits.length === 0) {
    alert('Chưa có nội dung bài giảng nào để xuất.');
    return;
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('vi-VN');
  const timeStr = now.toLocaleTimeString('vi-VN');

  let content = `========================================================\n`;
  content += `BẢN GHI PHỤ ĐỀ BÀI GIẢNG - EXTENSION NGHE GIẢNG\n`;
  content += `Thời gian xuất: ${timeStr
} ngày ${dateStr
}\n`;
  content += `Tổng số câu đã ghi nhận: ${transcriptUnits.length
}\n`;
  content += `========================================================\n\n`;

  content += `--- BẢN DỊCH TIẾNG VIỆT LIỀN MẠCH ---\n\n`;
  const viFlow = transcriptUnits.map(u => u.vietnamese).filter(Boolean).join(' ');
  content += viFlow + `\n\n`;

  content += `--- ĐỐI CHIẾU SONG NGỮ THEO TỪNG CÂU ---\n\n`;
  transcriptUnits.forEach((item, index) => {
    content += `[${item.timestamp
}] Câu ${index + 1
}:\n`;
    content += `EN: ${item.english
}\n`;
    content += `VI: ${item.vietnamese
}\n\n`;
  });

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `BaiGiang_${now.getFullYear()
}${(now.getMonth()+1).toString().padStart(2,'0')
}${now.getDate().toString().padStart(2,'0')
}_${now.getHours()
}${now.getMinutes()
}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function adjustFontSize(direction) {
  const sizes = ['small', 'medium', 'large', 'xlarge'];
  let currentIndex = sizes.indexOf(appSettings.fontSize);
  if (currentIndex === -1) currentIndex = 1;

  if (direction === 'inc' && currentIndex < sizes.length - 1) {
    currentIndex++;
  } else if (direction === 'dec' && currentIndex > 0) {
    currentIndex--;
  }

  const newSize = sizes[currentIndex];
  appSettings.fontSize = newSize;
  applyFontSize(newSize);
  saveSettings({ fontSize: newSize });
  scrollViewportToBottomIfAtBottom();
}

function switchTab(tabName) {
  if (tabName === 'subtitles') {
    DOM.tabSubtitles.classList.add('active');
    DOM.tabSettings.classList.remove('active');
    DOM.paneSubtitles.classList.add('active');
    DOM.paneSubtitles.classList.remove('hidden');
    DOM.paneSettings.classList.add('hidden');
    DOM.paneSettings.classList.remove('active');
    scrollViewportToBottomIfAtBottom();
  } else {
    DOM.tabSubtitles.classList.remove('active');
    DOM.tabSettings.classList.add('active');
    DOM.paneSubtitles.classList.add('hidden');
    DOM.paneSubtitles.classList.remove('active');
    DOM.paneSettings.classList.add('active');
    DOM.paneSettings.classList.remove('hidden');
  }
}

function checkPopoutMode() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('popout') === 'true') {
    DOM.btnHeaderPopout.style.display = 'none';
    document.title = 'Nghe Giảng - Cửa sổ rời';
  }
}

function toggleGeminiKeyVisibility() {
  const selectedEngine = DOM.selectEngine.value;
  const selectedSTT = DOM.selectSpeechEngine ? DOM.selectSpeechEngine.value : 'web-speech';
  const needsGeminiKey = (selectedSTT === 'gemini-stt' || selectedEngine === 'gemini');

  if (DOM.geminiKeyWrapper) {
    DOM.geminiKeyWrapper.classList.toggle('hidden', !needsGeminiKey);
  }
}

function listenRuntimeMessages() {
  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'MICROPHONE_PERMISSION_GRANTED') {
        DOM.permissionBanner.classList.add('hidden');
        if (!isSessionActive) {
          toggleListeningSession();
        }
      }
    });
  }
}

function bindEvents() {

  DOM.btnToggleListening.addEventListener('click', toggleListeningSession);

  DOM.btnRequestPermission.addEventListener('click', () => {
    SpeechEngine.openPermissionTab();
  });

  if (DOM.btnDismissNetworkNotice) {
    DOM.btnDismissNetworkNotice.addEventListener('click', () => {
      DOM.networkNoticeBanner.classList.add('hidden');
    });
  }

  if (DOM.btnSwitchToGeminiSTT) {
    DOM.btnSwitchToGeminiSTT.addEventListener('click', async () => {
      DOM.networkNoticeBanner.classList.add('hidden');
      if (DOM.selectSpeechEngine) {
        DOM.selectSpeechEngine.value = 'gemini-stt';
      }
      appSettings.speechEngine = 'gemini-stt';
      await saveSettings({ speechEngine: 'gemini-stt' });
      if (speechEngine) {
        speechEngine.engineType = 'gemini-stt';
      }
      toggleGeminiKeyVisibility();
      switchTab('settings');
      alert('Đã chuyển sang chế độ Gemini Audio STT. Nếu bạn chưa có API Key, vui lòng dán khóa miễn phí từ Google AI Studio rồi nhấn "Lưu Cài Đặt".');
    });
  }

  if (DOM.btnRetryWebSpeech) {
    DOM.btnRetryWebSpeech.addEventListener('click', () => {
      DOM.networkNoticeBanner.classList.add('hidden');
      toggleListeningSession();
    });
  }

  DOM.tabSubtitles.addEventListener('click', () => switchTab('subtitles'));
  DOM.tabSettings.addEventListener('click', () => switchTab('settings'));

  if (DOM.btnThemeToggle) {
    DOM.btnThemeToggle.addEventListener('click', async () => {
      const nextTheme = appSettings.theme === 'dark' ? 'light' : 'dark';
      appSettings.theme = nextTheme;
      applyTheme(nextTheme);
      await saveSettings({ theme: nextTheme });
    });
  }

  DOM.btnHeaderSettings.addEventListener('click', () => {
    const isCurrentlySettings = DOM.tabSettings.classList.contains('active');
    switchTab(isCurrentlySettings ? 'subtitles' : 'settings');
  });

  if (DOM.switchAppPower) {
    DOM.switchAppPower.addEventListener('change', (e) => {
      const isChecked = e.target.checked;

      setAppCollapseState(!isChecked, true);
    });
  }

  if (DOM.subtitlesViewport) {
    DOM.subtitlesViewport.addEventListener('scroll', () => {
      const el = DOM.subtitlesViewport;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distanceFromBottom <= SCROLL_THRESHOLD;
      isUserAtBottom = atBottom;

      if (atBottom) {
        if (DOM.btnScrollToLatest) {
          DOM.btnScrollToLatest.classList.add('hidden');
        }
      } else {

        if (transcriptUnits.length > 0 && DOM.btnScrollToLatest) {
          DOM.btnScrollToLatest.classList.remove('hidden');
        }
      }
    });
  }

  if (DOM.btnScrollToLatest) {
    DOM.btnScrollToLatest.addEventListener('click', () => {
      autoScrollEnabled = true;
      DOM.switchAutoScroll.checked = true;
      saveSettings({ autoScroll: true });

      const el = DOM.subtitlesViewport;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        isUserAtBottom = true;
        DOM.btnScrollToLatest.classList.add('hidden');
      }
    });
  }

  if (DOM.checkShowEnglish) {
    DOM.checkShowEnglish.addEventListener('change', async (e) => {
      const show = e.target.checked;
      updateShowEnglishUI(show);
      await saveSettings({ showEnglishParallel: show });
    });
  }

  DOM.selectMicDevice.addEventListener('change', async (e) => {
    const deviceId = e.target.value;
    appSettings.selectedMicId = deviceId;
    await saveSettings({ selectedMicId: deviceId });

    if (isSessionActive && speechEngine) {
      try {
        await speechEngine.startAudioCapture(deviceId);
      } catch (err) {
        console.warn('Lỗi đổi micro:', err);
      }
    }
  });

  DOM.btnFontDec.addEventListener('click', () => adjustFontSize('dec'));
  DOM.btnFontInc.addEventListener('click', () => adjustFontSize('inc'));

  DOM.btnCopyAll.addEventListener('click', copyAllTranscript);

  DOM.btnClear.addEventListener('click', clearAllSubtitles);

  DOM.btnExport.addEventListener('click', exportSubtitlesToText);

  DOM.btnHeaderPopout.addEventListener('click', () => {
    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: 'OPEN_POPOUT_WINDOW' }, (res) => {
        if (chrome.runtime.lastError) {
          window.open('sidepanel.html?popout=true', '_blank', 'width=480,height=720');
        }
      });
    } else {
      window.open('sidepanel.html?popout=true', '_blank', 'width=480,height=720');
    }
  });

  if (DOM.selectSpeechEngine) {
    DOM.selectSpeechEngine.addEventListener('change', async (e) => {
      toggleGeminiKeyVisibility();
      appSettings.speechEngine = e.target.value;
      await saveSettings({ speechEngine: e.target.value });
      if (speechEngine) {
        speechEngine.engineType = e.target.value;
      }
    });
  }
  DOM.selectEngine.addEventListener('change', async (e) => {
    toggleGeminiKeyVisibility();
    appSettings.translationEngine = e.target.value;
    await saveSettings({ translationEngine: e.target.value });
  });

  if (DOM.inputGeminiKey) {
    DOM.inputGeminiKey.addEventListener('input', (e) => {
      const val = e.target.value.trim().replace(/^["']|["']$/g, '');
      appSettings.geminiApiKey = val;
      saveSettings({ geminiApiKey: val });
      if (DOM.geminiKeyStatus) {
        DOM.geminiKeyStatus.classList.add('hidden');
      }
    });
  }

  if (DOM.btnTestGeminiKey) {
    DOM.btnTestGeminiKey.addEventListener('click', async () => {
      const rawKey = DOM.inputGeminiKey ? DOM.inputGeminiKey.value.trim().replace(/^["']|["']$/g, '') : '';
      if (!rawKey) {
        if (DOM.geminiKeyStatus) {
          DOM.geminiKeyStatus.textContent = 'Vui lòng dán API Key trước khi kiểm tra!';
          DOM.geminiKeyStatus.className = 'key-status-msg error';
          DOM.geminiKeyStatus.classList.remove('hidden');
        }
        return;
      }

      if (DOM.geminiKeyStatus) {
        DOM.geminiKeyStatus.textContent = 'Đang kiểm tra kết nối với Google AI Studio...';
        DOM.geminiKeyStatus.className = 'key-status-msg loading';
        DOM.geminiKeyStatus.classList.remove('hidden');
      }
      DOM.btnTestGeminiKey.disabled = true;

      try {
        const testRes = await testGeminiConnection(rawKey);
        if (testRes.ok) {
          DOM.geminiKeyStatus.textContent = `✓ ${testRes.message
}`;
          DOM.geminiKeyStatus.className = 'key-status-msg success';
          appSettings.geminiApiKey = rawKey;
          await saveSettings({ geminiApiKey: rawKey });
        } else {
          DOM.geminiKeyStatus.textContent = `✕ ${testRes.message
}`;
          DOM.geminiKeyStatus.className = 'key-status-msg error';
        }
      } catch (err) {
        DOM.geminiKeyStatus.textContent = `✕ Lỗi: ${err.message || 'Không thể kết nối'
}`;
        DOM.geminiKeyStatus.className = 'key-status-msg error';
      } finally {
        DOM.btnTestGeminiKey.disabled = false;
        DOM.geminiKeyStatus.classList.remove('hidden');
      }
    });
  }

  if (DOM.btnClearGeminiKey) {
    DOM.btnClearGeminiKey.addEventListener('click', async () => {
      if (DOM.inputGeminiKey) {
        DOM.inputGeminiKey.value = '';
      }
      appSettings.geminiApiKey = '';
      await saveSettings({ geminiApiKey: '' });
      if (DOM.geminiKeyStatus) {
        DOM.geminiKeyStatus.textContent = 'Đã xóa API Key khỏi bộ nhớ.';
        DOM.geminiKeyStatus.className = 'key-status-msg loading';
        DOM.geminiKeyStatus.classList.remove('hidden');
        setTimeout(() => {
          DOM.geminiKeyStatus.classList.add('hidden');
        }, 1500);
      }
    });
  }

  DOM.btnSaveConfig.addEventListener('click', async () => {
    const newSpeechEngine = DOM.selectSpeechEngine ? DOM.selectSpeechEngine.value : 'web-speech';
    const newEngine = DOM.selectEngine.value;
    const newKey = DOM.inputGeminiKey.value.trim();
    const newDialect = DOM.selectDialect.value;
    const newSaveHistory = DOM.checkSaveHistory.checked;

    appSettings.speechEngine = newSpeechEngine;
    appSettings.translationEngine = newEngine;
    appSettings.geminiApiKey = newKey;
    appSettings.englishDialect = newDialect;
    appSettings.saveHistoryToDisk = newSaveHistory;

    await saveSettings({
      speechEngine: newSpeechEngine,
      translationEngine: newEngine,
      geminiApiKey: newKey,
      englishDialect: newDialect,
      saveHistoryToDisk: newSaveHistory
    });

    if (speechEngine) {
      speechEngine.language = newDialect;
      speechEngine.engineType = newSpeechEngine;
    }

    const originalBtnText = DOM.btnSaveConfig.textContent;
    DOM.btnSaveConfig.textContent = 'Đã lưu cài đặt!';
    setTimeout(() => {
      DOM.btnSaveConfig.textContent = originalBtnText;
      switchTab('subtitles');
    }, 450);
  });

  window.addEventListener('beforeunload', () => {
    if (speechEngine) {
      speechEngine.stop();
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
