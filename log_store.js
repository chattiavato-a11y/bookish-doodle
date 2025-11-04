// log_store.js
// Local, privacy-preserving event logger + Insights panel wiring.
// Global export: window.ChattiaLog = { add, dump, clear, exportJSON, wireUI, sessionId }

(function (global) {
  "use strict";

  const STORE_KEY   = "chattia.logs.v1";
  const SESSION_KEY = "chattia.session.v1";
  const MAX_EVENTS  = 500;       // hard cap
  const RENDER_MAX  = 200;       // insights render cap

  // Create/restore a per-tab session id
  const sessionId = (() => {
    try {
      let s = sessionStorage.getItem(SESSION_KEY);
      if (!s) {
        s = randId(24);
        sessionStorage.setItem(SESSION_KEY, s);
      }
      return s;
    } catch { return randId(24); }
  })();

  // In-memory buffer mirrors localStorage
  let buf = loadBuf();

  // ---------- utils ----------
  function randId(n = 22) {
    const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
    let s = "";
    for (let i = 0; i < n; i++) s += abc[(Math.random() * abc.length) | 0];
    return s;
  }

  function iso() { return new Date().toISOString(); }

  function safeJSONParse(text, fallback = null) {
    try { return JSON.parse(String(text)); } catch { return fallback; }
  }

  function saveBuf() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(buf));
    } catch { /* no-op */ }
  }

  function loadBuf() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = safeJSONParse(raw, []);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  // Extremely small redactor for secrets/tokens
  function redact(obj, depth = 0) {
    if (obj == null) return obj;
    if (depth > 4) return "[…]";
    if (typeof obj === "string") {
      // redact obvious secrets inside string
      if (obj.length > 2048) return obj.slice(0, 2048) + "…";
      return obj.replace(/(sk-[a-z0-9_\-]{10,}|xai-[a-z0-9_\-]{10,}|ya29\.[\w\-\.]+|eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/gi, "•REDACTED•");
    }
    if (typeof obj !== "object") return obj;

    const out = Array.isArray(obj) ? [] : {};
    const SECRET_KEY = /token|secret|key|authorization|cookie|passwd|password/i;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (SECRET_KEY.test(k)) {
        out[k] = "•REDACTED•";
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }

  // ---------- public API ----------
  function add(evt) {
    try {
      const e = {
        ts: iso(),
        sid: sessionId,
        kind: String(evt?.kind || "log"),
        msg: String(evt?.msg || ""),
        meta: redact(evt?.meta ?? null),
      };
      buf.push(e);
      if (buf.length > MAX_EVENTS) buf = buf.slice(-MAX_EVENTS);
      saveBuf();
      // live-append if insights open
      appendToInsights(e);
    } catch { /* no-op */ }
  }

  function dump() {
    // return a safe shallow copy
    return buf.slice(-MAX_EVENTS);
  }

  function clear() {
    buf = [];
    saveBuf();
    // also clear UI if open
    try {
      const pre = document.getElementById("insightsText");
      if (pre) pre.textContent = "";
    } catch { /* no-op */ }
  }

  function exportJSON(pretty = false) {
    const data = {
      exported_at: iso(),
      session: sessionId,
      events: dump(),
    };
    return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  }

  // ---------- Insights UI wiring ----------
  function renderAll() {
    const pre = document.getElementById("insightsText");
    if (!pre) return;
    const head = [
      `Session: ${sessionId}`,
      `Events: ${buf.length}`,
      (() => {
        try {
          const l5 = global.L5Local?.last?.();
          if (!l5) return "L5 last: (n/a)";
          const ids = (l5.top || []).map(x => x.id).join(", ");
          return `L5 last: conf=${(l5.confidence||0).toFixed(3)} ids=[${ids}] q="${(l5.query||"").slice(0, 100)}"`;
        } catch { return "L5 last: (n/a)"; }
      })(),
      "",
      "Recent events:",
      ""
    ].join("\n");

    const lines = buf.slice(-RENDER_MAX).map(e =>
      `[${e.ts}] (${e.kind}) ${e.msg}${e.meta ? " " + tryStringify(e.meta) : ""}`
    );

    pre.textContent = head + lines.join("\n");
  }

  function tryStringify(x) {
    try { return JSON.stringify(x); } catch { return ""; }
  }

  function togglePanel(show) {
    const panel = document.getElementById("insightsPanel");
    if (!panel) return;
    if (typeof show === "boolean") {
      panel.style.display = show ? "block" : "none";
    } else {
      panel.style.display = panel.style.display === "block" ? "none" : "block";
    }
    if (panel.style.display === "block") renderAll();
  }

  function appendToInsights(e) {
    const panel = document.getElementById("insightsPanel");
    const pre   = document.getElementById("insightsText");
    if (!panel || !pre) return;
    if (panel.style.display !== "block") return; // only live-append if visible
    const line = `[${e.ts}] (${e.kind}) ${e.msg}${e.meta ? " " + tryStringify(e.meta) : ""}\n`;
    pre.textContent += line;
    // keep pre reasonably small
    if (pre.textContent.length > 80_000) renderAll();
  }

  function wireUI() {
    // Buttons may not exist on some pages; guard accordingly.
    const insightsBtn = document.getElementById("insightsBtn");
    const clearBtn    = document.getElementById("clearLogsBtn");

    if (insightsBtn) {
      insightsBtn.type = "button";
      insightsBtn.addEventListener("click", () => togglePanel());
    }
    if (clearBtn) {
      clearBtn.type = "button";
      clearBtn.addEventListener("click", () => {
        clear();
        // small toast in status if present
        try {
          const s = document.getElementById("status");
          if (s) s.textContent = "Local logs cleared.";
        } catch { /* no-op */ }
      });
    }

    // Initial render if panel is pre-opened (e.g., dev mode)
    const panel = document.getElementById("insightsPanel");
    if (panel && panel.style.display === "block") renderAll();
  }

  // Auto-wire on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireUI, { once: true });
  } else {
    // DOM already loaded
    wireUI();
  }

  // ---------- expose ----------
  global.ChattiaLog = {
    add, dump, clear, exportJSON, wireUI, sessionId
  };

  // A couple of convenience breadcrumbs so other modules can use:
  try { add({ kind: "boot", msg: "log_store_ready" }); } catch {}

})(window);
