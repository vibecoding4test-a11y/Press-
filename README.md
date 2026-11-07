# المرصد · Al-Marsad

**Read any newspaper in the world — in Arabic — without iframes.**

Al-Marsad is a three-pane Arabic news reader. It lists 289 publishers in 97 countries, shows each
publisher's latest headlines, opens the full article as clean text, and translates it into Arabic
paragraph by paragraph.

> **ملخص عربي:** لم يعد المرصد يعتمد على تضمين صفحات الصحف داخل `iframe` — وهي طريقة تمنعها
> ترويسات `X-Frame-Options` و`CSP frame-ancestors` ولا يمكن لأي HTML أو JavaScript تجاوزها.
> الآن يمر كل رابط خبر عبر **خادم استخراج** (محلي أو دالة Supabase) يجلب الصفحة، ويستخرج المقال،
> ويترجمه، ثم تعرضه الواجهة كنص نظيف داخل المرصد. هذا هو المسار الموثوق للنشر على GitHub وSupabase.

---

## Why the architecture changed

| Problem with the iframe approach | What Al-Marsad does instead |
| --- | --- |
| `X-Frame-Options: DENY / SAMEORIGIN` blocks the frame | The page is **fetched by our server**, where none of these headers apply |
| CSP `frame-ancestors` blocks the frame | No frame is created at all |
| Third-party cookies / consent walls inside frames | We only read the article HTML |
| CORS blocks the browser from reading the publisher | Server-side fetch has no CORS |
| Sandboxed frames break login, video, and menus | We render extracted text, so nothing breaks |
| Slow/blocked frames, mixed content | One JSON response, cached and translated server-side |

No browser-side trick can override `X-Frame-Options` or `frame-ancestors` — they are enforced by the
browser before any of our JavaScript runs. Moving the fetch to a server is the only reliable fix, and
it also gives us one extraction path for BBC, CNN, DW, Le Monde, Al Jazeera, Nikkei, Folha…

## The pipeline

```
   user pastes / picks a URL
             │
             ▼
   ┌──────────────────────────┐        ┌──────────────────────────────────┐
   │  Al-Marsad frontend      │  JSON  │  Ingest API                      │
   │  (static HTML/CSS/JS)    │◀──────▶│  · local:  server/server.mjs     │
   │  no iframes, no CORS     │        │  · prod :  Supabase Edge Function│
   └──────────────────────────┘        └──────────────────────────────────┘
             ▲                                     │
             │ render + translate                  │ 1. safe fetch (SSRF guard, limits)
             │                                     │ 2. extract article (RSS → JSON-LD → DOM)
             └─────────────────────────────────────┤ 3. translate (server-side, batched)
                                                   ▼
                                            publisher website
```

## Quick start (local)

Requires **Node 18.17+** (no npm dependencies).

```bash
npm start            # serves the app + API on http://localhost:3000
```

Open <http://localhost:3000>, pick a publisher, or paste any article URL into the bar at the top.

Optional configuration:

```bash
cp .env.example .env      # PORT, translation provider keys, limits
npm test                  # 19 unit + integration tests (no network needed)
```

> Opening `index.html` directly from disk (`file://`) will not work: the app needs the API. Run
> `npm start`, or point it at a deployed Supabase function (⚙ → *رابط خادم الاستخراج*).

## Repository layout

```
index.html                          app shell (three panes, RTL)
assets/styles.css                   all styles (light/dark, mobile, print)
assets/papers.js                    289 publishers: country, language, licence, Arabic edition
assets/config.js                    API base / Supabase function URL / defaults
assets/app.js                       UI: list, feed, reader, translation, settings
server/server.mjs                   local server: static files + /api (zero deps)
supabase/functions/ingest/index.ts  Supabase Edge Function (same contract)
supabase/functions/_shared/
  extract.js                        HTML parser + readability extractor + RSS/Atom + link discovery
  http.js                           safe fetch: SSRF guard, redirects, size/time limits, retries
  translate.js                      Google / DeepL / LibreTranslate / keyless provider
  pipeline.js                       the pipeline itself (runtime-agnostic)
  cache.js                          memory + Postgres (PostgREST) cache layers
  feeds.js                          known RSS endpoints for ~110 publishers (hints only)
supabase/schema.sql                 optional persistent cache table + RLS
tests/                              node:test suites and HTML fixtures
```

