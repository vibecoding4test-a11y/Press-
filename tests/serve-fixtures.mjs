#!/usr/bin/env node
/* =============================================================================
   Al-Marsad — offline fixture publisher
   -----------------------------------------------------------------------------
   A tiny fake news site used by the tests and for demoing the whole pipeline
   without touching the real internet (useful on planes, in CI, and in sandboxes
   with no egress).

     node tests/serve-fixtures.mjs            # http://127.0.0.1:8899
     ALLOW_PRIVATE_HOSTS=1 npm start          # then paste http://127.0.0.1:8899/
   ============================================================================= */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PORT = Number(process.env.FIXTURE_PORT || 8899);

/* The fixture feed links to realistic article URLs; map them onto our files. */
const ARTICLES = {
  "/2026/11/02/coastal-storm-warning-issued": "bbc-article.html",
  "/2026/11/02/markets-slip-as-rate-fears-return": "cnn-article.html",
  "/2026/11/01/leaders-meet-for-climate-talks": "paywall.html"
};

const TYPES = { ".html": "text/html; charset=utf-8", ".xml": "application/rss+xml; charset=utf-8" };

http.createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = ARTICLES[pathname] || (pathname === "/" ? "homepage.html" : pathname.replace(/^\/+/, ""));
  const file = path.resolve(DIR, rel);

  if (!file.startsWith(DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 — fixture not found: " + rel);
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] || "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, process.env.FIXTURE_HOST || "127.0.0.1", () => {
  console.log(`\n  fake publisher — http://127.0.0.1:${PORT}/`);
  console.log(`  feed          — http://127.0.0.1:${PORT}/feed.xml`);
  console.log(`  run the app with ALLOW_PRIVATE_HOSTS=1 so it may fetch this host.\n`);
});
