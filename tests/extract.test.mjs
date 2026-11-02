import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

import {
  extractArticle, parseFeed, parseHTML, discoverFeed, extractLinks,
  detectLang, isBlockedHostname, parseTargetUrl, textOf, cleanText, walkElements
} from "../supabase/functions/_shared/extract.js";
import { isPrivateAddress, fetchText, HttpError } from "../supabase/functions/_shared/http.js";
import { createPipeline, createMemoryCache } from "../supabase/functions/_shared/pipeline.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(DIR, "fixtures", name), "utf8");
const blocksText = (a) => a.blocks.map((b) => b.x).join("\n");

/* ------------------------------------------------------------- extraction -- */

test("extracts a BBC-style article with metadata and no chrome", () => {
  const a = extractArticle(fixture("bbc-article.html"), "https://www.bbc.com/news/articles/storm-coast");
  assert.equal(a.title, "Coastal towns brace for storm");
  assert.equal(a.site, "BBC News");
  assert.equal(a.lang, "en");
  assert.equal(a.dir, "ltr");
  assert.match(a.byline, /Jane Doe/);
  assert.equal(a.publishedAt, "2026-10-31T21:14:00.000Z");
  assert.equal(a.image, "https://ichef.bbci.co.uk/news/1024/branded_news/storm.jpg");
  assert.equal(a.canonical, "https://www.bbc.com/news/articles/storm-coast");
  assert.equal(a.paywalled, false);
  assert.equal(a.thin, false);

  const body = blocksText(a);
  assert.match(body, /Thousands of homes are without power/);
  assert.match(body, /Emergency shelters opened/);
  assert.doesNotMatch(body, /Share on Facebook/);
  assert.doesNotMatch(body, /More on this story/);
  assert.doesNotMatch(body, /Advertisement/);
  assert.doesNotMatch(body, /Homepage/);

  // Heading blocks stay headings
  const headings = a.blocks.filter((b) => b.t === "h").map((b) => b.x);
  assert.ok(headings.includes("Emergency shelters opened"));
  assert.equal(a.blocks[0].t, "h");
});

test("extracts a CNN-style article", () => {
  const a = extractArticle(fixture("cnn-article.html"), "https://edition.cnn.com/2026/11/01/investing/markets-slip/index.html");
  assert.equal(a.title, "Markets slip as rate fears return");
  assert.equal(a.site, "CNN");
  assert.match(a.excerpt, /Global stocks fell/);
  const body = blocksText(a);
  assert.match(body, /Stoxx 600/);
  assert.match(body, /gold edged higher/);
  assert.doesNotMatch(body, /Read the full story on CNN/);
  assert.doesNotMatch(body, /CNN Sans/);
  assert.ok(a.blocks.length >= 4);
});

test("detects a paywalled article", () => {
  const a = extractArticle(fixture("paywall.html"), "https://financialpost.example/2026/10/20/negotiations");
  assert.equal(a.paywalled, true);
  assert.equal(a.title, "Inside the negotiations");
});

test("keeps Arabic articles in Arabic and right-to-left", () => {
  const a = extractArticle(fixture("arabic-article.html"), "https://www.aljazeera.net/news/2026/11/1/x");
  assert.equal(a.lang, "ar");
  assert.equal(a.dir, "rtl");
  assert.equal(a.title, "الجمعية العامة تعقد جلسة طارئة");
  assert.match(blocksText(a), /ممرات آمنة/);
  assert.doesNotMatch(blocksText(a), /الرئيسية/);
});

test("flags a JavaScript-only shell as thin instead of pretending it worked", () => {
  const a = extractArticle(fixture("spa-shell.html"), "https://spa.example/article");
  assert.equal(a.thin, true);
  assert.ok(a.blocks.length < 3);
});