`_shared/` is plain ES modules with no runtime-specific APIs, so the **same tested code** runs in
Node and in the Deno/Supabase Edge runtime. `server/server.mjs` and `functions/ingest/index.ts` are
thin adapters (resolver + cache + HTTP surface).

## API

Both runtimes expose an identical contract. Local: `/api/...` or `/api?op=...`. Edge:
`https://<ref>.supabase.co/functions/v1/ingest?op=...`.

| Method | Operation | Description |
| --- | --- | --- |
| `GET` | `?op=health` | service name, version, extractor version, translation provider, limits |
| `GET` | `?op=article&url=…&translate=ar&fresh=1` | fetch + extract one article (optionally translated) |
| `GET` | `?op=feed&url=…&fresh=1` | list a publisher's latest articles (RSS/Atom, else link discovery) |
| `POST` | `?op=translate` | `{"texts":[…],"sl":"en","tl":"ar"}` → `{"out":[{"ar":"…"}]}` |

`?op=article` answers with either an article or a listing, so a pasted homepage becomes a headline
list instead of a three-line "article":

```jsonc
{
  "ok": true,
  "kind": "article",
  "url": "https://www.bbc.com/news/articles/…",
  "canonical": "https://www.bbc.com/news/articles/…",
  "site": "BBC News",
  "title": "Coastal towns brace for storm",
  "byline": "Jane Doe",
  "publishedAt": "2026-10-31T21:14:00.000Z",
  "lang": "en", "dir": "ltr",
  "image": "https://ichef.bbci.co.uk/…jpg",
  "excerpt": "Thousands of homes are without power…",
  "wordCount": 412,
  "paywalled": false,
  "thin": false,
  "blocks": [
    { "t": "h", "x": "Coastal towns brace for storm" },
    { "t": "p", "x": "Thousands of homes are without power…" },
    { "t": "img", "x": "Damage in the old town", "src": "https://…/a.jpg" }
  ],
  "translation": { "lang": "ar", "title": "…", "texts": ["…"], "provider": "google" },
  "source": { "status": 200, "fetchedUrl": "…", "bytes": 412033, "truncated": false, "redirects": 1 },
  "fetchedAt": "2026-11-02T07:36:56.242Z",
  "cached": true
}
```

```bash
curl -s "http://localhost:3000/api/feed?url=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("https://www.france24.com/en/"))')" | jq '.via, .items[0]'
```

The frontend does **not** call publishers directly. It calls `?op=article` for the text, then
`?op=translate` in batches of 14 paragraphs so the reader can show progress (and so a long article
never hits a request timeout).

## Configuration

### Frontend (`assets/config.js`, or the ⚙ dialog at runtime)

| Key | Meaning |
| --- | --- |
| `apiBase` | Same-origin path (`""` → `/api`). Set it if you mount the API elsewhere |
| `supabaseFunction` | Full function URL, used when the site is hosted statically |
| `autoTranslate` | Translate each article as soon as it opens (default `true`) |
| `maxBlocks` | Safety cap for rendering |

Resolution order: saved ⚙ value → `apiBase` → `supabaseFunction` → same-origin `/api`. If none
answers, the app says so explicitly and falls back to a clearly-labelled browser-only mode
(`r.jina.ai` + the public translate endpoint) instead of silently failing.

Everything shareable is in the URL: `?url=<article>` and `?paper=<publisher>` are deep links the app
restores on load.

