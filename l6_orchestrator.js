// l6_orchestrator.js — orchestrates L5 (client) → WebLLM (local) → /api/chat (server).
// Now with local logging (IndexedDB) + Insights panel.

import { L5Local } from './l5_local_llm.js';
import { WebLLM } from './l5_webllm.js';
import { Log } from './l0_log.js';

// ---------- DOM ----------
const qs=(s)=>document.querySelector(s);
const chat=qs('#chat'), inp=qs('#input'), send=qs('#send'), status=qs('#status'), warn=qs('#warn');
const langSel=qs('#langSel'), themeBtn=qs('#themeBtn'), form=qs('#chatForm');
const insightsBtn=qs('#insightsBtn'), clearLogsBtn=qs('#clearLogsBtn');
const insightsPanel=qs('#insightsPanel'), insightsText=qs('#insightsText');

// ---------- Budget ----------
const Budget = { softWarn:25000, hardCap:35000, spent:0,
  approxTokens(s){ return Math.ceil(String(s||'').length/4); },
  canSpend(n){ return (this.spent + Math.max(0,n|0)) <= this.hardCap; },
  note(n){ this.spent += Math.max(0, n|0); updateBudgetHint(); }
};
function updateBudgetHint(){ const el=document.getElementById('budgetHint'); if (el) el.textContent=String(Budget.spent); }

// ---------- CSRF + honeypot ----------
function csrfToken(){ const k='shield.csrf'; let t=sessionStorage.getItem(k);
  if(!t){ t=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2); sessionStorage.setItem(k,t); }
  return t;
}
const hpInput = (()=>{ const hp=document.createElement('input');
  hp.type='text'; hp.name='hp'; hp.tabIndex=-1; hp.ariaHidden='true';
  hp.style.cssText='position:absolute;left:-5000px;width:1px;height:1px;opacity:0;';
  form.appendChild(hp); return hp; })();

// ---------- State ----------
const state={ messages:[], lang:'en', theme:'dark', csrf: csrfToken(), webllmModel:'Llama-3.1-8B-Instruct-q4f16_1' };

// ---------- UI wiring ----------
themeBtn.onclick=()=>{ state.theme=state.theme==='dark'?'light':'dark';
  document.documentElement.dataset.theme=state.theme; themeBtn.textContent=state.theme[0].toUpperCase()+state.theme.slice(1); };
langSel.onchange=(e)=> state.lang = e.target.value;

function add(role, text){ const d=document.createElement('div'); d.className='msg '+(role==='user'?'me':'ai'); d.textContent=text; chat.appendChild(d); chat.scrollTop=chat.scrollHeight; return d; }

// ---------- Pack helpers ----------
async function loadPack(){ if (window.__PACK__) return window.__PACK__;
  const r=await fetch('/packs/site-pack.json',{headers:{'Accept':'application/json'}}); if(!r.ok) throw new Error('pack_load_failed');
  window.__PACK__=await r.json(); return window.__PACK__;
}
function tokenize(s){ return (s||'').toLowerCase().normalize('NFKC').match(/[a-z0-9áéíóúüñ]+/gi)||[]; }
async function deriveStrong({ query, lang }){
  try{
    const pack=await loadPack(); const terms=tokenize(query); const list=[];
    for (const d of (pack.docs||[])){
      if (lang && d.lang && d.lang!==lang) continue;
      for (const c of (d.chunks||[])){
        const t=tokenize(c.text); let score=0; for (const w of terms) if (t.includes(w)) score++;
        if (score>0) list.push({ id:c.id, text:c.text, score });
      }
    }
    return list.sort((a,b)=>b.score-a.score).slice(0,4);
  }catch{ return []; }
}
function groundedSystem({ lang, strong }){
  const ctx=(strong||[]).map(t=>`[#${t.id}] ${t.text}`).join('\n');
  const policy=(lang==='es')?'Responde SOLO con el contexto. Si falta info, dilo. Cita [#id] en las afirmaciones.':'Answer ONLY using the context. If info is missing, say so. Cite [#id] for claims.';
  const style=(lang==='es')?'Sé conciso y claro.':'Be concise and clear.';
  return `${policy}\n${style}\n\nContext:\n${ctx}`;
}

