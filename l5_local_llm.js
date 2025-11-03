// l5_webllm.js
// Local WebLLM adapter. Loads ONLY when called (low confidence).
// Expects you to HOST on your origin:
//   /static/webllm/web-llm.min.js
//   /static/webllm/models/Llama-3.1-8B-Instruct-q4f16_1/...

export const WebLLM = (() => {
  let engine = null;
  let ready = false;
  let currentModel = null;

  function hasWebGPU(){ return !!navigator.gpu; }

  async function loadRuntime(){
    if (window.webllm || window.mlc) return;
    await new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = '/static/webllm/web-llm.min.js';   // YOU host this file
      s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
    });
  }

  async function createEngine(modelId, onProgress){
    // Try WebLLM (modern)
    if (window.webllm && typeof window.webllm.CreateMLCEngine === 'function'){
      const engine = await window.webllm.CreateMLCEngine(
        modelId,
        { initProgressCallback: p => onProgress && onProgress(p) }
      );
      // normalize interface
      engine.modelId = modelId;
      if (!engine.chat?.completions?.create){
        engine.chat = engine.chat || {};
        engine.chat.completions = {
          async create({messages, stream}){
            const out = await engine.getMessage(messages); // fallback
            async function* gen(){ yield { choices:[{delta:{content: out||''}}]}; }
            return stream ? gen() : { choices:[{ message:{ content: out||'' } }] };
          }
        };
      }
      return engine;
    }
    // Try legacy global (mlc)
    if (window.mlc && typeof window.mlc.createMLCEngine === 'function'){
      const eng = await window.mlc.createMLCEngine(modelId, {
        assetBaseUrl: '/static/webllm/models/',
        initProgressCallback: p => onProgress && onProgress(p)
      });
      eng.modelId = modelId;
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
    let out = '';
    for await (const ev of stream){
      const delta = ev?.choices?.[0]?.delta?.content || '';
      if (!delta) continue;
      out += delta;
      onToken && onToken(delta);
    }
    return out;
  }

  return { hasWebGPU, load, generate, get ready(){ return ready; } };
})();

