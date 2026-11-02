/* =============================================================================
   Al-Marsad — ingestion pipeline (runtime-agnostic)
   -----------------------------------------------------------------------------
       news URL ──▶ fetch (server side) ──▶ extract ──▶ translate ──▶ JSON
                                                                       │
                                              rendered natively by the app ◀┘

   No iframes, therefore no X-Frame-Options / CSP frame-ancestors problem, and
   one extraction path for BBC, CNN, DW, Le Monde, Al Jazeera, Nikkei…
   ============================================================================= */

import {
  EXTRACTOR_VERSION, extractArticle, extractLinks, discoverFeed, looksLikeFeed,
  parseFeed, parseTargetUrl, hostOf
} from "./extract.js";
import { HttpError, fetchTextWithRetry } from "./http.js";
import { TranslateError, providerInfo, pickProvider, translateTexts } from "./translate.js";
import { feedHintFor } from "./feeds.js";

export const SERVICE_NAME = "al-marsad-ingest";
export const SERVICE_VERSION = "1.1.0";

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_BYTES = 1_800_000;

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/* A tiny LRU/TTL cache so `?fresh=0` is meaningful even without a database. */
export function createMemoryCache(limit = 200) {
  const map = new Map();
  return {
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expires < Date.now()) { map.delete(key); return null; }
      map.delete(key); map.set(key, hit); // LRU touch
      return hit.value;
    },
    async set(key, value, ttlMs = 600000) {
      if (map.has(key)) map.delete(key);
      map.set(key, { value, expires: Date.now() + ttlMs });
      while (map.size > limit) map.delete(map.keys().next().value);
    }
  };
}

const cacheKey = (prefix, url) => prefix + ":" + String(url).trim().replace(/#.*$/, "");

/* "/", "/news", "/en/" are front pages, not articles: they should open a list
   of headlines rather than a three-paragraph "article". */
function looksLikeFrontPage(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, "");
    const segs = p.split("/").filter(Boolean);
    if (segs.length > 2) return false;
    if (/\d{4}\/\d{2}/.test(p)) return false;
    if (/[a-z0-9-]{14,}/i.test(p)) return false;
    return true;
  } catch (e) { return false; }
}