// ---------- Insights panel ----------
async function refreshInsights(){
  insightsText.textContent='Loading…';
  const snap = await Log.snapshot();
  const lines = [];
  lines.push(`Total turns: ${snap.total}`);
  lines.push(`By path: ${Object.entries(snap.byPath).map(([k,v])=>`${k}:${v}`).join('  ')||'-'}`);
  lines.push(`Session tokens (approx): ${snap.spent}`);
  if (Object.keys(snap.byProvider||{}).length){
    lines.push(`Tokens by provider: ${Object.entries(snap.byProvider).map(([k,v])=>`${k}:${v}`).join('  ')}`);
  }
  if (snap.candidates.length){
    lines.push(`\nAdd-to-pack candidates (most frequent questions with low local coverage):`);
    snap.candidates.forEach((c,i)=> lines.push(`${i+1}. (${c.n}) ${c.q}`));
  }else{
    lines.push(`\nNo add-to-pack candidates yet — great local coverage.`);
  }
  insightsText.textContent = lines.join('\n');
}
insightsBtn.onclick=async ()=>{
  if (insightsPanel.style.display==='block'){ insightsPanel.style.display='none'; return; }
  await refreshInsights(); insightsPanel.style.display='block';
};
clearLogsBtn.onclick=async ()=>{
  await Log.clear(); await refreshInsights(); warn.textContent='Local logs cleared.';
};

// ---------- Server SSE ----------
async function sendToServerSSE(payload){
  const t0 = performance.now();
  const res = await fetch('/api/chat', {
    method:'POST', headers:{'Content-Type':'application/json','X-CSRF': state.csrf},
    body: JSON.stringify(payload)
  });
  if (!res.ok || !res.body) throw new Error('server_unavailable');

  const reader=res.body.getReader(); const dec=new TextDecoder();
  let full=''; const aiEl=add('assistant',''); status.textContent='Streaming…';
  while(true){
    const {value,done}=await reader.read(); if(done) break;
    const chunk=dec.decode(value,{stream:true});
    for(const line of chunk.split('\n')){
      if(!line.startsWith('data: ')) continue;
      const data=line.slice(6); if(data==='[END]') break;
      aiEl.textContent+=data; full+=data; chat.scrollTop=chat.scrollHeight;
    }
  }
  const used = Number(res.headers.get('X-Tokens-This-Call')||'0')|0;
  if (used>0){
    const before=Budget.spent; Budget.note(used);
    if (before < Budget.softWarn && Budget.spent >= Budget.softWarn) warn.textContent='Approaching session budget (25k).';
    if (Budget.spent >= Budget.hardCap) warn.textContent='Session hard cap reached (35k). Further generation disabled.';
  }
  status.textContent='Ready.'; state.messages.push({role:'assistant', content: full});

  // log
  const provider = (res.headers.get('X-Provider')||'server').toLowerCase();
  const t1 = performance.now();
  await Log.addTurn({
    ts: Date.now(), lang: state.lang,
    pathUsed: 'server', provider, tokensIn: Budget.approxTokens(payload?.messages?.slice(-1)[0]?.content||''), tokensOut: used,
    latencyMs: Math.round(t1 - t0),
    question: payload?.messages?.slice(-1)[0]?.content || '',
    answerPreview: full.slice(0,280),
    topIds: [], coverageOK: false
  });
}