### Server (`.env` / Supabase secrets)

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | local server |
| `TRANSLATE_PROVIDER` | `auto` | `google`, `deepl`, `libre`, `free`, `none` |
| `GOOGLE_TRANSLATE_API_KEY` | – | Cloud Translation v2, most reliable |
| `DEEPL_API_KEY` | – | DeepL (`:fx` keys use the free host automatically) |
| `LIBRE_TRANSLATE_URL` / `…_API_KEY` | – | self-hosted LibreTranslate |
| `MAX_BLOCKS` | `120` | paragraphs per article |
| `FETCH_TIMEOUT_MS` | `15000` | per request |
| `MAX_PAGE_BYTES` | `1800000` | hard cap on downloaded HTML |
| `ARTICLE_CACHE_TTL_MS` | `600000` | article cache |
| `FEED_CACHE_TTL_MS` | `480000` | feed cache |
| `ALLOW_PRIVATE_HOSTS` | `0` | **dev only**, for a local fixture server |
| `ALLOWED_ORIGINS` | `*` | edge function CORS allow-list (`https://you.github.io,…`) |

`TRANSLATE_PROVIDER=free` uses Google's public dictionary endpoint: no key, no quota guarantee. It
is fine for personal use and demos; for a public deployment set a real key (Cloud Translation and
DeepL both have generous free tiers) so translation never fails mid-article.

## Deploy to Supabase + GitHub Pages

The frontend is static; the ingestion function runs on Supabase. That combination is the one the
architecture was designed for.

> Step-by-step checkbox version, with your project's exact commands and URLs: **[DEPLOY-SUPABASE.md](DEPLOY-SUPABASE.md)**.

### 1. Database cache (optional but recommended)

```sql
-- Supabase dashboard → SQL editor → paste supabase/schema.sql → Run
```

Creates `ingest_cache` with RLS enabled and **no** policies, so only the service role (used by the
function) can touch it. Without this the function still works — it just relies on per-isolate memory.

### 2. Deploy the function

```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy ingest --no-verify-jwt     # public endpoint, no user JWT

supabase secrets set ALLOWED_ORIGINS="https://<you>.github.io,http://localhost:3000"
# optional, strongly recommended for reliable translation:
supabase secrets set GOOGLE_TRANSLATE_API_KEY=…
```

`--no-verify-jwt` is intentional: the endpoint serves public news data and is called from a static
page that has no user session. Rate limiting and SSRF guards live inside the function.

Your endpoint is then:

```
https://<your-project-ref>.supabase.co/functions/v1/ingest
```

### 3. Publish the frontend

```bash
# GitHub Pages (from your repository)
git push origin main
# Settings → Pages → Deploy from branch → main / (root)
```

Then open the site, click **⚙**, paste the function URL into *رابط خادم الاستخراج*, and save. The
choice is stored in `localStorage`; to bake it in for every visitor, set it in `assets/config.js`:

```js
window.AL_MARSAD_CONFIG = {
  apiBase: "",
  supabaseFunction: "https://<your-project-ref>.supabase.co/functions/v1/ingest",
  autoTranslate: true
};
```

**Alternative:** any host that can run Node (`npm start`) works unchanged — Fly.io, Railway, a VPS
behind nginx, Docker (`CMD ["node","server/server.mjs"]`). A serverless platform without a Node
runtime (Vercel/Netlify functions) only needs a ~20-line adapter around `pipeline.js`; the pipeline
itself takes `fetch`, a DNS resolver and a cache, and nothing else.

## How extraction works

1. **Fetch** with a normal browser User-Agent, manual redirect handling (max 4), a 15 s timeout, and a
   1.8 MB cap. Every hop is validated against the SSRF guard.
2. **Discover a feed first.** `feeds.js` holds known RSS/Atom endpoints for ~110 publishers; otherwise
   `<link rel="alternate" type="application/rss+xml">`; otherwise links are scored out of the homepage.
   RSS gives reliable titles, dates and images with zero scraping.
3. **Extract the article.** JSON-LD (`NewsArticle`) → OpenGraph → `<h1>`; then a container scorer
   ranks candidate elements by paragraph text, link density, class/id hints and semantic tags
   (`article`, `main`, `[itemprop=articleBody]`). Boilerplate (nav, share bars, related, ads,
   newsletters, cookie banners) is dropped by class/id patterns, link density and text patterns.
   `<script>` content is never treated as article text (JSON-LD is read separately), and duplicate
   mobile/desktop renderings are de-duplicated.
