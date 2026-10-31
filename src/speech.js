export const SPEECH_STATES = {
  IDLE: 'idle',
  REQUESTING_MIC: 'requesting_mic',
  LISTENING: 'listening',
  PAUSED_SILENCE: 'paused_silence',
  RECONNECTING: 'reconnecting',
  NETWORK_ERROR: 'network_error',
  ERROR: 'error',
  PERMISSION_DENIED: 'permission_denied',
  STOPPED: 'stopped'
};

export const GEMINI_STT_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.0-flash-exp',
  'gemini-1.5-pro'
];

let cachedWorkingSTTModel = null;

export async function isBraveBrowser() {
  if (typeof navigator !== 'undefined') {
    if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
      try {
        return await navigator.brave.isBrave();
      } catch (e) {
        return false;
      }
    }
  }
  return false;
}

export class SpeechEngine {

  constructor(options = {}) {
    this.onStateChange = options.onStateChange || (() => {});
    this.onVolumeChange = options.onVolumeChange || (() => {});
    this.onResult = options.onResult || (() => {});
    this.onTextTranscript = options.onTextTranscript || (() => {});
    this.onRecognitionEnd = options.onRecognitionEnd || (() => {});
    this.onError = options.onError || (() => {});

    this.recognition = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.gainNode = null;
    this.compressor = null;
    this.analyser = null;
    this.processedStream = null;
    this.volumeAnimationId = null;
    this.mediaRecorder = null;

    this.isListeningRequested = false;
    this.reconnectTimer = null;
    this.selectedDeviceId = '';
    this.language = 'en-US';
    this.engineType = options.engineType || 'web-speech';
    this.consecutiveNetworkErrors = 0;
    this.isRecognitionActive = false;
    this.consecutiveRestartFailures = 0;

    this.audioChunkQueue = [];
    this.isProcessingAudioQueue = false;
  }