// ---------- Main flow ----------
async function handleSend(){
  const raw=(inp.value||'').trim(); if(!raw) return;

  const v=window.Shield.scanAndSanitize(raw);
  if(!v.ok){ warn.textContent='Blocked input.'; return; }
  warn.textContent='';
  add('user', v.sanitized);
  state.messages.push({role:'user', content:v.sanitized, lang: state.lang});
  inp.value='';

  // 1) L5 extractive (client)
  status.textContent='Searching locally…';
  const t0 = performance.now();
  const draft = await L5Local.draft({ query: v.sanitized, lang: state.lang, bm25Min:0.6, coverageNeeded:2 });

  if (draft){
    status.textContent='Streaming…';
    const aiEl=add('assistant',''); let i=0;
    const tick=()=>{ if(i<draft.length){ aiEl.textContent+=draft[i++]; chat.scrollTop=chat.scrollHeight; setTimeout(tick,8); }
      else{
        status.textContent='Ready.'; state.messages.push({role:'assistant', content: aiEl.textContent});
        // log L5
        const t1=performance.now();
        deriveStrong({ query: v.sanitized, lang: state.lang }).then(strong=>{
          const ids=(strong||[]).map(s=>s.id);
          Log.addTurn({
            ts: Date.now(), lang: state.lang, pathUsed:'l5-client', provider:'', tokensIn: Budget.approxTokens(v.sanitized),
            tokensOut: Budget.approxTokens(aiEl.textContent), latencyMs: Math.round(t1 - t0),
            question: v.sanitized, answerPreview: aiEl.textContent.slice(0,280),
            topIds: ids, coverageOK: true
          });
        });
      }};
    tick(); return;
  }

  // 2) WebLLM (local GPU)
  if (WebLLM.hasWebGPU()){
    if(!Budget.canSpend(100)){ warn.textContent='Session token cap reached (35k).'; status.textContent='Stopped.'; return; }
    status.textContent='Loading local model…';
    let strong = []; try{
      await WebLLM.load({ model: state.webllmModel, progress: p=>{ status.textContent=`Loading local model… ${Math.round((p?.progress||0)*100)}%`; } });
      strong = await deriveStrong({ query: v.sanitized, lang: state.lang });
    }catch{
      // fall through to server
    }

    if (WebLLM.ready){
      const sys = groundedSystem({ lang: state.lang, strong });
      const messages = [{role:'system', content: sys}, {role:'user', content: v.sanitized}];
      const t0b = performance.now();
      status.textContent='Generating (local)…';
      const aiEl=add('assistant',''); let streamed=0;
      try{
        await WebLLM.generate({
          messages,
          onToken:(tok)=>{
            const t=Budget.approxTokens(tok);
            if(!Budget.canSpend(t)){ warn.textContent='Session token cap reached (35k). Truncating.'; return; }
            streamed += t; aiEl.textContent += tok; chat.scrollTop=chat.scrollHeight;
            if ((Budget.spent + streamed) >= Budget.softWarn && Budget.spent < Budget.softWarn) warn.textContent='Approaching session budget (25k).';
          }
        });
      }catch{/* go to server */}

      if (aiEl.textContent){
        Budget.note(streamed);
        status.textContent=`Ready. (≈${Budget.spent}/${Budget.hardCap})`;
        state.messages.push({role:'assistant', content: aiEl.textContent});
        if (Budget.spent >= Budget.hardCap) warn.textContent='Session hard cap reached (35k). Further generation disabled.';
        // log WebLLM
        const t1b=performance.now();
        const ids=(strong||[]).map(s=>s.id);
        await Log.addTurn({
          ts: Date.now(), lang: state.lang, pathUsed:'webllm', provider:'local-webgpu',
          tokensIn: Budget.approxTokens(v.sanitized), tokensOut: streamed, latencyMs: Math.round(t1b - t0b),
          question: v.sanitized, answerPreview: aiEl.textContent.slice(0,280),
          topIds: ids, coverageOK: (ids.length>=2)
        });
        return;
      }
    }
  }

  // 3) Server (L2/L3/L7)
  try{
    await sendToServerSSE({
      messages: state.messages.slice(-16),
      lang: state.lang,
      csrf: state.csrf,
      hp: hpInput.value || ''
    });
  }catch{
    const msg=(state.lang==='es')?'Ruta de servidor no disponible en este momento.':'Server path unavailable at the moment.';
    add('assistant', msg); state.messages.push({role:'assistant', content: msg}); status.textContent='Ready.';
    // log failure stub
    await Log.addTurn({
      ts: Date.now(), lang: state.lang, pathUsed:'server-fail', provider:'', tokensIn: Budget.approxTokens(v.sanitized),
      tokensOut: 0, latencyMs: 0, question: v.sanitized, answerPreview:'', topIds:[], coverageOK:false
    });
  }
}

// ---------- Bind ----------
send.onclick=handleSend;
inp.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleSend(); }});

// ---------- Budget pill init ----------
updateBudgetHint();
