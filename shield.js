// Client Shield (pre-L1 hardening utilities)
// - Normalizes (NFKC), strips bidi/zero-width, caps length
// - Scrubs HTMLish tags/handlers, dangerous protocols, CSS url()
// - Scores common XSS/SSRF/Traversal patterns
// - Produces a sanitized echo-safe string
// - Session CSRF token + honeypot helpers
// - Tiny helpers: safe JSON parse, ID generator

(function (global){
  "use strict";

  // ---------- Char classes & patterns ----------
  const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\uFEFF]/g; // dir marks & ZW chars
  const NULLS = /\x00/g;

  const DANGEROUS_PROTOCOLS = /\b(?:javascript|vbscript|file|data):/gi;
  const TAGS   = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;  // rough tag removal
  const ON_ATTR = /\bon\w+\s*=/gi;                  // inline event handlers
  const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  const IMPORT_AT_RULE = /@import\s+['"]?[^'"]+['"]?/gi;

  // Suspicious payload hints
  const SUSPECT_PATTERNS = [
    /<script/i, /<\/script/i, /<iframe/i, /<object/i, /<embed/i, /<svg/i,
    /xlink:href/i, /onerror\s*=/i, /onload\s*=/i,
    /\.\.\//,                                      // traversal
    /\b(select|union|insert|update|delete|drop)\b.*\bfrom\b/i, // sqli-ish
    /\b(?:https?|ftp):\/\/[^\s]{2,}/i,            // external URLs (SSRF bait)
  ];

  // ---------- Core transforms ----------
  function normalize(s){
    try { return String(s ?? "").normalize("NFKC"); } catch { return String(s ?? ""); }
  }

  function stripBidiAndNulls(s){
    return (s || "").replace(BIDI, "").replace(NULLS, "");
  }

  function escapeAngles(s){
    // Only &lt; &gt; to preserve readable text while defeating tag parsing
    return String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function scrubHTMLish(s){
    // Remove obvious handlers/tags/@import; neutralize css url()
    let out = String(s)
      .replace(ON_ATTR, "")
      .replace(TAGS, "")
      .replace(IMPORT_AT_RULE, "");

    out = out.replace(CSS_URL, (m, q, url) => {
      const u = String(url || "").replace(/\s/g, "");
      return DANGEROUS_PROTOCOLS.test(u) ? "url(about:blank)" : m;
    });

    // Neutralize bare dangerous protocols if any slipped through
    out = out.replace(DANGEROUS_PROTOCOLS, "about:blank:");

    // Final angle escaping as belt-and-suspenders
    return escapeAngles(out);
  }

  function collapseRepeats(s){
    // Tame zalgo-ish spam: collapse 3+ repeats to 2
    return String(s).replace(/([^\s])\1{2,}/g, "$1$1");
  }

  function baseSanitize(input, maxLen = 4000){
    let t = normalize(input);
    t = stripBidiAndNulls(t);
    if (t.length > maxLen) t = t.slice(0, maxLen);
    t = scrubHTMLish(t);
    t = collapseRepeats(t);
    return t.trim();
  }

  // ---------- Risk scoring ----------
  function riskScore(original){
    const txt = String(original || "");
    const lower = txt.toLowerCase();
    let score = 0;
    const hits = [];

    for (const re of SUSPECT_PATTERNS){
      if (re.test(lower)) { score += 10; hits.push(re.source); }
    }
    // Many external links → add risk
    const linkCount = (lower.match(/\bhttps?:\/\//g) || []).length;
    score += Math.min(linkCount * 2, 10);

    // Angle bracket volume (pre-escape) → add risk
    const angleCount = (txt.match(/[<>]/g) || []).length;
    score += Math.min(angleCount, 10);

    return { score, hits };
  }

  // ---------- Public scan ----------
  function scanAndSanitize(input, opts = {}){
    const { maxLen = 4000, threshold = 12 } = opts;
    const sanitized = baseSanitize(input, maxLen);
    const { score, hits } = riskScore(input);
    const ok = score < threshold;
    const reasons = ok ? [] : hits.slice(0, 6);
    return { ok, score, reasons, sanitized };
  }

  // ---------- CSRF + honeypot ----------
  function randomId(len = 22){
    const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
    let s = "";
    for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
  }

  function csrfToken(){
    try {
      const key = "shield.csrf.v1";
      let t = sessionStorage.getItem(key);
      if (!t){ t = randomId(28); sessionStorage.setItem(key, t); }
      return t;
    } catch {
      // No storage? fall back to ephemeral token.
      return randomId(28);
    }
  }

  function attachHoneypot(form){
    const hp = document.createElement("input");
    hp.type = "text";
    hp.name = "hp";
    hp.autocomplete = "off";
    hp.tabIndex = -1;
    hp.ariaHidden = "true";
    hp.style.cssText = "position:absolute;left:-5000px;top:auto;width:1px;height:1px;opacity:0;";
    form.appendChild(hp);
    return hp;
  }

  // ---------- Small safe helpers ----------
  function safeParseJSON(text, fallback = null){
    try { return JSON.parse(String(text)); } catch { return fallback; }
  }

  function safeStringify(obj){
    try { return JSON.stringify(obj); } catch { return ""; }
  }

  // ---------- Export ----------
  global.Shield = {
    scanAndSanitize,
    baseSanitize,
    csrfToken,
    attachHoneypot,
    randomId,
    safeParseJSON,
    safeStringify
  };

})(window);
