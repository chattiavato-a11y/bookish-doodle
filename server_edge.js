// server_edge.js  — L2 Guard + L3 Policy + SSE + L7 provider chain
// Providers: OSS(OpenAI-compatible), Grok (xAI), Gemini, OpenAI.
// Per-provider soft cap = 25k; session hard cap = 35k. Best-effort in-memory counters.
//
// ENV (all TEXT):
//  FRONTEND_ORIGIN     = (optional) lock CORS to your UI origin, else same-origin
//  PACK_URL            = https://<your-origin>/packs/site-pack.json
//  ENABLE_PROVIDERS    = "true" to allow L7 calls (default "false")
//  PROVIDER_CHAIN      = "oss,grok,gemini,openai" (any subset/order)
//  // OSS (OpenAI-compatible; e.g., Together, OpenRouter, self-hosted):
//  OSS_BASE_URL        = e.g. "https://api.together.xyz/v1"
//  OSS_MODEL_ID        = e.g. "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"
//  OSS_API_KEY         = "sk-..."
//  // Grok (xAI):
//  GROK_BASE_URL       = "https://api.x.ai/v1"
//  GROK_MODEL_ID       = e.g. "grok-2-latest"
//  GROK_API_KEY        = "xai-..."
//  // Gemini (Google AI for Developers):
//  GEMINI_BASE_URL     = "https://generativelanguage.googleapis.com/v1beta"
//  GEMINI_MODEL_ID     = e.g. "gemini-2.5-flash"
//  GEMINI_API_KEY      = "..."
//  // OpenAI:
//  OPENAI_BASE_URL     = "https://api.openai.com/v1"
//  OPENAI_MODEL_ID     = e.g. "gpt-4o-mini"
//  OPENAI_API_KEY      = "sk-..."
//
// Notes: xAI exposes OpenAI-compatible /v1/chat/completions at https://api.x.ai . :contentReference[oaicite:0]{index=0}
/* Gemini uses REST: POST {BASE}/models/{MODEL}:generateContent?key=... . :contentReference[oaicite:1]{index=1}
   OpenAI & Together use /chat/completions (OpenAI-compatible). :contentReference[oaicite:2]{index=2} */

const MAX_BODY_BYTES = 64 * 1024;
const RL_PER_IP_PER_MIN = 20;
const WINDOW_MS = 60_000;

const PROVIDER_SOFT = 25_000;     // soft cap per provider
const SESSION_HARD  = 35_000;     // hard cap per session

const POLICY_PATTERNS = [
  /ignore (?:all|the) (?:previous|prior|above) (?:instructions|rules)/i,
  /act as .* (?:system|developer)/i,
  /reveal (?:the )?system prompt/i,
  /olvida las instrucciones/i, /actúa como .* sistema/i,
  /\b(?:ssn|social security number)\b/i,
  /\b(?:credit card|card number|tarjeta de crédito|cvv)\b/i,
  /\b(?:password|contraseña|passcode|clave)\b/i,
];

const sessionCounters = new Map(); // sid -> { session: number, per: {oss,grok,gemini,openai} }
const rateMap = new Map();         // simple best-effort IP rate limiter

const CORS = (origin, allow) =>
  (!allow || origin !== allow) ? {} : {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF, X-Nonce",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

function ipOf(req){ return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "0.0.0.0"; }

function rateLimit(ip){
  const now = Date.now();
  const rec = rateMap.get(ip) || { count:0, ts: now };
  if (now - rec.ts > WINDOW_MS){ rec.count = 0; rec.ts = now; }
  rec.count++; rateMap.set(ip, rec);
  return rec.count <= RL_PER_IP_PER_MIN;
}

function bad(status, msg, extra={}) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { "Content-Type":"application/json; charset=utf-8", ...extra }
  });
}

async function readJSON(req){
  const len = Number(req.headers.get("content-length")||0);
  if (len && len > MAX_BODY_BYTES) throw new Error("payload_too_large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("payload_too_large");
  try { return JSON.parse(text||"{}"); } catch { throw new Error("bad_json"); }
}

function violatesPolicy(s){
  const txt = String(s||"");
  for (const re of POLICY_PATTERNS) if (re.test(txt)) return true;
  if (/\b(?:\d[ -]?){13,19}\b/.test(txt)) return true; // rough CC
  return false;
}

function tok(s){ return (String(s||"").toLowerCase().normalize("NFKC").match(/[a-z0-9áéíóúüñ]+/gi))||[]; }

async function loadPack(url){ const r = await fetch(url, { headers:{Accept:"application/json"}});
  if(!r.ok) throw new Error("pack_fetch_failed"); return await r.json(); }

function topChunks(pack, query, lang){
  const terms = tok(query), hits=[];
  for (const d of (pack.docs||[])){
    if (lang && d.lang && d.lang!==lang) continue;
    for (const c of (d.chunks||[])){
      const t = tok(c.text); let score=0; for(const w of terms) if (t.includes(w)) score++;
      if (score>0) hits.push({ id:c.id, text:c.text, score });
    }
  }
  return hits.sort((a,b)=>b.score-a.score).slice(0,6);
}

function composeExtractive(strong, lang){
  if (!strong.length) return null;
  const parts = strong.slice(0,3).map(t => `${t.text.trim()} [#${t.id}]`);
  return parts.join(" ").trim();
}

function sseString(s, extraHeaders={}){
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c){
      const n=64; for(let i=0;i<s.length;i+=n){ c.enqueue(enc.encode(`data: ${s.slice(i,i+n)}\n\n`)); }
      c.enqueue(enc.encode("data: [END]\n\n")); c.close();
    }
  });
  return new Response(stream, { status:200, headers:{
    "Content-Type":"text/event-stream; charset=utf-8",
    "Cache-Control":"no-cache, no-transform",
    ...extraHeaders
  }});
}

