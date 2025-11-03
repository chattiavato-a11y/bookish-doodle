// l6_orchestrator.js
// L1 → L5 (client) → WebLLM (local GPU) → /api/chat (server: L2/L3/L7) + local logging + insights

import { L5Local } from './l5_local_llm.js';
import { WebLLM } from './l5_webllm.js';

// ---------- DOM ----------
const qs = (s) => document.querySelector(s);
const chat   = qs('#chat');
const inp    = qs('#input');
const send   = qs('#send');
const status = qs('#status');
const warn   = qs('#warn');
const langSel= qs('#langSel');
const themeBtn = qs('#themeBtn');
const form   = qs('#chatForm');

// Optional Insights UI (we'll gracefully no-op if elements aren't present)
const btnInsights  = qs('#insightsBtn') || qs('#btnInsights');
const btnClearLogs = qs('#clearLogsBtn') || qs('#btnClearLogs');
const panelInsights= qs('#insightsPanel') || qs('#panelInsights');
const insightsText = panelInsights ? (panelInsights.querySelector('#insightsText') || panelInsights.querySelector('pre')) : null;

// ---------- Session budget ----------
const Budget = {
  softWarn: 25000,
  hardCap:  35000,
  spent:    0,
  approxTokens(s){ return Math.ceil(String(s||'').length/4); },
  canSpend(n){ return (this.spent + Math.max(0,n|0)) <= this.hardCap; },
  note(n){ this.spent += Math.max(0, n|0); updateBudgetHint(); }
};
function updateBudgetHint(){
  const el = document.getElementById('budgetHint');
  if (el) el.textContent = String(Budget.spent);
}

// ---------- CSRF + honeypot ----------
function csrfToken(){
  const k='shield.csrf';
  let t=sessionStorage.getItem(k);
  if(!t){ t=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2); sessionStorage.setItem(k,t); }
  return t;
}
const hpInput = (function(){
  const hp=document.createElement('input');
  hp.type='text'; hp.name='hp'; hp.tabIndex=-1; hp.ariaHidden='true';
  hp.style.cssText='position:absolute;left:-5000px;width:1px;height:1px;opacity:0;';
  form.appendChild(hp);
  return hp;
})();

// ---------- UI state ----------
const state = {
  messages: [],
  lang: 'en',
  theme: 'dark',
  csrf: csrfToken(),
  webllmModel: 'Llama-3.1-8B-Instruct-q4f16_1'
};

// ---------- UI wiring ----------
themeBtn.onclick = () => {
  state.theme = state.theme==='dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  themeBtn.textContent = state.theme[0].toUpperCase()+state.theme.slice(1);
};
langSel.onchange = (e)=> state.lang = e.target.value;