test("uses JSON-LD articleBody when the DOM has no paragraphs", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"NewsArticle","headline":"LD only","articleBody":"First paragraph of the embedded body, long enough to count as real content.\\n\\nSecond paragraph of the embedded body, also long enough to be kept by the extractor."}
  </script></head><bod><div id="app"></div></body></html>`;
  const a = extractArticle(html, "https://example.com/ld");
  assert.equal(a.title, "LD only");
  assert.equal(a.blocks.filter((b) => b.t === "p").length, 2);
});

test("prefers the article body over a long footer", () => {
  const filler = "word ".repeat(400);
  const html = `<html lang="en"><head><title>Real | Site</title></head><body>
    <div class="article-body"><p>${"The actual article text is here. ".repeat(12)}</p></div>
    <footer><p>${filler}</p></footer></body></html>`;
  const a = extractArticle(html, "https://example.com/x");
  assert.match(blocksText(a), /actual article text/);
  assert.doesNotMatch(blocksText(a), /^word word/);
});

/* ----------------------------------------------------------------- parser -- */

test("parser survives malformed markup", () => {
  const root = parseHTML(`<div><p>one<p>two</div></span><script>if (a < b) { x("<p>no</p>") }</script><!-- c --><ul><li>three`);
  const text = textOf(root);
  assert.match(text, /one/);
  assert.match(text, /two/);
  assert.match(text, /three/);
  // script text is kept only as raw data for JSON-LD, never as article content
  const art = extractArticle(`<html lang="en"><body><article><div class="article-body">
    <p>This is a real paragraph with more than twenty five characters in it.</p>
    <script>var x = "<p>not an article paragraph at all</p>";</script>
    <p>Another real paragraph that is also longer than twenty five characters.</p>
  </div></article></body></html>`, "https://example.com/x");
  assert.doesNotMatch(blocksText(art), /not an article paragraph/);
  const tags = [...walkElements(root)].map((n) => n.tag);
  assert.ok(tags.includes("p"));
  assert.ok(tags.includes("li"));
});

test("decodes entities and normalises whitespace", () => {
  assert.equal(cleanText("a&nbsp;&amp;&nbsp;b"), "a & b");
  assert.equal(cleanText("  multiple\n\tspaces  "), "multiple spaces");
  assert.equal(cleanText("&#1575;&#1604;&#1605;&#1585;&#1589;&#1583;"), "المرصد");
});

test("language detection falls back sensibly", () => {
  assert.equal(detectLang("مرحبا بالعالم هذا نص عربي طويل نسبيا للاختبار"), "ar");
  assert.equal(detectLang("Это длинный русский текст для проверки языка"), "ru");
  assert.equal(detectLang("Ceci est un texte français assez long pour être détecté avec des mots courants"), "fr");
  assert.equal(detectLang("Hello world this is English text", "en"), "en");
});

/* ------------------------------------------------------------------ feeds -- */

test("parses RSS 2.0 with media and summaries", () => {
  const f = parseFeed(fixture("feed.xml"), "https://example.com/");
  assert.equal(f.ok, true);
  assert.equal(f.title, "Daily Example");
  assert.equal(f.items.length, 3);
  assert.equal(f.items[0].title, "Coastal towns brace for storm");
  assert.equal(f.items[0].url, "https://example.com/2026/11/02/coastal-storm-warning-issued");
  assert.equal(f.items[0].image, "https://example.com/img/storm.jpg");
  assert.equal(f.items[0].summary, "Thousands of homes are without power as a storm sweeps the coast.");
  assert.equal(f.items[0].publishedAt, "2026-11-02T09:00:00.000Z");
  // newest first
  assert.ok(f.items[0].publishedAt > f.items[2].publishedAt);
});

test("parses Atom", () => {
  const f = parseFeed(fixture("atom.xml"), "https://example.org/");
  assert.equal(f.via, "atom");
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].url, "https://example.org/posts/atom-story-one");
});

test("discovers a feed from a homepage and extracts article links as fallback", () => {
  const html = fixture("homepage.html");
  assert.equal(discoverFeed(html, "https://example.com/"), "https://example.com/feed.xml");
  const links = extractLinks(html, "https://example.com/");
  assert.equal(links.ok, true);
  const urls = links.items.map((i) => i.url);
  assert.ok(urls.includes("https://example.com/2026/11/02/coastal-storm-warning-issued"));
  assert.ok(!urls.some((u) => /login|about-us/.test(u)));
});

/* ----------------------------------------------------------------- guards -- */

test("blocks SSRF targets", () => {
  for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.10", "169.254.169.254",
    "172.16.0.5", "100.64.1.1", "[::1]", "something.internal"]) {
    assert.equal(isBlockedHostname(host.replace(/^\[|\]$/g, "")), true, host);
  }
  assert.equal(isBlockedHostname("www.bbc.com"), false);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(isPrivateAddress("fd00::1"), true);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
});

test("rejects non-http, credentialed and internal URLs", () => {
  assert.equal(parseTargetUrl("ftp://example.com/x").error, "unsupported_protocol");
  assert.equal(parseTargetUrl("javascript:alert(1)").error, "unsupported_protocol");
  assert.equal(parseTargetUrl("https://user:pass@example.com/").error, "credentials_in_url");
  assert.equal(parseTargetUrl("http://169.254.169.254/latest/meta-data/").error, "blocked_host");
  assert.ok(parseTargetUrl("https://example.com/a?b=1").url);
});

/* ---------------------------------------------------------------- fetching -- */

function fixtureServer() {
  const server = http.createServer((req, res) => {
    const name = (req.url || "/").split("?")[0];
    if (name === "/redirect") { res.writeHead(302, { location: "/bbc-article.html" }); return res.end(); }
    if (name === "/huge") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><body>" + "x".repeat(5000) + "</body></html>");
    }
    if (name === "/slow") {
      setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>late</p>"); }, 3000);
      return;
    }
    const file = path.join(DIR, "fixtures", name.replace(/^\//, "") || "homepage.html");
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end("nope"); }
    res.writeHead(200, { "content-type": name.endsWith(".xml") ? "application/rss+xml" : "text/html; charset=utf-8" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("fetchText enforces SSRF, redirects, size and timeout limits", async (t) => {
  const server = await fixtureServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => server.close());

  await assert.rejects(
    () => fetchText(base + "/bbc-article.html"),
    (e) => e instanceof HttpError && e.code === "blocked_host"
  );

  const ok = await fetchText(base + "/bbc-article.html", { allowPrivate: true });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Coastal towns/);

  const redirected = await fetchText(base + "/redirect", { allowPrivate: true });
  assert.equal(redirected.finalUrl, base + "/bbc-article.html");
  assert.equal(redirected.redirects.length, 1);

  const truncated = await fetchText(base + "/huge", { allowPrivate: true, maxBytes: 1000 });
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.text.length <= 1000);

  await assert.rejects(
    () => fetchText(base + "/slow", { allowPrivate: true, timeoutMs: 300 }),
    (e) => e.code === "timeout"
  );

  await assert.rejects(
    () => fetchText(base + "/missing.html", { allowPrivate: true }),
    (e) => e.code === "not_found"
  );
});

/* ---------------------------------------------------------------- pipeline -- */

test("pipeline: article → cache → feed discovery, no network beyond the fixture", async (t) => {
  const server = await fixtureServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => server.close());

  const pipeline = createPipeline({
    env: { ALLOW_PRIVATE_HOSTS: "1", TRANSLATE_PROVIDER: "none" },
    resolveHost: async () => ["127.0.0.1"],
    cache: createMemoryCache(20)
  });

  const health = pipeline.health();
  assert.equal(health.ok, true);
  assert.equal(health.translation.enabled, false);

  const art = await pipeline.article({ url: base + "/bbc-article.html" });
  assert.equal(art.kind, "article");
  assert.equal(art.title, "Coastal towns brace for storm");
  assert.equal(art.cached, undefined);
  assert.ok(art.blocks.length > 3);
  assert.equal(art.source.status, 200);

  const again = await pipeline.article({ url: base + "/bbc-article.html" });
  assert.equal(again.cached, true);

  const fresh = await pipeline.article({ url: base + "/bbc-article.html", fresh: true });
  assert.equal(fresh.cached, undefined);

  // translation disabled server-side must not break the response
  const translated = await pipeline.article({ url: base + "/cnn-article.html", translateTo: "ar" });
  assert.equal(translated.translation, null);
  assert.equal(translated.translationError.code, "disabled");

  // homepage → feed link → parsed feed
  const feed = await pipeline.feed({ url: base + "/homepage.html" });
  assert.equal(feed.kind, "feed");
  assert.equal(feed.via, "rss");
  assert.equal(feed.items.length, 3);
  assert.equal(feed.items[0].title, "Coastal towns brace for storm");

  // serving the feed directly also works
  const direct = await pipeline.article({ url: base + "/feed.xml" });
  assert.equal(direct.kind, "feed");
  assert.equal(direct.items.length, 3);

  // A strict pipeline (the production default) refuses internal targets.
  const strict = createPipeline({ env: { TRANSLATE_PROVIDER: "none" }, resolveHost: async () => ["127.0.0.1"] });
  await assert.rejects(
    () => strict.article({ url: "http://169.254.169.254/latest/meta-data/" }),
    (e) => e.code === "blocked_host"
  );
  await assert.rejects(
    () => strict.article({ url: "http://127.0.0.1:8080/article" }),
    (e) => e.code === "blocked_host"
  );
  await assert.rejects(
    () => strict.article({ url: "not a url" }),
    (e) => e.code === "invalid_url"
  );
});

test("pipeline translates through an injected provider-compatible path", async () => {
  // Exercise the translation plumbing without network: stub global fetch for
  // the Google public endpoint and assert order/alignment is preserved.
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? init.body.toString() : "" });
    const n = (String(init.body).match(/(^|&)q=/g) || []).length;
    return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ["مترجم " + (i + 1), "en"])), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    const pipeline = createPipeline({
      env: { TRANSLATE_PROVIDER: "free" },
      resolveHost: async () => ["93.184.216.34"]
    });
    const out = await pipeline.translate({ texts: ["one", "two", "three"], sl: "en", tl: "ar" });
    assert.equal(out.ok, true);
    assert.equal(out.provider, "free");
    assert.deepEqual(out.out.map((o) => o.ar), ["مترجم 1", "مترجم 2", "مترجم 3"]);
    assert.match(calls[0].url, /clients5\.google\.com/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("pipeline: server-side translation is attached to an article", async () => {
  const server = await fixtureServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("clients5.google.com")) {
      const n = (String(init.body).match(/(^|&)q=/g) || []).length;
      return new Response(JSON.stringify(Array.from({ length: n }, () => ["نص مترجم", "en"])), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return realFetch(url, init);
  };
  try {
    const pipeline = createPipeline({
      env: { ALLOW_PRIVATE_HOSTS: "1", TRANSLATE_PROVIDER: "free" },
      resolveHost: async () => ["127.0.0.1"],
      cache: createMemoryCache(10)
    });
    const art = await pipeline.article({ url: base + "/cnn-article.html", translateTo: "ar" });
    assert.ok(art.translation, "translation present");
    assert.equal(art.translation.lang, "ar");
    assert.equal(art.translation.title, "نص مترجم");
    assert.equal(art.translation.texts.length, art.blocks.length);
    for (const b of art.blocks) {
      if (b.t === "img") continue;
      assert.ok(art.translation.texts[art.blocks.indexOf(b)]);
    }
  } finally {
    server.close();
    globalThis.fetch = realFetch;
  }
});
