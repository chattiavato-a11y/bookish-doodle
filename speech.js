// speech.js
// Centralized speech controls (STT + TTS) for the chat experience.
// - Browser-native only (no vendors)
// - Secure-context guard (HTTPS/localhost)
// - Detailed error messages
// - Debounced start()
// - Optional sanitization via window.Shield
// - Plugs into UI via inputEl + callbacks

const LANG_FALLBACKS = {
  en: 'en-US',
  es: 'es-419' // prefer LatAm; browser will fall back if unsupported
};

export class SpeechController {
  constructor({
    inputEl,
    statusEl,
    warnEl,
    micBtn,
    ttsBtn,
    state,
    onFinalTranscript, // (text) => void
    onInterim          // (text) => void
  } = {}) {
    this.inputEl   = inputEl  || null;
    this.statusEl  = statusEl || null;
    this.warnEl    = warnEl   || null;
    this.micBtn    = micBtn   || null;
    this.ttsBtn    = ttsBtn   || null;

    this.state     = state || {};
    this.onFinalTranscript = typeof onFinalTranscript === 'function' ? onFinalTranscript : null;
    this.onInterim = typeof onInterim === 'function' ? onInterim : null;

    // STT
    this.recognition   = null;
    this.recLang       = this.languageFor(this.state?.lang || 'en');
    this.recActive     = false;
    this.finalTranscript = '';
    this._startAt      = 0; // debounce guard

    // TTS
    this.synth      = ('speechSynthesis' in window) ? window.speechSynthesis : null;
    this.voices     = [];
    this.ttsEnabled = Boolean(this.state?.ttsEnabled);

    this.initRecognition();
    this.initSynthesis();
    this.bindButtons();
  }

  // ---------- Lang helpers ----------
  languageFor(code) {
    return LANG_FALLBACKS[code] || `${code || 'en'}-US`;
  }
  setLang(code) {
    this.recLang = this.languageFor(code);
    if (this.recognition) this.recognition.lang = this.recLang;
  }

  // ---------- Sanitization helper ----------
  sanitizeText(text) {
    try {
      if (window.Shield?.scanAndSanitize) {
        const r = window.Shield.scanAndSanitize(text, { maxLen: 2000, threshold: 12 });
        if (!r.ok) {
          this.warn(`Blocked suspicious input: ${r.reasons?.join(', ') || 'policy'}`);
          return '';
        }
        return r.sanitized || '';
      }
      // fallback light scrub
      return String(text || '').replace(/[<>]/g, c => (c === '<' ? '&lt;' : '&gt;')).trim();
    } catch {
      return String(text || '').trim();
    }
  }

  // ---------- UI helpers ----------
  setStatus(msg) { if (this.statusEl) this.statusEl.textContent = msg; }
  warn(msg) { if (this.warnEl) this.warnEl.textContent = msg; }

