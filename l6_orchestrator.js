// l6_orchestrator.js
// L1 → L5 (client) → WebLLM (local GPU) → /api/chat (server: L2/L3/L7) + local logging + insights

import { L5Local } from './l5_local_llm.js';
import { WebLLM } from './l5_webllm.js';
import { SpeechController } from './speech.js';

// ---------- URL helpers ----------
const pageBase = (() => {
  if (typeof window !== 'undefined' && window.location){
    try { return new URL('.', window.location.href); } catch {}
  }
  if (typeof document !== 'undefined' && document.baseURI){
    try { return new URL('.', document.baseURI); } catch {}
  }
  return new URL('.', 'https://localhost/');
})();

const Config = (() => {
  const prior = window.__CHATTIA_CONFIG__ || {};
  const apiURL = prior.apiURL
    || window.__CHATTIA_API_URL
    || new URL('./api/chat', pageBase).toString();
  const packURL = prior.packURL
    || window.__CHATTIA_PACK_URL
    || new URL('./packs/site-pack.json', pageBase).toString();
  const webllmScript = prior.webllmScript
    || window.__CHATTIA_WEBLLM_SCRIPT
    || new URL('./static/webllm/web-llm.min.js', pageBase).toString();
  const ensureSlash = (value) => value.endsWith('/') ? value : `${value}/`;
  const webllmAssets = ensureSlash(prior.webllmAssets
    || window.__CHATTIA_WEBLLM_ASSETS
    || new URL('./static/webllm/models/', pageBase).toString());

  const merged = { apiURL, packURL, webllmScript, webllmAssets };
  window.__CHATTIA_CONFIG__ = merged;
  window.__CHATTIA_API_URL = apiURL;
  window.__CHATTIA_PACK_URL = packURL;
  window.__CHATTIA_WEBLLM_SCRIPT = webllmScript;
  window.__CHATTIA_WEBLLM_ASSETS = webllmAssets;
  return merged;
})();

// ---------- DOM ----------
const qs = (s) => document.querySelector(s);
const chat   = qs('#chat');
const inp    = qs('#input');
const send   = qs('#send');
const status = qs('#status');
const warn   = qs('#warn');
const langSel= qs('#langSel');
const themeBtn = qs('#themeBtn');
const micBtn = qs('#micBtn');
const ttsBtn = qs('#ttsBtn');
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
  webllmModel: 'Llama-3.1-8B-Instruct-q4f16_1',
  ttsEnabled: false
};

// ---------- UI wiring ----------
themeBtn.onclick = () => {
  state.theme = state.theme==='dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  themeBtn.textContent = state.theme[0].toUpperCase()+state.theme.slice(1);
};
const speech = new SpeechController({
  inputEl: inp,
  statusEl: status,
  warnEl: warn,
  micBtn,
  ttsBtn,
  state,
  onFinalTranscript: (text) => {
    if (inp) {
      inp.value = text;
      inp.focus();
    }
  }
});
langSel.onchange = (e)=> {
  state.lang = e.target.value;
  speech.setLang(state.lang);
};

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
  const r = await fetch(Config.packURL, { headers:{'Accept':'application/json'} });
  if (!r.ok) throw new Error('pack_load_failed');
  window.__PACK__ = await r.json();
  return window.__PACK__;
}
function tokenize(s){ return (s||'').toLowerCase().normalize('NFKC').match(/[a-z0-9áéíóúüñ]+/gi)||[]; }

function strongFromPack(pack, { query, lang }){
  const terms = tokenize(query);
  const list=[];
  for (const d of (pack?.docs||[])){
    if (lang && d.lang && d.lang!==lang) continue;
    for (const c of (d.chunks||[])){
      const t = tokenize(c.text);
      let score=0; for (const w of terms) if (t.includes(w)) score++;
      if (score>0) list.push({ id:c.id, text:c.text, score });
    }
  }
  return list.sort((a,b)=>b.score-a.score).slice(0,4);
}

