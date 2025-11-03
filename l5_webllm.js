// l5_webllm.js
// Local WebLLM adapter — loaded only on low confidence. You host assets under /static/webllm/...

export const WebLLM = (() => {
  const pageBase = (() => {
    if (typeof window !== 'undefined' && window.location){
      try { return new URL('.', window.location.href); } catch {}
    }
    if (typeof document !== 'undefined' && document.baseURI){
      try { return new URL('.', document.baseURI); } catch {}
    }
    return new URL('.', 'https://localhost/');
  })();

  const cfg = window.__CHATTIA_CONFIG__ || {};
  const ensureSlash = (value) => value.endsWith('/') ? value : `${value}/`;
  const SCRIPT_URL = cfg.webllmScript || window.__CHATTIA_WEBLLM_SCRIPT || new URL('./static/webllm/web-llm.min.js', pageBase).toString();
  const ASSET_BASE = ensureSlash(cfg.webllmAssets || window.__CHATTIA_WEBLLM_ASSETS || new URL('./static/webllm/models/', pageBase).toString());
  window.__CHATTIA_WEBLLM_SCRIPT = SCRIPT_URL;
  window.__CHATTIA_WEBLLM_ASSETS = ASSET_BASE;

  let engine = null;
  let ready = false;
  let currentModel = null;

  function hasWebGPU(){ return !!navigator.gpu; }

  async function loadRuntime(){
    if (window.webllm || window.mlc) return;
    await new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = SCRIPT_URL;
      s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
    });
  }

  async function createEngine(modelId, onProgress){
    if (window.webllm && typeof window.webllm.CreateMLCEngine === 'function'){
      const eng = await window.webllm.CreateMLCEngine(
        modelId,
        { initProgressCallback: p => onProgress && onProgress(p) }
      );
      // normalize streaming API if needed
      if (!eng.chat?.completions?.create){
        eng.chat = eng.chat || {};
        eng.chat.completions = {
          async create({messages, stream}){
            const out = await eng.getMessage(messages);
            async function* gen(){ yield { choices:[{delta:{content: out||''}}]}; }
            return stream ? gen() : { choices:[{ message:{ content: out||'' } }] };
          }
        };
      }
      return eng;
    }
    if (window.mlc && typeof window.mlc.createMLCEngine === 'function'){
      const eng = await window.mlc.createMLCEngine(modelId, {
        assetBaseUrl: ASSET_BASE,
        initProgressCallback: p => onProgress && onProgress(p)
      });
      if (!eng.chat?.completions?.create){
        eng.chat = eng.chat || {};
        eng.chat.completions = {
          async create({messages, stream}){
            const out = await eng.chatCompletion({ messages, temperature: 0.2 });
            async function* gen(){ yield { choices:[{delta:{content: out||''}}]}; }
            return stream ? gen() : { choices:[{ message:{ content: out||'' } }] };
          }
        };
      }
      return eng;
    }
    throw new Error('webllm_engine_unavailable');
  }

  async function load({ model='Llama-3.1-8B-Instruct-q4f16_1', progress } = {}){
    if (!hasWebGPU()) throw new Error('webgpu_unavailable');
    if (ready && engine && currentModel === model) return true;
    await loadRuntime();
    engine = await createEngine(model, progress);
    currentModel = model; ready = !!engine;
    return ready;
  }

  async function generate({ messages, onToken }){
    if (!ready || !engine) throw new Error('not_ready');
    const stream = await engine.chat.completions.create({ messages, stream:true, temperature:0.2 });
    for await (const ev of stream){
      const delta = ev?.choices?.[0]?.delta?.content || '';
      if (!delta) continue;
      onToken && onToken(delta);
    }
  }

  return { hasWebGPU, load, generate, get ready(){ return ready; } };
})();