  cleanupCurrentRecognition() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      rec.onstart = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch (e) {}
    }
    this.isRecognitionActive = false;
  }

  static openPermissionTab() {
    const url = chrome.runtime.getURL('permission.html');
    if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, '_blank');
    }
  }

  createRecognitionInstance() {
    const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('Trình duyệt Chrome của bạn chưa hỗ trợ Web Speech API.');
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = this.language;

    recognition.onstart = () => {
      this.isRecognitionActive = true;
      this.consecutiveRestartFailures = 0;
      this.consecutiveNetworkErrors = 0;
      console.log(`[NgheGiang-Diag][2.SpeechRecog] SpeechRecognition started. Lang: ${this.language}`);
      if (this.isListeningRequested) {
        this.onStateChange(SPEECH_STATES.LISTENING, 'Đang nghe giảng viên (tiếng Anh)...');
      }
    };

    recognition.onresult = (event) => {
      this.consecutiveNetworkErrors = 0;
      this.consecutiveRestartFailures = 0;
      if (this.isListeningRequested) {
        console.log(`[NgheGiang-Diag][2.SpeechRecog] Result received. Results: ${event.results.length}, resultIndex: ${event.resultIndex}`);
        this.onResult(event);
      }
    };

    recognition.onerror = async (event) => {
      const errType = event.error || '';

      if (errType === 'no-speech' || errType === 'aborted') {
        return;
      }

      console.warn(`[NgheGiang-Diag][2.SpeechRecog] Recognition notice: ${errType}`);

      if (errType === 'not-allowed') {
        this.isListeningRequested = false;
        this.stopAudioCapture();
        this.cleanupCurrentRecognition();
        this.onStateChange(
          SPEECH_STATES.PERMISSION_DENIED,
          'Quyền micro bị từ chối hoặc chưa được cấp cho tiện ích.'
        );
        return;
      }

      if (errType === 'audio-capture') {
        this.consecutiveRestartFailures = (this.consecutiveRestartFailures || 0) + 1;
        if (this.consecutiveRestartFailures >= 3) {
          this.isListeningRequested = false;
          this.stopAudioCapture();
          this.cleanupCurrentRecognition();
          this.onStateChange(
            SPEECH_STATES.ERROR,
            'Không tìm thấy micro hoặc micro đang bị ứng dụng khác chiếm quyền.'
          );
        } else if (this.isListeningRequested) {
          this.scheduleAutoRestart(500);
        }
        return;
      }

      if (errType === 'network') {
        this.consecutiveNetworkErrors = (this.consecutiveNetworkErrors || 0) + 1;
        const isBrave = await isBraveBrowser();

        if (isBrave) {
          this.isListeningRequested = false;
          this.stopAudioCapture();
          this.cleanupCurrentRecognition();
          const message = 'Trình duyệt Brave không kết nối được tới máy chủ nhận dạng Web Speech của Google. Bạn có thể chuyển sang chế độ "Google Gemini Audio STT" trong Cài đặt (miễn phí) để nghe trên Brave.';
          this.onStateChange(SPEECH_STATES.NETWORK_ERROR, message);
          this.onError({ type: 'network', isBrave: true, message });
          return;
        }

        if (this.consecutiveNetworkErrors < 3 && this.isListeningRequested) {
          console.warn(`[NgheGiang-Diag][2.SpeechRecog] Tạm mất kết nối Web Speech (${this.consecutiveNetworkErrors}/3). Tự động kết nối lại...`);
          this.scheduleAutoRestart(400);
          return;
        }

        this.isListeningRequested = false;
        this.stopAudioCapture();
        this.cleanupCurrentRecognition();

        let message = 'Lỗi kết nối máy chủ nhận dạng Web Speech.';
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          message = 'Không có kết nối Internet. Vui lòng kiểm tra lại đường truyền mạng.';
        } else {
          message = 'Không thể kết nối máy chủ nhận dạng Web Speech sau nhiều lần thử. Vui lòng thử lại hoặc đổi sang Google Gemini Audio STT.';
        }

        this.onStateChange(SPEECH_STATES.NETWORK_ERROR, message);
        this.onError({
          type: 'network',
          isBrave: false,
          isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
          consecutiveErrors: this.consecutiveNetworkErrors,
          message
        });
        return;
      }
    };

    recognition.onend = () => {
      this.isRecognitionActive = false;

      if (this.onRecognitionEnd) {
        try { this.onRecognitionEnd(); } catch (e) {}
      }

      if (this.isListeningRequested) {
        if (!this.isMicrophoneTrackActive()) {
          this.handleTrackFailure('Microphone track đã ngừng hoạt động.');
        } else {
          this.scheduleAutoRestart(200);
        }
      }
    };

    return recognition;
  }

  scheduleAutoRestart(delay = 200) {
    if (!this.isListeningRequested) return;

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isListeningRequested) return;

      this.cleanupCurrentRecognition();

      try {
        this.recognition = this.createRecognitionInstance();
        this.recognition.start();
        this.consecutiveRestartFailures = 0;
      } catch (err) {
        console.warn('[NgheGiang-Diag][2.SpeechRecog] Auto-restart attempt error:', err.message);
        this.consecutiveRestartFailures = (this.consecutiveRestartFailures || 0) + 1;

        if (this.isListeningRequested) {
          if (this.consecutiveRestartFailures < 4) {
            const nextDelay = Math.min(300 * Math.pow(1.5, this.consecutiveRestartFailures), 3000);
            this.scheduleAutoRestart(nextDelay);
          } else {
            console.error('[NgheGiang-Diag][2.SpeechRecog] Consecutive restart failures exceeded limit.');
            this.isListeningRequested = false;
            this.stopAudioCapture();
            this.cleanupCurrentRecognition();
            this.onStateChange(SPEECH_STATES.ERROR, 'Dịch vụ nhận dạng giọng nói tạm gián đoạn sau nhiều lần thử. Vui lòng bấm Bắt đầu nghe để thử lại.');
            if (this.onError) {
              this.onError({ type: 'restart_limit', message: 'Nhận dạng giọng nói gián đoạn.' });
            }
          }
        }
      }
    }, delay);
  }

  static async getMicrophoneDevices() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');

      return audioInputs.map((d, index) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${index + 1
}`
      }));
    } catch (err) {
      console.warn('[NgheGiang] Lỗi khi lấy danh sách micro:', err);
      return [];
    }
  }

  isMicrophoneTrackActive() {
    if (!this.mediaStream) return false;
    const tracks = this.mediaStream.getAudioTracks();
    return tracks.length > 0 && tracks.some(t => t.readyState === 'live' && t.enabled);
  }

  handleTrackFailure(message) {
    console.warn('[NgheGiang-Diag][1.AudioCapture] Track failure:', message);
    this.isListeningRequested = false;
    this.stopAudioCapture();
    this.cleanupCurrentRecognition();
    this.onStateChange(SPEECH_STATES.ERROR, message);
    if (this.onError) {
      this.onError({ type: 'track_ended', message });
    }
  }

  async startAudioCapture(deviceId = '') {
    this.stopAudioCapture();

    const constraints = {
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000, min: 16000 }
      }
    };

    if (deviceId) {
      constraints.audio.deviceId = { ideal: deviceId };
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      const audioTracks = this.mediaStream.getAudioTracks();
      if (!audioTracks || audioTracks.length === 0) {
        throw new Error('NO_AUDIO_TRACK');
      }

      const primaryTrack = audioTracks[0];
      primaryTrack.onended = () => {
        console.warn('[NgheGiang-Diag][1.AudioCapture] Audio track ended unexpectedly.');
        if (this.isListeningRequested) {
          this.handleTrackFailure('Microphone đã bị ngắt kết nối hoặc bị ứng dụng khác đóng.');
        }
      };
      primaryTrack.onmute = () => {
        console.warn('[NgheGiang-Diag][1.AudioCapture] Audio track muted.');
        if (this.isListeningRequested) {
          this.onStateChange(SPEECH_STATES.PAUSED_SILENCE, 'Micro bị ngắt tiếng (Muted)...');
        }
      };
      primaryTrack.onunmute = () => {
        console.log('[NgheGiang-Diag][1.AudioCapture] Audio track unmuted.');
        if (this.isListeningRequested && this.isRecognitionActive) {
          this.onStateChange(SPEECH_STATES.LISTENING, 'Đang nghe giảng viên (tiếng Anh)...');
        }
      };

      console.log(`[NgheGiang-Diag][1.AudioCapture] Micro stream acquired. DeviceId: ${deviceId || 'default'}, Tracks: ${audioTracks.length}`);

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioContext = new AudioCtx();
        const source = this.audioContext.createMediaStreamSource(this.mediaStream);

        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.setValueAtTime(1.35, this.audioContext.currentTime);

        this.compressor = this.audioContext.createDynamicsCompressor();
        this.compressor.threshold.setValueAtTime(-42, this.audioContext.currentTime);
        this.compressor.knee.setValueAtTime(20, this.audioContext.currentTime);
        this.compressor.ratio.setValueAtTime(3.5, this.audioContext.currentTime);
        this.compressor.attack.setValueAtTime(0.003, this.audioContext.currentTime);
        this.compressor.release.setValueAtTime(0.25, this.audioContext.currentTime);

        source.connect(this.gainNode);
        this.gainNode.connect(this.compressor);

        if (this.audioContext.createMediaStreamDestination) {
          const dest = this.audioContext.createMediaStreamDestination();
          this.compressor.connect(dest);
          this.processedStream = dest.stream;
        }

        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        this.compressor.connect(this.analyser);

        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const checkVolume = () => {
          if (!this.analyser || !this.isListeningRequested) {
            this.onVolumeChange(0);
            return;
          }

          this.analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          const average = sum / bufferLength;

          const normalized = Math.min(1.0, Math.max(0.0, (average / 115) * 1.8));
          this.onVolumeChange(normalized);

          this.volumeAnimationId = requestAnimationFrame(checkVolume);
        };

        checkVolume();
      }
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        throw err;
      }
      console.warn('[NgheGiang] AudioCapture VU meter warning:', err.message);
    }
  }

  stopAudioCapture() {
    if (this.mediaStream) {
      console.log('[NgheGiang-Diag][1.AudioCapture] Stopping hardware microphone stream.');
    }
    if (this.volumeAnimationId) {
      cancelAnimationFrame(this.volumeAnimationId);
      this.volumeAnimationId = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => {
        track.onended = null;
        track.onmute = null;
        track.onunmute = null;
        try {
          track.stop();
        } catch (e) {}
      });
      this.mediaStream = null;
    }

    if (this.processedStream) {
      this.processedStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (e) {}
      });
      this.processedStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
      this.gainNode = null;
      this.compressor = null;
      this.analyser = null;
    }

    this.onVolumeChange(0);
  }

  async startGeminiAudioSTT(apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new Error('MISSING_GEMINI_KEY');
    }

    if (!this.mediaStream) {
      throw new Error('Micro chưa được kết nối.');
    }

    const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');

    const streamToRecord = this.processedStream || this.mediaStream;

    let mimeType = 'audio/webm;codecs=opus';
    if (typeof MediaRecorder !== 'undefined') {
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      }
      this.mediaRecorder = mimeType ? new MediaRecorder(streamToRecord, { mimeType }) : new MediaRecorder(streamToRecord);
    } else {
      throw new Error('Trình duyệt không hỗ trợ MediaRecorder.');
    }

    this.audioChunkQueue = [];
    this.isProcessingAudioQueue = false;

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 800 && this.isListeningRequested) {
        this.audioChunkQueue.push(e.data);
        this.processAudioChunkQueue(cleanKey);
      }
    };

    this.mediaRecorder.start(2200);
    console.log('[NgheGiang-Diag][2.SpeechRecog] Gemini Audio STT MediaRecorder active (2.2s slices).');
  }

  async processAudioChunkQueue(cleanKey) {
    if (this.isProcessingAudioQueue || this.audioChunkQueue.length === 0) return;
    this.isProcessingAudioQueue = true;

    try {
      while (this.audioChunkQueue.length > 0 && this.isListeningRequested) {
        if (this.audioChunkQueue.length > 5) {
          console.warn(`[NgheGiang-Diag][2.SpeechRecog] Audio queue đang dồn ${this.audioChunkQueue.length
} chunks, đang điều tiết...`);
          this.audioChunkQueue.shift();
        }

        const chunkBlob = this.audioChunkQueue.shift();
        await this.transcribeAudioChunk(chunkBlob, cleanKey);
      }
    } finally {
      this.isProcessingAudioQueue = false;
    }
  }

  async transcribeAudioChunk(audioBlob, apiKey) {
    if (!this.isListeningRequested) return;

    try {
      const buffer = await audioBlob.arrayBuffer();
      const base64Audio = arrayBufferToBase64(buffer);

      const cleanMime = (audioBlob.type || 'audio/webm').split(';')[0].trim() || 'audio/webm';

      const modelsToTry = cachedWorkingSTTModel
        ? [cachedWorkingSTTModel, ...GEMINI_STT_MODELS.filter(m => m !== cachedWorkingSTTModel)]
        : GEMINI_STT_MODELS;

      let transcribedText = '';
      let lastErrorMessage = '';

      for (const model of modelsToTry) {
        if (!this.isListeningRequested) break;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model
}:generateContent?key=${encodeURIComponent(apiKey)
}`;
        const payload = {
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: cleanMime,
                    data: base64Audio
                  }
                },
                {
                  text: "You are an English speech recognition system for lecture audio. Transcribe verbatim only the clear spoken English words. If there is only silence, noise, breathing, or non-English speech, return EMPTY. Output strictly the transcribed words, without timestamps, quotes, or markdown."
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 120
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
          ]
        };

        const timeoutCtrl = new AbortController();
        const timeoutTimer = setTimeout(() => timeoutCtrl.abort(), 7500);

        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey
            },
            body: JSON.stringify(payload),
            signal: timeoutCtrl.signal
          });

          clearTimeout(timeoutTimer);

          if (!res.ok) {
            const errBody = await res.text();
            let parsedMsg = `HTTP ${res.status
}`;
            try {
              const errJson = JSON.parse(errBody);
              parsedMsg = errJson.error?.message || parsedMsg;
            } catch (_) {}

            lastErrorMessage = parsedMsg;
            console.warn(`[NgheGiang-Diag][2.SpeechRecog] Gemini Audio STT (${model
}) error ${res.status
}: ${parsedMsg
}`);

            if (res.status === 404) {
              cachedWorkingSTTModel = null;
              continue;
            }
            break;
          }

          cachedWorkingSTTModel = model;
          const data = await res.json();
          transcribedText = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
          break;
        } catch (fetchErr) {
          clearTimeout(timeoutTimer);
          if (fetchErr.name === 'AbortError') {
            console.warn(`[NgheGiang-Diag][2.SpeechRecog] Gemini Audio STT (${model
}) timeout sau 7.5s`);
          } else {
            console.warn(`[NgheGiang-Diag][2.SpeechRecog] Gemini Audio STT (${model
}) fetch error:`, fetchErr.message);
          }
          lastErrorMessage = fetchErr.message;
        }
      }

      if (transcribedText && transcribedText !== 'EMPTY' && !transcribedText.toUpperCase().includes('EMPTY') && this.isListeningRequested) {
        console.log(`[NgheGiang-Diag][2.SpeechRecog] Gemini STT transcribed segment: "${transcribedText
}"`);
        if (this.onTextTranscript) {
          this.onTextTranscript(transcribedText);
        }
      } else if (!transcribedText && lastErrorMessage && this.isListeningRequested) {
        if (lastErrorMessage.includes('API_KEY_INVALID') || lastErrorMessage.includes('API key not valid')) {
          this.onStateChange(SPEECH_STATES.ERROR, 'Gemini API Key không hợp lệ. Vui lòng kiểm tra lại trong Cài đặt.');
        } else if (lastErrorMessage.includes('RESOURCE_EXHAUSTED') || lastErrorMessage.includes('429')) {
          this.onStateChange(SPEECH_STATES.ERROR, 'Gemini API hết hạn mức request (Rate limit). Vui lòng đợi giây lát.');
        }
      }
    } catch (err) {
      console.warn('[NgheGiang-Diag][2.SpeechRecog] Gemini STT chunk error:', err.message);
    }
  }

  async start(options = {}) {
    this.selectedDeviceId = options.deviceId || '';
    if (options.language) {
      this.language = options.language;
    }
    if (options.engineType) {
      this.engineType = options.engineType;
    }

    this.onStateChange(SPEECH_STATES.REQUESTING_MIC, 'Đang kết nối micro...');

    try {
      await this.startAudioCapture(this.selectedDeviceId);
    } catch (err) {
      this.isListeningRequested = false;
      this.stopAudioCapture();

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        this.onStateChange(
          SPEECH_STATES.PERMISSION_DENIED,
          'Cần cấp quyền micro cho tiện ích. Bấm vào nút bên dưới để mở trang cấp quyền.'
        );
        throw new Error('PERMISSION_REQUIRED');
      } else {
        this.onStateChange(SPEECH_STATES.ERROR, `Lỗi micro: ${err.message || err.name
}`);
        throw err;
      }
    }

    if (this.engineType === 'gemini-stt') {
      try {
        await this.startGeminiAudioSTT(options.geminiApiKey);
        this.isListeningRequested = true;
        this.onStateChange(SPEECH_STATES.LISTENING, 'Đang nghe bài giảng (Gemini Audio)...');
        return;
      } catch (geminiErr) {
        this.isListeningRequested = false;
        this.stopAudioCapture();
        if (geminiErr.message === 'MISSING_GEMINI_KEY') {
          this.onStateChange(
            SPEECH_STATES.ERROR,
            'Chưa có Gemini API Key. Vui lòng vào Cài đặt để nhập API Key miễn phí từ Google AI Studio.'
          );
        } else {
          this.onStateChange(SPEECH_STATES.ERROR, `Lỗi khởi động Gemini Audio: ${geminiErr.message
}`);
        }
        throw geminiErr;
      }
    }

    return new Promise((resolve, reject) => {
      let startupResolved = false;
      const timeoutTimer = setTimeout(() => {
        if (!startupResolved) {
          startupResolved = true;
          this.isListeningRequested = true;
          resolve();
        }
      }, 3500);

      try {
        this.cleanupCurrentRecognition();
        this.consecutiveRestartFailures = 0;
        this.consecutiveNetworkErrors = 0;
        this.recognition = this.createRecognitionInstance();

        const origOnStart = this.recognition.onstart;
        this.recognition.onstart = () => {
          clearTimeout(timeoutTimer);
          if (!startupResolved) {
            startupResolved = true;
            this.isListeningRequested = true;
            resolve();
          }
          if (origOnStart) origOnStart();
        };

        const origOnError = this.recognition.onerror;
        this.recognition.onerror = async (event) => {
          if (!startupResolved && event.error !== 'no-speech') {
            clearTimeout(timeoutTimer);
            startupResolved = true;
            this.isListeningRequested = false;
            this.stopAudioCapture();
            const isBrave = await isBraveBrowser();
            const err = new Error(event.error);
            err.type = event.error;
            err.isBrave = isBrave;
            reject(err);
          }
          if (origOnError) origOnError(event);
        };

        this.recognition.start();
      } catch (recErr) {
        startupResolved = true;
        this.isListeningRequested = false;
        this.stopAudioCapture();

        if (recErr.name === 'NotAllowedError' || recErr.message?.includes('not-allowed')) {
          this.onStateChange(
            SPEECH_STATES.PERMISSION_DENIED,
            'Quyền nhận dạng micro bị từ chối. Vui lòng cấp quyền micro cho tiện ích.'
          );
          reject(new Error('PERMISSION_REQUIRED'));
        } else {
          this.onStateChange(SPEECH_STATES.ERROR, `Không thể khởi động Web Speech: ${recErr.message
}`);
          reject(recErr);
        }
      }
    });
  }

  stop() {
    this.isListeningRequested = false;
    this.consecutiveRestartFailures = 0;

    this.audioChunkQueue = [];
    this.isProcessingAudioQueue = false;

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch (e) {}
      this.mediaRecorder = null;
    }

    this.cleanupCurrentRecognition();

    this.stopAudioCapture();
    this.onStateChange(SPEECH_STATES.STOPPED, 'Đã dừng nghe. Micro đã tắt.');
  }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