function add(role, text){
  const d=document.createElement('div');
  d.className='msg '+(role==='user'?'me':'ai');
  d.textContent = text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

// ---------- Pack helpers ----------
async function loadPack(){
  if (window.__PACK__) return window.__PACK__;
  const r = await fetch('/packs/site-pack.json', { headers:{'Accept':'application/json'} });
  if (!r.ok) throw new Error('pack_load_failed');
  window.__PACK__ = await r.json();
  return window.__PACK__;
}
function tokenize(s){ return (s||'').toLowerCase().normalize('NFKC').match(/[a-z0-9áéíóúüñ]+/gi)||[]; }
async function deriveStrong({ query, lang }){
  try{
    const pack = await loadPack();
    const terms = tokenize(query);
    const list=[];
    for (const d of (pack.docs||[])){
      if (lang && d.lang && d.lang!==lang) continue;
      for (const c of (d.chunks||[])){
        const t = tokenize(c.text);
        let score=0; for (const w of terms) if (t.includes(w)) score++;
        if (score>0) list.push({ id:c.id, text:c.text, score });
      }
    }
    return list.sort((a,b)=>b.score-a.score).slice(0,4);
  } catch { return []; }
}
function groundedSystem({ lang, strong }){
  const ctx = (strong||[]).map(t=>`[#${t.id}] ${t.text}`).join('\n');
  const policy = (lang==='es')
    ? 'Responde SOLO con el contexto. Si falta info, dilo. Cita [#id] en las afirmaciones.'
    : 'Answer ONLY using the context. If info is missing, say so. Cite [#id] for claims.';
  const style = (lang==='es') ? 'Sé conciso y claro.' : 'Be concise and clear.';
  return `${policy}\n${style}\n\nContext:\n${ctx}`;
}

async function offlinePackFallback({ query, lang }){
  const strong = await deriveStrong({ query, lang });
  if (!strong.length) return null;

  const lead = (lang==='es')
    ? 'Modo fuera de línea: respondiendo solo con el paquete local. Arranca el worker /api/chat para habilitar proveedores.'
    : 'Offline mode: responding only with the local knowledge pack. Start the /api/chat worker to enable providers.';

  const body = strong.map(t => `[#${t.id}] ${t.text}`).join('\n\n');
  return `${lead}\n\n${body}`;
}

// ---------- Server call (SSE) ----------
async function sendToServerSSE(payload){
  let res;
  try {
    res = await fetch('/api/chat', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-CSRF': state.csrf },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    const error = new Error('server_fetch_failed');
    error.detail = { cause: err };
    throw error;
  }

  if (!res.ok || !res.body){
    const detail = { status: res.status };
    try {
      const type = res.headers.get('content-type') || '';
      if (type.includes('application/json')) {
        detail.body = await res.json();
      } else {
        detail.text = await res.text();
      }
    } catch {}
    const error = new Error('server_http_error');
    error.detail = detail;
    throw error;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  const aiEl = add('assistant','');
  status.textContent = 'Streaming…';

  while (true){
    const {value, done} = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, {stream:true});
    for (const line of chunk.split('\n')){
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[END]') break;
      aiEl.textContent += data;
      full += data;
      chat.scrollTop = chat.scrollHeight;
    }
  }

  const used = Number(res.headers.get('X-Tokens-This-Call')||'0')|0;
  if (used > 0) {
    const before = Budget.spent; Budget.note(used);
    if (before < Budget.softWarn && Budget.spent >= Budget.softWarn){
      warn.textContent = 'Approaching session budget (25k).';
    }
    if (Budget.spent >= Budget.hardCap){
      warn.textContent = 'Session hard cap reached (35k). Further generation disabled.';
    }
  }

  const packStatus = res.headers.get('X-Pack-Status');
  if (packStatus === 'pack-unavailable' && !warn.textContent){
    warn.textContent = 'Knowledge pack unavailable. Using provider or fallback responses only.';
  }

  status.textContent='Ready.';
  state.messages.push({role:'assistant', content: full});

  if (window.ChattiaLog){
    window.ChattiaLog.put({
      role: 'assistant', text: full, lang: state.lang,
      path: 'server', tokens: used,
      provider: res.headers.get('X-Provider') || 'unknown',
      sessionTotal: Budget.spent
    });
  }
}

// ---------- Main flow ----------
async function handleSend(){
  const raw=(inp.value||'').trim();
  if (!raw) return;

  const v = window.Shield.scanAndSanitize(raw);
  if (!v.ok){ warn.textContent='Blocked input.'; return; }
  warn.textContent='';

  add('user', v.sanitized);
  state.messages.push({ role:'user', content:v.sanitized, lang: state.lang });
  inp.value='';

  if (window.ChattiaLog){
    window.ChattiaLog.put({
      role: 'user', text: v.sanitized, lang: state.lang,
      path: 'client', tokens: Budget.approxTokens(v.sanitized),
      provider: 'n/a', sessionTotal: Budget.spent
    });
  }

  // 1) L5 client extractive
  status.textContent='Searching locally…';
  const draft = await L5Local.draft({ query: v.sanitized, lang: state.lang, bm25Min:0.6, coverageNeeded:2 });
  if (draft){
    status.textContent='Streaming…';
    const aiEl = add('assistant','');
    let i=0;
    const tick = () => {
      if (i<draft.length){
        aiEl.textContent += draft[i++];
        chat.scrollTop=chat.scrollHeight;
        setTimeout(tick, 8);
      } else {
        status.textContent='Ready.';
        state.messages.push({ role:'assistant', content: aiEl.textContent });
        if (window.ChattiaLog){
          window.ChattiaLog.put({
            role: 'assistant', text: aiEl.textContent, lang: state.lang,
            path: 'l5-client', tokens: Budget.approxTokens(aiEl.textContent),
            provider: 'none', sessionTotal: Budget.spent
          });
        }
      }
    };
    tick();
    return;
  }

  // 2) WebLLM (local GPU)
  if (WebLLM.hasWebGPU()){
    if (!Budget.canSpend(100)){
      warn.textContent='Session token cap reached (35k).';
      status.textContent='Stopped.';
      return;
    }
    status.textContent='Loading local model…';
    try {
      await WebLLM.load({
        model: state.webllmModel,
        progress: p => { status.textContent = `Loading local model… ${Math.round((p?.progress||0)*100)}%`; }
      });
    } catch { /* fall through */ }

    if (WebLLM.ready){
      const strong = await deriveStrong({ query: v.sanitized, lang: state.lang });
      const sys = groundedSystem({ lang: state.lang, strong });
      const messages = [{ role:'system', content: sys }, { role:'user', content: v.sanitized }];

      status.textContent='Generating (local)…';
      const aiEl = add('assistant',''); let streamed = 0;
      try{
        await WebLLM.generate({
          messages,
          onToken: (tok)=>{
            const t = Budget.approxTokens(tok);
            if (!Budget.canSpend(t)){ warn.textContent='Session token cap reached (35k). Truncating.'; return; }
            streamed += t; aiEl.textContent += tok; chat.scrollTop=chat.scrollHeight;
            if ((Budget.spent + streamed) >= Budget.softWarn && Budget.spent < Budget.softWarn){
              warn.textContent='Approaching session budget (25k).';
            }
          }
        });
      } catch { /* fall through */ }

      if (aiEl.textContent){
        Budget.note(streamed);
        status.textContent=`Ready. (≈${Budget.spent}/${Budget.hardCap})`;
        state.messages.push({ role:'assistant', content: aiEl.textContent });
        if (window.ChattiaLog){
          window.ChattiaLog.put({
            role: 'assistant', text: aiEl.textContent, lang: state.lang,
            path: 'webllm', tokens: streamed,
            provider: 'local-webgpu', sessionTotal: Budget.spent
          });
        }
        if (Budget.spent >= Budget.hardCap){
          warn.textContent='Session hard cap reached (35k). Further generation disabled.';
        }
        return;
      }
    }
  }

  // 3) Server escalation
  try{
    await sendToServerSSE({
      messages: state.messages.slice(-16),
      lang: state.lang,
      csrf: state.csrf,
      hp: hpInput.value || ''
    });
  } catch (err){
    const offline = await offlinePackFallback({ query: v.sanitized, lang: state.lang });
    if (offline){
      warn.textContent = (state.lang==='es')
        ? 'El servidor /api/chat no respondió; mostrando contenido local.'
        : 'The /api/chat server did not respond; showing local content.';
      add('assistant', offline);
      state.messages.push({ role:'assistant', content: offline });
      if (window.ChattiaLog){
        window.ChattiaLog.put({
          role: 'assistant', text: offline, lang: state.lang,
          path: 'offline-pack', tokens: Budget.approxTokens(offline), provider: 'none', sessionTotal: Budget.spent
        });
      }
      status.textContent = (state.lang==='es') ? 'Listo (sin servidor).' : 'Ready (offline).';
      return;
    }

    const msg = describeServerError(err);
    add('assistant', msg);
    state.messages.push({ role:'assistant', content: msg });
    if (window.ChattiaLog){
      window.ChattiaLog.put({
        role: 'assistant', text: msg, lang: state.lang,
        path: 'server-fail', tokens: 0, provider: 'none', sessionTotal: Budget.spent
      });
    }
    status.textContent='Ready.';
  }
}

// ---------- Insights UI wiring ----------
async function renderInsights(){
  if (!panelInsights || !insightsText || !window.ChattiaLog) return;
  const items = await window.ChattiaLog.latest(30);
  const lines = items.map(e => {
    const ts = new Date(e.ts).toLocaleString();
    const tag = `${e.role}@${e.path}`;
    const tok = (e.tokens||0);
    const pvd = e.provider||'';
    return `[${ts}] ${tag} (${tok}t ${pvd}) — ${e.text}`;
  });
  insightsText.textContent = lines.join('\n') || 'No logs yet.';
}
if (btnInsights && panelInsights){
  btnInsights.addEventListener('click', async ()=>{
    const isHidden = panelInsights.style.display === 'none' || !panelInsights.style.display;
    if (isHidden) { panelInsights.style.display = 'block'; await renderInsights(); }
    else { panelInsights.style.display = 'none'; }
  });
}
if (btnClearLogs && panelInsights){
  btnClearLogs.addEventListener('click', async ()=>{
    if (!window.ChattiaLog) return;
    await window.ChattiaLog.clear();
    if (insightsText) insightsText.textContent = 'Logs cleared.';
  });
}

// ---------- Bind send ----------
send.onclick = handleSend;
inp.addEventListener('keydown', e=>{
  if (e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    handleSend();
  }
});

// initial pill sync
updateBudgetHint();

function describeServerError(err){
  const fallback = (state.lang==='es') ? 'Ruta de servidor no disponible en este momento.' : 'Server path unavailable at the moment.';
  const detail = err?.detail || {};
  const code = detail?.body?.error || detail?.text || '';

  if (err?.message === 'server_fetch_failed'){
    return (state.lang==='es')
      ? 'No se pudo contactar al servidor. Revisa tu conexión o despliegue.'
      : 'Could not reach the server. Check your connection or deployment.';
  }

  if (err?.message === 'server_http_error' && detail?.status === 502 && code === ''){
    return (state.lang==='es')
      ? 'El servidor respondió 502. Verifica que el worker tenga acceso a packs/site-pack.json.'
      : 'Server responded with 502. Ensure the worker can reach packs/site-pack.json.';
  }

  if (err?.message === 'server_http_error' && detail?.status === 404){
    return (state.lang==='es')
      ? 'Ruta /api/chat no encontrada. Ejecuta `wrangler dev` o despliega el worker server_edge.js.'
      : 'Route /api/chat not found. Run `wrangler dev` or deploy the server_edge.js worker.';
  }

  const map = {
    pack_unavailable: {
      en: 'Knowledge pack unavailable. Host packs/site-pack.json or set PACK_URL.',
      es: 'Paquete de conocimiento no disponible. Aloja packs/site-pack.json o configura PACK_URL.'
    },
    csrf_failed: {
      en: 'Session mismatch (CSRF). Refresh the page and try again.',
      es: 'Desfase de sesión (CSRF). Actualiza la página e inténtalo de nuevo.'
    },
    rate_limited: {
      en: 'Too many requests from this IP. Please wait a minute.',
      es: 'Demasiadas solicitudes desde esta IP. Espera un minuto.'
    },
    provider_chain_disabled: {
      en: 'Provider chain disabled. Enable ENABLE_PROVIDERS=true if escalation is required.',
      es: 'Cadena de proveedores deshabilitada. Activa ENABLE_PROVIDERS=true si necesitas escalado.'
    },
    pack_fetch_failed: {
      en: 'Knowledge pack fetch failed. Check PACK_URL or static hosting.',
      es: 'Error al obtener el paquete de conocimiento. Verifica PACK_URL o el hosting estático.'
    }
  };

  if (typeof code === 'string'){ 
    const trimmed = code.trim();
    if (map[trimmed]){
      return (state.lang==='es') ? map[trimmed].es : map[trimmed].en;
    }
    if (/^[a-z_]+$/.test(trimmed)){
      return (state.lang==='es')
        ? `Error del servidor: ${trimmed}.`
        : `Server reported error: ${trimmed}.`;
    }
    if (trimmed){
      return trimmed;
    }
  }

  return fallback;
}
