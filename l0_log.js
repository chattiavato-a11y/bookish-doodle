// l0_log.js — local-only logs (IndexedDB). No network.
// Stores each turn: ts, lang, pathUsed, provider, tokensIn, tokensOut, latencyMs,
// question, answerPreview, topIds, coverageOK.

export const Log = (() => {
  const DB_NAME = 'chattia_logs';
  const STORE = 'turns';
  let dbp;

  function openDB(){
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject)=>{
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e)=>{
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)){
          const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          os.createIndex('ts', 'ts');
          os.createIndex('path', 'pathUsed');
        }
      };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error);
    });
    return dbp;
  }

  async function addTurn(turn){
    try{
      const db = await openDB();
      await new Promise((resolve, reject)=>{
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = resolve;
        tx.onerror = ()=> reject(tx.error);
        tx.objectStore(STORE).add(turn);
      });
    }catch(e){ /* ignore */ }
  }

  async function getAll(){
    try{
      const db = await openDB();
      return await new Promise((resolve, reject)=>{
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = ()=> resolve(req.result||[]);
        req.onerror = ()=> reject(req.error);
      });
    }catch{ return []; }
  }

  async function clear(){
    try{
      const db = await openDB();
      await new Promise((resolve, reject)=>{
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = resolve;
        tx.onerror = ()=> reject(tx.error);
        tx.objectStore(STORE).clear();
      });
    }catch(e){ /* ignore */ }
  }

  // Aggregate: what to add to pack; where we spent tokens
  async function snapshot(){
    const rows = await getAll();
    const total = rows.length;

    const byPath = rows.reduce((m,r)=>{ m[r.pathUsed]=(m[r.pathUsed]||0)+1; return m; }, {});
    const spent = rows.reduce((s,r)=> s + (r.tokensOut||0) + (r.tokensIn||0), 0);

    const byProvider = rows.reduce((m,r)=>{
      if (r.provider) m[r.provider]=(m[r.provider]||0)+((r.tokensOut||0)+(r.tokensIn||0));
      return m;
    }, {});

    // candidates: queries that *did not* pass coverage locally (coverageOK=false) and escalated
    const candidateMap = new Map();
    for (const r of rows){
      if (r.coverageOK) continue;
      const q = (r.question||'').toLowerCase().trim();
      if (!q) continue;
      candidateMap.set(q, (candidateMap.get(q)||0)+1);
    }
    const candidates = Array.from(candidateMap.entries())
      .map(([q,n])=>({ q, n }))
      .sort((a,b)=> b.n - a.n)
      .slice(0,10);

    return { total, byPath, spent, byProvider, candidates };
  }

  return { addTurn, snapshot, clear };
})();
