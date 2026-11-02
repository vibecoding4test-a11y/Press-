#!/usr/bin/env node
/* =============================================================================
   Al-Marsad — local server
   -----------------------------------------------------------------------------
   Serves the static app and the ingestion API on one origin, which is the
   "server" half of the architecture:

       GET  /api/health
       GET  /api/article?url=<news url>&translate=ar&fresh=0
       GET  /api/feed?url=<homepage or feed url>&fresh=0
       POST /api/translate   { "texts": ["..."], "sl": "en", "tl": "ar" }

   The Supabase Edge Function (supabase/functions/ingest) exposes the identical
   contract at ?op=health|article|feed|translate, so the frontend does not care
   which one it is talking to.

   Zero dependencies. Node >= 18.
   ============================================================================= */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";

import { createPipeline, createMemoryCache, SERVICE_NAME, SERVICE_VERSION } from "../supabase/functions/_shared/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/* ------------------------------------------------------------------ .env ---- */
function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      if (process.env[m[1]] !== undefined) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch (e) { /* no .env is fine */ }
}
loadEnvFile(path.join(ROOT, ".env"));

const env = process.env;
const PORT = Number(env.PORT || 3000);
const HOST = env.HOST || "0.0.0.0";

const resolveHost = async (host) => {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

const pipeline = createPipeline({
  env,
  resolveHost,
  cache: createMemoryCache(300),
  log: (...args) => { if (env.LOG_LEVEL === "debug") console.log("[marsad]", ...args); }
});

/* ---------------------------------------------------------------- helpers --- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,accept",
  "access-control-max-age": "86400"
};

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...CORS
  };
  if (!res.hasHeader("cache-control")) headers["cache-control"] = "no-store";
  res.writeHead(status, headers);
  res.end(payload);
}

function sendError(res, err) {
  const status = err && Number.isInteger(err.status) ? err.status : 502;
  const code = (err && err.code) || "error";
  const message = (err && err.message) || "حدث خطأ غير متوقع.";
  if (status >= 500) console.error("[marsad] error:", code, message);
  sendJSON(res, status, { ok: false, code, error: message, provider: err && err.provider });
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const e = new Error("الطلب أكبر من الحد المسموح.");
      e.status = 413; e.code = "body_too_large";
      throw e;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch (e) {
    const err = new Error("صيغة JSON غير صالحة.");
    err.status = 400; err.code = "bad_json";
    throw err;
  }
}

const bool = (v) => v === "1" || v === "true" || v === "yes";

/* -------------------------------------------------------------------- API --- */

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  // /api/<op> or /api?op=<op>
  const parts = url.pathname.split("/").filter(Boolean);
  let op = url.searchParams.get("op") || "";
  if (!op && parts[0] === "api" && parts[1]) op = parts[1];
  op = (op || "health").toLowerCase();

  if (req.method === "GET" && (op === "health" || op === "")) {
    return sendJSON(res, 200, { ...pipeline.health(), service: SERVICE_NAME, version: SERVICE_VERSION });
  }

  if (req.method === "GET" && op === "article") {
    const target = url.searchParams.get("url");
    if (!target) {
      const e = new Error("مرّر رابط المقال في المعامل url."); e.status = 400; e.code = "missing_url"; throw e;
    }
    const data = await pipeline.article({
      url: target,
      translateTo: (url.searchParams.get("translate") || "").slice(0, 5),
      fresh: bool(url.searchParams.get("fresh"))
    });
    res.setHeader("cache-control", "public, max-age=60");
    return sendJSON(res, 200, data);
  }

  if (req.method === "GET" && op === "feed") {
    const target = url.searchParams.get("url");
    if (!target) {
      const e = new Error("مرّر رابط الصفحة في المعامل url."); e.status = 400; e.code = "missing_url"; throw e;
    }
    const data = await pipeline.feed({ url: target, fresh: bool(url.searchParams.get("fresh")) });
    res.setHeader("cache-control", "public, max-age=60");
    return sendJSON(res, 200, data);
  }

  if (req.method === "POST" && op === "translate") {
    const body = await readBody(req);
    const data = await pipeline.translate({
      texts: body.texts,
      sl: (body.sl || "auto").slice(0, 5),
      tl: (body.tl || "ar").slice(0, 5)
    });
    return sendJSON(res, 200, data);
  }

  const e = new Error("مسار غير معروف: " + url.pathname);
  e.status = 404; e.code = "not_found";
  throw e;
}

/* ----------------------------------------------------------------- static --- */

const BLOCKED = new Set([".git", ".env", "node_modules", ".supabase"]);

async function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { pathname = "/"; }
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  const rel = pathname.replace(/^\/+/, "");
  const file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  const segments = rel.split("/");
  if (segments.some((s) => BLOCKED.has(s) || s.startsWith(".env"))) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let stat;
  try { stat = await fsp.stat(file); } catch (e) { stat = null; }
  if (!stat || stat.isDirectory()) {
    // SPA-ish fallback for /<paper> style paths is not needed; 404 cleanly.
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 — الملف غير موجود: " + rel);
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(36)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag }); res.end(); return;
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": stat.size,
    etag,
    // The app is a single page with hashed-free asset names; keep browsers honest.
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
    "x-content-type-options": "nosniff"
  });
  if (req.method === "HEAD") { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ boot --- */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch (e) {
    res.writeHead(400).end("Bad request");
    return;
  }

  try {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res, url);
    } else {
      res.writeHead(405, { allow: "GET,HEAD,OPTIONS" }).end("Method not allowed");
    }
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
    else res.end();
  } finally {
    if (env.LOG_LEVEL === "debug") {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, HOST, () => {
  const info = pipeline.health();
  console.log(`\n  المرصد · Al-Marsad — http://localhost:${PORT}`);
  console.log(`  API      : /api/health · /api/article · /api/feed · /api/translate`);
  console.log(`  extractor: ${info.extractor}`);
  console.log(`  ترجمة    : ${info.translation.enabled ? info.translation.detail : "معطّلة (الترجمة في المتصفح)"}`);
  if (String(env.ALLOW_PRIVATE_HOSTS || "") === "1") {
    console.log("  ⚠ ALLOW_PRIVATE_HOSTS=1 — جلب الشبكات الداخلية مسموح (للتطوير فقط)");
  }
  console.log("");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
