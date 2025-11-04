// l5_local_llm.js
// Local retrieval + extractive drafting (runs before any provider escalation).
// Global export: window.L5Local = { draft, loadPack, clearCache, last }

(function (global){
  "use strict";

  // ---- Config & constants ---------------------------------------------------
  const CFG = global.__CHATTIA_CONFIG__ || {};
  const LS_KEYS = {
    etag: "chattia.pack.etag.v1",
    json: "chattia.pack.json.v1"
  };

  // Resolve page base (for local fallback URL generation)
  const PAGE_BASE = (() => {
    try {
      if (global.location?.href) return new URL(".", global.location.href);
      if (global.document?.baseURI) return new URL(".", global.document.baseURI);
    } catch {}
    return new URL(".", "https://invalid.local/");
  })();

  // Preferred PACK URL order:
  // 1) window.__CHATTIA_CONFIG__.packURL
  // 2) window.__CHATTIA_PACK_URL (legacy override)
  // 3) relative ./packs/site-pack.json under current origin
  const PACK_URL = (() => {
    const fromCfg = CFG.packURL;
    const legacy = global.__CHATTIA_PACK_URL;
    if (fromCfg && typeof fromCfg === "string") return fromCfg;
    if (legacy && typeof legacy === "string") return legacy;
    const derived = new URL("./packs/site-pack.json", PAGE_BASE).toString();
    global.__CHATTIA_PACK_URL = derived; // cache for any legacy readers
    return derived;
  })();

  // Optional integrity: Base64(SHA-256(bytes)) — NO 'sha256-' prefix
  const PACK_SHA256 = (CFG.packSHA256 || "").trim();

  // ---- Small utilities ------------------------------------------------------
  function log(kind, msg, meta){
    try { global.ChattiaLog?.add?.({ kind, msg, meta }); } catch {}
  }

  function toBase64(buf){
    const b = String.fromCharCode(...new Uint8Array(buf));
    // btoa expects binary string
    return btoa(b);
  }

  async function sha256Base64(buf){
    if (!crypto?.subtle) return ""; // integrity optional
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return toBase64(hash);
  }

  function tok(s){
    return (String(s||"")
      .toLowerCase()
      .normalize("NFKC")
      .match(/[a-z0-9áéíóúüñ]+/gi)) || [];
  }

  // ---- Pack caching with ETag ----------------------------------------------
  let MEM_PACK = null;        // parsed JSON in memory
  let MEM_ETAG = null;        // last seen ETag
  let LAST = { strong: [], top: [], query: "", lang: "en", confidence: 0 };

  function loadFromLocalStorage(){
    try {
      const et = localStorage.getItem(LS_KEYS.etag);
      const js = localStorage.getItem(LS_KEYS.json);
      if (!js) return null;
      MEM_ETAG = et || null;
      MEM_PACK = JSON.parse(js);
      log("l5", "pack_cache_hit", { etag: !!et });
      return MEM_PACK;
    } catch {
      return null;
    }
  }

  function saveToLocalStorage(jsonStr, etag){
    try {
      localStorage.setItem(LS_KEYS.json, jsonStr);
      if (etag) localStorage.setItem(LS_KEYS.etag, etag);
      MEM_PACK = JSON.parse(jsonStr);
      MEM_ETAG = etag || null;
    } catch {}
  }

  async function fetchPackWithCache() {
    const headers = new Headers({ "Accept":"application/json" });
    const et = MEM_ETAG ?? localStorage.getItem(LS_KEYS.etag);
    if (et) headers.set("If-None-Match", et);

    const res = await fetch(PACK_URL, {
      method: "GET",
      headers,
      cache: "no-store"
    });

    // 304: keep local copy
    if (res.status === 304) {
      log("l5", "pack_304_not_modified");
      return MEM_PACK || loadFromLocalStorage();
    }

    if (!res.ok) {
      throw new Error(`pack_fetch_failed_${res.status}`);
    }

    const etag = res.headers.get("ETag");
    const buf = await res.arrayBuffer();

    // Optional integrity
    if (PACK_SHA256) {
      const got = await sha256Base64(buf);
      if (got !== PACK_SHA256) {
        log("l5", "pack_integrity_failed", { got, expected: PACK_SHA256 });
        throw new Error("pack_integrity_failed");
      }
    }

    const text = new TextDecoder().decode(buf);
    // Validate JSON before persisting
    try { JSON.parse(text); } catch { throw new Error("pack_bad_json"); }

    saveToLocalStorage(text, etag);
    log("l5", "pack_fetched", { etag: !!etag });
    return MEM_PACK;
  }

  // Public: loadPack() — returns parsed pack JSON
  async function loadPack(){
    if (MEM_PACK) return MEM_PACK;
    const ls = loadFromLocalStorage();
    if (ls) return ls;
    return await fetchPackWithCache();
  }

  // Clear local cache (forces fresh fetch next time)
  function clearCache(){
    try {
      localStorage.removeItem(LS_KEYS.json);
      localStorage.removeItem(LS_KEYS.etag);
    } catch {}
    MEM_PACK = null; MEM_ETAG = null;
  }

  // ---- Scoring & composing --------------------------------------------------
  /**
   * BM25-ish scoring over all chunks.
   * pack: { docs: [ { lang?: 'en'|'es', chunks: [ { id, text } ] } ] }
   * returns: sorted array [{id,text,score}, ...]
   */
  function scoreChunks(pack, query, lang){
    const terms = tok(query);
    if (!terms.length) return [];

    const allChunks = [];
    for (const d of (pack.docs || [])){
      if (lang && d.lang && d.lang !== lang) continue;
      for (const c of (d.chunks || [])) allChunks.push(c);
    }
    if (!allChunks.length) return [];

    // Doc frequency per term
    const df = Object.create(null);
    for (const c of allChunks){
      const ctoks = new Set(tok(c.text));
      for (const t of terms) if (ctoks.has(t)) df[t] = (df[t]||0) + 1;
    }
    const N = allChunks.length;

    // IDF
    const idf = Object.create(null);
    for (const t of terms){
      const dft = df[t] || 0.5;
      idf[t] = Math.log( (N - dft + 0.5) / (dft + 0.5) + 1 );
    }

    // Score each chunk
    const out = [];
    for (const c of allChunks){
      const ctoks = tok(c.text);
      const tf = Object.create(null);
      for (const t of ctoks) tf[t] = (tf[t]||0) + 1;

      let s = 0;
      const k1 = 1.2, b = 0.75;
      const len = ctoks.length, avg = 120; // heuristic avg chunk length
      for (const t of terms){
        const f = tf[t] || 0; if (!f) continue;
        const denom = f + k1 * (1 - b + b * (len / avg));
        s += idf[t] * ((f * (k1 + 1)) / (denom || 1));
      }
      if (s > 0) out.push({ id: c.id, text: c.text, score: s });
    }

    return out.sort((a,b)=> b.score - a.score);
  }

  function composeExtractive(top){
    if (!top?.length) return null;
    return top.slice(0,3).map(t => `${t.text.trim()} [#${t.id}]`).join(" ");
  }

  // ---- Public draft() -------------------------------------------------------
  /**
   * draft({ query, lang='en', bm25Min=0.6, coverageNeeded=2 })
   * Returns an extractive STRING when confident, else null.
   */
  async function draft(opts = {}){
    const query = String(opts.query || "");
    if (!query.trim()) return null;

    const lang = (opts.lang === "es") ? "es" : "en";
    const bm25Min = typeof opts.bm25Min === "number" ? opts.bm25Min : 0.6;
    const coverageNeeded = Math.max(1, opts.coverageNeeded || 2);

    try {
      const pack = await loadPack();
      const scored = scoreChunks(pack, query, lang);
      if (!scored.length) {
        LAST = { strong: [], top: [], query, lang, confidence: 0 };
        log("l5", "no_hits");
        return null;
      }

      // Take top K for coverage/confidence estimation
      const topK = scored.slice(0, Math.max(coverageNeeded, 3));
      const confidence = (() => {
        const max = topK[0].score || 1;
        return Math.max(0, Math.min(1, (topK[0].score / (max || 1))));
      })();

      const coverage = Math.min(topK.length, coverageNeeded);
      if (coverage < coverageNeeded || confidence < bm25Min) {
        LAST = { strong: topK, top: topK, query, lang, confidence };
        log("l5", "low_confidence", { coverage, coverageNeeded, confidence, bm25Min });
        return null;
      }

      const extractive = composeExtractive(topK);
      LAST = { strong: topK, top: topK, query, lang, confidence };
      log("l5", "extractive_ok", { ids: topK.map(x=>x.id), confidence });
      return extractive;
    } catch (e) {
      log("l5", "draft_error", { err: String(e?.message || e) });
      return null;
    }
  }

  // Expose last scoring snapshot for insights/debug
  function last(){ return LAST; }

  // ---- Global export --------------------------------------------------------
  global.L5Local = { draft, loadPack, clearCache, last };

})(window);
