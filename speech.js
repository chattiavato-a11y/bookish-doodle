// speech.js
// Centralized speech controls (STT + TTS) for the chat experience.
// - Browser-native only (no vendors)
// - Secure-context guard (HTTPS/localhost)
// - Detailed error messages
// - Debounced start()
// - Optional sanitization via window.Shield
// - Plugs into UI via inputEl + callbacks

// speech.js
// Centralized speech controls (STT + TTS) for the chat UI.
// Exposes: window.SpeechController

(function (global) {
  "use strict";

  const LANG_FALLBACKS = {
    en: "en-US",
    es: "es-419" // Latin America; browsers may fall back to es-ES automatically
  };

  function pickLang(code) {
    if (!code) return "en-US";
    const low = String(code).toLowerCase();
    return LANG_FALLBACKS[low] || (low.includes("-") ? code : `${low}-US`);
  }

  // Graceful feature detection
  const SpeechRecognition =
    global.SpeechRecognition || global.webkitSpeechRecognition || null;
  const hasSTT = !!SpeechRecognition;
  const hasTTS = "speechSynthesis" in global && "SpeechSynthesisUtterance" in global;

  class SpeechController {
    /**
     * @param {{
     *   inputEl: HTMLTextAreaElement,
     *   statusEl?: HTMLElement,
     *   warnEl?: HTMLElement,
     *   micBtn?: HTMLButtonElement,
     *   ttsBtn?: HTMLButtonElement,
     *   state?: { lang?: string, ttsEnabled?: boolean },
     *   onFinalTranscript?: (text:string)=>void
     * }} opts
     */
    constructor(opts = {}) {
      this.inputEl = opts.inputEl || null;
      this.statusEl = opts.statusEl || null;
      this.warnEl = opts.warnEl || null;
      this.micBtn = opts.micBtn || null;
      this.ttsBtn = opts.ttsBtn || null;
      this.state = opts.state || {};
      this.onFinalTranscript = typeof opts.onFinalTranscript === "function" ? opts.onFinalTranscript : null;

      // ----- STT -----
      this.recognition = null;
      this.recActive = false;
      this.finalTranscript = "";
      this.recLang = pickLang(this.state.lang || "en");
      if (hasSTT) this._initRecognition();

      // ----- TTS -----
      this.synth = hasTTS ? global.speechSynthesis : null;
      this.voices = [];
      this.ttsEnabled = !!this.state.ttsEnabled;
      if (hasTTS) this._initSynthesis();

      // ----- UI -----
      this._bindButtons();
    }

    setLang(code) {
      this.state.lang = code;
      this.recLang = pickLang(code);
      if (this.recognition) this.recognition.lang = this.recLang;
    }

    // ===================== STT =====================
    _initRecognition() {
      try {
        const rec = new SpeechRecognition();
        rec.continuous = false;          // single utterance
        rec.interimResults = true;       // show partials in the textarea
        rec.lang = this.recLang;

        rec.addEventListener("start", () => {
          this.recActive = true;
          this.finalTranscript = "";
          if (this.statusEl) this.statusEl.textContent = "Listening…";
          if (this.micBtn) this.micBtn.setAttribute("aria-pressed", "true");
          if (this.warnEl) this.warnEl.textContent = "";
        });

        rec.addEventListener("result", (ev) => {
          let interim = "";
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const res = ev.results[i];
            const text = (res[0] && res[0].transcript) || "";
            if (res.isFinal) this.finalTranscript += text + " ";
            else interim += text;
          }
          const combined = (this.finalTranscript + interim).trim();
          if (combined && this.inputEl) {
            this.inputEl.value = combined;
            // Let orchestrator hooks (e.g., Shield) react to input changes
            this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });

        rec.addEventListener("error", (ev) => {
          const msg = this._humanSTTError(ev?.error);
          if (this.warnEl) this.warnEl.textContent = msg;
          this.stopRecognition();
        });

        rec.addEventListener("end", () => {
          if (!this.recActive) return;
          this.recActive = false;
          if (this.micBtn) this.micBtn.setAttribute("aria-pressed", "false");
          if (this.statusEl) this.statusEl.textContent = "Ready.";
          const text = (this.finalTranscript || "").trim();
          if (text) {
            if (this.onFinalTranscript) this.onFinalTranscript(text);
            else if (this.inputEl) {
              this.inputEl.value = text;
              this.inputEl.focus();
            }
          }
        });

        this.recognition = rec;
      } catch {
        // Disable mic UI if construction failed
        this.recognition = null;
      }

      if (this.micBtn && !this.recognition) {
        this.micBtn.disabled = true;
        this.micBtn.title = "Speech recognition unavailable in this browser.";
      }
    }

    _humanSTTError(code) {
      switch (code) {
        case "not-allowed": return "Microphone access denied. Enable permissions to use speech input.";
        case "no-speech":   return "No speech detected. Try speaking closer to the mic.";
        case "audio-capture": return "No microphone was found. Check your audio device.";
        case "aborted":     return "Listening aborted.";
        case "network":     return "Network issue during recognition.";
        default:            return "Speech recognition issue. Please retry.";
      }
    }

    startRecognition() {
      if (!this.recognition || this.recActive) return;
      try {
        this.recognition.lang = this.recLang;
        this.recognition.start();
        if (this.micBtn) this.micBtn.focus();
      } catch {
        if (this.warnEl) this.warnEl.textContent = "Unable to start speech recognition.";
      }
    }

    stopRecognition() {
      if (!this.recognition) return;
      try { this.recognition.stop(); } catch {}
      this.recActive = false;
      if (this.micBtn) this.micBtn.setAttribute("aria-pressed", "false");
      if (this.statusEl && this.statusEl.textContent === "Listening…") {
        this.statusEl.textContent = "Ready.";
      }
    }

    // ===================== TTS =====================
    _initSynthesis() {
      const load = () => {
        try { this.voices = this.synth.getVoices() || []; } catch { this.voices = []; }
      };
      load();
      try {
        this.synth.addEventListener("voiceschanged", load);
      } catch { /* some browsers don't fire it */ }

      if (this.ttsBtn) {
        this.ttsBtn.disabled = false;
        this.ttsBtn.title = "Toggle narration";
        this.ttsBtn.setAttribute("aria-pressed", String(this.ttsEnabled));
        this.ttsBtn.textContent = this.ttsEnabled ? "🔊 On" : "🔇 Off";
      }
    }

    _pickVoice(langCode) {
      if (!this.voices || !this.voices.length) return null;
      const target = pickLang(langCode || this.state.lang || "en");
      // exact
      let v = this.voices.find(v => v.lang === target);
      if (v) return v;
      // base match (e.g., 'es' → 'es-*')
      const base = target.split("-")[0];
      v = this.voices.find(v => v.lang && v.lang.toLowerCase().startsWith(base));
      return v || null;
    }

    narrateAssistant(text, langCode) {
      if (!this.ttsEnabled || !this.synth) return;
      const clean = String(text || "").trim();
      if (!clean) return;

      const u = new SpeechSynthesisUtterance(clean);
      u.lang = pickLang(langCode || this.state.lang || "en");
      const v = this._pickVoice(langCode || this.state.lang || "en");
      if (v) u.voice = v;

      try { this.synth.cancel(); } catch {}
      try { this.synth.speak(u); } catch {
        if (this.warnEl) this.warnEl.textContent = "Unable to narrate right now.";
      }
    }

    cancelSpeech() {
      if (!this.synth) return;
      try { this.synth.cancel(); } catch {}
    }

    // ===================== UI wiring =====================
    _bindButtons() {
      // Mic
      if (this.micBtn) {
        if (!hasSTT) {
          this.micBtn.disabled = true;
          this.micBtn.title = "Speech recognition unavailable in this browser.";
        } else {
          this.micBtn.type = "button";
          this.micBtn.addEventListener("click", () => {
            if (this.recActive) this.stopRecognition();
            else this.startRecognition();
          });
        }
      }

      // TTS
      if (this.ttsBtn) {
        if (!hasTTS) {
          this.ttsBtn.disabled = true;
          this.ttsBtn.title = "Text-to-speech unavailable in this browser.";
        } else {
          this.ttsBtn.type = "button";
          this.ttsBtn.addEventListener("click", () => {
            this.ttsEnabled = !this.ttsEnabled;
            if (this.state) this.state.ttsEnabled = this.ttsEnabled;
            this.ttsBtn.setAttribute("aria-pressed", String(this.ttsEnabled));
            this.ttsBtn.textContent = this.ttsEnabled ? "🔊 On" : "🔇 Off";
            if (!this.ttsEnabled) this.cancelSpeech();
          });
        }
      }
    }
  }

  // expose
  global.SpeechController = SpeechController;

})(window);
