// log_store.js
// Local-only interaction recorder for Chattia.
// Stores conversations in IndexedDB ("chattia_logs") -> "events".
// Fields per entry:
//  ts, role, text, lang, path, tokens, provider, sessionTotal
// No remote calls. No downloads.

const ChattiaLog = (() => {
  const DB_NAME = 'chattia_logs';
  const DB_VER  = 1;
  const ST_NAME = 'events';

  let dbPromise = null;
  let mem = []; // fallback in case IndexedDB is not available

  function hasIDB(){
    return typeof indexedDB !== 'undefined';
  }

  function openDB(){
    if (!hasIDB()){
      return Promise.resolve(null);
    }
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
    const rec = {
      ts: Date.now(),
      ...entry
    };
    const db = await openDB();
    if (!db){
      // fallback to memory (kept small)
      mem.push(rec);
      if (mem.length > 500) mem.shift();
      return;
    }
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(ST_NAME, 'readwrite');
      const st = tx.objectStore(ST_NAME);
      st.add(rec);
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
    });
  }

  async function latest(limit=50){
    const db = await openDB();
    if (!db){
      return mem.slice(-limit);
    }
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(ST_NAME, 'readonly');
      const st = tx.objectStore(ST_NAME);
      const idx = st.index('by_ts');
      const res = [];
      const cursorReq = idx.openCursor(null, 'prev');
      cursorReq.onsuccess = (ev)=>{
        const cursor = ev.target.result;
        if (!cursor || res.length >= limit){
          resolve(res);
          return;
        }
        res.push(cursor.value);
        cursor.continue();
      };
      cursorReq.onerror = ()=> reject(cursorReq.error);
    });
  }

  return { put, latest };
})();

window.ChattiaLog = ChattiaLog;