function approxTokens(...pieces){ return Math.ceil(pieces.map(x=>String(x||"")).join("").length/4); }

function getSID(reqBody){ return String(reqBody?.csrf||"") || "anon"; }
function getCounters(sid){
  let v = sessionCounters.get(sid);
  if (!v){ v = { session:0, per:{oss:0,grok:0,gemini:0,openai:0} }; sessionCounters.set(sid, v); }
  return v;
}

// ---------- Provider adapters ----------
async function callOpenAICompat({ base, key, model, messages }){
  const url = `${base.replace(/\/+$/,'')}/chat/completions`;
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature:0.2, stream:false })
  });
  if (!r.ok) throw new Error(`provider_http_${r.status}`);
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content || "";
  const used = (j?.usage?.total_tokens ?? approxTokens(JSON.stringify(messages), text));
  return { text, used };
}

async function callGrok({ base, key, model, messages }){
  // xAI is OpenAI-compatible chat completions. :contentReference[oaicite:3]{index=3}
  return callOpenAICompat({ base, key, model, messages });
}

async function callOpenAI({ base, key, model, messages }){
  // Standard OpenAI Chat Completions. :contentReference[oaicite:4]{index=4}
  return callOpenAICompat({ base, key, model, messages });
}

async function callGemini({ base, key, model, systemText, userText }){
  // Gemini generateContent (non-stream); we stream it to client. :contentReference[oaicite:5]{index=5}
  const url = `${base.replace(/\/+$/,'')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const contents = [{ role:"user", parts:[{ text: `SYSTEM:\n${systemText}\n\nUSER:\n${userText}`}]}];
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ contents }) });
  if (!r.ok) throw new Error(`provider_http_${r.status}`);
  const j = await r.json();
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p=>p.text||"").join("") || "";
  const used = approxTokens(systemText, userText, text); // Gemini usage varies; approximate
  return { text, used };
}

// ---------- L7 chain ----------
async function runProviderChain({ env, userMsg, lang, strong, sid }){
  if (String(env?.ENABLE_PROVIDERS||"").toLowerCase()!=="true")
    return { text:null, used:0, provider:"none", ptotal:0, stotal: getCounters(sid).session };

  const chain = String(env?.PROVIDER_CHAIN || "oss,grok,gemini,openai")
    .split(",").map(s=>s.trim()).filter(Boolean);

  const sys = (lang==="es"
    ? "Responde SOLO con el contexto. Si falta info, dilo. Cita [#id]."
    : "Answer ONLY using the context. If info is missing, say so. Cite [#id].");
  const ctx = (strong||[]).map(t=>`[#${t.id}] ${t.text}`).join("\n");
  const systemText = `${sys}\n\nContext:\n${ctx}`;
  const messages = [{ role:"system", content: systemText }, { role:"user", content: userMsg }];

  const ctr = getCounters(sid);

  for (const p of chain){
    try{
      if (!(p in ctr.per)) ctr.per[p]=0;
      if (ctr.per[p] >= PROVIDER_SOFT) continue; // skip exhausted provider

      if (p==="oss" && env?.OSS_BASE_URL && env?.OSS_API_KEY && env?.OSS_MODEL_ID){
        const { text, used } = await callOpenAICompat({
          base: env.OSS_BASE_URL, key: env.OSS_API_KEY, model: env.OSS_MODEL_ID, messages
        });
        // enforce caps
        if (ctr.session + used > SESSION_HARD) return { text, used: Math.max(0, SESSION_HARD-ctr.session), provider:p, ptotal:ctr.per[p], stotal:ctr.session };
        ctr.per[p] += used; ctr.session += used;
        return { text, used, provider:p, ptotal:ctr.per[p], stotal:ctr.session };
      }

      if (p==="grok" && env?.GROK_BASE_URL && env?.GROK_API_KEY && env?.GROK_MODEL_ID){
        const { text, used } = await callGrok({
          base: env.GROK_BASE_URL, key: env.GROK_API_KEY, model: env.GROK_MODEL_ID, messages
        });
        if (ctr.session + used > SESSION_HARD) return { text, used: Math.max(0, SESSION_HARD-ctr.session), provider:p, ptotal:ctr.per[p], stotal:ctr.session };
        ctr.per[p] += used; ctr.session += used;
        return { text, used, provider:p, ptotal:ctr.per[p], stotal:ctr.session };
      }

      if (p==="gemini" && env?.GEMINI_BASE_URL && env?.GEMINI_API_KEY && env?.GEMINI_MODEL_ID){
        const { text, used } = await callGemini({
          base: env.GEMINI_BASE_URL, key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL_ID,
          systemText, userText: userMsg
        });
        if (ctr.session + used > SESSION_HARD) return { text, used: Math.max(0, SESSION_HARD-ctr.session), provider:p, ptotal:ctr.per[p], stotal:ctr.session };
        ctr.per[p] += used; ctr.session += used;
        return { text, used, provider:p, ptotal:ctr.per[p], stotal:ctr.session };
      }

      if (p==="openai" && env?.OPENAI_BASE_URL && env?.OPENAI_API_KEY && env?.OPENAI_MODEL_ID){
        const { text, used } = await callOpenAI({
          base: env.OPENAI_BASE_URL, key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL_ID, messages
        });
        if (ctr.session + used > SESSION_HARD) return { text, used: Math.max(0, SESSION_HARD-ctr.session), provider:p, ptotal:ctr.per[p], stotal:ctr.session };
        ctr.per[p] += used; ctr.session += used;
        return { text, used, provider:p, ptotal:ctr.per[p], stotal:ctr.session };
      }
    } catch (e){
      // continue to next provider
    }
  }
  return { text:null, used:0, provider:"none", ptotal:0, stotal: getCounters(sid).session };
}

// ---------- request handler ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin")||"";
    const allow = env?.FRONTEND_ORIGIN || "";

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS(origin, allow) });
    if (url.pathname === "/healthz") return new Response("ok");

    if (url.pathname !== "/api/chat") return new Response("Not found", { status:404 });

    const cors = CORS(origin, allow);
    if (allow && origin && origin !== allow) return bad(403,"origin_not_allowed",cors);
    if (req.method !== "POST") return bad(405,"method_not_allowed",{...cors,"Allow":"POST, OPTIONS"});

    const ip = ipOf(req);
    if (!rateLimit(ip)) return bad(429,"rate_limited",cors);
    if (!(req.headers.get("content-type")||"").includes("application/json"))
      return bad(415,"unsupported_media_type",cors);

    let body;
    try { body = await readJSON(req); } catch(e){ return bad(e.message==="payload_too_large"?413:400, e.message, cors); }

    // Honeypot + CSRF
    if (String(body.hp||"").trim()!=="") return bad(400,"bot_detected",cors);
    const csrfHdr = req.headers.get("x-csrf")||""; const csrfBody = String(body.csrf||"");
    if (!csrfHdr || !csrfBody || csrfHdr!==csrfBody) return bad(403,"csrf_failed",cors);

    const userMsg = String(body.messages?.slice(-1)[0]?.content||"");
    const lang = (body.lang==="es"?"es":"en");
    if (violatesPolicy(userMsg)){
      const refuse = lang==="es" ? "No puedo ayudar con esa solicitud. Reformula por favor." : "I can’t help with that request. Please rephrase.";
      return sseString(refuse, { ...cors, "X-Provider":"policy", "X-Tokens-This-Call":"0", "X-Session-Total":String(getCounters(getSID(body)).session) });
    }

    // Load pack + try grounded extractive
    const packUrl = (env?.PACK_URL && String(env.PACK_URL).trim()) || `${url.origin}/packs/site-pack.json`;
    let pack; try { pack = await loadPack(packUrl); } catch { return bad(502,"pack_unavailable",cors); }
    const strong = topChunks(pack, userMsg, lang);
    const extractive = composeExtractive(strong, lang);

    // Heuristic: if strong coverage is decent, return extractive; else escalate to L7
    const coverageOK = strong.length >= 2;
    const sid = getSID(body);

    if (coverageOK && extractive){
      const used = approxTokens(userMsg, extractive);
      const ctr = getCounters(sid); if (ctr.session + used <= SESSION_HARD){ ctr.session += used; }
      return sseString(extractive, {
        ...cors, "X-Provider":"l5-server", "X-Tokens-This-Call":String(used),
        "X-Provider-Total":"0", "X-Session-Total":String(ctr.session),
        "X-Provider-Notice":"providers-not-used"
      });
    }

    // L7 providers (if enabled)
    const { text, used, provider, ptotal, stotal } =
      await runProviderChain({ env, userMsg, lang, strong, sid });

    if (!text){
      const fallback = lang==="es"
        ? "No tengo suficiente información local y los proveedores no están disponibles. [#none]"
        : "I don’t have enough local info and providers are unavailable. [#none]";
      const used0 = approxTokens(userMsg, fallback);
      return sseString(fallback, {
        ...cors, "X-Provider":"none", "X-Tokens-This-Call":String(used0),
        "X-Provider-Total":"0", "X-Session-Total":String(getCounters(sid).session)
      });
    }

    // Stream provider answer (chunked) with budget headers
    return sseString(text, {
      ...cors,
      "X-Provider": provider,
      "X-Tokens-This-Call": String(used),
      "X-Provider-Total": String(getCounters(s

