// l6_orchestrator.js
// Orchestrates L1 → L5 (client retrieval) → WebLLM (local GPU) → /api/chat (server: L2/L3/L7).
// Providers are configured server-side; UI stays vendor-neutral. No external URLs here.

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

// ---------- Session budget (client view) ----------
const Budget = {
  softWarn: 25000,      // session soft warning
  hardCap:  35000,      // session hard cap
  spent:    0,          // approx running total (WebLLM + server usage)
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

// safe render (never innerHTML)
function add(role, text){
  const d=document.createElement('div');
  d.className='msg '+(role==='user'?'me':'ai');
  d.textContent = text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

// ---------- Pack helpers (optional grounding for WebLLM) ----------
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

// ---------- Server call (SSE) ----------
async function sendToServerSSE(payload){
  const res = await fetch('/api/chat', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-CSRF': state.csrf },
    body: JSON.stringify(payload)
  });
  if (!res.ok || !res.body) throw new Error('server_unavailable');

  // Keep UI vendor-neutral; do not display provider name.
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

  // Update session budget from server token header (adds; does not overwrite)
  const used = Number(res.headers.get('X-Tokens-This-Call')||'0')|0;
  if (used > 0) {
    const before = Budget.spent;
    Budget.note(used);
    // soft warn boundary crossed
    if (before < Budget.softWarn && Budget.spent >= Budget.softWarn){
      warn.textContent = 'Approaching session budget (25k).';
    }
    if (Budget.spent >= Budget.hardCap){
      warn.textContent = 'Session hard cap reached (35k). Further generation disabled.';
    }
  }

  status.textContent='Ready.';
  state.messages.push({role:'assistant', content: full});
}

// ---------- Main flow ----------
async function handleSend(){
  const raw=(inp.value||'').trim();
  if (!raw) return;

  // Client shield
  const v = window.Shield.scanAndSanitize(raw);
  if (!v.ok){ warn.textContent='Blocked input.'; return; }
  warn.textContent='';
  add('user', v.sanitized);
  state.messages.push({ role:'user', content:v.sanitized, lang: state.lang });
  inp.value='';

  // 1) L5 extractive (client)
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
      }
    };
    tick();
    return;
  }

  // 2) WebLLM (local GPU) — session budget only
  if (WebLLM.hasWebGPU()){
    if (!Budget.canSpend(100)){ // simple headroom check
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
    } catch {
      // fall through to server
    }

    if (WebLLM.ready){
      const strong = await deriveStrong({ query: v.sanitized, lang: state.lang });
      const sys = groundedSystem({ lang: state.lang, strong });
      const messages = [{ role:'system', content: sys }, { role:'user', content: v.sanitized }];

      status.textContent='Generating (local)…';
      const aiEl = add('assistant','');
      let streamed = 0;
      try{
        await WebLLM.generate({
          messages,
          onToken: (tok)=>{
            const t = Budget.approxTokens(tok);
            if (!Budget.canSpend(t)){
              warn.textContent='Session token cap reached (35k). Truncating.';
              return; // stop appending further; generation continues internally
            }
            streamed += t;
            aiEl.textContent += tok;
            chat.scrollTop = chat.scrollHeight;

            // one-time soft warn
            if ((Budget.spent + streamed) >= Budget.softWarn && Budget.spent < Budget.softWarn){
              warn.textContent='Approaching session budget (25k).';
            }
          }
        });
      } catch {
        // fall through to server
      }
      if (aiEl.textContent){
        Budget.note(streamed);
        status.textContent=`Ready. (≈${Budget.spent}/${Budget.hardCap})`;
        state.messages.push({ role:'assistant', content: aiEl.textContent });
        if (Budget.spent >= Budget.hardCap){
          warn.textContent='Session hard cap reached (35k). Further generation disabled.';
        }
        return;
      }
    }
  }

  // 3) Server (L2/L3/L7 behind /api/chat)
  try{
    await sendToServerSSE({
      messages: state.messages.slice(-16),
      lang: state.lang,
      csrf: state.csrf,
      hp: hpInput.value || ''
    });
  } catch {
    const msg = (state.lang==='es')
      ? 'Ruta de servidor no disponible en este momento.'
      : 'Server path unavailable at the moment.';
    add('assistant', msg);
    state.messages.push({ role:'assistant', content: msg });
    status.textContent='Ready.';
  }
}

// ---------- Bind send ----------
send.onclick = handleSend;
inp.addEventListener('keydown', e=>{
  if (e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    handleSend();
  }
});

// initial hint sync if pill exists
updateBudgetHint();
