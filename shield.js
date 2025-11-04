// Client Shield — normalize, strip bidi/zero-width, sanitize HTML-ish, risk score, CSRF + honeypot
(function (global){
  const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\uFEFF]/g;
  const NULLS = /\x00/g;
  const DANGEROUS_PROTOCOLS = /\b(?:javascript|vbscript|file|data):/gi;
  const TAGS = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
  const ON_ATTR = /\bon\w+\s*=/gi;
  const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  const IMPORT_AT_RULE = /@import\s+['"]?[^'"]+['"]?/gi;

  const SUSPECT_PATTERNS = [
    /<script/i, /<\/script/i, /<iframe/i, /<object/i, /<embed/i, /<svg/i,
    /xlink:href/i, /onerror\s*=/i, /onload\s*=/i,
    /\.\.\//, /\b(select|union|insert|update|delete|drop)\b.*\bfrom\b/i,
    /\b(?:https?|ftp):\/\/[^\s]{2,}/i,
  ];

  function normalize(s){ try { return s.normalize('NFKC'); } catch { return s; } }
  function stripBidiAndNulls(s){ return (s||'').replace(BIDI, '').replace(NULLS,''); }
  function escapeAngles(s){ return s.replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function scrubHTMLish(s){
    let out = s.replace(ON_ATTR, '').replace(TAGS,'').replace(IMPORT_AT_RULE,'');
    out = out.replace(CSS_URL, (m,q,url)=> {
      const u = (url||'').replace(/\s/g,'');
      return DANGEROUS_PROTOCOLS.test(u) ? 'url(about:blank)' : m;
    });
    out = out.replace(DANGEROUS_PROTOCOLS, 'about:blank:');
    return escapeAngles(out);
  }
  function stripZeroWidthRepeats(s){ return s.replace(/([^\s])\1{2,}/g, '$1$1'); }
  function baseSanitize(s, maxLen=4000){
    let t = String(s||'');
    t = normalize(t);
    t = stripBidiAndNulls(t);
    if (t.length > maxLen) t = t.slice(0, maxLen);
    t = scrubHTMLish(t);
    t = stripZeroWidthRepeats(t);
    return t.trim();
  }
  function riskScore(s){
    const txt = (s||'').toLowerCase();
    let score = 0, hits = [];
    for (const re of SUSPECT_PATTERNS){
      if (re.test(txt)) { score += 10; hits.push(re.source); }
    }
    const linkCount = (txt.match(/\bhttps?:\/\//g)||[]).length; score += Math.min(linkCount*2, 10);
    const angle = (s.match(/[<>]/g)||[]).length; score += Math.min(angle, 10);
    return {score, hits};
  }
  function scanAndSanitize(input, opts={}){
    const {maxLen=4000, threshold=12} = opts;
    const sanitized = baseSanitize(input, maxLen);
    const {score, hits} = riskScore(input);
    const ok = score < threshold;
    const reasons = ok ? [] : hits.slice(0,6);
    return { ok, score, reasons, sanitized };
  }
  function csrfToken(){
    const key = 'shield.csrf';
    let t = sessionStorage.getItem(key);
    if (!t){ t = randomId(24); sessionStorage.setItem(key, t); }
    return t;
  }
  function randomId(len=22){
    const abc='abcde12fghi34jkl56mno78pqrs0tuvwxyz0123ABCDEFGHIJ456KLMNOPQRSTU789VWXYZ_-';
    let s=''; for(let i=0;i<len;i++) s += abc[Math.floor(Math.random()*abc.length)];
    return s;
  }
  function attachHoneypot(form){
    const hp = document.createElement('input');
    hp.type='text'; hp.name='hp'; hp.autocomplete='off';
    hp.tabIndex = -1; hp.ariaHidden='true';
    hp.style.cssText='position:absolute;left:-5000px;top:auto;width:1px;height:1px;opacity:0;';
    form.appendChild(hp); return hp;
  }
  global.Shield = { scanAndSanitize, csrfToken, randomId, baseSanitize, attachHoneypot };
})(window);

