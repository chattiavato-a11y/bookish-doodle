// speech.js
// Centralized speech controls (STT + TTS) for the chat experience.

const LANG_FALLBACKS = {
  en: 'en-US',
  es: 'es-ES'
};

export class SpeechController {
  constructor({ inputEl, statusEl, warnEl, micBtn, ttsBtn, state, onFinalTranscript }) {
    this.inputEl = inputEl;
    this.statusEl = statusEl;
    this.warnEl = warnEl;
    this.micBtn = micBtn;
    this.ttsBtn = ttsBtn;
    this.state = state || {};
    this.onFinalTranscript = onFinalTranscript || null;

    this.recognition = null;
    this.recLang = this.languageFor(state?.lang || 'en');
    this.recActive = false;
    this.finalTranscript = '';

    this.synth = ('speechSynthesis' in window) ? window.speechSynthesis : null;
    this.voices = [];
    this.ttsEnabled = Boolean(state?.ttsEnabled);

    this.initRecognition();
    this.initSynthesis();
    this.bindButtons();
  }

  languageFor(code) {
    return LANG_FALLBACKS[code] || `${code || 'en'}-US`;
  }

  setLang(code) {
    this.recLang = this.languageFor(code);
    if (this.recognition) {
      this.recognition.lang = this.recLang;
    }
  }

  initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition || !this.micBtn) {
      if (this.micBtn) {
        this.micBtn.disabled = true;
        this.micBtn.title = 'Speech recognition unavailable in this browser.';
      }
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = this.recLang;

    recognition.addEventListener('start', () => {
      this.recActive = true;
      if (this.statusEl) this.statusEl.textContent = 'Listening…';
      if (this.micBtn) this.micBtn.setAttribute('aria-pressed', 'true');
      this.finalTranscript = '';
    });

    recognition.addEventListener('result', (event) => {
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
      const current = (this.finalTranscript + interim).trim();
      if (current && this.inputEl) {
        this.inputEl.value = current;
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    recognition.addEventListener('error', (event) => {
      const msg = event.error === 'not-allowed'
        ? 'Microphone access denied. Enable permissions to use speech input.'
        : 'Speech recognition issue. Please retry.';
      if (this.warnEl) this.warnEl.textContent = msg;
      this.stopRecognition();
    });

    recognition.addEventListener('end', () => {
      if (!this.recActive) return;
      this.recActive = false;
      if (this.micBtn) this.micBtn.setAttribute('aria-pressed', 'false');
      if (this.statusEl) this.statusEl.textContent = 'Ready.';
      const finalText = this.finalTranscript.trim();
      if (finalText) {
        if (typeof this.onFinalTranscript === 'function') {
          this.onFinalTranscript(finalText);
        } else if (this.inputEl) {
          this.inputEl.value = finalText;
          this.inputEl.focus();
        }
      }
    });

    this.recognition = recognition;
  }

  initSynthesis() {
    if (!this.synth || !this.ttsBtn) {
      if (this.ttsBtn) {
        this.ttsBtn.disabled = true;
        this.ttsBtn.title = 'Text-to-speech unavailable in this browser.';
      }
      return;
    }

    const loadVoices = () => {
      this.voices = this.synth.getVoices();
    };
    loadVoices();
    this.synth.addEventListener('voiceschanged', loadVoices);
  }

  bindButtons() {
    if (this.micBtn) {
      this.micBtn.type = 'button';
      this.micBtn.addEventListener('click', () => {
        if (this.recActive) {
          this.stopRecognition();
        } else {
          this.startRecognition();
        }
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

  startRecognition() {
    if (!this.recognition || this.recActive) return;
    try {
      this.recognition.lang = this.recLang;
      this.recognition.start();
      if (this.micBtn) this.micBtn.focus();
      if (this.warnEl) this.warnEl.textContent = '';
    } catch (err) {
      if (this.warnEl) this.warnEl.textContent = 'Unable to start speech recognition.';
    }
  }

  stopRecognition() {
    if (!this.recognition) return;
    try {
      this.recognition.stop();
    } catch (err) {
      /* no-op */
    }
    this.recActive = false;
    if (this.micBtn) this.micBtn.setAttribute('aria-pressed', 'false');
    if (this.statusEl && this.statusEl.textContent === 'Listening…') {
      this.statusEl.textContent = 'Ready.';
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
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = this.languageFor(langCode || this.state?.lang || 'en');
    const voice = this.narrationVoice(langCode || this.state?.lang || 'en');
    if (voice) utterance.voice = voice;
    this.synth.cancel();
    this.synth.speak(utterance);
  }

  cancelSpeech() {
    if (this.synth) {
      this.synth.cancel();
    }
  }
}
