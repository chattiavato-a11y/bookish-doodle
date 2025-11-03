// Minimal Client Shield: normalize, strip bidi/zero-width, remove tags/handlers/protocols,
// cap length, and compute a tiny risk score. We render ONLY sanitized text.

(function (global){
  const BIDI=/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\uFEFF]/g, NULLS=/\x00/g;
  const DANG=/\b(?:javascript|vbscript|file|data):/gi, TAGS=/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, ON=/\bon\w+\s*=/gi, CSSURL=/url\(\s*(['"]?)(.*?)\1\s*\)/gi, IMP=/@import\s+['"]?[^'"]+['"]?/gi;
  const SUS=[/<script/i,/<\/script/i,/<iframe/i,/<object/i,/<embed/i,/<svg/i,/xlink:href/i,/onerror\s*=/i,/onload\s*=/i,/\.\.\//,/\b(select|union|insert|update|delete|drop)\b.*\bfrom\b/i,/\b(?:https?|ftp):\/\/[^\s]{2,}/i];

  function norm(s){ try{ return s.normalize('NFKC'); }catch{ return s; } }
  function scrub(s){
    let out=s.replace(ON,'').replace(TAGS,'').replace(IMP,'');
    out=out.replace(CSSURL,(m,q,u)=>DANG.test((u||'').replace(/\s/g,''))?'url(about:blank)':m);
    out=out.replace(DANG,'about:blank:');
    return out.replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function scanAndSanitize(input, maxLen=2000){
    let t=String(input||''); t=norm(t).replace(BIDI,'').replace(NULLS,''); if(t.length>maxLen) t=t.slice(0,maxLen); t=scrub(t);
    const txt=t.toLowerCase(); let score=0,hits=[]; for(const re of SUS){ if(re.test(txt)){ score+=10; hits.push(re.source);} }
    const link=(txt.match(/\bhttps?:\/\//g)||[]).length; score+=Math.min(link*2,10);
    const ok=score<12; return { ok, sanitized:t, reasons: ok?[]:hits.slice(0,6) };
  }

  function randomId(len=22){ const abc='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'; let s=''; for(let i=0;i<len;i++) s+=abc[Math.floor(Math.random()*abc.length)]; return s; }
  function csrfToken(){ const k='shield.csrf'; let t=sessionStorage.getItem(k); if(!t){ t=randomId(24); sessionStorage.setItem(k,t);} return t; }
  function attachHoneypot(form){ const hp=document.createElement('input'); hp.type='text'; hp.name='hp'; hp.tabIndex=-1; hp.ariaHidden='true'; hp.style.cssText='position:absolute;left:-5000px;width:1px;height:1px;opacity:0;'; form.appendChild(hp); return hp; }

  global.Shield = { scanAndSanitize, csrfToken, attachHoneypot };
})(window);
