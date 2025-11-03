// log_store.js — local-only logs in IndexedDB, with clear()

const ChattiaLog = (() => {
  const DB_NAME = 'chattia_logs';
  const DB_VER  = 1;
  const ST_NAME = 'events';
  let dbPromise = null;
  let mem = [];

  function hasIDB(){ return typeof indexedDB !== 'undefined'; }

  function openDB(){
    if (!hasIDB()) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject)=>{
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (ev)=>{
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(ST_NAME)){
          const s = db.createObjectStore(ST_NAME, { keyPath: 'id', autoIncrement: true });
          s.createIndex('by_ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error);
    });
    return dbPromise;
  }

  async function put(entry){
    const rec = { ts: Date.now(), ...entry };
    const db = await openDB();
    if (!db){ mem.push(rec); if (mem.length>500) mem.shift(); return; }
    await new Promise((resolve, reject)=>{
      const tx = db.transaction(ST_NAME, 'readwrite');
      tx.objectStore(ST_NAME).add(rec);
      tx.oncomplete = resolve; tx.onerror = ()=> reject(tx.error);
    });
  }

  async function latest(limit=50){
    const db = await openDB();
    if (!db) return mem.slice(-limit).reverse();
    return await new Promise((resolve, reject)=>{
      const out = [];
      const tx = db.transaction(ST_NAME, 'readonly');
      const idx = tx.objectStore(ST_NAME).index('by_ts');
      const cur = idx.openCursor(null, 'prev');
      cur.onsuccess = (e)=>{
        const c = e.target.result;
        if (!c || out.length>=limit){ resolve(out); return; }
        out.push(c.value); c.continue();
      };
      cur.onerror = ()=> reject(cur.error);
    });
  }

  async function clear(){
    const db = await openDB();
    mem = [];
    if (!db) return;
    await new Promise((resolve, reject)=>{
      const tx = db.transaction(ST_NAME, 'readwrite');
      tx.objectStore(ST_NAME).clear();
      tx.oncomplete = resolve; tx.onerror = ()=> reject(tx.error);
    });
  }

  return { put, latest, clear };
})();
window.ChattiaLog = ChattiaLog;

