// L5: Local retrieval + extractive draft with inline [#id] cites.
// Loads /packs/site-pack.json once, builds a tiny tf-idf scorer (BM25-ish).

export const L5Local = (() => {
  let cache = { ready:false, docs:[], langIndex:new Map(), df:new Map(), N:0 };

  async function loadPack(){
    if (cache.ready) return;
    const r = await fetch('/packs/site-pack.json', { headers:{'Accept':'application/json'} });
    if (!r.ok) throw new Error('pack_load_failed');
    const pack = await r.json();
    const tok = s => (s||'').toLowerCase().normalize('NFKC').match(/[a-z0-9áéíóúüñ]+/gi)||[];

    const docs=[]; // flat list of chunks across docs
    for (const d of (pack.docs||[])){
      for (const c of (d.chunks||[])){
        const terms = tok(c.text);
        const tf = new Map(); for (const w of terms) tf.set(w, (tf.get(w)||0)+1);
        docs.push({ id:c.id, text:c.text, lang:d.lang||'en', tf, terms:new Set(terms) });
      }
    }
    const df = new Map(); for (const d of docs) for (const w of d.terms) df.set(w, (df.get(w)||0)+1);
    const langIndex = new Map(); for (const d of docs){ const L=d.lang; if(!langIndex.has(L)) langIndex.set(L, []); langIndex.get(L).push(d); }

    cache = { ready:true, docs, langIndex, df, N:docs.length };
  }

  function scoreQuery(query, doc, df, N){
    const qtok = (query||'').toLowerCase().normalize('NFKC').match(/[a-z0-9áéíóúüñ]+/gi)||[];
    let s = 0;
    for (const w of qtok){
      const f = doc.tf.get(w)||0; if (!f) continue;
      const idf = Math.log(1 + ( (N - (df.get(w)||0) + 0.5) / ((df.get(w)||0) + 0.5) ));
      // simple BM25-ish with k1=1.2, b=0.75 approximated by (f / (f+1.2)) * idf
      s += (f/(f+1.2)) * idf;
    }
    return s;
  }

  function extractAnswer(top, lang){
    // Compose a short answer from top chunks. Keep citations.
    if (!top.length) return null;
    const sep = (lang==='es') ? ' ' : ' ';
    const parts = top.slice(0,3).map(t => `${t.text.trim()} [#${t.id}]`);
    return parts.join(sep).trim();
  }

  async function draft({ query, lang='en', bm25Min=0.6, coverageNeeded=2 }){
    await loadPack();
    const pool = cache.langIndex.get(lang) || cache.docs; // fallback to any
    const scored = pool.map(d => ({ ...d, score: scoreQuery(query, d, cache.df, cache.N)}))
                       .sort((a,b)=>b.score-a.score);
    const strong = scored.filter(x=>x.score>0).slice(0,6);
    const coverage = new Set(strong.slice(0,6).flatMap(d => Array.from(d.terms))).size;
    const pass = strong.length >= coverageNeeded && (strong[0]?.score||0) >= bm25Min;
    if (!pass) return null;
    return extractAnswer(strong, lang);
  }

  return { draft };
})();
