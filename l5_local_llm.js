// l5_local_llm.js
// Local retrieval + extractive drafting used before any escalation.

export const L5Local = (() => {
  const pageBase = (() => {
    if (typeof window !== 'undefined' && window.location){
      try { return new URL('.', window.location.href); } catch {}
    }
    if (typeof document !== 'undefined' && document.baseURI){
      try { return new URL('.', document.baseURI); } catch {}
    }
    return new URL('.', 'https://localhost/');
  })();

  const PACK_URL = (() => {
    const cfg = window.__CHATTIA_CONFIG__ || {};
    const existing = cfg.packURL || window.__CHATTIA_PACK_URL;
    if (existing) return existing;
    const derived = new URL('./packs/site-pack.json', pageBase).toString();
    window.__CHATTIA_PACK_URL = derived;
    return derived;
  })();

  async function loadPack() {
    if (window.__PACK__) return window.__PACK__;
    const r = await fetch(PACK_URL, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('pack_load_failed');
    window.__PACK__ = await r.json();
    return window.__PACK__;
  }

  function tok(s) {
    return (String(s||'').toLowerCase().normalize('NFKC').match(/[a-z0-9áéíóúüñ]+/gi)) || [];
  }

  // Simple BM25-like scoring (idf-ish) over chunks
  function scoreChunks(pack, query, lang) {
    const chunks = [];
    const terms = tok(query);
    if (!terms.length) return [];

    const allChunks = [];
    for (const d of (pack.docs||[])) {
      if (lang && d.lang && d.lang !== lang) continue;
      for (const c of (d.chunks||[])) {
        allChunks.push(c);
      }
    }
    if (!allChunks.length) return [];

    // doc freq per term
    const df = {};
    for (const c of allChunks) {
      const ctoks = new Set(tok(c.text));
      for (const t of terms) if (ctoks.has(t)) df[t] = (df[t]||0)+1;
    }
    const N = allChunks.length;
    const idf = {};
    for (const t of terms) {
      const dft = df[t] || 0.5;
      idf[t] = Math.log( (N - dft + 0.5) / (dft + 0.5) + 1 );
    }

    for (const c of allChunks) {
      const ctoks = tok(c.text);
      const tf = {};
      for (const t of ctoks) tf[t] = (tf[t]||0)+1;
      let s = 0;
      for (const t of terms) {
        const f = tf[t] || 0;
        if (!f) continue;
        // BM25-ish: k1=1.2, b=0.75 with len norm (approximate using length in tokens)
        const k1 = 1.2, b = 0.75;
        const len = ctoks.length, avg = 120; // heuristic avg chunk length
        const denom = f + k1 * (1 - b + b * (len / avg));
        s += idf[t] * ((f * (k1+1)) / (denom || 1));
      }
      if (s > 0) chunks.push({ id: c.id, text: c.text, score: s });
    }
    return chunks.sort((a,b)=>b.score-a.score);
  }

  function composeExtractive(top) {
    if (!top || !top.length) return null;
    const parts = top.slice(0,3).map(t => `${t.text.trim()} [#${t.id}]`);
    return parts.join(' ');
  }

  // Public: returns a STRING (draft) or null if low confidence
  async function draft({ query, lang = 'en', bm25Min = 0.6, coverageNeeded = 2 } = {}) {
    try {
      const pack = await loadPack();
      const scored = scoreChunks(pack, query, lang);
      if (!scored.length) return null;

      // coverage = number of distinct chunk hits
      const coverage = Math.min(scored.length, coverageNeeded);
      const top = scored.slice(0, Math.max(coverageNeeded, 3));

      // normalize scores to [0..1] with a crude max
      const max = top[0].score || 1;
      const confidence = Math.max(0, Math.min(1, (top[0].score / (max || 1))));

      if (coverage < coverageNeeded || confidence < bm25Min) return null;
      return composeExtractive(top);
    } catch {
      return null;
    }
  }

  return { draft };
})();


