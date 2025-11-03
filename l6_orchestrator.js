import { L5Local } from './l5_local_llm.js';

const qs=(s)=>document.querySelector(s);
const chat=qs('#chat'), inp=qs('#input'), send=qs('#send'), status=qs('#status'), warn=qs('#warn');
const langSel=qs('#langSel'); const themeBtn=qs('#themeBtn'); const form=qs('#chatForm');

const hpInput = (function(){ const hp=document.createElement('input'); hp.type='text'; hp.name='hp'; hp.tabIndex=-1; hp.ariaHidden='true'; hp.style.cssText='position:absolute;left:-5000px;width:1px;height:1px;opacity:0;'; form.appendChild(hp); return hp; })();

const state={ messages:[], lang:'en', theme:'dark', csrf: csrfToken() };
function csrfToken(){ const k='shield.csrf'; let t=sessionStorage.getItem(k); if(!t){ t=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2); sessionStorage.setItem(k,t);} return t; }

themeBtn.onclick=()=>{ state.theme = state.theme==='dark'?'light':'dark';
  document.documentElement.dataset.theme=state.theme; themeBtn.textContent=state.theme[0].toUpperCase()+state.theme.slice(1); };
langSel.onchange=(e)=> state.lang = e.target.value;

function add(role, text){ const d=document.createElement('div'); d.className='msg '+(role==='user'?'me':'ai'); d.textContent=text; chat.appendChild(d); chat.scrollTop=chat.scrollHeight; return d; }

async function handleSend(){
  const raw=(inp.value||'').trim(); if(!raw) return;
  const v=window.Shield.scanAndSanitize(raw); if(!v.ok){ warn.textContent='Blocked input.'; return; }
  warn.textContent=''; add('user', v.sanitized); state.messages.push({role:'user', content:v.sanitized, lang: state.lang}); inp.value='';

  status.textContent='Searching locally…';
  const draft = await L5Local.draft({ query: v.sanitized, lang: state.lang, bm25Min:0.6, coverageNeeded:2 });

  if (!draft){ status.textContent='Low confidence locally (as designed for Step 1, no fallback yet).';
    const ai=add('assistant', (state.lang==='es'?'No tengo suficiente información en mi contenido local.':'I don’t have enough info in my local content.')+' [#none]');
    state.messages.push({role:'assistant', content: ai.textContent}); return;
  }

  status.textContent='Streaming…';
  const aiEl = add('assistant',''); let i=0;
  const tick = () => { if (i<draft.length){ aiEl.textContent += draft[i++]; chat.scrollTop=chat.scrollHeight; setTimeout(tick, 8); }
                       else { status.textContent='Ready.'; state.messages.push({role:'assistant', content: aiEl.textContent}); } };
  tick();
}

send.onclick=handleSend;
inp.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleSend(); }});
