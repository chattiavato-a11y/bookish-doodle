// shield.js — HI DEFENSE L0
// Cloudflare Worker + Client Compatible
// Budget: Soft 25k, Hard 35k tokens
// XSS | SQLi | SSRF | Zalgo | BIDI | Honeypot | CSRF

(function (global) {
  'use strict';

  const SOFT_CAP = 25000;
  const HARD_CAP = 35000;

  const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\uFEFF]/g;
  const ZW = /[\u200B-\u200D\u2060\u2061\u2062\u2063\u2064\u2066-\u2069\u206A-\u206F\uFEFF]/g;
  const NULLS = /\x00/g;

  const DANGEROUS_PROTOCOLS = /\b(?:javascript|vbscript|file|data|vnd\.ms|vnd\.apple):/gi;
  const TAGS = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
  const ON_ATTR = /\bon\w+\s*=/gi;
  const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  const IMPORT_AT = /@import\s+['"]?[^'"]+['"]?/gi;

  const SUSPECT = [
    /<script/i, /<\/script/i, /<iframe/i, /<object/i, /<embed/i, /<svg/i,
    /xlink:href/i, /onerror\s*=/i, /onload\s*=/i, /expression\s*\(/i,
    /\.\.\//, /\.\.%2f/i, /%2e%2e%2f/i,
    /\b(select|union|insert|update|delete|drop|create|alter)\b.*\b(from|into|table|database)\b/i,
    /\b(?:https?|ftp|ssh|sftp):\/\/[^\s]{4,}/i,
    /eval\s*\(/i, /setTimeout\s*\(/i, /setInterval\s*\(/i,
    /document\./i, /window\./i, /location\./i
  ];

  let sessionTokens = 0;
  const SESSION_KEY = 'shield.session.tokens';

  function loadSessionTokens() {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      sessionTokens = stored ? Math.min(parseInt(stored, 10), HARD_CAP) : 0;
    } catch (e) {
      sessionTokens = 0;
    }
  }

  function saveSessionTokens() {
    try {
      sessionStorage.setItem(SESSION_KEY, String(sessionTokens));
    } catch (e) {}
  }

  loadSessionTokens();

  function normalize(s) {
    try { return s.normalize('NFKC'); } catch { return s; }
  }

  function stripBidiAndZW(s) {
    return (s || '').replace(BIDI, '').replace(ZW, '').replace(NULLS, '');
  }

  function escapeAngles(s) {
    return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function scrubHTML(s) {
    let out = s
      .replace(ON_ATTR, '')
      .replace(TAGS, '')
      .replace(IMPORT_AT, '');
    out = out.replace(CSS_URL, (m, q, url) => {
      const u = (url || '').replace(/\s/g, '');
      return DANGEROUS_PROTOCOLS.test(u) ? 'url(about:blank)' : m;
    });
    out = out.replace(DANGEROUS_PROTOCOLS, 'about:blank:');
    return escapeAngles(out);
  }

  function collapseZalgo(s) {
    return s.replace(/([^\s])\1{2,}/g, '$1$1');
  }

  function baseSanitize(s, maxLen = 4000) {
    let t = String(s || '');
    t = normalize(t);
    t = stripBidiAndZW(t);
    if (t.length > maxLen) t = t.slice(0, maxLen);
    t = scrubHTML(t);
    t = collapseZalgo(t);
    return t.trim();
  }

  function riskScore(s) {
    const txt = (s || '').toLowerCase();
    let score = 0, hits = [];
    for (const re of SUSPECT) {
      if (re.test(txt)) { score += 15; hits.push(re.source); }
    }
    const links = (txt.match(/\bhttps?:\/\//g) || []).length;
    score += Math.min(links * 3, 15);
    const angles = (s.match(/[<>]/g) || []).length;
    score += Math.min(angles, 15);
    return { score, hits: hits.slice(0, 5) };
  }

  function checkBudget(text) {
    const estimated = Math.ceil(text.length / 4);
    const projected = sessionTokens + estimated;

    if (projected > HARD_CAP) {
      return { ok: false, reason: 'hard_cap', projected, cap: HARD_CAP };
    }
    if (projected > SOFT_CAP) {
      return { ok: true, reason: 'soft_cap', projected, cap: SOFT_CAP };
    }
    return { ok: true, reason: 'ok', projected };
  }

  function updateBudget(text) {
    const estimated = Math.ceil(text.length / 4);
    sessionTokens = Math.min(sessionTokens + estimated, HARD_CAP);
    saveSessionTokens();
    return { used: sessionTokens, estimated };
  }

  function scanAndSanitize(input, opts = {}) {
    const { maxLen = 4000, threshold = 30 } = opts;
    const sanitized = baseSanitize(input, maxLen);
    const { score, hits } = riskScore(input);
    const budget = checkBudget(sanitized);

    const ok = score < threshold && budget.ok;

    return {
      ok,
      sanitized,
      score,
      hits,
      budget: {
        ok: budget.ok,
        reason: budget.reason,
        used: sessionTokens,
        projected: budget.projected,
        soft: SOFT_CAP,
        hard: HARD_CAP
      },
      update: () => updateBudget(sanitized)
    };
  }

  function csrfToken() {
    const key = 'shield.csrf';
    let t = sessionStorage.getItem(key);
    if (!t) {
      t = randomId(28);
      sessionStorage.setItem(key, t);
    }
    return t;
  }

  function randomId(len = 28) {
    const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
    let s = '';
    for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
  }

  function attachHoneypot(form) {
    const hp = document.createElement('input');
    hp.type = 'text'; hp.name = 'hp'; hp.autocomplete = 'off';
    hp.tabIndex = -1; hp.ariaHidden = 'true';
    hp.style.cssText = 'position:absolute;left:-5000px;width:1px;height:1px;opacity:0;';
    form.appendChild(hp);
    return hp;
  }

  function getBudgetStatus() {
    return { used: sessionTokens, soft: SOFT_CAP, hard: HARD_CAP };
  }

  function resetBudget() {
    sessionTokens = 0;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  // Export for Worker + Client
  global.Shield = {
    scanAndSanitize,
    csrfToken,
    randomId,
    baseSanitize,
    attachHoneypot,
    getBudgetStatus,
    resetBudget,
    SOFT_CAP,
    HARD_CAP
  };

  // Worker export
  if (typeof exports !== 'undefined') {
    exports.Shield = global.Shield;
  }

})(typeof window !== 'undefined' ? window : global);
