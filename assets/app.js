/* =============================================================================
   Al-Marsad — frontend
   -----------------------------------------------------------------------------
   The viewer never iframes a publisher. Every page is fetched by the ingestion
   API (local server or Supabase Edge Function), reduced to clean blocks, then
   rendered here and translated. X-Frame-Options / CSP frame-ancestors therefore
   cannot block anything: the browser only ever talks to our own API.
   ============================================================================= */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const LS_KEY = "al-marsad.v1";
  const CFG = Object.assign({}, window.AL_MARSAD_CONFIG || {});

  /* ------------------------------------------------------------------ utils */
  const flagOf = (cc) => {
    try { return cc.toUpperCase().replace(/./g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt())); }
    catch (e) { return ""; }
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().replace(/[\u064B-\u0652\u0670\u0640]/g, "").replace(/\s+/g, " ").trim();
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch (e) { return String(u || ""); } };
  const isHttps = (u) => /^https?:\/\//i.test(String(u || ""));
  const isArabicText = (s) => (String(s).match(/[\u0600-\u06FF]/g) || []).length > String(s).length * 0.25;
  const LANG_NAME = {
    ar: "العربية", en: "الإنجليزية", fr: "الفرنسية", de: "الألمانية", es: "الإسبانية", it: "الإيطالية",
    nl: "الهولندية", ru: "الروسية", tr: "التركية", pt: "البرتغالية", sv: "السويدية", no: "النرويجية",
    da: "الدنماركية", fi: "الفنلندية", pl: "البولندية", cs: "التشيكية", hu: "الهنغارية", ro: "الرومانية",
    el: "اليونانية", sr: "الصربية", hr: "الكرواتية", bg: "البلغارية", is: "الأيسلندية", id: "الإندونيسية",
    ms: "الماليزية", th: "التايلاندية", vi: "الفيتنامية", zh: "الصينية", ja: "اليابانية", ko: "الكورية",
    hi: "الهندية", bn: "البنغالية", fa: "الفارسية", he: "العبرية", uk: "الأوكرانية", ne: "النيبالية",
    si: "السنهالية", ta: "التاميلية", te: "التيلوغوية", ur: "الأردية", az: "الأذرية", kk: "الكازاخية"
  };
  const langLabel = (l) => LANG_NAME[l] || (l ? String(l).toUpperCase() : "غير معروفة");
  const RTL = new Set(["ar", "he", "fa", "ur"]);

  const dtf = new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" });
  const relFmt = new Intl.RelativeTimeFormat("ar", { numeric: "auto" });

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const diffMin = Math.round((d.getTime() - Date.now()) / 60000);
    if (Math.abs(diffMin) < 60 * 24 * 7) {
      if (Math.abs(diffMin) < 60) return relFmt.format(diffMin, "minute");
      if (Math.abs(diffMin) < 60 * 24) return relFmt.format(Math.round(diffMin / 60), "hour");
      return relFmt.format(Math.round(diffMin / 1440), "day");
    }
    return dtf.format(d);
  }

  let toastT;
  function toast(msg, ms = 2800) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), ms);
  }

  /* ------------------------------------------------------------------ state */
  const S = {
    backend: { base: "", kind: "checking", ok: false, info: null },
    papers: [], sel: null,
    view: "welcome",
    feed: { state: "idle", data: null, error: null, url: null },
    article: { state: "idle", data: null, error: null, url: null },
    trans: { state: "idle", data: null, error: null, url: null, done: 0, total: 0 },
    transCache: new Map(),
    q: "", filter: "free", favs: new Set(),
    theme: "light", side: "left", bilingual: false, scale: 1, autoTranslate: true,
    widths: { sb: 290, tr: 470 },
    apiBase: "", busyRequest: 0
  };

  const remember = {
    get(key, dflt) { try { const v = localStorage.getItem("al-marsad." + key); return v === null ? dflt : v; } catch (e) { return dflt; } },
    set(key, val) { try { localStorage.setItem("al-marsad." + key, String(val)); } catch (e) { /* ignore */ } }
  };

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        theme: S.theme, side: S.side, widths: S.widths, favs: [...S.favs], filter: S.filter,
        sel: S.sel ? S.sel.u : null, bilingual: S.bilingual, scale: S.scale,
        autoTranslate: S.autoTranslate
      }));
    } catch (e) { /* storage might be unavailable */ }
  }

  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { saved = {}; }
    S.theme = saved.theme === "dark" ? "dark" : "light";
    S.side = saved.side === "right" ? "right" : "left";
    S.filter = ["free", "embed", "all", "fav"].includes(saved.filter) ? saved.filter : "free";
    S.bilingual = !!saved.bilingual;
    S.scale = Number(saved.scale) || 1;
    S.autoTranslate = saved.autoTranslate === undefined ? CFG.autoTranslate !== false : !!saved.autoTranslate;
    S.widths = Object.assign({ sb: 290, tr: 470 }, saved.widths || {});
    (saved.favs || []).forEach((u) => S.favs.add(u));
    S.apiBase = remember.get("apiBase", "");
    return saved.sel || null;
  }

  /* ---------------------------------------------------------------- backend */
  const backendBase = () => S.apiBase || CFG.apiBase || CFG.supabaseFunction || "";

  async function fetchJSON(url, opts = {}) {
    const timeout = opts.timeout || CFG.requestTimeoutMs || 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(url, Object.assign({ cache: "no-store" }, opts, { signal: controller.signal }));
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") {
        const err = new Error("انتهت مهلة الطلب. قد يكون الخادم بطيئًا أو أن الناشر يحجب الجلب.");
        err.code = "timeout";
        throw err;
      }
      const err = new Error("تعذّر الوصول إلى خادم الاستخراج.");
      err.code = "network";
      throw err;
    }
    clearTimeout(timer);
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) {
      const err = new Error(res.status === 404
        ? "لا يوجد خادم استخراج على هذا العنوان (404)."
        : "أعاد الخادم استجابة غير مفهومة (HTTP " + res.status + ").");
      err.code = "bad_backend";
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (!res.ok || body.ok === false) {
      const err = new Error(body.error || body.message || "فشل الطلب (HTTP " + res.status + ")");
      err.code = body.code || "api_error";
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function detectBackend({ quiet = false } = {}) {
    if (!quiet) setServerBadge("checking");
    const candidates = [];
    const explicit = backendBase();
    if (explicit) candidates.push({ base: explicit, kind: /\/functions\/v1\//.test(explicit) ? "supabase" : "custom" });
    if (!explicit || explicit !== "/api") candidates.push({ base: "", kind: "local" });

    for (const cand of candidates) {
      const base = cand.base;
      try {
        const info = await fetchJSON((base || "/api") + "?op=health", { timeout: 4000 });
        if (info && info.ok) {
          S.backend = { base, kind: cand.kind, ok: true, info };
          setServerBadge("ok");
          return S.backend;
        }
      } catch (e) { /* try the next candidate */ }
    }
    S.backend = { base: "", kind: "direct", ok: false, info: null };
    setServerBadge("direct");
    return S.backend;
  }

  function setServerBadge(state) {
    const dot = $("#srvdot"), txt = $("#srvtext"), badge = $("#srvbadge");
    if (state === "checking") {
      dot.className = "pulse"; txt.textContent = "جارٍ فحص الخادم…"; badge.title = "نتحقق من وجود خادم استخراج (محلي أو Supabase).";
      return;
    }
    if (state === "ok") {
      const info = S.backend.info || {};
      const kindLabel = S.backend.kind === "supabase" ? "Supabase Edge" : S.backend.kind === "custom" ? "خادم مُعرَّف" : "الخادم المحلي";
      dot.className = "pulse on";
      txt.textContent = kindLabel + " يعمل";
      badge.title = (info.service || "al-marsad-ingest") + " " + (info.version || "") +
        " · المُستخرِج " + (info.extractor || "?") +
        " · الترجمة: " + ((info.translation && info.translation.detail) || "—");
      return;
    }
    dot.className = "pulse warn";
    txt.textContent = "بلا خادم — وضع محدود";
    badge.title = "لم نجد خادم استخراج. شغّل python/node server أو اضبط رابط Supabase Function من ⚙.";
  }

  async function apiArticle(url, { fresh = false } = {}) {
    if (!S.backend.ok) return directArticle(url);
    const qs = new URLSearchParams({ op: "article", url });
    if (fresh) qs.set("fresh", "1");
    return fetchJSON((S.backend.base || "/api") + "?" + qs.toString());
  }

  async function apiFeed(url, { fresh = false } = {}) {
    if (!S.backend.ok) {
      const err = new Error("استعراض قائمة الأخبار يحتاج خادم الاستخراج.");
      err.code = "no_backend";
      throw err;
    }
    const qs = new URLSearchParams({ op: "feed", url });
    if (fresh) qs.set("fresh", "1");
    return fetchJSON((S.backend.base || "/api") + "?" + qs.toString());
  }

  async function apiTranslate(texts, sl) {
    if (!S.backend.ok) return directTranslate(texts, sl);
    const body = JSON.stringify({ texts, sl: sl || "auto", tl: "ar" });
    const data = await fetchJSON((S.backend.base || "/api") + "?op=translate", {
      method: "POST", headers: { "content-type": "application/json" }, body
    });
    return (data.out || []).map((o) => o.ar || "");
  }

  /* ------------------------------------------------- degraded browser mode */
  function parseMarkdown(md) {
    const lines = String(md).split(/\r?\n/);
    const blocks = [];
    let title = "";
    for (const raw of lines) {
      let l = raw.trim();
      if (!l) continue;
      const tm = l.match(/^Title:\s*(.+)$/i);
      if (tm && !title) { title = tm[1].trim(); continue; }
      if (/^(URL Source|Markdown Content|Published Time|Warning):/i.test(l)) continue;
      if (/^!\[/.test(l)) continue;
      l = l.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "");
      const linkChars = (l.match(/\)\]\(/g) || []).length;
      const isHeading = /^#{1,3}\s+/.test(l);
      l = l.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]{1,3}/g, "").replace(/\s+/g, " ").trim();
      if (!l || l.length < 30) continue;
      if (linkChars >= 2 && l.length < 120) continue;
      if (/^(الرئيسية|Home|Menu|Share|Read more|Subscribe|Sign in|Log in|Advertisement)/i.test(l)) continue;
      if (/(?:[a-z]{8,}[-_]?){3,}/i.test(l)) continue;
      blocks.push({ t: isHeading ? "h" : "p", x: l });
      if (blocks.length > 130) break;
    }
    return { title, blocks };
  }

  async function directArticle(url) {
    const err0 = new Error(
      "لم يتم العثور على خادم استخراج. شغّل «npm start» أو اضبط رابط Supabase Function من زر ⚙ — " +
      "هذا هو المسار الموثوق الذي يتجاوز حجب التضمين."
    );
    err0.code = "no_backend";
    let res;
    try {
      res = await fetch("https://r.jina.ai/" + url, { headers: { "x-respond-with": "markdown" } });
    } catch (e) {
      throw err0;
    }
    if (!res.ok) throw err0;
    const md = await res.text();
    const parsed = parseMarkdown(md);
    if (!parsed.blocks.length) throw err0;
    const host = hostOf(url);
    const paper = S.papers.find((p) => p.u === url);
    return {
      ok: true, kind: "article", url, canonical: url, site: paper ? paper.n : host,
      title: parsed.title || (paper ? paper.n : host), excerpt: "", byline: "", publishedAt: null,
      image: null, lang: isArabicText(parsed.blocks.slice(0, 5).map((b) => b.x).join(" ")) ? "ar" : "",
      dir: "auto", blocks: parsed.blocks, wordCount: parsed.blocks.length * 20, paywalled: false,
      thin: false, degraded: true, fetchedAt: new Date().toISOString(),
      source: { fetchedUrl: "r.jina.ai", bytes: md.length }
    };
  }

  async function directTranslate(texts, sl) {
    const out = [];
    for (let i = 0; i < texts.length; i += 10) {
      const slice = texts.slice(i, i + 10);
      const form = new URLSearchParams();
      slice.forEach((t) => form.append("q", String(t).slice(0, 4800)));
      const r = await fetch("https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=" +
        encodeURIComponent(sl || "auto") + "&tl=ar", { method: "POST", body: form });
      if (!r.ok) throw new Error("تعذّرت الترجمة من المتصفح (HTTP " + r.status + ").");
      const j = await r.json();
      const arr = Array.isArray(j) ? j.map((x) => Array.isArray(x) ? (x[0] || "") : String(x || "")) : [];
      while (arr.length < slice.length) arr.push("");
      out.push(...arr.slice(0, slice.length));
    }
    return out;
  }

  /* -------------------------------------------------------------- left pane */
  const byCountry = [];
  function buildGroups() {
    byCountry.length = 0;
    const m = new Map();
    S.papers.forEach((p) => {
      if (!m.has(p.c)) m.set(p.c, { c: p.c, cc: p.cc, items: [] });
      m.get(p.c).items.push(p);
    });
    m.forEach((g) => byCountry.push(g));
    byCountry.sort((a, b) => (b.items.length - a.items.length) || a.c.localeCompare(b.c, "ar"));
  }

  function matches(p) {
    if (S.filter === "free" && p.t !== "free") return false;
    if (S.filter === "embed" && p.e !== "yes") return false;
    if (S.filter === "fav" && !S.favs.has(p.u)) return false;
    if (S.q) {
      const q = norm(S.q);
      if (!norm(p.n + " " + p.c + " " + p.u + " " + (p.l || "")).includes(q)) return false;
    }
    return true;
  }

  function paperRow(p) {
    const on = S.sel && S.sel.u === p.u;
    const fav = S.favs.has(p.u);
    return `<div class="paper${on ? " active" : ""}" data-u="${esc(p.u)}">
      <button class="plink" data-act="open" title="${esc(p.n)} — ${esc(hostOf(p.u))}">
        <span class="pname">${esc(p.n)}</span>
        ${p.a ? `<span class="ar-tag" title="لهذه الصحيفة نسخة عربية رسمية">ع</span>` : ""}
        <span class="ltag" title="${langLabel(p.l)}">${esc((p.l || "").toUpperCase())}</span>
        <span class="dot ${p.e}" title="${p.e === "yes" ? "بنية صفحة يسهل استخراجها" : p.e === "no" ? "استخراج أقل موثوقية — يعمل عبر الخادم" : "غير مؤكد"}"></span>
      </button>
      <button class="mini star${fav ? " on" : ""}" data-act="fav" title="${fav ? "إزالة من المفضلة" : "أضف إلى المفضلة"}" aria-label="مفضلة">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${fav ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.8z"/></svg>
      </button>
      <a class="mini" href="${esc(p.u)}" target="_blank" rel="noopener noreferrer" title="فتح موقع الصحيفة" aria-label="فتح الموقع">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>
      </a>
    </div>`;
  }

  function renderList() {
    const parts = byCountry.map((g) => {
      const items = g.items.filter(matches);
      if (!items.length) return "";
      return `<details class="country" data-c="${esc(g.c)}"${items.some((p) => S.sel && p.u === S.sel.u) || S.q ? " open" : ""}>
        <summary><span class="flag">${flagOf(g.cc)}</span><span class="cname">${esc(g.c)}</span>
          <span class="num">${items.length}</span>
          <svg class="caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
        </summary>
        <div class="apad">${items.map(paperRow).join("")}</div>
      </details>`;
    }).filter(Boolean);

    $("#listbody").innerHTML = parts.length ? parts.join("") :
      `<div class="noresult">لا نتائج مطابقة.<br>جرّب <b>كل المصادر</b> أو امسح البحث.</div>`;

    const count = (fn) => S.papers.filter(fn).length;
    $("#n-free").textContent = count((p) => p.t === "free");
    $("#n-embed").textContent = count((p) => p.e === "yes");
    $("#n-all").textContent = String(S.papers.length);
    $("#n-fav").textContent = String(S.favs.size);
    $("#sf-count").textContent = `${S.papers.length} صحيفة في ${byCountry.length} دولة`;
    $$(".chip").forEach((c) => c.classList.toggle("on", c.dataset.f === S.filter));
  }

  /* ------------------------------------------------------------ viewer shell */
  function viewerTitle(main, sub, cc) {
    $("#vtitle").innerHTML = `${cc ? `<span class="flag">${flagOf(cc)}</span>` : ""}<b>${esc(main)}</b>` +
      (sub ? `<span class="url" dir="ltr">${esc(sub)}</span>` : "");
  }

  function setStateChip(kind, label) {
    const el = $("#vstate");
    el.className = "state " + kind;
    el.textContent = label;
  }

  function emptyCard(html) {
    return `<div class="emptywrap"><div class="card">${html}</div></div>`;
  }

  /* -------------------------------------------------------------- welcome */
  const QUICK = ["https://www.bbc.com/news", "https://www.france24.com/en/", "https://www.dw.com/ar/",
    "https://www.aljazeera.net/", "https://meduza.io/en", "https://english.news.cn/"];

  function renderWelcome() {
    S.view = "welcome";
    $("#backBtn").disabled = true;
    $("#openExt").href = "#";
    $("#openExt").setAttribute("aria-disabled", "true");
    viewerTitle("لم تختر صحيفة بعد", "", "");
    setStateChip("unknown", "—");
    const quick = QUICK.map((u) => {
      const q = S.papers.find((x) => x.u === u);
      return q ? `<button class="chip" data-u="${esc(q.u)}">${flagOf(q.cc)} ${esc(q.n)}</button>` : "";
    }).join("");
    $("#stage").innerHTML = emptyCard(`
      <h3>كيف تقرأ خبرًا من أي صحيفة بالعربية؟</h3>
      <ol class="steps">
        <li>اختر صحيفة من القائمة، أو <b>الصق رابط خبر</b> في الشريط أعلاه.</li>
        <li>يجلبه <b>خادم الاستخراج</b> (محلي أو Supabase) ويستخرج نص المقال.</li>
        <li>يظهر المقال هنا كاملًا داخل المرصد، وتُترجم فقراته إلى العربية في النافذة المجاورة.</li>
      </ol>
      <p class="muted small">لا نستخدم <span dir="ltr">iframe</span> إطلاقًا: لذلك لا توقفنا سياسات
        <span dir="ltr">X-Frame-Options</span> أو <span dir="ltr">CSP frame-ancestors</span> التي تفرضها الصحف.</p>
      <div class="row" id="quickrow">${quick}</div>
    `);
    const row = $("#quickrow");
    if (row) row.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-u]");
      if (!b) return;
      const q = S.papers.find((x) => x.u === b.dataset.u);
      if (q) selectPaper(q);
    });
  }

  /* ----------------------------------------------------------------- feeds */
  function renderFeedLoading() {
    S.view = "feed";
    $("#backBtn").disabled = !S.sel;
    const cards = Array.from({ length: 6 }, () => `<div class="news-card skel-card"><b></b><b></b><b></b></div>`).join("");
    $("#stage").innerHTML = `<div class="feed">
      <div class="feedhead"><div><span class="spin"></span> جارٍ جلب آخر الأخبار…</div></div>
      <div class="cards">${cards}</div></div>`;
    setStateChip("loading", "جارٍ الجلب");
  }

  function renderFeed() {
    const d = S.feed.data;
    S.view = "feed";
    $("#backBtn").disabled = true;
    const paper = S.sel;
    if (!d) { renderWelcome(); return; }
    const site = d.site || (paper ? paper.n : hostOf(d.url || ""));
    viewerTitle(paper ? paper.n : site, hostOf(paper ? paper.u : ""), paper ? paper.cc : "");
    $("#openExt").href = paper ? paper.u : d.source && d.source.fetchedUrl || "#";
    $("#openExt").removeAttribute("aria-disabled");
    setStateChip(d.via === "links" ? "unknown" : "yes", d.via === "links" ? "قائمة مستخرجة" : "خلاصة RSS");

    const viaNote = d.via === "links"
      ? `<p class="note">لم نجد خلاصة RSS لهذا الموقع، فاستخرجنا روابط الأخبار من صفحته الرئيسية. الترتيب تقديري.</p>`
      : "";

    const items = (d.items || []).map((it, i) => {
      const img = it.image && isHttps(it.image)
        ? `<img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
        : `<span class="thumb-fallback" aria-hidden="true">${flagOf(paper ? paper.cc : "") || "📰"}</span>`;
      return `<button class="news-card" data-i="${i}">
        <span class="thumb">${img}</span>
        <span class="nc-body">
          <span class="nc-title">${esc(it.title)}</span>
          ${it.summary ? `<span class="nc-sum">${esc(it.summary)}</span>` : ""}
          <span class="nc-meta">
            ${it.publishedAt ? `<time datetime="${esc(it.publishedAt)}">${esc(fmtDate(it.publishedAt))}</time>` : ""}
            ${it.section ? `<span class="sec">${esc(it.section)}</span>` : ""}
            <span class="host" dir="ltr">${esc(hostOf(it.url))}</span>
          </span>
        </span>
      </button>`;
    }).join("");

    $("#stage").innerHTML = `<div class="feed">
      <div class="feedhead">
        <div class="fht">
          <h2>${esc(site)}</h2>
          <span class="sub">${d.items.length} خبرًا · ${d.via === "links" ? "مستخرجة من الصفحة" : "من خلاصة الناشر"}</span>
        </div>
        <a class="ghost" href="${esc(paper ? paper.u : "#")}" target="_blank" rel="noopener noreferrer">الموقع الأصلي ↗</a>
      </div>
      ${viaNote}
      <div class="cards">${items || `<div class="noresult">لا أخبار في هذه القائمة الآن.</div>`}</div>
    </div>`;

    $$("#stage .news-card[data-i]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const it = d.items[Number(btn.dataset.i)];
        if (it) openArticle(it.url, { fromFeed: true });
      });
    });
    if (window.innerWidth <= 980) setTab("view");
  }

  /* --------------------------------------------------------------- articles */
  function renderArticleLoading() {
    S.view = "article";
    const p = S.sel;
    viewerTitle(p ? p.n : "جارٍ الجلب", hostOf(S.article.url || ""), p ? p.cc : "");
    setStateChip("loading", "جارٍ الاستخراج");
    $("#stage").innerHTML = `<div class="reader">
      <div class="skel"><b></b><b></b><b></b></div>
      <div class="loadline"><span class="spin"></span> يطلب الخادم الصفحة من الناشر ويستخرج المقال…</div>
      <div class="skel"><b></b><b></b><b></b><b></b><b></b></div>
    </div>`;
    $("#backBtn").disabled = !S.sel && !S.feed.data;
  }

  function isDuplicateTitle(b, i, title) {
    return i === 0 && b.t === "h" && norm(b.x) === norm(title || "");
  }

  function blockHTML(b, dir) {
    if (b.t === "img") {
      if (!isHttps(b.src)) return "";
      return `<figure class="aimg"><img src="${esc(b.src)}" alt="${esc(b.x || "")}" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('figure').remove()">${b.x ? `<figcaption>${esc(b.x)}</figcaption>` : ""}</figure>`;
    }
    if (b.t === "h") return `<h2 class="blk h" dir="auto">${esc(b.x)}</h2>`;
    if (b.t === "li") return `<div class="blk li" dir="auto"><span class="bullet">•</span><span>${esc(b.x)}</span></div>`;
    if (b.t === "q") return `<blockquote class="blk q" dir="auto">${esc(b.x)}</blockquote>`;
    return `<p class="blk" dir="auto">${esc(b.x)}</p>`;
  }

  function renderArticle() {
    const A = S.article.data;
    S.view = "article";
    if (!A) { renderWelcome(); return; }
    if (A.kind === "feed") { S.feed.data = A; renderFeed(); return; }

    const paper = S.sel;
    const site = A.site || (paper ? paper.n : hostOf(A.url));
    viewerTitle(paper ? paper.n : site, hostOf(A.canonical || A.url), paper ? paper.cc : "");
    $("#openExt").href = A.canonical || A.url;
    $("#openExt").removeAttribute("aria-disabled");
    $("#backBtn").disabled = !S.sel && !S.feed.data;

    const dir = A.dir === "rtl" || RTL.has(A.lang) ? "rtl" : A.dir === "ltr" ? "ltr" : "auto";
    setStateChip(A.degraded ? "unknown" : "yes", A.degraded ? "وضع محدود" : "مستخرَج من الخادم");

    const pills = [
      `<span class="pill">${esc(site)}</span>`,
      A.lang ? `<span class="pill">${esc(langLabel(A.lang))}</span>` : `<span class="pill">لغة غير محددة</span>`,
      A.publishedAt ? `<span class="pill">${esc(fmtDate(A.publishedAt))}</span>` : "",
      A.wordCount ? `<span class="pill">${A.wordCount} كلمة</span>` : "",
      A.paywalled ? `<span class="pill warn">جزء مدفوع</span>` : "",
      A.degraded ? `<span class="pill warn">بلا خادم</span>` : ""
    ].filter(Boolean).join("");

    const notices = [];
    if (A.paywalled) notices.push(`<div class="banner warn">هذا المقال مدفوع كليًا أو جزئيًا؛ نعرض الجزء المتاح للتعرّف فقط. اقرأ الباقي عند الناشر.</div>`);
    if (A.thin || A.hint) notices.push(`<div class="banner">${esc(A.hint || "استُخرج نص محدود من هذه الصفحة.")}</div>`);
    if (A.degraded) notices.push(`<div class="banner warn">وضع محدود: لم يتصل الموقع بخادم الاستخراج، فاستُخدم جلب المتصفح الاحتياطي. للحصول على استخراج كامل وترجمة موثوقة شغّل الخادم أو اضبط رابط Supabase من ⚙.</div>`);

    const hero = A.image && isHttps(A.image) && !A.blocks.some((b) => b.t === "img" && b.src === A.image)
      ? `<figure class="hero"><img src="${esc(A.image)}" alt="" loading="eager" referrerpolicy="no-referrer" onerror="this.closest('figure').remove()"></figure>` : "";

    const source = A.canonical || A.url;
    $("#stage").innerHTML = `<article class="reader" dir="${dir}">
      <header class="ahead">
        <div class="pills">${pills}</div>
        <h1 class="rtitle" dir="auto">${esc(A.title || site)}</h1>
        ${A.byline ? `<p class="abyline">${esc(A.byline)}</p>` : ""}
        ${A.excerpt ? `<p class="aexcerpt" dir="auto">${esc(A.excerpt)}</p>` : ""}
        <div class="arow">
          <a class="ghost primary" href="${esc(source)}" target="_blank" rel="noopener noreferrer">اقرأ عند المصدر ↗</a>
          <button class="ghost" id="trInline">ترجمة فورية</button>
          <button class="ghost" id="copyLink">نسخ الرابط</button>
        </div>
      </header>
      ${notices.join("")}
      ${hero}
      <div class="ablocks">${A.blocks.map((b, i) => (isDuplicateTitle(b, i, A.title) ? "" : blockHTML(b, dir))).join("")}</div>
      <footer class="afooter">
        نص مستخرَج آليًا من <a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(source))}</a>
        · © المحتوى ملك ناشره · الترجمة آلية وقد تخطئ، والنص الأصلي هو المرجع.
        ${A.source && A.source.bytes ? `<span class="srcmeta"> · ${Math.round(A.source.bytes / 1024)} ك.ب من الصفحة الأصلية</span>` : ""}
      </footer>
    </article>`;

    const inline = $("#trInline");
    if (inline) inline.onclick = () => { translateCurrent(true); if (window.innerWidth <= 980) setTab("trans"); };
    const copyLink = $("#copyLink");
    if (copyLink) copyLink.onclick = async () => {
      try { await navigator.clipboard.writeText(source); toast("نُسخ رابط المصدر ✓"); }
      catch (e) { toast("تعذّر النسخ"); }
    };
    $("#stage").scrollTop = 0;
  }

  function renderError() {
    const E = S.article.error || {};
    S.view = "error";
    setStateChip("no", "تعذّر الجلب");
    const url = S.article.url;
    const needsServer = E.code === "no_backend";
    $("#stage").innerHTML = emptyCard(`
      <h3>لم نتمكن من إحضار هذا الخبر</h3>
      <p>${esc(E.message || "خطأ غير معروف.")}</p>
      ${needsServer ? `<p class="muted small">خادم الاستخراج هو الجزء الذي يتجاوز حجب التضمين. شغّله بالأمر
        <span class="kbd" dir="ltr">npm start</span> أو اضبط رابط Supabase Function من ⚙.</p>` : ""}
      <div class="row">
        <button class="ghost primary" id="retryArticle">إعادة المحاولة</button>
        ${isHttps(url) ? `<a class="ghost" href="${esc(url)}" target="_blank" rel="noopener noreferrer">فتح عند الناشر ↗</a>` : ""}
        ${S.sel ? `<button class="ghost" id="backToFeed">قائمة الأخبار</button>` : ""}
        <button class="ghost" id="openSettings2">إعدادات الخادم</button>
      </div>
      ${E.code ? `<p class="muted small" dir="ltr">code: ${esc(E.code)}</p>` : ""}
    `);
    const retry = $("#retryArticle");
    if (retry) retry.onclick = () => openArticle(url, { fresh: true, fromFeed: true });
    const back = $("#backToFeed");
    if (back) back.onclick = () => (S.feed.data ? renderFeed() : renderWelcome());
    const set = $("#openSettings2");
    if (set) set.onclick = showSettings;
  }

  /* ------------------------------------------------------------ translations */
  function renderTransIdle() {
    $("#tsrc").textContent = S.sel ? hostOf(S.sel.u) : "";
    $("#trGoBtn").disabled = !S.article.data;
    $("#tstage").innerHTML = `<div class="emptywrap"><div class="card">
      <h3>الترجمة تظهر هنا</h3>
      <p>اختر خبرًا من القائمة أو الصق رابطًا في الأعلى. سيُستخرج نص المقال من الخادم ثم تُترجم فقراته إلى العربية هنا، ويبقى النص الأصلي في النافذة المجاورة.</p>
      <p class="muted small">الترجمة آلية وقد تخطئ في الأسماء والمصطلحات — والنص الأصلي هو المرجع.</p>
    </div></div>`;
  }

  function renderTrans() {
    const T = S.trans, A = S.article.data;
    $("#tsrc").textContent = hostOf((A && (A.canonical || A.url)) || S.article.url || "");
    const btn = $("#trGoBtn");
    btn.disabled = !A;
    btn.querySelector("span").textContent = T.state === "loading" ? "جارٍ الترجمة…" : "ترجم";

    if (!A) return renderTransIdle();

    if (T.state === "idle") {
      const already = A.lang === "ar";
      $("#tstage").innerHTML = `<div class="emptywrap"><div class="card">
        <h3>${already ? "الخبر عربي أصلًا" : "جاهز للترجمة"}</h3>
        <p>${already
          ? "هذا المصدر ينشر بالعربية، لذا لا حاجة لترجمة آلية — يمكنك قراءته كما هو في نافذة القراءة."
          : `سيُترجم <b>${esc(A.title || "")}</b> (${esc(langLabel(A.lang))}) فقرة فقرة إلى العربية.`}</p>
        <div class="row">
          <button class="ghost primary" id="goTrans">${already ? "اعرض النص في هذه النافذة" : "ترجم الآن"}</button>
          <a class="ghost" href="${esc(A.canonical || A.url)}" target="_blank" rel="noopener noreferrer">فتح المصدر ↗</a>
        </div>
        <p class="muted small">الترجمة تتم في ${S.backend.ok ? "الخادم" : "المتصفح (وضع محدود)"} — وبإمكانك إظهار النص الأصلي تحت كل فقرة بزر «نص أصلي».</p>
      </div></div>`;
      const go = $("#goTrans");
      if (go) go.onclick = () => translateCurrent(false);
      return;
    }

    if (T.state === "loading") {
      const A2 = S.article.data;
      const pct = Math.round((T.done / Math.max(T.total, 1)) * 100);
      $("#tstage").innerHTML = `<div class="reader">
        <div class="tmeta"><span class="tag">جارٍ الترجمة</span><span>${T.done} / ${T.total} فقرة</span></div>
        <div class="prog"><i style="width:${pct}%"></i></div>
        <h1 class="ttitle">${esc(A2.title || "")}</h1>
        <div class="skel"><b></b><b></b><b></b><b></b></div>
      </div>`;
      return;
    }

    if (T.state === "error") {
      $("#tstage").innerHTML = `<div class="emptywrap"><div class="card">
        <h3>تعذّرت الترجمة</h3>
        <p>${esc(T.error || "خطأ غير معروف")}</p>
        <div class="row"><button class="ghost primary" id="again">إعادة المحاولة</button>
        <a class="ghost" href="${esc((A && (A.canonical || A.url)) || "#")}" target="_blank" rel="noopener noreferrer">فتح المصدر ↗</a></div>
      </div></div>`;
      const again = $("#again");
      if (again) again.onclick = () => translateCurrent(true);
      return;
    }

    if (T.state === "self") {
      $("#tstage").innerHTML = `<div class="reader" dir="rtl">
        <div class="tmeta"><span class="tag">المصدر عربي</span><span>لا ترجمة آلية</span></div>
        <h1 class="ttitle" dir="auto">${esc(A.title || "")}</h1>
        ${A.blocks.map((b, i) => {
          if (isDuplicateTitle(b, i, A.title)) return "";
          if (b.t === "img") return blockHTML(b);
          if (b.t === "h") return `<h2 class="tp h" dir="auto">${esc(b.x)}</h2>`;
          return `<p class="tp" dir="auto">${esc(b.x)}</p>`;
        }).join("")}
      </div>`;
      return;
    }

    if (T.state === "done" && T.data) {
      const R = T.data;
      const scroll = $("#tstage").scrollTop;
      const meta = [
        `<span class="tag">ترجمة آلية</span>`,
        `<span>${esc(R.provider || "الخادم")}</span>`,
        `<span>${esc(langLabel(A.lang))} → العربية</span>`,
        R.partial ? `<span class="warn">${R.doneCount} من ${A.blocks.length} فقرة</span>` : "",
      ].filter(Boolean).join(" · ");

      const body = A.blocks.map((b, i) => {
        const ar = R.texts[i] || "";
        if (isDuplicateTitle(b, i, A.title)) return "";
        if (b.t === "img") return blockHTML(b);
        if (!ar) return `<p class="tp missing" dir="auto">${esc(b.x)}</p>`;
        if (b.t === "h") return `<h2 class="tp h" dir="auto">${esc(ar)}</h2>${S.bilingual ? `<div class="orig">${esc(b.x)}</div>` : ""}`;
        if (b.t === "li") return `<div class="tp li" dir="auto"><span class="bullet">•</span><span>${esc(ar)}</span></div>${S.bilingual ? `<div class="orig">${esc(b.x)}</div>` : ""}`;
        if (b.t === "q") return `<blockquote class="tp q" dir="auto">${esc(ar)}</blockquote>${S.bilingual ? `<div class="orig">${esc(b.x)}</div>` : ""}`;
        return `<p class="tp" dir="auto">${esc(ar)}</p>${S.bilingual ? `<div class="orig">${esc(b.x)}</div>` : ""}`;
      }).join("");

      $("#tstage").innerHTML = `<div class="reader" dir="rtl">
        <div class="tmeta">${meta}</div>
        <h1 class="ttitle" dir="auto">${esc(R.title || A.title || "")}</h1>
        ${S.bilingual && A.title ? `<div class="orig">${esc(A.title)}</div>` : ""}
        ${body}
        <footer class="afooter">ترجمة آلية من <a href="${esc(A.canonical || A.url)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(A.canonical || A.url))}</a> — تحقّق من النص الأصلي عند الاقتباس.</footer>
      </div>`;
      $("#tstage").scrollTop = scroll;
    }
  }

  async function translateCurrent(fresh) {
    const A = S.article.data;
    if (!A || A.kind === "feed") { toast("اختر خبرًا أولًا"); return; }
    const key = A.canonical || A.url;

    if (A.lang === "ar" || (!A.lang && isArabicText(A.blocks.slice(0, 4).map((b) => b.x).join(" ")))) {
      S.trans = { state: "self", data: null, error: null, url: A.url, done: 0, total: 0 };
      renderTrans();
      if (window.innerWidth <= 980) setTab("trans");
      return;
    }

    if (!fresh && S.transCache.has(key)) {
      S.trans = { state: "done", data: S.transCache.get(key), error: null, url: A.url, done: 0, total: 0 };
      renderTrans();
      if (window.innerWidth <= 980) setTab("trans");
      return;
    }

    const token = A.canonical || A.url || "";
    const isCurrent = () => {
      const cur = S.article.data;
      return !!cur && ((cur.canonical || cur.url || "") === token);
    };

    const texts = [A.title || ""].concat(A.blocks.map((b) => (b.t === "img" ? "" : b.x)));
    const total = texts.filter(Boolean).length;
    S.trans = { state: "loading", data: null, error: null, url: A.url, done: 0, total };
    renderTrans();
    if (window.innerWidth <= 980) setTab("trans");

    const out = new Array(texts.length).fill("");
    const CH = S.backend.ok ? 14 : 8;
    const batches = [];
    for (let i = 0; i < texts.length; i += CH) batches.push(i);

    let firstError = null;
    let completed = 0;
    const translateBatch = async (start) => {
      const idx = [];
      for (let k = start; k < Math.min(start + CH, texts.length); k++) if (texts[k]) idx.push(k);
      if (!idx.length) return;
      const res = await apiTranslate(idx.map((k) => texts[k]), A.lang || "auto");
      idx.forEach((k, j) => { out[k] = res[j] || ""; });
      completed += idx.length;
      if (isCurrent() && S.trans.state === "loading") { S.trans.done = completed; renderTrans(); }
    };

    // Two at a time keeps the free endpoint happy while feeling instant.
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length && !firstError) {
        const start = batches[cursor++];
        try { await translateBatch(start); } catch (e) { firstError = firstError || e; }
      }
    };
    await Promise.all([worker(), worker()]);

    if (!isCurrent()) return; // the reader moved on while we were translating

    if (firstError) {
      S.trans = { state: "error", data: null, error: firstError.message || String(firstError), url: A.url, done: completed, total };
      renderTrans();
      return;
    }

    const R = {
      title: out[0] || A.title || "", texts: out.slice(1),
      provider: S.backend.ok
        ? ((S.backend.info && S.backend.info.translation && (S.backend.info.translation.detail || S.backend.info.translation.name)) || "خادم الاستخراج")
        : "ترجمة المتصفح (وضع محدود)",
      at: Date.now(), doneCount: completed, partial: completed < total
    };
    S.transCache.set(key, R);
    S.trans = { state: "done", data: R, error: null, url: A.url, done: completed, total };
    renderTrans();
    if (completed < total) toast(`عُرضت ترجمة ${completed} فقرة من ${texts.filter(Boolean).length}.`, 4000);
  }

  /* ------------------------------------------------------------- navigation */
  function syncUrlState(params) {
    try {
      const u = new URL(location.href);
      for (const k of ["url", "paper"]) u.searchParams.delete(k);
      if (params && params.url) u.searchParams.set("url", params.url);
      if (params && params.paper) u.searchParams.set("paper", params.paper);
      history.replaceState(null, "", u.toString());
    } catch (e) { /* file:// or sandboxed contexts */ }
  }

  async function selectPaper(p, { keepArticle = false } = {}) {
    S.sel = p;
    save();
    syncUrlState({ paper: p.u });
    renderList();
    const det = document.querySelector(`.country[data-c="${CSS.escape(p.c)}"]`);
    if (det) det.open = true;
    if (!keepArticle) {
      S.article = { state: "idle", data: null, error: null, url: null };
      S.feed = { state: "idle", data: null, error: null, url: null };
      S.trans = { state: "idle", data: null, error: null, url: null, done: 0, total: 0 };
      renderTransIdle();
      if (!S.backend.ok) {
        renderNoBackendForFeed(p);
        return;
      }
      await loadFeed(p.u);
    }
    if (window.innerWidth <= 980) { setTab("view"); document.body.classList.remove("drawer"); }
  }

  function renderNoBackendForFeed(p) {
    S.view = "welcome";
    viewerTitle(p.n, hostOf(p.u), p.cc);
    setStateChip("no", "بلا خادم");
    $("#openExt").href = p.u;
    $("#stage").innerHTML = emptyCard(`
      <h3>${flagOf(p.cc)} ${esc(p.n)}</h3>
      <p>لعرض قائمة أخبار هذه الصحيفة وتلاوة مقالاتها داخل المرصد، يلزم <b>خادم الاستخراج</b> — فهو الذي يجلب
        الخلاصة والمقالات نيابةً عن المتصفح.</p>
      <p class="muted small">شغّل <span class="kbd" dir="ltr">npm start</span> ثم أعد تحميل الصفحة، أو اضبط رابط
        <span dir="ltr">Supabase Function</span> من ⚙.</p>
      <div class="row">
        <a class="ghost primary" href="${esc(p.u)}" target="_blank" rel="noopener noreferrer">فتح موقع الصحيفة ↗</a>
        <button class="ghost" id="openSettings3">إعدادات الخادم</button>
        <button class="ghost" id="pasteHint">الصق رابط خبر</button>
      </div>
    `);
    const s = $("#openSettings3");
    if (s) s.onclick = showSettings;
    const ph = $("#pasteHint");
    if (ph) ph.onclick = () => { setTab("view"); $("#urlInput").focus(); };
  }

  async function loadFeed(url, { fresh = false } = {}) {
    S.feed = { state: "loading", data: null, error: null, url };
    renderFeedLoading();
    try {
      const data = await apiFeed(url, { fresh });
      if (data.kind === "feed") {
        S.feed = { state: "done", data, error: null, url };
        renderFeed();
      } else {
        // The publisher URL resolved to a single article.
        S.article = { state: "done", data, error: null, url };
        renderArticle();
      }
    } catch (e) {
      S.feed = { state: "error", data: null, error: e, url };
      renderFeedError(e);
    }
  }

  function renderFeedError(e) {
    S.view = "feed";
    setStateChip("no", "تعذّر الجلب");
    $("#stage").innerHTML = emptyCard(`
      <h3>تعذّر جلب أخبار هذا المصدر</h3>
      <p>${esc(e.message || "خطأ غير معروف.")}</p>
      <div class="row">
        <button class="ghost primary" id="retryFeed">إعادة المحاولة</button>
        ${S.sel ? `<a class="ghost" href="${esc(S.sel.u)}" target="_blank" rel="noopener noreferrer">موقع الصحيفة ↗</a>` : ""}
      </div>
    `);
    const r = $("#retryFeed");
    if (r) r.onclick = () => S.sel && loadFeed(S.sel.u, { fresh: true });
  }

  async function openArticle(url, { fresh = false, fromFeed = false } = {}) {
    const clean = String(url || "").trim();
    if (!isHttps(clean)) { toast("أدخل رابطًا يبدأ بـ http:// أو https://"); return; }
    S.article = { state: "loading", data: null, error: null, url: clean };
    S.trans = { state: "idle", data: null, error: null, url: null, done: 0, total: 0 };
    renderTransIdle();
    renderArticleLoading();
    if (window.innerWidth <= 980) setTab("view");
    try {
      const data = await apiArticle(clean, { fresh });
      if (data.kind === "feed") {
        S.feed = { state: "done", data, error: null, url: clean };
        renderFeed();
        return;
      }
      S.article = { state: "done", data, error: null, url: data.canonical || clean };
      syncUrlState({ url: data.canonical || clean });
      renderArticle();
      // If the pasted URL belongs to a listed paper, keep its context.
      if (!S.sel) {
        const host = hostOf(data.canonical || clean);
        const paper = S.papers.find((p) => hostOf(p.u) === host);
        if (paper) { S.sel = paper; save(); renderList(); }
      }
      if (S.autoTranslate) translateCurrent(false);
      else renderTrans();
    } catch (e) {
      S.article = { state: "error", data: null, error: e, url: clean };
      renderError();
    }
  }

  /* ----------------------------------------------------------------- modals */
  function modal(html) {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="card">${html}</div>`;
    document.body.appendChild(m);
    m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
    return m;
  }

  function showHelp() {
    modal(`
      <h3>كيف يعمل المرصد؟</h3>
      <ul>
        <li><b>المشكلة:</b> كثير من الصحف ترسل <span dir="ltr">X-Frame-Options</span> أو
          <span dir="ltr">CSP frame-ancestors</span>، وهي سياسات متصفح لا يمكن لأي HTML/JavaScript تجاوزها.
          لذلك لا يعتمد المرصد على تضمين صفحات الناشرين.</li>
        <li><b>المسار:</b> رابط الخبر ← <b>خادم الاستخراج</b> (محلي أو Supabase Edge Function) ← استخراج
          المقال وتنظيفه ← ترجمة إلى العربية ← عرضه داخل المرصد.</li>
        <li><b>النافذة الأولى:</b> ${S.papers.length} صحيفة في ${byCountry.length} دولة. النقطة الخضراء تعني أن
          بنية الموقع يسهل استخراجها، لكن كل المواقع تعمل عبر الخادم.</li>
        <li><b>النافذة الثانية:</b> قائمة أخبار الصحيفة (من خلاصة RSS أو من صفحتها)، ثم المقال كاملًا كنص نظيف
          مع رابط المصدر ووقت النشر.</li>
        <li><b>النافذة الثالثة:</b> الترجمة العربية فقرة بفقرة، مع إمكانية إظهار النص الأصلي تحت كل فقرة.</li>
        <li><b>الخادم:</b> <span class="kbd" dir="ltr">npm start</span> يشغّل الواجهة والـ API على
          <span class="kbd" dir="ltr">http://localhost:3000</span>. للإنتاج: انشر الدالة على Supabase واضبط
          رابطها من زر ⚙.</li>
        <li><b>الاختصارات:</b> <span class="kbd">/</span> بحث · <span class="kbd">t</span> ترجم ·
          <span class="kbd">b</span> نص أصلي · <span class="kbd">Esc</span> إغلاق.</li>
        <li><b>حقوق:</b> المحتوى ملك ناشريه. نعرض نصًا مستخرجًا مع رابط واضح للمصدر، ولا نخزّن المقالات المدفوعة،
          والترجمة آلية قد تخطئ — والنص الأصلي هو المرجع عند الاقتباس.</li>
      </ul>
      <div class="row"><button class="ghost primary" id="okm">فهمت</button></div>
    `).addEventListener("click", (e) => { if (e.target.id === "okm") e.currentTarget.remove(); });
  }

  function showSettings() {
    const info = S.backend.info;
    const kind = S.backend.kind;
    const m = modal(`
      <h3>إعدادات الخادم والترجمة</h3>
      <p class="muted small">المرصد يحتاج خادم استخراج. يعمل افتراضيًا على نفس النطاق (<span dir="ltr">/api</span>)
        عبر <span dir="ltr">server/server.mjs</span>. عند نشر الواجهة على GitHub Pages، انشر دالة Supabase وضع
        رابطها هنا.</p>
      <label class="field">
        <span>رابط خادم الاستخراج (Supabase Function URL)</span>
        <input id="apiBaseInput" dir="ltr" placeholder="https://<project-ref>.supabase.co/functions/v1/ingest" value="${esc(S.apiBase)}">
      </label>
      <p class="muted small">اتركه فارغًا لاستخدام <span dir="ltr">/api</span> على نفس النطاق.</p>
      <label class="check"><input type="checkbox" id="autoTr" ${S.autoTranslate ? "checked" : ""}> ترجمة كل خبر تلقائيًا عند فتحه</label>
      <div class="statusbox">
        <div><b>الحالة:</b> ${S.backend.ok ? "متصل" : "غير متصل — وضع المتصفح المحدود"}${kind !== "checking" ? ` (${esc(kind)})` : ""}</div>
        ${info ? `<div class="muted small" dir="ltr">${esc(info.service || "")} ${esc(info.version || "")} · extractor ${esc(info.extractor || "")}</div>` : ""}
        ${info && info.translation ? `<div class="muted small">الترجمة: ${esc(info.translation.detail || info.translation.name || "—")}</div>` : ""}
      </div>
      <div class="row">
        <button class="ghost primary" id="saveSettings">حفظ وإعادة الفحص</button>
        <button class="ghost" id="resetSettings">افتراضي</button>
        <a class="ghost" href="https://github.com/vibecoding4test-a11y/Press-#deploy" target="_blank" rel="noopener noreferrer">دليل النشر ↗</a>
      </div>
    `);
    $("#saveSettings").onclick = async () => {
      const v = $("#apiBaseInput").value.trim();
      S.apiBase = v;
      remember.set("apiBase", v);
      S.autoTranslate = $("#autoTr").checked;
      save();
      m.remove();
      await detectBackend();
      toast(S.backend.ok ? "تم الاتصال بالخادم ✓" : "لم نجد خادمًا على هذا الرابط", 4000);
      if (S.backend.ok && S.sel) loadFeed(S.sel.u, { fresh: true });
      else if (S.backend.ok && S.article.url) openArticle(S.article.url, { fresh: true });
    };
    $("#resetSettings").onclick = () => {
      $("#apiBaseInput").value = "";
      $("#autoTr").checked = true;
    };
    $("#autoTr").onchange = () => { S.autoTranslate = $("#autoTr").checked; save(); };
  }

  /* ------------------------------------------------------------------ chrome */
  function applyTheme() { document.documentElement.dataset.theme = S.theme; }
  function applySide() { document.documentElement.dataset.side = S.side; }
  function applyWidths() {
    document.documentElement.style.setProperty("--sb", S.widths.sb + "px");
    document.documentElement.style.setProperty("--tr", S.widths.tr + "px");
  }
  function applyScale() { document.documentElement.style.setProperty("--read", (1.02 * S.scale).toFixed(2) + "rem"); }
  function setTab(name) {
    document.body.classList.toggle("tab-trans", name === "trans");
    $("#tabView").classList.toggle("on", name === "view");
    $("#tabTrans").classList.toggle("on", name === "trans");
  }

  function dragSplit(el, which) {
    el.addEventListener("pointerdown", (e) => {
      if (window.innerWidth <= 980) return;
      e.preventDefault();
      el.classList.add("drag");
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = S.widths[which], side = S.side;
      const move = (ev) => {
        const dx = ev.clientX - x0;
        let w = which === "sb" ? w0 + (side === "left" ? dx : -dx) : w0 - dx;
        const cap = which === "sb" ? window.innerWidth * 0.42 : window.innerWidth * 0.62;
        w = Math.min(Math.max(w, which === "sb" ? 225 : 300), Math.max(280, cap));
        S.widths[which] = Math.round(w);
        applyWidths();
      };
      const up = () => {
        el.classList.remove("drag");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        save();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
    el.addEventListener("dblclick", () => {
      S.widths[which] = which === "sb" ? 290 : 470;
      applyWidths();
      save();
    });
  }

  /* ------------------------------------------------------------------ events */
  function wire() {
    $("#listbody").addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const row = e.target.closest(".paper");
      if (!row) return;
      const u = row.dataset.u;
      const p = S.papers.find((x) => x.u === u);
      if (!p) return;
      const act = (e.target.closest("[data-act]") || { dataset: {} }).dataset.act;
      if (act === "fav") {
        S.favs.has(u) ? S.favs.delete(u) : S.favs.add(u);
        save(); renderList();
        return;
      }
      selectPaper(p);
    });

    $("#q").addEventListener("input", (e) => {
      S.q = e.target.value;
      $("#searchwrap").classList.toggle("has", !!S.q);
      renderList();
    });
    $("#qclr").addEventListener("click", () => {
      S.q = ""; $("#q").value = "";
      $("#searchwrap").classList.remove("has");
      renderList();
    });
    $("#chips").addEventListener("click", (e) => {
      const c = e.target.closest(".chip");
      if (!c) return;
      S.filter = c.dataset.f;
      save(); renderList();
    });

    $("#ingestForm").addEventListener("submit", (e) => {
      e.preventDefault();
      let v = $("#urlInput").value.trim();
      if (!v) { toast("الصق رابط خبر أولًا"); return; }
      if (!/^https?:\/\//i.test(v)) v = "https://" + v.replace(/^\/+/, "");
      $("#urlInput").value = v;
      openArticle(v);
    });

    $("#trGoBtn").addEventListener("click", () => {
      if (!S.article.data) { toast("اختر خبرًا أولًا"); return; }
      translateCurrent(true);
    });
    $("#trBtn").addEventListener("click", () => {
      if (!S.article.data) { toast("اختر خبرًا أولًا"); return; }
      translateCurrent(true);
      if (window.innerWidth <= 980) setTab("trans");
    });
    $("#biBtn").addEventListener("click", () => {
      S.bilingual = !S.bilingual;
      $("#biBtn").classList.toggle("on", S.bilingual);
      save();
      if (S.trans.state === "done") renderTrans();
      toast(S.bilingual ? "إظهار النص الأصلي تحت الترجمة" : "عرض الترجمة فقط");
    });
    $("#fontUp").addEventListener("click", () => { S.scale = Math.min(1.5, +(S.scale + 0.08).toFixed(2)); applyScale(); save(); });
    $("#fontDn").addEventListener("click", () => { S.scale = Math.max(0.82, +(S.scale - 0.08).toFixed(2)); applyScale(); save(); });
    $("#copyBtn").addEventListener("click", async () => {
      const A = S.article.data;
      if (!A) { toast("لا توجد ترجمة لنسخها"); return; }
      let text = "";
      if (S.trans.state === "done" && S.trans.data) {
        text = (S.trans.data.title || A.title || "") + "\n\n" +
          A.blocks.map((b, i) => (b.t === "img" ? "" : (S.trans.data.texts[i] || ""))).filter(Boolean).join("\n\n");
      } else if (S.trans.state === "self") {
        text = (A.title || "") + "\n\n" + A.blocks.filter((b) => b.t !== "img").map((b) => b.x).join("\n\n");
      } else {
        text = (A.title || "") + "\n\n" + A.blocks.filter((b) => b.t !== "img").map((b) => b.x).join("\n\n");
      }
      text += "\n\n— المصدر: " + (A.canonical || A.url || "");
      try { await navigator.clipboard.writeText(text); toast("نُسخ النص ✓"); }
      catch (e) { toast("تعذّر النسخ — حدّد النص يدويًا"); }
    });
    $("#printBtn").addEventListener("click", () => window.print());
    $("#reloadBtn").addEventListener("click", () => {
      if (S.article.url) openArticle(S.article.url, { fresh: true });
      else if (S.sel) loadFeed(S.sel.u, { fresh: true });
    });
    $("#backBtn").addEventListener("click", () => {
      if (S.feed.data && S.article.data && S.view === "article") renderFeed();
      else if (S.sel && S.backend.ok) loadFeed(S.sel.u);
      else renderWelcome();
    });
    $("#sideBtn").addEventListener("click", () => {
      S.side = S.side === "left" ? "right" : "left";
      applySide(); save();
      toast("القائمة الآن على " + (S.side === "left" ? "اليسار" : "اليمين"));
    });
    $("#themeBtn").addEventListener("click", () => {
      S.theme = S.theme === "light" ? "dark" : "light";
      applyTheme(); save();
    });
    $("#settingsBtn").addEventListener("click", showSettings);
    $("#helpBtn").addEventListener("click", showHelp);
    $("#aboutLink").addEventListener("click", showHelp);
    $("#menuBtn").addEventListener("click", () => document.body.classList.toggle("drawer"));
    $("#scrim").addEventListener("click", () => document.body.classList.remove("drawer"));
    $("#tabView").addEventListener("click", () => setTab("view"));
    $("#tabTrans").addEventListener("click", () => setTab("trans"));
    $$(".split").forEach((el) => dragSplit(el, el.id === "split1" ? "sb" : "tr"));

    addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === "/" && !typing) { e.preventDefault(); $("#q").focus(); $("#q").select(); }
      else if (e.key === "Escape") { document.body.classList.remove("drawer"); const m = $(".modal"); if (m) m.remove(); }
      else if ((e.key === "t" || e.key === "T") && !typing && !e.ctrlKey && !e.metaKey) { if (S.article.data) $("#trBtn").click(); }
      else if ((e.key === "b" || e.key === "B") && !typing && !e.ctrlKey && !e.metaKey) { $("#biBtn").click(); }
    });
  }

  /* -------------------------------------------------------------------- init */
  function init() {
    S.papers = Array.isArray(window.PAPERS) ? window.PAPERS : [];
    buildGroups();
    const savedSel = load();

    applyTheme(); applySide(); applyWidths(); applyScale();
    if (S.bilingual) $("#biBtn").classList.add("on");

    renderList();
    renderWelcome();
    renderTransIdle();
    setTab("view");
    wire();

    const paper = savedSel ? S.papers.find((x) => x.u === savedSel) : null;
    if (paper) {
      S.sel = paper;
      renderList();
      viewerTitle(paper.n, hostOf(paper.u), paper.cc);
    }

    // Shareable deep links: ?url=<news url> or ?paper=<publisher url>
    const params = new URLSearchParams(location.search);
    const deepUrl = params.get("url");
    const deepPaper = params.get("paper");
    const deepPaperObj = deepPaper ? S.papers.find((x) => x.u === deepPaper) : null;

    detectBackend().then(() => {
      if (deepUrl) { openArticle(deepUrl); return; }
      if (deepPaperObj) { selectPaper(deepPaperObj); return; }
      if (paper) { selectPaper(paper, { keepArticle: true }); return; }
      if (S.backend.ok) renderWelcome();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
