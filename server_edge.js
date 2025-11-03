// server_edge.js
// Edge runtime: secure /api/chat with L2 (guard) + L3 (policy). Providers OFF.
// Reads your content pack (PACK_URL) and returns a grounded extractive answer via SSE.
// No external vendors are contacted in this step.

const MAX_BODY_BYTES = 64 * 1024;          // ~64KB JSON body limit
const RL_PER_IP_PER_MIN = 20;              // simple best-effort rate limit
const WINDOW_MS = 60_000;

const POLICY_PATTERNS = [
  // jailbreak / prompt injection (EN/ES)
  /ignore (?:all|the) (?:previous|prior|above) (?:instructions|rules)/i,
  /act as .* (?:system|developer)/i,
  /reveal (?:the )?system prompt/i,
  /olvida las instrucciones/i,
  /actúa como .* sistema/i,
  // sensitive/PII (EN/ES)
  /\b(?:ssn|social security number)\b/i,
  /\b(?:credit card|card number|tarjeta de crédito|cvv)\b/i,
  /\b(?:password|contraseña|passcode|clave)\b/i,
];

const CORS_HEADERS = (origin, allowed) => {
  if (!origin) return {};
  if (allowed && origin === allowed) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "Content-Type, X-CSRF, X-Nonce",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    };
  }
  return {};
};

const rateMap = new Map(); // { ip: {count, ts} } — best-effort in-memory

function ipOf(req) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || req.headers.get("x-real-ip")
      || "0.0.0.0";
}

function rateLimit(ip) {
  const now = Date.now();
  const rec = rateMap.get(ip) || { count: 0, ts: now };
  if (now - rec.ts > WINDOW_MS) { rec.count = 0; rec.ts = now; }
  rec.count++;
  rateMap.set(ip, rec);
  return rec.count <= RL_PER_IP_PER_MIN;
}

function bad(status, msg, extraHeaders={}) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

async function readJSON(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len && len > MAX_BODY_BYTES) throw new Error("payload_too_large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("payload_too_large");
  try { return JSON.parse(text || "{}"); } catch { throw new Error("bad_json"); }
}

function violatesPolicy(s) {
  const txt = String(s || "");
  for (const re of POLICY_PATTERNS) if (re.test(txt)) return true;
  // very rough CC pattern (heuristic)
  if (/\b(?:\d[ -]?){13,19}\b/.test(txt)) return true;
  return false;
}

function tokenize(s) {
  return (String(s||"").toLowerCase().normalize("NFKC").match(/[a-z0-9áéíóúüñ]+/gi)) || [];
}

async function loadPack(url) {
  const r = await fetch(url, { headers: { "Accept": "application/json" }});
  if (!r.ok) throw new Error("pack_fetch_failed");
  return await r.json();
}

function topChunks(pack, query, lang) {
  const terms = tokenize(query);
  const hits = [];
  for (const d of (pack.docs || [])) {
    if (lang && d.lang && d.lang !== lang) continue;
    for (const c of (d.chunks || [])) {
      const t = tokenize(c.text);
      let score = 0; for (const w of terms) if (t.includes(w)) score++;
      if (score > 0) hits.push({ id: c.id, text: c.text, score });
    }
  }
  return hits.sort((a,b)=>b.score-a.score).slice(0,6);
}

function composeExtractive(strong, lang) {
  if (!strong.length) return null;
  const joiner = lang === "es" ? " " : " ";
  const parts = strong.slice(0,3).map(t => `${t.text.trim()} [#${t.id}]`);
  return parts.join(joiner).trim();
}

function sseFromString(s, extraHeaders={}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // stream text in small chunks to feel live
      const chunkSize = 64;
      for (let i = 0; i < s.length; i += chunkSize) {
        const piece = s.slice(i, i + chunkSize);
        controller.enqueue(encoder.encode(`data: ${piece}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: [END]\n\n`));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Provider": "l5-server",
      "X-Provider-Notice": "providers-disabled",
      ...extraHeaders
    }
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin") || "";
    const allowOrigin = env?.FRONTEND_ORIGIN || ""; // set to your UI origin if you need cross-origin

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS(origin, allowOrigin) });
    }

    // simple health check
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname !== "/api/chat") {
      return new Response("Not found", { status: 404 });
    }

    // --- L2: Guard ---
    const cors = CORS_HEADERS(origin, allowOrigin);
    if (allowOrigin && origin && origin !== allowOrigin) {
      return bad(403, "origin_not_allowed", cors);
    }

    if (req.method !== "POST") {
      return bad(405, "method_not_allowed", { ...cors, "Allow": "POST, OPTIONS" });
    }

    const ip = ipOf(req);
    if (!rateLimit(ip)) return bad(429, "rate_limited", cors);

    const ctype = req.headers.get("content-type") || "";
    if (!ctype.includes("application/json")) return bad(415, "unsupported_media_type", cors);

    let body;
    try { body = await readJSON(req); } catch (e) {
      const code = e.message === "payload_too_large" ? 413 : 400;
      return bad(code, e.message, cors);
    }

    const hp = String(body.hp || "");
    if (hp.trim() !== "") return bad(400, "bot_detected", cors);

    const csrfHeader = req.headers.get("x-csrf") || "";
    const csrfBody = String(body.csrf || "");
    if (!csrfHeader || !csrfBody || csrfHeader !== csrfBody) {
      return bad(403, "csrf_failed", cors);
    }

    // --- L3: Policy Gate ---
    const userMsg = String((body.messages?.slice(-1)[0]?.content) || "");
    const lang = (body.lang === "es" ? "es" : "en");
    if (violatesPolicy(userMsg)) {
      const refuse = lang === "es"
        ? "No puedo ayudar con esa
