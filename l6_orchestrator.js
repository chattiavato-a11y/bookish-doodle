import { L5Local } from './l5_local_llm.js';
import { WebLLM } from './l5_webllm.js';

const qs=(s)=>document.querySelector(s);
const chat=qs('#chat'), inp=qs('#input'), send=qs('#send'), status=qs('#status'), warn=qs('#warn');
const langSel=qs('#langSel'); const themeBtn=qs('#themeBtn'); const form=qs('#chatForm');

// --- Session budget (local-only stage): warn at 25k, hard stop at 35k ---
const Budget = {
  softWarn: 25000,
  hardCap: 35000,
  spent: 0,
  approxTokens(s){ return Math.ceil(String(s||'').length/4); },
  canSpend(n){ return (this.spent + n) <= this.hardCap; },
  note(n){ this.spent += Math.max(0, n|0); }
};

const hpInput = (function(){ const hp=document.createElement('input'); hp.type='text'; hp.name='hp'; hp.tabIndex=-1; hp.ariaHidden='true'; hp.style.cssText='position:absolute;left:-5000px;width:1px;height:1px;opacity:0;'; form.appendChild(hp); return hp; })();
const state={ messages:[], lang:'en', theme:'dark', csrf: csrfToken(), webllmModel:'Llama-3.1-8B-Instruct-q4f16_1' };

function csrfToken(){ const k='shield.csrf'; let t=sessionStorage.getItem(k); if(!t){ t=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2); sessionStorage.setItem(k,t);} return t; }
themeBtn.onclick=()=>{ state.theme = state.theme==='dark'?'light':'dark';
  document.documentElement.dataset.theme=state.theme; themeBtn.textContent=state.theme[0].toUpperCase()+state.theme.slice(1); };
langSel.onchange=(e)=> state.lang = e.target.value;

function add(role, text){ const d=document.createElement('div'); d.className='msg '+(role==='user'?'me':'ai'); d.textContent=text; chat.appendChild(d); chat.scrollTop=chat.scrollHeight; return d; }

async function loadPack(){
  // tiny cache on window to avoid refetch each time
  if (window.__PACK__) return window.__PACK__;
  const r = await fetch('/packs/site-pack.json', { headers:{'Accept':'application/json'} });
  if (!r.ok) throw new Error('pack_load_failed');
  window.__PACK__ = await r.json();
  return window.__PACK__;
}

function tokenize(s){ return (s||'').toLowerCase().normalize('NFKC').match(/[a-z0-9áéíóúüñ]+/gi)||[]; }

async function deriveStrong({ query, lang }){
  try {
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

async function handleSend(){
  const raw=(inp.value||'').trim(); if(!raw) return;
  const v=window.Shield.scanAndSanitize(raw); if(!v.ok){ warn.textContent='Blocked input.'; return; }
  warn.textContent=''; add('user', v.sanitized); state.messages.push({role:'user', content:v.sanitized, lang: state.lang}); inp.value='';

  // First: L5 extractive
  status.textContent='Searching locally…';
  const draft = await L5Local.draft({ query: v.sanitized, lang: state.lang, bm25Min:0.6, coverageNeeded:2 });
  if (draft){
    status.textContent='Streaming…';
    const aiEl = add('assistant',''); let i=0;
    const tick = () => {
      if (i<draft.length){ aiEl.textContent += draft[i++]; chat.scrollTop=chat.scrollHeight; setTimeout(tick, 8); }
      else { status.textContent='Ready.'; state.messages.push({role:'assistant', content: aiEl.textContent}); }
    }; tick();
    return;
  }

  // Low confidence → try WebLLM/WebGPU (local), count SESSION ONLY
  if (!WebLLM.hasWebGPU()){
    const msg = (state.lang==='es')
      ? 'Este dispositivo no soporta WebGPU; sin proveedor externo en esta etapa.'
      : 'WebGPU not available on this device; no external provider at this stage.';
    status.textContent='Local-only path exhausted.'; add('assistant', msg);
    state.messages.push({role:'assistant', content: msg});
    return;
  }

  // Budget guard before starting
  if (!Budget.canSpend(100)){ // need headroom
    warn.textContent = 'Session token cap reached (35k).';
    status.textContent = 'Stopped.';
    return;
  }

  status.textContent='Loading local model…';
  try {
    await WebLLM.load({
      model: state.webllmModel,
      progress: p => { status.textContent = `Loading local model… ${Math.round((p?.progress||0)*100)}%`; }
    });
  } catch (e){
    status.textContent='Local model unavailable.';
    const msg = (state.lang==='es') ? 'No se pudo cargar el modelo local.' : 'Could not load local model.';
    add('assistant', msg); state.messages.push({role:'assistant', content: msg}); return;
  }

  // Build grounded messages for WebLLM
  const strong = await deriveStrong({ query: v.sanitized, lang: state.lang });
  const sys = groundedSystem({ lang: state.lang, strong });
  const messages = [{ role:'system', content: sys }, { role:'user', content: v.sanitized }];

  status.textContent='Generating (local GPU)…';
  const aiEl = add('assistant',''); let streamedTokens = 0;

  try {
    await WebLLM.generate({
      messages,
      onToken: (tok)=>{
        const t = Budget.approxTokens(tok);
        if (!Budget.canSpend(t)){ warn.textContent='Session token cap reached (35k). Truncating.'; return; }
        streamedTokens += t;
        aiEl.textContent += tok; chat.scrollTop=chat.scrollHeight;

        if (Budget.spent + streamedTokens >= Budget.softWarn && Budget.spent < Budget.softWarn){
          // one-time early warning (soft)
          warn.textContent = 'Approaching session budget (25k).';
        }
      }
    });
  } catch (e){
    status.textContent='Local GPU generation failed.';
    const msg = (state.lang==='es') ? 'Fallo de generación local.' : 'Local generation failed.';
    add('assistant', msg); state.messages.push({role:'assistant', content: msg}); return;
  }

  // Note budget and close
  Budget.note(streamedTokens);
  status.textContent = `Ready. (≈${Budget.spent}/${Budget.hardCap})`;
  state.messages.push({role:'assistant', content: aiEl.textContent});

  if (Budget.spent >= Budget.hardCap){
    warn.textContent = 'Session hard cap reached (35k). Further generation disabled.';
  }
}

send.onclick=handleSend;
inp.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleSend(); }});