  // ---------- STT ----------
  initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition || !this.micBtn) {
      if (this.micBtn) {
        this.micBtn.disabled = true;
        this.micBtn.title = 'Speech recognition unavailable in this browser.';
      }
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = this.recLang;

    rec.addEventListener('start', () => {
      this.recActive = true;
      this.setStatus('Listening…');
      if (this.micBtn) this.micBtn.setAttribute('aria-pressed', 'true');
      this.finalTranscript = '';
      this.warn('');
    });

    rec.addEventListener('result', (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0]?.transcript || '';
        if (res.isFinal) {
          this.finalTranscript += text + ' ';
        } else {
          interim += text;
        }
      }
      const cur = (this.finalTranscript + interim).trim();
      if (cur) {
        if (this.inputEl) {
          this.inputEl.value = cur;
          this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (this.onInterim) this.onInterim(cur);
      }
    });

    rec.addEventListener('error', (event) => {
      const map = {
        'no-speech': 'No speech detected. Try again closer to the mic.',
        'audio-capture': 'No microphone available or not selected.',
        'not-allowed': 'Microphone blocked. Allow mic permissions in the browser.',
        'service-not-allowed': 'Speech service disabled by the browser.',
        'aborted': 'Recognition aborted (another start/stop).',
        'network': 'Browser STT service had a network error.',
        'bad-grammar': 'Grammar issue (ignore if not using SRGS).',
        'language-not-supported': 'Language not supported by this browser.',
        'invalid-state': 'Recognition already running (debounced).'
      };
      const detail = map[event?.error] || `Speech recognition error: ${event?.error || 'unknown'}`;
      this.warn(detail);
      this.stopRecognition();
      this.setStatus('Ready.');
    });

    rec.addEventListener('end', () => {
      // 'end' fires for both success and abort/error
      if (this.micBtn) this.micBtn.setAttribute('aria-pressed', 'false');
      this.recActive = false;
      this.setStatus('Ready.');

      const finalText = this.finalTranscript.trim();
      if (!finalText) return;

      const clean = this.sanitizeText(finalText);
      if (!clean) return;

      if (typeof this.onFinalTranscript === 'function') {
        this.onFinalTranscript(clean);
      } else if (this.inputEl) {
        this.inputEl.value = clean;
        this.inputEl.focus();
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    this.recognition = rec;
  }

  startRecognition() {
    if (!this.recognition || this.recActive) return;

    // debounce starts (prevents invalid-state/aborted churn)
    const now = Date.now();
    if (now - this._startAt < 600) return;
    this._startAt = now;

    // Secure context guard (HTTPS or localhost)
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecureContext && !isLocalhost) {
      this.warn('Speech input needs HTTPS or localhost.');
      this.setStatus('Ready.');
      return;
    }

    try {
      this.recognition.lang = this.recLang;
      this.recognition.start();
      if (this.micBtn) this.micBtn.focus();
      this.warn('');
    } catch {
      this.warn('Unable to start speech recognition.');
    }
  }

  stopRecognition() {
    if (!this.recognition) return;
    try { this.recognition.stop(); } catch { /* no-op */ }
    this.recActive = false;
    if (this.micBtn) this.micBtn.setAttribute('aria-pressed', 'false');
    if (this.statusEl && this.statusEl.textContent === 'Listening…') {
      this.statusEl.textContent = 'Ready.';
    }
  }

  // ---------- TTS ----------
  initSynthesis() {
    if (!this.synth || !this.ttsBtn) {
      if (this.ttsBtn) {
        this.ttsBtn.disabled = true;
        this.ttsBtn.title = 'Text-to-speech unavailable in this browser.';
      }
      return;
    }
    const loadVoices = () => { this.voices = this.synth.getVoices(); };
    loadVoices();
    this.synth.addEventListener('voiceschanged', loadVoices);
  }

  bindButtons() {
    if (this.micBtn) {
      this.micBtn.type = 'button';
      this.micBtn.addEventListener('click', () => {
        if (this.recActive) this.stopRecognition();
        else this.startRecognition();
      });
    }

    if (this.ttsBtn) {
      this.ttsBtn.type = 'button';
      this.ttsBtn.setAttribute('aria-pressed', String(this.ttsEnabled));
      this.ttsBtn.addEventListener('click', () => {
        this.ttsEnabled = !this.ttsEnabled;
        if (this.state) this.state.ttsEnabled = this.ttsEnabled;
        this.ttsBtn.setAttribute('aria-pressed', String(this.ttsEnabled));
        this.ttsBtn.textContent = this.ttsEnabled ? '🔊 On' : '🔇 Off';
        if (!this.ttsEnabled) this.cancelSpeech();
      });
      this.ttsBtn.textContent = this.ttsEnabled ? '🔊 On' : '🔇 Off';
    }
  }

  narrationVoice(langCode) {
    if (!this.voices || !this.voices.length) return null;
    const target = this.languageFor(langCode);
    const exact = this.voices.find(v => v.lang === target);
    if (exact) return exact;
    const base = target.split('-')[0];
    return this.voices.find(v => v.lang && v.lang.startsWith(base)) || null;
  }

  narrateAssistant(text, langCode) {
    if (!this.ttsEnabled || !this.synth || !text) return;
    const utter = new SpeechSynthesisUtterance(text);
    const lang = langCode || this.state?.lang || 'en';
    utter.lang = this.languageFor(lang);
    const voice = this.narrationVoice(lang);
    if (voice) utter.voice = voice;
    try { this.synth.cancel(); } catch {/* no-op */}
    this.synth.speak(utter);
  }

  cancelSpeech() {
    try { if (this.synth) this.synth.cancel(); } catch {/* no-op */}
  }
}