async function deriveStrong({ query, lang }){
  try{
    const pack = await loadPack();
    return strongFromPack(pack, { query, lang });
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
  let pack;
  try {
    pack = await loadPack();
  } catch {
    const text = (lang==='es')
      ? 'Modo fuera de línea: no se pudo cargar packs/site-pack.json. Asegura el hosting estático o configura PACK_URL.'
      : 'Offline mode: packs/site-pack.json could not be loaded. Host the static pack or set PACK_URL.';
    return { text, reason: 'pack-load-failed' };
  }

  const strong = strongFromPack(pack, { query, lang });
  if (!strong.length){
    const text = (lang==='es')
      ? 'Modo fuera de línea: no hay suficiente contexto local para esta consulta. Arranca el worker /api/chat para proveedores.'
      : 'Offline mode: the local knowledge pack has no matches for this query. Start the /api/chat worker for providers.';
    return { text, reason: 'no-local-match' };
  }

  const lead = (lang==='es')
    ? 'Modo fuera de línea: respondiendo solo con el paquete local. Arranca el worker /api/chat para habilitar proveedores.'
    : 'Offline mode: responding only with the local knowledge pack. Start the /api/chat worker to enable providers.';

  const body = strong.map(t => `[#${t.id}] ${t.text}`).join('\n\n');
  return { text: `${lead}\n\n${body}`, reason: 'local-context', strongCount: strong.length };
}

// ---------- Server call (SSE) ----------
async function sendToServerSSE(payload){
  let res;
  try {
    res = await fetch(Config.apiURL, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-CSRF': state.csrf },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    const error = new Error('server_fetch_failed');
    error.detail = { cause: err, apiURL: Config.apiURL };
    throw error;
  }

  if (!res.ok || !res.body){
    const detail = { status: res.status, apiURL: Config.apiURL };
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
  const packUrlHint = res.headers.get('X-Pack-URL');
  if (packUrlHint && packUrlHint !== Config.packURL){
    const prev = Config.packURL;
    Config.packURL = packUrlHint;
    window.__CHATTIA_PACK_URL = packUrlHint;
    if (window.__CHATTIA_CONFIG__){
      window.__CHATTIA_CONFIG__.packURL = packUrlHint;
    } else {
      window.__CHATTIA_CONFIG__ = { packURL: packUrlHint };
    }
    if (window.__PACK__ && prev !== packUrlHint){
      window.__PACK__ = null;
    }
  }
  if (packStatus === 'pack-unavailable' && !warn.textContent){
    warn.textContent = 'Knowledge pack unavailable. Using provider or fallback responses only.';
  }

  status.textContent='Ready.';
  state.messages.push({role:'assistant', content: full});
  speech.narrateAssistant(full, state.lang);

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

  speech.cancelSpeech();

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
    speech.cancelSpeech();
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
        speech.narrateAssistant(aiEl.textContent, state.lang);
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
    speech.cancelSpeech();
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
        speech.narrateAssistant(aiEl.textContent, state.lang);
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
      hp: hpInput.value || '',
      packUrl: Config.packURL
    });
  } catch (err){
    const offline = await offlinePackFallback({ query: v.sanitized, lang: state.lang });
    if (offline){
      const { text, reason } = offline;
      if (reason === 'pack-load-failed'){
        warn.textContent = (state.lang==='es')
          ? `No se pudo cargar ${Config.packURL}. Revisa el hosting o PACK_URL.`
          : `${Config.packURL} could not be loaded. Check hosting or PACK_URL.`;
      } else if (reason === 'no-local-match'){
        warn.textContent = (state.lang==='es')
          ? 'Sin coincidencias locales. Arranca /api/chat para escalar a proveedores.'
          : 'No local matches. Start /api/chat to escalate to providers.';
      } else {
        warn.textContent = (state.lang==='es')
          ? 'El servidor /api/chat no respondió; mostrando contexto local.'
          : 'The /api/chat server did not respond; showing local context.';
      }
      add('assistant', text);
      state.messages.push({ role:'assistant', content: text });
      if (window.ChattiaLog){
        const tokens = Budget.approxTokens(text);
        const meta = { reason };
        if (typeof offline.strongCount === 'number') meta.strong = offline.strongCount;
        window.ChattiaLog.put({
          role: 'assistant', text, lang: state.lang,
          path: 'offline-pack', tokens, provider: 'none', sessionTotal: Budget.spent, meta
        });
      }
      status.textContent = (state.lang==='es')
        ? (reason === 'pack-load-failed' ? 'Listo (sin pack).' : 'Listo (sin servidor).')
        : (reason === 'pack-load-failed' ? 'Ready (pack offline).' : 'Ready (offline).');
      return;
    }

    const msg = describeServerError(err);
    add('assistant', msg);
    state.messages.push({ role:'assistant', content: msg });
    speech.narrateAssistant(msg, state.lang);
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
    const meta = e.meta?.reason ? ` {${e.meta.reason}${typeof e.meta.strong==='number'?`,${e.meta.strong}`:''}}` : '';
    return `[${ts}] ${tag} (${tok}t ${pvd})${meta} — ${e.text}`;
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
  const fallback = (state.lang==='es')
    ? `Ruta de servidor no disponible en este momento (${Config.apiURL}).`
    : `Server path unavailable at the moment (${Config.apiURL}).`;
  const detail = err?.detail || {};
  const code = detail?.body?.error || detail?.text || '';

  if (err?.message === 'server_fetch_failed'){
    const target = err?.detail?.apiURL || Config.apiURL;
    return (state.lang==='es')
      ? `No se pudo contactar al servidor (${target}). Revisa tu conexión o despliegue.`
      : `Could not reach the server (${target}). Check your connection or deployment.`;
  }

  if (err?.message === 'server_http_error' && detail?.status === 502 && code === ''){
    return (state.lang==='es')
      ? 'El servidor respondió 502. Verifica que el worker tenga acceso a packs/site-pack.json.'
      : 'Server responded with 502. Ensure the worker can reach packs/site-pack.json.';
  }

  if (err?.message === 'server_http_error' && detail?.status === 404){
    return (state.lang==='es')
      ? `Ruta ${Config.apiURL} no encontrada. Ejecuta \`wrangler dev\` o despliega el worker server_edge.js.`
      : `Route ${Config.apiURL} not found. Run \`wrangler dev\` or deploy the server_edge.js worker.`;
  }

  const map = {
    pack_unavailable: {
      en: `Knowledge pack unavailable (${Config.packURL}). Host packs/site-pack.json or set PACK_URL.`,
      es: `Paquete de conocimiento no disponible (${Config.packURL}). Aloja packs/site-pack.json o configura PACK_URL.`
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
      en: `Knowledge pack fetch failed (${Config.packURL}). Check PACK_URL or static hosting.`,
      es: `Error al obtener el paquete de conocimiento (${Config.packURL}). Verifica PACK_URL o el hosting estático.`
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

// l6_orchestrator.js
// UI glue + Guardrails + Escalation ladder (L5 → optional WebLLM → L7 server).
// Relies on globals provided by index.html script order:
//   Shield (shield.js), ChattiaLog (log_store.js), SpeechController (speech.js),
//   L5Local (l5_local_llm.js), L5WebLLM (l5_webllm.js)

(function (global){
  "use strict";

  // ---------- helpers ----------
  const Q = (s)=>document.querySelector(s);
  const log = (kind,msg,meta)=>{ try{ global.ChattiaLog?.add?.({kind,msg,meta}); }catch{} };

  // ---------- config ----------
  const CFG = global.__CHATTIA_CONFIG__ || {};
  const API_URL  = CFG.apiURL  || "/api/chat";
  const PACK_URL = CFG.packURL || "/packs/site-pack.json";

  // token budgeting (only for server/provider path)
  const SOFT_CAP = 25_000;  // warn
  const HARD_CAP = 35_000;  // block
  const TOKENS_PER_CHAR = 1/4;

  // L5 thresholds
  const L5_MIN_CONF = 0.60;
  const L5_COVERAGE = 2;

  // ---------- state ----------
  const state = {
    theme: "dark",
    lang: "en",
    messages: [],
    csrf: Shield.csrfToken(),
    ttsEnabled: false,
    providerTokens: 0,   // counts ONLY server/provider usage
    sending: false
  };

  // ---------- DOM ----------
  const els = {
    form:   Q("#chatForm"),
    chat:   Q("#chat"),
    inp:    Q("#input"),
    send:   Q("#send"),
    status: Q("#status"),
    warn:   Q("#warn"),
    themeBtn: Q("#themeBtn"),
    langSel:  Q("#langSel"),
    micBtn:   Q("#micBtn"),
    ttsBtn:   Q("#ttsBtn"),
    // Insights (optional)
    insBtn:   Q("#insightsBtn"),
    clrBtn:   Q("#clearLogsBtn"),
    insPanel: Q("#insightsPanel"),
    insText:  Q("#insightsText") || (Q("#insightsPanel")?.querySelector("pre"))
  };

  // honeypot
  const hpEl = Shield.attachHoneypot(els.form);

  // speech
  const speech = new SpeechController({
    inputEl: els.inp,
    statusEl: els.status,
    warnEl: els.warn,
    micBtn: els.micBtn,
    ttsBtn: els.ttsBtn,
    state,
    onFinalTranscript(txt){ try{ els.inp.value = txt; els.inp.focus(); }catch{} }
  });

  // ---------- UI wiring ----------
  if (els.themeBtn){
    els.themeBtn.addEventListener("click", ()=>{
      state.theme = state.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = state.theme;
      els.themeBtn.textContent = state.theme[0].toUpperCase()+state.theme.slice(1);
      log("ui","theme_toggle",{ theme: state.theme });
    });
  }
  if (els.langSel){
    els.langSel.addEventListener("change", e=>{
      state.lang = String(e.target.value || "en");
      try { speech.setLang(state.lang); } catch {}
      log("ui","lang_change",{ lang: state.lang });
    });
  }

  if (els.send){
    els.send.addEventListener("click", ()=> sendFlow());
  }
  if (els.inp){
    els.inp.addEventListener("keydown", (e)=>{
      if (e.key === "Enter" && !e.shiftKey){
        e.preventDefault();
        sendFlow();
      }
    });
  }

  // ---------- render helpers ----------
  function addMsg(role, text){
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "me" : "ai");
    div.textContent = String(text || "");           // safe echo
    els.chat.appendChild(div);
    els.chat.scrollTop = els.chat.scrollHeight;
    return div;
  }
  const setStatus = (s)=>{ if (els.status) els.status.textContent = s || ""; };
  const setWarn   = (s)=>{ if (els.warn)   els.warn.textContent   = s || ""; };

  function clientGate(raw){
    const r = Shield.scanAndSanitize(raw, { maxLen: 2000, threshold: 12 });
    if (!r.ok){
      setWarn(`Blocked by client Shield. Reasons: ${r.reasons.join(", ")}`);
      log("guard","blocked_client",{ reasons: r.reasons });
      return { ok:false };
    }
    setWarn("");
    return { ok:true, text: r.sanitized };
  }

  // ---------- local pack fallback helpers ----------
  async function loadPack(){
    if (global.__PACK__) return global.__PACK__;
    const res = await fetch(PACK_URL, { headers: { "Accept":"application/json" }, cache:"no-store" });
    if (!res.ok) throw new Error("pack_load_failed");
    global.__PACK__ = await res.json();
    return global.__PACK__;
  }
  function tok(s){ return (String(s||"").toLowerCase().normalize("NFKC").match(/[a-z0-9áéíóúüñ]+/gi)) || []; }
  function strongFromPack(pack, query, lang){
    const terms = tok(query);
    const out = [];
    for (const d of (pack?.docs||[])){
      if (lang && d.lang && d.lang !== lang) continue;
      for (const c of (d.chunks||[])){
        const tt = tok(c.text);
        let score = 0; for (const w of terms) if (tt.includes(w)) score++;
        if (score>0) out.push({ id:c.id, text:c.text, score });
      }
    }
    return out.sort((a,b)=>b.score-a.score).slice(0,4);
  }
  async function offlinePackFallback(query, lang){
    let pack;
    try { pack = await loadPack(); }
    catch {
      return {
        text: lang==='es'
          ? 'Modo fuera de línea: no se pudo cargar packs/site-pack.json. Asegura el hosting o configura PACK_URL.'
          : 'Offline mode: packs/site-pack.json could not be loaded. Host it or set PACK_URL.',
        reason: 'pack-load-failed'
      };
    }
    const strong = strongFromPack(pack, query, lang);
    if (!strong.length){
      return {
        text: lang==='es'
          ? 'Modo fuera de línea: no hay contexto local suficiente. Inicia /api/chat para proveedores.'
          : 'Offline mode: the local pack has no matches. Start /api/chat to enable providers.',
        reason: 'no-local-match'
      };
    }
    const lead = lang==='es'
      ? 'Modo fuera de línea: respondiendo solo con el paquete local.'
      : 'Offline mode: answering using the local knowledge pack only.';
    const body = strong.map(t=>`[#${t.id}] ${t.text}`).join('\n\n');
    return { text: `${lead}\n\n${body}`, reason: 'local-context', strongCount: strong.length };
  }

  // ---------- server SSE ----------
  async function serverStream(){
    if (state.providerTokens >= HARD_CAP){
      setWarn("Session hard cap reached (35k tokens). Start a new session.");
      log("budget","hard_cap_block",{ used: state.providerTokens });
      return;
    }
    if (state.providerTokens >= SOFT_CAP){
      setWarn("Approaching session limit; continuing may end the session soon.");
      log("budget","soft_cap_warn",{ used: state.providerTokens });
    }

    setStatus("Connecting to server …");
    state.sending = true;
    const aiEl = addMsg("assistant", "");
    let full = "";

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type":"application/json", "X-CSRF": state.csrf },
        body: JSON.stringify({
          messages: state.messages.slice(-16),
          lang: state.lang,
          csrf: state.csrf,
          hp: hpEl?.value || ""
        })
      });

      if (!res.ok || !res.body){
        setStatus("Server refused the request.");
        setWarn("Offline mode: local pack only or API unavailable.");
        log("l7","server_bad",{ status: res.status });
        return;
      }

      setStatus("Streaming …");
      const reader = res.body.getReader();
      const dec = new TextDecoder();

      while(true){
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream:true });
        for (const line of chunk.split("\n")){
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[END]") continue;
          full += data;
          aiEl.textContent = full;
          els.chat.scrollTop = els.chat.scrollHeight;

          state.providerTokens += Math.ceil(data.length * TOKENS_PER_CHAR);
          if (state.providerTokens >= HARD_CAP){
            setWarn("Hard cap reached mid-stream; stopping.");
            log("budget","hard_cap_midstream",{ used: state.providerTokens });
            try { reader.cancel(); } catch {}
            break;
          }
        }
      }

      full = (full||"").trim();
      if (!full){
        setWarn("No content streamed from server.");
        log("l7","empty_stream");
        return;
      }

      state.messages.push({ role:"assistant", content: full });
      setStatus("Ready.");
      try { speech.narrateAssistant(full, state.lang); } catch {}
      log("l7","server_answer_ok",{ chars: full.length, used: state.providerTokens });

    } catch (e){
      setStatus("Server error.");
      setWarn("Couldn’t reach the API. Using local-only answers when possible.");
      log("l7","server_fetch_error",{ err:String(e?.message||e) });
    } finally {
      state.sending = false;
    }
  }

  // ---------- main send flow ----------
  async function sendFlow(){
    if (state.sending) return;
    const raw = (els.inp.value||"").trim();
    if (!raw) return;

    speech.cancelSpeech();

    // client shield before echo
    const v1 = clientGate(raw);
    if (!v1.ok) return;

    // echo sanitized
    addMsg("user", v1.text);
    state.messages.push({ role:"user", content: v1.text, lang: state.lang });
    els.inp.value = "";

    // second pass
    const v2 = clientGate(v1.text);
    if (!v2.ok) return;

    // L5 local extractive
    setStatus("Thinking locally (L5) …");
    log("l6","try_l5",{ lang: state.lang });

    try{
      const extractive = await global.L5Local?.draft?.({
        query: v2.text, lang: state.lang,
        bm25Min: L5_MIN_CONF, coverageNeeded: L5_COVERAGE
      });

      if (extractive){
        const ai = addMsg("assistant", extractive);
        state.messages.push({ role:"assistant", content: extractive });
        setStatus("Ready.");
        try { speech.narrateAssistant(extractive, state.lang); } catch {}
        log("l6","l5_answer_ok",{ chars: extractive.length, pack: PACK_URL });
        return;
      }
    } catch(e){
      log("l6","l5_error",{ err:String(e?.message||e) });
    }

    // Optional WebLLM (local WebGPU), if present
    if (global.L5WebLLM?.supported?.()){
      try{
        setStatus("Loading on-device model (WebLLM)…");
        const aiEl = addMsg("assistant", "");
        const controller = new AbortController();

        // derive tiny grounded system from pack (best-effort)
        let sys = "You are a concise assistant.";
        try {
          const pack = await loadPack();
          const strong = strongFromPack(pack, v2.text, state.lang);
          const ctx = strong.map(t=>`[#${t.id}] ${t.text}`).join('\n');
          const policy = (state.lang==='es')
            ? "Responde SOLO con el contexto. Si falta info, dilo. Cita [#id]."
            : "Answer ONLY using the context. If info is missing, say so. Cite [#id].";
          const style  = (state.lang==='es') ? "Sé conciso." : "Be concise.";
          sys = `${policy}\n${style}\n\nContext:\n${ctx}`;
        } catch {}

        const full = await global.L5WebLLM.generate?.({
          system: sys,
          messages: state.messages.slice(-12),
          temperature: 0.2,
          maxTokens: 220,
          onDelta: (t)=>{
            aiEl.textContent += t;
            els.chat.scrollTop = els.chat.scrollHeight;
          },
          signal: controller.signal
        });

        if (full && full.trim()){
          state.messages.push({ role:"assistant", content: full.trim() });
          setStatus("Ready.");
          try { speech.narrateAssistant(full, state.lang); } catch {}
          log("l6","webllm_answer_ok",{ chars: full.length });
          return;
        }
      } catch(e){
        log("l6","webllm_error",{ err:String(e?.message||e) });
      }
    } else {
      log("l6","webllm_missing_or_unsupported");
    }

    // Escalate to server (L7 providers behind /api/chat)
    await serverStream();
  }

  // ---------- insights (optional) ----------
  async function renderInsights(){
    if (!els.insPanel || !els.insText || !global.ChattiaLog) return;
    const items = await global.ChattiaLog.latest(30);
    const lines = items.map(e=>{
      const ts = new Date(e.ts).toLocaleString();
      const tag = `${e.role}@${e.path}`;
      const tok = (e.tokens||0);
      const pvd = e.provider||'';
      return `[${ts}] ${tag} (${tok}t ${pvd}) — ${e.text}`;
    });
    els.insText.textContent = lines.join('\n') || 'No logs yet.';
  }
  if (els.insBtn && els.insPanel){
    els.insBtn.addEventListener("click", async ()=>{
      const hidden = !els.insPanel.style.display || els.insPanel.style.display === "none";
      if (hidden){ els.insPanel.style.display = "block"; await renderInsights(); }
      else       { els.insPanel.style.display = "none"; }
    });
  }
  if (els.clrBtn && els.insPanel){
    els.clrBtn.addEventListener("click", async ()=>{
      try { await global.ChattiaLog?.clear?.(); } catch {}
      if (els.insText) els.insText.textContent = "Logs cleared.";
    });
  }

  // ---------- bind send ----------
  els.send?.addEventListener("click", sendFlow);
  els.inp?.addEventListener("keydown", (e)=>{
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); sendFlow(); }
  });

  // ---------- boot log ----------
  log("boot","l6_ready",{ api: API_URL, pack: PACK_URL, softCap: SOFT_CAP, hardCap: HARD_CAP });

})(window);
