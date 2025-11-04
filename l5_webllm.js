// l5_webllm.js
// Optional local LLM (WebGPU/WebLLM) used only when L5 retrieval is low-confidence.
// Global export: window.L5WebLLM = { supported, warmup, generate, unload, busy }

(function (global){
  "use strict";

  const CFG = global.__CHATTIA_CONFIG__ || {};
  const log  = (kind, msg, meta)=>{ try{ global.ChattiaLog?.add?.({kind,msg,meta}); }catch{} };

  // Prefer a same-origin loader (so CSP `script-src 'self'` is enough).
  const LOCAL_WEBLLM_LOADER = "/static/webllm/web-llm.min.js";
  const FALLBACK_WEBLLM_LOADER = (CFG.webllmScript || "").trim(); // e.g., https://esm.run/@mlc-ai/web-llm

  const MODEL_ID = (CFG.webllmModelId || "Llama-3.1-8B-Instruct-q4f16_1-MLC").trim();

  // Soft token cap for local draft (kept small to be snappy)
  const LOCAL_MAX_TOKENS = 256;

  // Internal single-engine cache
  let _engine = null;
  let _imported = null;
  let _busy = false;

  function supported(){
    // WebGPU is required for good perf; allow override for testing.
    const hasGPU = !!(global.navigator && "gpu" in global.navigator);
    return !!hasGPU;
  }

  function busy(){ return _busy; }

  async function _importWebLLM(){
    if (_imported) return _imported;
    // Try local first
    try{
      _imported = await import(LOCAL_WEBLLM_LOADER);
      log("l5w","import_loader_local_ok",{src:LOCAL_WEBLLM_LOADER});
      return _imported;
    }catch(e){
      log("l5w","import_loader_local_fail",{err:String(e)});
    }
    if (FALLBACK_WEBLLM_LOADER){
      try{
        _imported = await import(/* @vite-ignore */ FALLBACK_WEBLLM_LOADER);
        log("l5w","import_loader_cdn_ok",{src:FALLBACK_WEBLLM_LOADER});
        return _imported;
      }catch(e){
        log("l5w","import_loader_cdn_fail",{err:String(e), src:FALLBACK_WEBLLM_LOADER});
      }
    }
    throw new Error("webllm_loader_unavailable");
  }

  async function warmup(initProgressCallback){
    if (!supported()) {
      log("l5w","webgpu_not_supported");
      return null;
    }
    if (_engine) return _engine;

    const webllm = await _importWebLLM();

    // Best-effort progress callback for UI
    const progress = (p)=> {
      // p: { progress:0..1, size?:number, message?:string, ... }
      try { if (typeof initProgressCallback === "function") initProgressCallback(p); } catch {}
      log("l5w","load_progress", p);
    };

    // NOTE: We intentionally *do not* override appConfig here.
    // If you host artifacts at /static/webllm/models/<MODEL_ID>/,
    // configure the WebLLM build to use same-origin URLs, or serve them via your proxy.
    _engine = await webllm.CreateMLCEngine(MODEL_ID, { initProgressCallback: progress });
    log("l5w","engine_ready",{ model: MODEL_ID });
    return _engine;
  }

  /**
   * generate({ system, messages, temperature, maxTokens, onDelta, signal })
   * - messages: OpenAI-style [{role:'system'|'user'|'assistant', content:string}, ...]
   * - onDelta(token: string) called for streamed pieces
   * returns full string
   */
  async function generate(opts = {}){
    if (!supported()) throw new Error("webgpu_not_supported");
    const engine = await warmup(opts.initProgressCallback);

    const messages = Array.isArray(opts.messages) ? opts.messages.slice(-16) : [];
    const temperature = typeof opts.temperature === "number" ? opts.temperature : 0.2;
    const maxTokens = Math.max(1, Math.min(LOCAL_MAX_TOKENS, opts.maxTokens || LOCAL_MAX_TOKENS));
    const onDelta = typeof opts.onDelta === "function" ? opts.onDelta : null;
    const signal = opts.signal;

    // Compose with optional system message
    const convo = [];
    if (opts.system) convo.push({ role: "system", content: String(opts.system) });
    for (const m of messages){
      if (!m || !m.role) continue;
      let role = m.role;
      if (role !== "system" && role !== "assistant" && role !== "user") role = "user";
      convo.push({ role, content: String(m.content ?? "") });
    }

    let text = "";
    _busy = true;
    try{
      const chunks = await _engine.chat.completions.create({
        messages: convo,
        temperature,
        stream: true,
        max_tokens: maxTokens,
        stream_options: { include_usage: true }
      });

      for await (const chunk of chunks){
        if (signal?.aborted) throw new Error("aborted");
        const piece = chunk?.choices?.[0]?.delta?.content || "";
        if (piece){
          text += piece;
          if (onDelta) onDelta(piece);
        }
        // final chunk may include usage; we ignore here (UI can estimate)
      }
      return text.trim();
    } finally {
      _busy = false;
      log("l5w","generate_done",{ chars: text.length });
    }
  }

  async function unload(){
    // WebLLM does not expose a hard "dispose" yet; we just drop refs.
    _engine = null;
    _imported = _imported || null;
    log("l5w","engine_unloaded");
  }

  // -------- export --------
  global.L5WebLLM = {
    supported, warmup, generate, unload, busy
  };

  try { log("l5w","ready",{ model: MODEL_ID, loaderLocal: LOCAL_WEBLLM_LOADER, loaderFallback: !!FALLBACK_WEBLLM_LOADER }); } catch {}

})(window);