4. **Flag reality:** `thin: true` when a page is a JavaScript shell or too short, `paywalled: true`
   for `isAccessibleForFree: false`, `metered`, or paywall DOM markers. The UI then says so and points
   at the publisher instead of pretending it has the text.
5. **Translate** server-side in batches, or return raw text and let the client batch it (`?op=translate`)
   so the reader shows progress.

Language detection uses the declared `lang`/`og:locale`, Unicode script counting (Arabic, Hebrew,
Cyrillic, Greek, Devanagari, CJK…), and a function-word fallback for Latin-script languages.

## Security & limits

- **SSRF**: only `http`/`https`, no credentials in URLs, and hostnames are resolved before connecting;
  loopback, link-local (including `169.254.169.254`), private, CGNAT, multicast and IPv6 literal
  ranges are refused. Redirect targets are checked hop by hop.
- **Resource limits**: 1.8 MB body cap, 15 s timeout, 4 redirects, 120 blocks, 60 000 characters per
  translation request, 300 texts max.
- **Rate limiting** in the edge function (per IP, per isolate): 120 article/feed calls and 60
  translation calls per minute.
- **Caching**: paywalled articles are **never** cached; everything else is capped at 10 minutes.
- **No secrets in the browser.** Provider keys live only in server env/secrets.
- The frontend escapes every string it renders, and only renders `http(s)` image URLs.

## Testing

```bash
npm test
```

19 tests cover the HTML parser (malformed markup, entities), extraction quality on BBC/CNN-style
fixtures, paywall and thin-page detection, Arabic/RTL handling, JSON-LD fallback, RSS + Atom parsing,
feed discovery, link extraction, SSRF blocking, redirect/size/timeout limits, cache behaviour, and
translation batching/alignment (with a stubbed provider, so no network is required).

The fixtures live in `tests/fixtures/` and double as an offline playground — a fake publisher with a
homepage, an RSS feed, a paywalled article and an Arabic article:

```bash
npm run fixtures                    # fake publisher on http://127.0.0.1:8899
ALLOW_PRIVATE_HOSTS=1 npm start     # app on :3000, allowed to fetch localhost
# then paste http://127.0.0.1:8899/ into the app (or http://127.0.0.1:8899/feed.xml)
```

`ALLOW_PRIVATE_HOSTS=1` exists only for this; leave it unset in production so the SSRF guard stays on.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "بلا خادم — وضع محدود" | No function URL configured and `/api` is absent. Run `npm start` or set the URL in ⚙ |
| `401` / `403` from a publisher | Bot protection (Cloudflare/Akamai). The extractor reports it; try another source or add a proxy |
| "استُخرج نص محدود" (`thin`) | JavaScript-rendered article. Use the source link; a headless-browser renderer would be the next step |
| Feed list empty, `via: "links"` | No RSS found; links were scraped from the homepage (order is approximate) |
| Translation stops mid-article | Free provider quota/rate limit. Set `GOOGLE_TRANSLATE_API_KEY` or `DEEPL_API_KEY` |
| CORS error in the browser console | `ALLOWED_ORIGINS` on the function must include your site's exact origin |
| `404` from the function URL | Wrong URL shape — it must end in `/functions/v1/ingest` |

## Rights and attribution

Al-Marsad is a reader, not a re-publisher. Every rendered article keeps the publisher's name, a
visible link to the canonical URL, and a reminder that the original is authoritative. Paywalled
content is not cached and is shown only as far as the publisher serves it publicly. For a commercial
deployment, review each publisher's terms for automated access, and prefer official APIs or licensed
feeds where they exist.

## Roadmap ideas

- LLM summarisation / story clustering ("Arabic news agent" digests across sources)
- Per-publisher adapters where generic extraction is weak (SPA sites)
- Reading list, search across followed publishers, offline export
- Optional headless-browser fallback for JavaScript-only pages
- User accounts on Supabase (favourites and history already exist locally)

## License

MIT for the code. Article content remains the property of its publishers.
