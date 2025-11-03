import { L5Local } from './l5_local_llm.js';
import { WebLLM } from './l5_webllm.js';

const qs=(s)=>document.querySelector(s);
const chat=qs('#chat'), inp=qs('#input'), send=qs('#send'), status=qs('#status'), warn=qs('#warn');
const langSel=qs('#langSel'); const themeBtn=qs('#themeBtn'); const form=qs('#chatForm');

const hpInput = (function(){ const hp=document.createElement('input'); hp.type='text'; hp.name='hp'; hp.tabIndex=-1; hp.ariaHidden='true'; hp.style.cssText='position:absolute;left:-5000px;width:1px;height:1px;opacity:0;'; form.appendChild(hp); return hp; })();
const state={ messages:[], lang:'en', theme:'dark', csrf: csrfToken(), webllmModel:'Llama-3.1-8B-Instruct-q4f16_1' };

// Session budget (local WebLLM only in this step): warn 25k, stop 35k
const Budget = { softWarn:25000, hardCap:35000, spent:0,
  approxTokens(s){ return Math.ceil(String(s||'').length/4); },
  canSpend(n){ return (this.spent + n) <= this.hardCap; },
  note(n){ this.spent += Math.max(0, n|0); }
};

// Allow server call (providers OFF; server returns extractive SSE)
const ALLOW_SERVER = true;

function csrfToken(){ const k='shield.csrf'; let t=sessionStorage.getItem(k); if(!t){ t=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2); sessionStorage.setItem(k,t);} return t; }
themeBtn.onclick=()=>{ state.theme = state.theme==='dark'?'light':'dark';
  document.documentElement.dataset.theme=state.theme; themeBtn.textContent=state.theme[0].toUpperCase()+state.theme.slice(1); };
langSel.onchange=(e)=> state.lang = e.target.value;

function add(role, text){ const d=document.createElement('div'); d.className='msg '+(role==='user'?'me':'ai'); d.textContent=text; chat.appendChild(d); chat.scrollTop=chat.scrollHeight; return d; }

async function sendToServerSSE(payload){
  const res = await fetch('/api/chat', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-CSRF': state.csrf },
    body: JSON.stringify(payload)
  });
  if (!res.ok || !res.body) throw new Error('server_unavailable');

  const reader = res.body.getReader(); const dec = new TextDecoder();
  let full = ''; const aiEl = add('assistant',''); status.textContent='Streaming (server)…';

  while (true){
    const {value, done} = await reader.read(); if (done) break;
    const chunk = dec.decode(value, {stream:true});
    for (const line of chunk.split('\n')){
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[END]') break;
      aiEl.textContent += data; full += data; chat.scrollTop = chat.scrollHeight;
    }
  }
  state.messages.push({role:'assistant', content: full});
  status.textContent='Ready.';
}

async function handleSend(){
  const raw=(inp.value||'').trim(); if(!raw) return;
  const v=window.Shield.scanAndSanitize(raw); if(!v.ok){ warn.textContent='Blocked input.'; return; }
  warn.textContent=''; add('user', v.sanitized); state.messages.push({role:'user', content:v.sanitized, lang: state.lang}); inp.value='';

  // 1) L5 extractive (client-side)
  status.textContent='Searching locally…';
  const draft = await L5Local.draft({ query: v.sanitized, lang: state.lang, bm25Min:0.6, coverageNeeded:2 });
  if (draft){
    status.textContent='Streaming…';
    const aiEl = add('assistant',''); let i=0;
    const tick = () => { if (i<draft.length){ aiEl.textContent += draft[i++]; chat.scrollTop=chat.scrollHeight; setTimeout(tick, 8); }
                         else { status.textContent='Ready.'; state.messages.push({role:'assistant', content: aiEl.textContent}); } };
    tick(); return;
  }

  // 2) WebLLM (local GPU) — session budget only
  if (WebLLM.hasWebGPU()){
    if (!Budget.canSpend(100)){ warn.textContent='Session token cap reached (35k).'; status.textContent='Stopped.'; return; }
    status.textContent='Loading local model…';
    try {
      await WebLLM.load({ model: state.webllmModel, progress: p => { status.textContent = `Loading local model… ${Math.round((p?.progress||0)*100)}%`; } });
      const strong = []; // optional: derive top chunks again if you want; omitted for brevity
      const sys = (state.lang==='es')
        ? 'Responde SOLO con el contexto cuando sea posible; de lo contrario, dilo. Cita [#id].'
        : 'Answer ONLY using context when possible; otherwise, say so. Cite [#id].';
      const messages = [{ role:'system', content: sys }, { role:'user', content: v.sanitized }];

      status.textContent='Generating (local GPU)…';
      const aiEl = add('assistant',''); let streamed = 0;
      await WebLLM.generate({
        messages,
        onToken: (tok)=>{
          const t = Budget.approxTokens(tok);
          if (!Budget.canSpend(t)){ warn.textContent='Session token cap reached (35k). Truncating.'; return; }
          streamed += t; aiEl.textContent += tok; chat.scrollTop=chat.scrollHeight;
          if (Budget.spent + streamed >= Budget.softWarn && Budget.spent < Budget.softWarn){
            warn.textContent='Approaching session budget (25k).';
          }
        }
      });
      Budget.note(streamed);
      status.textContent=`Ready. (≈${Budget.spent}/${Budget.hardCap})`;
      state.messages.push({role:'assistant', content: aiEl.textContent});
      if (Budget.spent >= Budget.hardCap) warn.textContent='Session hard cap reached (35k).';
      return;
    } catch { /* fall through to server */ }
  }

  // 3) Server (L2/L3 + SSE, providers OFF)
  if (ALLOW_SERVER){
    try {
      await sendToServerSSE({
        messages: state.messages.slice(-16),
        lang: state.lang,
        csrf: state.csrf,
        hp: hpInput.value || ''
      });
      return;
    } catch (e){
      status.textContent='Server path unavailable.';
    }
  }

  // If all paths fail:
  const msg = (state.lang==='es') ? 'Sin suficiente información local en este dispositivo.' : 'No sufficient local info on this device.';
  add('assistant', msg); state.messages.push({role:'assistant', content: msg});
}

send.onclick=handleSend;
inp.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleSend(); }});
