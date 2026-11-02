/* =============================================================================
   Al-Marsad — Supabase Edge Function (ingest)
   -----------------------------------------------------------------------------
   The production half of the architecture:

     GET/POST  ?op=health
     GET       ?op=article&url=<news url>&translate=ar&fresh=1
     GET       ?op=feed&url=<homepage|feed url>&fresh=1
     POST      ?op=translate   { "texts": [...], "sl": "en", "tl": "ar" }

   Deploy:
     supabase functions deploy ingest --no-verify-jwt
     supabase secrets set ALLOWED_ORIGINS="https://<you>.github.io,http://localhost:3000"

   Everything network-facing (SSRF guard, extractor, translator) lives in
   ../_shared and is unit-tested from Node, so this file stays a thin adapter.
   ============================================================================= */
// @ts-nocheck — the shared modules are plain ES modules with JSDoc types.

import { createPipeline } from "../_shared/pipeline.js";
import { createLayeredCache, createPostgrestCache } from "../_shared/cache.js";
import { HttpError } from "../_shared/http.js";

const env = Deno.env.toObject();

/* --------------------------------------------------------------------- CORS */

const rawOrigins = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);

function corsFor(req) {
  const origin = req.headers.get("origin") || "";
  const allowAll = rawOrigins.includes("*");
  let allow = "";
  if (allowAll) {
    allow = origin || "*";
  } else if (origin && rawOrigins.some((o) => {
    if (o === origin) return true;
    // "https://*.github.io" style wildcards
    if (o.includes("*")) {
      const re = new RegExp("^" + o.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return re.test(origin);
    }
    return false;
  })) {
    allow = origin;
  }
  const headers = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,accept",
    "access-control-max-age": "86400",
    "vary": "origin"
  };
  if (allow) headers["access-control-allow-origin"] = allow;
  return headers;
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
  });

/* -------------------------------------------------------------- rate limit */

const buckets = new Map();
function rateLimited(req, { limit = 120, windowMs = 60000 } = {}) {
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "anon")
    .split(",")[0].trim();
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.reset < now) {
    buckets.set(ip, { count: 1, reset: now + windowMs });
    if (buckets.size > 5000) buckets.clear();
    return false;
  }
  b.count++;
  return b.count > limit;
}

/* --------------------------------------------------------------- the service */

const dbCache = createPostgrestCache({
  url: env.SUPABASE_URL,
  serviceKey: env.SUPABASE_SERVICE_ROLE_KEY
});

const pipeline = createPipeline({
  env,
  resolveHost: async (host) => {
    const addrs = [];
    for (const type of ["A", "AAAA"]) {
      try {
        const rows = await Deno.resolveDns(host, type);
        if (Array.isArray(rows)) addrs.push(...rows);
      } catch (e) { /* a host may only have one family */ }
    }
    return addrs;
  },
  cache: createLayeredCache([dbCache]),
  log: (...args) => console.log("[ingest]", ...args)
});

/* ------------------------------------------------------------------ routing */

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const started = Date.now();

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return json({ ok: false, code: "bad_request", error: "طلب غير صالح." }, 400, cors);
  }

  // Accept ?op=article as well as /ingest/article
  const pathOp = (url.pathname.split("/").filter(Boolean).pop() || "").toLowerCase();
  const known = ["health", "article", "feed", "translate"];
  const op = (url.searchParams.get("op") || (known.includes(pathOp) ? pathOp : "health")).toLowerCase();

  try {
    if (op === "health") {
      const body = pipeline.health();
      return json({ ...body, features: { ...body.features, persistentCache: !!dbCache } }, 200, cors);
    }

    if (req.method !== "GET" && req.method !== "POST") {
      return json({ ok: false, code: "method_not_allowed", error: "استخدم GET أو POST." }, 405, cors);
    }

    if (op === "article" || op === "feed") {
      if (rateLimited(req)) {
        return json({ ok: false, code: "rate_limited", error: "طلبات كثيرة جدًا — انتظر قليلًا." }, 429, cors);
      }
      const target = url.searchParams.get("url");
      if (!target) return json({ ok: false, code: "missing_url", error: "مرّر المعامل url." }, 400, cors);
      const fresh = ["1", "true", "yes"].includes((url.searchParams.get("fresh") || "").toLowerCase());

      const data = op === "article"
        ? await pipeline.article({ url: target, translateTo: (url.searchParams.get("translate") || "").slice(0, 5), fresh })
        : await pipeline.feed({ url: target, fresh });

      return json(data, 200, { ...cors, "cache-control": "public, max-age=60" });
    }

    if (op === "translate") {
      if (req.method !== "POST") return json({ ok: false, code: "method_not_allowed", error: "استخدم POST." }, 405, cors);
      if (rateLimited(req, { limit: 60 })) {
        return json({ ok: false, code: "rate_limited", error: "طلبات ترجمة كثيرة — انتظر قليلًا." }, 429, cors);
      }
      const text = await req.text();
      if (text.length > 400_000) {
        return json({ ok: false, code: "body_too_large", error: "الطلب كبير جدًا." }, 413, cors);
      }
      let body;
      try { body = JSON.parse(text || "{}"); } catch (e) {
        return json({ ok: false, code: "bad_json", error: "صيغة JSON غير صالحة." }, 400, cors);
      }
      const data = await pipeline.translate({
        texts: body.texts,
        sl: String(body.sl || "auto").slice(0, 5),
        tl: String(body.tl || "ar").slice(0, 5)
      });
      return json(data, 200, cors);
    }

    return json({ ok: false, code: "unknown_op", error: "عملية غير معروفة: " + op }, 404, cors);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : (err && Number.isInteger(err.status) ? err.status : 502);
    const code = (err && err.code) || "error";
    const message = (err && err.message) || "خطأ غير متوقع في الخادم.";
    if (status >= 500) console.error("[ingest] error", code, message);
    return json({ ok: false, code, error: message, provider: err && err.provider }, status, cors);
  } finally {
    console.log(`[ingest] ${op} ${req.method} ${Date.now() - started}ms`);
  }
});