export function createPipeline({ env = {}, resolveHost, cache = null, log = () => {} } = {}) {
  const allowPrivate = String(env.ALLOW_PRIVATE_HOSTS || "") === "1";
  const maxBlocks = Math.min(300, int(env.MAX_BLOCKS, 120));
  const timeoutMs = Math.min(30000, int(env.FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT));
  const maxBytes = Math.min(4_000_000, int(env.MAX_PAGE_BYTES, DEFAULT_MAX_BYTES));
  const articleTtl = int(env.ARTICLE_CACHE_TTL_MS, 10 * 60 * 1000);
  const feedTtl = int(env.FEED_CACHE_TTL_MS, 8 * 60 * 1000);
  const provider = pickProvider(env);
  const discoveredFeeds = new Map(); // host -> feed url | null (process-level hint cache)

  const fetchOpts = { resolveHost, allowPrivate, timeoutMs, maxBytes: Math.min(maxBytes, 1_800_000) };

  async function readArticle(url, { fresh = false } = {}) {
    const parsed = parseTargetUrl(url, { allowPrivate });
    if (parsed.error) {
      throw new HttpError(parsed.error, parsed.error === "blocked_host"
        ? "هذا العنوان يشير إلى شبكة داخلية."
        : "الرابط غير صالح — استخدم رابط مقال يبدأ بـ https://", 400);
    }
    const target = parsed.url.href;
    const key = cacheKey("article", target);

    if (cache && !fresh) {
      const hit = await cache.get(key).catch(() => null);
      if (hit) return { ...hit, cached: true };
    }

    log("fetch", target);
    const res = await fetchTextWithRetry(target, fetchOpts);

    let payload;
    if (looksLikeFeed(res.text)) {
      const feed = parseFeed(res.text, res.finalUrl);
      payload = { ok: true, kind: "feed", ...feed, source: sourceOf(res), fetchedAt: nowIso() };
      if (cache) await cache.set(key, payload, feedTtl).catch(() => null);
      return payload;
    }

    const article = extractArticle(res.text, res.finalUrl, { maxBlocks });
    article.kind = "article";
    article.source = sourceOf(res);
    article.fetchedAt = nowIso();
    article.hint = article.thin
      ? (article.wordCount < 60
        ? "الصفحة تُبنى بجافاسكربت أو تظهر جزئيًا للزوار الآليين. افتح المصدر الأصلي للاطلاع على المقال كاملًا."
        : "استُخرج نص محدود من هذه الصفحة؛ قد تكون مدفوعة أو مقسّمة على صفحات.")
      : null;

    if (!article.blocks.length && !article.title) {
      throw new HttpError("no_content", "لم نعثر على نص قابل للقراءة في هذه الصفحة.", 422);
    }

    const body = { ok: true, ...article };
    if (cache && !article.paywalled) await cache.set(key, body, articleTtl).catch(() => null);
    return body;
  }

  async function readFeed(url, { fresh = false } = {}) {
    const parsed = parseTargetUrl(url, { allowPrivate });
    if (parsed.error) throw new HttpError(parsed.error, "الرابط غير صالح.", 400);
    const target = parsed.url.href;
    const key = cacheKey("feed", target);

    if (cache && !fresh) {
      const hit = await cache.get(key).catch(() => null);
      if (hit) return { ...hit, cached: true };
    }

    const host = hostOf(target).toLowerCase();
    const attempts = [];

    // 1) known feed for this publisher
    const hint = feedHintFor(target);
    if (hint) attempts.push(hint);

    // 2) a feed previously discovered for this host
    if (discoveredFeeds.has(host)) {
      const known = discoveredFeeds.get(host);
      if (known && known !== hint) attempts.push(known);
    }

    for (const feedUrl of attempts) {
      try {
        const res = await fetchTextWithRetry(feedUrl, { ...fetchOpts, maxBytes: 700_000, attempts: 1 });
        const feed = parseFeed(res.text, feedUrl);
        if (feed.ok && feed.items.length) {
          discoveredFeeds.set(host, feedUrl);
          const out = {
            ok: true, kind: "feed", site: feed.site || hostOf(target), title: feed.title,
            items: rankFeedItems(feed.items, host), via: feed.via, feedUrl,
            source: { fetchedUrl: feedUrl, bytes: res.bytes, redirects: res.redirects.length },
            fetchedAt: nowIso()
          };
          if (cache) await cache.set(key, out, feedTtl).catch(() => null);
          return out;
        }
      } catch (e) {
        log("feed-hint-failed", feedUrl, e.code || e.message);
      }
    }

    // 3) fetch the page, discover its feed, else scrape article links
    const res = await fetchTextWithRetry(target, fetchOpts);
    const feedUrl = discoverFeed(res.text, res.finalUrl);
    if (feedUrl) {
      try {
        const fr = await fetchTextWithRetry(feedUrl, { ...fetchOpts, maxBytes: 700_000, attempts: 1 });
        const feed = parseFeed(fr.text, feedUrl);
        if (feed.ok && feed.items.length) {
          discoveredFeeds.set(host, feedUrl);
          const out = {
            ok: true, kind: "feed", site: feed.site || hostOf(target), title: feed.title,
            items: rankFeedItems(feed.items, host), via: feed.via, feedUrl,
            source: { fetchedUrl: feedUrl, bytes: fr.bytes, redirects: fr.redirects.length },
            fetchedAt: nowIso()
          };
          if (cache) await cache.set(key, out, feedTtl).catch(() => null);
          return out;
        }
      } catch (e) {
        log("feed-discovery-failed", feedUrl, e.code || e.message);
      }
    }
    discoveredFeeds.set(host, null);

    const links = extractLinks(res.text, res.finalUrl, 40);
    if (!links.ok) {
      throw new HttpError("no_articles", "لم نجد خلاصة ولا روابط مقالات على هذه الصفحة.", 422);
    }
    const out = {
      ok: true, kind: "feed", site: hostOf(target), title: hostOf(target),
      items: links.items, via: "links", feedUrl: null,
      source: sourceOf(res), fetchedAt: nowIso()
    };
    if (cache) await cache.set(key, out, feedTtl).catch(() => null);
    return out;
  }

  /** Translate a whole article (title + blocks) in one call. */
  async function translateArticle(article, targetLang) {
    if (!targetLang) return { translation: null };
    if (provider === "none") return { translation: null, translationError: { code: "disabled", message: "الترجمة عبر الخادم معطّلة." } };
    if (!article || !Array.isArray(article.blocks) || !article.blocks.length) return { translation: null };
    if (article.lang && article.lang === targetLang) return { translation: null, sameLanguage: true };

    const blocks = article.blocks.slice(0, maxBlocks);
    const sourceTexts = [article.title || ""].concat(blocks.map((b) => (b.t === "img" ? "" : b.x)));
    const totalChars = sourceTexts.reduce((a, s) => a + s.length, 0);
    if (totalChars > 45000) {
      return { translation: null, translationError: { code: "too_long", message: "المقال أطول من حد الترجمة في طلب واحد." } };
    }
    try {
      const { texts, provider: used } = await translateTexts(sourceTexts, {
        sl: article.lang || "auto", tl: targetLang, env
      });
      return {
        translation: {
          lang: targetLang,
          title: texts[0] || article.title,
          texts: texts.slice(1),
          provider: used,
          at: nowIso()
        }
      };
    } catch (e) {
      log("translate-failed", e.code || e.message);
      return {
        translation: null,
        translationError: {
          code: e.code || "translate_failed",
          message: e.message || "تعذّرت الترجمة عبر الخادم.",
          provider: e.provider || provider
        }
      };
    }
  }

  async function article({ url, translateTo = "", fresh = false }) {
    const data = await readArticle(url, { fresh });
    if (data.kind === "feed") return data; // user pasted a feed URL

    // A front page (or a JavaScript-only shell) is far more useful as a list of
    // its latest headlines than as a three-line "article".
    if ((data.thin || data.blocks.length < 3) && (looksLikeFrontPage(url) || data.blocks.length < 3)) {
      try {
        const listing = await readFeed(url, { fresh });
        if (listing && Array.isArray(listing.items) && listing.items.length >= 2) {
          return { ...listing, requestedUrl: url };
        }
      } catch (e) { log("frontpage-feed-failed", e.code || e.message); }
    }
    const extra = translateTo ? await translateArticle(data, translateTo) : { translation: null };
    return { ...data, ...extra, translationLang: translateTo || null };
  }

  async function feed({ url, fresh = false }) {
    return readFeed(url, { fresh });
  }

  async function translate({ texts, sl = "auto", tl = "ar" }) {
    if (!Array.isArray(texts) || !texts.length) {
      throw new HttpError("no_texts", "لا يوجد نص للترجمة.", 400);
    }
    if (texts.length > 300) throw new HttpError("too_many", "عدد الفقرات أكبر من الحد (300).", 413);
    const total = texts.reduce((a, t) => a + String(t || "").length, 0);
    if (total > 60000) throw new HttpError("too_long", "النص أطول من الحد المسموح (60 ألف حرف).", 413);
    if (provider === "none") throw new TranslateError("disabled", "الترجمة عبر الخادم معطّلة.", "none");
    const cleaned = texts.map((t) => String(t == null ? "" : t));
    const { texts: out, provider: used } = await translateTexts(cleaned, { sl, tl, env });
    return { ok: true, out: out.map((ar) => ({ ar })), provider: used, lang: tl };
  }

  function health() {
    const info = providerInfo(env);
    return {
      ok: true,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      extractor: EXTRACTOR_VERSION,
      translation: { enabled: provider !== "none", ...info },
      features: { article: true, feed: true, translate: provider !== "none", persistentCache: false },
      limits: { maxBlocks, timeoutMs, maxPageBytes: maxBytes },
      runtime: typeof Deno !== "undefined" ? "edge" : "node",
      time: nowIso()
    };
  }

  return { health, article, feed, translate, provider, config: { maxBlocks, timeoutMs, maxBytes } };
}

function sourceOf(res) {
  return {
    status: res.status,
    fetchedUrl: res.finalUrl,
    bytes: res.bytes,
    truncated: res.truncated,
    redirects: res.redirects.length,
    contentType: res.contentType
  };
}

function nowIso() { return new Date().toISOString(); }

/** Put a publisher's own top stories first, then everything else. */
function rankFeedItems(items, host) {
  const key = host.replace(/^www\./, "").split(".")[0];
  return items.slice().sort((a, b) => {
    const score = (it) => {
      let s = 0;
      try { if (hostOf(it.url).includes(key)) s += 3; } catch (e) { /* ignore */ }
      if (it.image) s += 1;
      if (it.summary) s += 1;
      return s;
    };
    return score(b) - score(a);
  });
}
