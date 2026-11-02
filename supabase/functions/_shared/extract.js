/* =============================================================================
   Al-Marsad — extractor core
   -----------------------------------------------------------------------------
   Runtime-agnostic (Supabase Edge / Deno, Node 18+, browsers). No dependencies.
   Turns a news URL's HTML into a clean, structured article:
     { title, byline, publishedAt, image, lang, blocks:[{t,x}], paywalled, ... }
   so the app can render it natively instead of iframing the publisher.
   ============================================================================= */

export const EXTRACTOR_VERSION = "al-marsad/1.0";

/* ------------------------------------------------------------------ utilities */

export const absUrl = (href, base) => {
  if (!href) return null;
  try { return new URL(String(href).trim(), base).href; } catch (e) { return null; }
};

export const hostOf = (u) => {
  try { return new URL(u).host.replace(/^www\./, ""); } catch (e) { return String(u || ""); }
};

/* crude but adequate "same publisher" test (handles co.uk, com.au, ...) */
export function sameSite(a, b) {
  const ha = hostOf(a).toLowerCase(), hb = hostOf(b).toLowerCase();
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const tail = (h) => {
    const p = h.split(".");
    if (p.length <= 2) return h;
    const twoLevel = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(p.slice(-2).join("."));
    return p.slice(twoLevel ? -3 : -2).join(".");
  };
  return tail(ha) === tail(hb);
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  hellip: "…", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", deg: "°", times: "×",
  euro: "€", pound: "£", yen: "¥", sect: "§", para: "¶", dagger: "†", prime: "′", Prime: "″",
  lrm: "\u200E", rlm: "\u200F", zwnj: "\u200C", zwj: "\u200D", shy: "\u00AD",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", agrave: "à", egrave: "è",
  auml: "ä", ouml: "ö", uuml: "ü", szlig: "ß", ccedil: "ç", ntilde: "ñ", aring: "å", oslash: "ø",
  Auml: "Ä", Ouml: "Ö", Uuml: "Ü", Eacute: "É", Agrave: "À", Ccedil: "Ç", aelig: "æ", AElig: "Æ",
  cacute: "ć", ccaron: "č", dcaron: "ď", ecaron: "ě", ncaron: "ň", rcaron: "ř", scaron: "š",
  zcaron: "ž", yacute: "ý", uu: "ü", otilde: "õ", atilde: "ã", Ecirc: "Ê", ecirc: "ê",
  acirc: "â", ecirc: "ê", icirc: "î", ocirc: "ô", ucirc: "û", acutes: "", Aring: "Å", Oslash: "Ø",
  lsquor: "‚", rsquor: "’", bdquo: "„", sbquo: "‚", frac12: "½", frac14: "¼", frac34: "¾",
  plusmn: "±", micro: "µ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π", mu: "μ",
  sigma: "σ", omega: "ω", Delta: "Δ", Omega: "Ω", infin: "∞", ne: "≠", le: "≤", ge: "≥",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", check: "✓", star: "☆", starf: "★"
};

export function decodeEntities(s) {
  return String(s == null ? "" : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, ent) => {
    if (ent[0] === "#") {
      const hex = ent[1] === "x" || ent[1] === "X";
      const code = parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    const v = NAMED_ENTITIES[ent];
    return v === undefined ? m : v;
  });
}

/* Collapse whitespace, drop control chars, normalise quotes used as spacing */
export function cleanText(s) {
  return decodeEntities(String(s == null ? "" : s))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ----------------------------------------------------------------- HTML parser */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen",
  "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "textarea", "title", "xmp"]);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw) {
  const out = Object.create(null);
  if (!raw) return out;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1].toLowerCase();
    if (name === "/" || !name) continue;
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
    out[name] = decodeEntities(val);
  }
  return out;
}

const el = (tag, attrs) => ({ e: 1, tag, attrs: attrs || Object.create(null), children: [], parent: null });
const txt = (text) => ({ e: 0, text, parent: null });

/**
 * Tolerant, dependency-free HTML → tree parser.
 * Unknown/malformed markup is ignored rather than throwing; depth and node
 * counts are capped so hostile pages cannot exhaust the isolate's memory.
 */
export function parseHTML(html, limits = {}) {
  const maxNodes = limits.maxNodes || 60000;
  const maxDepth = limits.maxDepth || 220;
  const root = el("#document");
  let cur = root;
  const stack = [root];
  const src = String(html == null ? "" : html);
  const n = src.length;
  let i = 0, nodes = 0;

  const pushText = (t) => {
    if (!t) return;
    const node = txt(t);
    node.parent = cur;
    cur.children.push(node);
  };

  while (i < n && nodes < maxNodes) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(src);
    if (!m) { pushText("<"); i = lt + 1; continue; }

    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrsRaw = m[3] || "";
    const selfClosing = /\/\s*$/.test(attrsRaw);
    i = TAG_RE.lastIndex;

    if (closing) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) { stack.length = k; cur = stack[k - 1]; break; }
      }
      continue;
    }

    const node = el(tag, parseAttrs(attrsRaw.replace(/\/\s*$/, "")));
    node.parent = cur;
    cur.children.push(node);
    nodes++;

    if (VOID_TAGS.has(tag) || selfClosing) continue;

    if (RAW_TEXT_TAGS.has(tag)) {
      const re = new RegExp("</" + tag + "\\s*>", "i");
      const rest = src.slice(i);
      const hit = rest.search(re);
      const raw = hit < 0 ? rest : rest.slice(0, hit);
      if (raw) { const t = txt(raw); t.parent = node; node.children.push(t); }
      if (hit < 0) { i = n; } else { i += hit + (re.exec(rest.slice(hit)) || [""])[0].length; }
      continue;
    }

    if (stack.length >= maxDepth) continue; // flatten over-deep trees
    stack.push(node);
    cur = node;
  }

  return root;
}

/* ----------------------------------------------------------- tree traversal */

export function textOf(node) {
  if (!node) return "";
  if (!node.e) return node.text || "";
  let out = "";
  const walk = (nd) => {
    for (const ch of nd.children) {
      if (!ch.e) out += ch.text || "";
      else if (ch.tag === "br") out += " ";
      else walk(ch);
    }
  };
  walk(node);
  return out;
}

const getAttr = (node, name) => (node && node.attrs ? node.attrs[name] : undefined);
const classOf = (node) => ((getAttr(node, "class") || "") + " " + (getAttr(node, "id") || "")).trim();

export function* walkElements(root) {
  const stack = [root];
  while (stack.length) {
    const nd = stack.pop();
    if (!nd.e) continue;
    if (nd !== root) yield nd;
    for (let k = nd.children.length - 1; k >= 0; k--) {
      const ch = nd.children[k];
      if (ch.e) stack.push(ch);
    }
  }
}

const firstByTag = (root, tags) => {
  for (const nd of walkElements(root)) if (tags.includes(nd.tag)) return nd;
  return null;
};

const allByTag = (root, tags) => {
  const out = [];
  for (const nd of walkElements(root)) if (tags.includes(nd.tag)) out.push(nd);
  return out;
};

const isHidden = (node) => {
  if (!node.e) return false;
  if (getAttr(node, "hidden") !== undefined) return true;
  if ((getAttr(node, "aria-hidden") || "").toLowerCase() === "true") return true;
  const style = (getAttr(node, "style") || "").replace(/\s+/g, "").toLowerCase();
  return /display:none|visibility:hidden/.test(style);
};

/* --------------------------------------------------------------- boilerplate */

const JUNK_RE = new RegExp([
  "comment", "comments", "share", "sharing", "social", "promo", "promotion", "advert", "advertisement",
  "\\bads?\\b", "ad-slot", "adslot", "sponsor", "newsletter", "subscribe", "subscription", "signup",
  "sign-up", "cookie", "consent", "gdpr", "banner", "related", "recirc", "recommend", "outbrain",
  "taboola", "most-read", "most-popular", "mostread", "popular", "sidebar", "footer", "masthead",
  "nav", "navbar", "navigation", "menu", "breadcrumb", "pagination", "pager", "toolbar", "popup",
  "modal", "overlay", "skip-link", "skip", "weather", "widget", "trending", "paywall-bar",
  "regwall", "login", "signin", "register", "search", "teaser-list", "top-stories", "also-read",
  "read-more", "more-stories", "outstream", "video-player", "embed-", "print-only", "sr-only",
  "screen-reader", "visually-hidden", "hidden", "byline-share", "article-tools",
  "مقترحات", "اقرأ-أيضا", "اقرأ-أيضاً", "ذات-صلة", "الأكثر-قراءة", "إعلان", "اشترك", "شارك",
  "التعليقات", "تعليقات", "القائمة", "التنقل", "تخطي"
].join("|"), "i");

const POSITIVE_RE = new RegExp([
  "article[-_]?(body|content|text|__body|body__)", "story[-_]?(body|content|text)", "entry[-_]?content",
  "post[-_]?(body|content)", "content[-_]?body", "rich[-_]?text", "body[-_]?text", "articlebody",
  "caas-body", "zn-body", "artikeltext", "page-content", "main-content", "prose", "texte-article",
  "article__content", "article-content", "story__content", "content__article", "post__content"
].join("|"), "i");

const BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote", "li", "figcaption", "pre", "dd", "dt"]);

const JUNK_TEXT_RE = new RegExp("^(advertisement|advertising|إعلان|إعلانات|اقرأ المزيد|اقرأ أيضاً|اقرأ أيضا|" +
  "read more|read also|related|related stories|more from|share|share this|share on|follow us|" +
  "subscribe|sign up|sign in|log in|login|menu|home|skip to content|تابعنا|اشترك|سجّل|تسجيل الدخول|" +
  "جميع الحقوق محفوظة|all rights reserved|cookie|accept cookies|we use cookies|enable javascript|" +
  "javascript is disabled|loading|جارٍ التحميل|تخطي إلى المحتوى)$", "i");

const NAV_TEXT_RE = new RegExp("^(skip to|jump to|saltar a|ir al contenido|passer au|aller au|" +
  "zum inhalt|vai al|ga naar|пропустить|الانتقال إلى|تخطَّ إلى|تخطي إلى|اقفز إلى)", "i");

const isJunkNode = (node) => {
  const cls = classOf(node);
  if (!cls) return false;
  if (POSITIVE_RE.test(cls)) return false;
  return JUNK_RE.test(cls);
};

/* Remove duplicated halves (mobile + desktop renderings of the same title) */
export function dedupText(t) {
  const n = t.length;
  if (n < 16) return t;
  for (const size of [Math.floor(n / 2), Math.floor(n / 3)]) {
    if (size < 8 || n % size) continue;
    const piece = t.slice(0, size);
    if (piece.repeat(n / size) === t) return piece.trim();
  }
  return t;
}

/* ------------------------------------------------------------------ metadata */

function collectMeta(root) {
  const meta = { byName: Object.create(null), jsonld: [], links: [] };
  for (const nd of walkElements(root)) {
    if (nd.tag === "meta") {
      const key = (getAttr(nd, "property") || getAttr(nd, "name") || getAttr(nd, "itemprop") || "").toLowerCase();
      const val = getAttr(nd, "content");
      if (key && val != null && !(key in meta.byName)) meta.byName[key] = val;
    } else if (nd.tag === "link") {
      meta.links.push({ rel: (getAttr(nd, "rel") || "").toLowerCase(), type: (getAttr(nd, "type") || "").toLowerCase(), href: getAttr(nd, "href"), title: getAttr(nd, "title") });
    } else if (nd.tag === "script") {
      const type = (getAttr(nd, "type") || "").toLowerCase();
      if (type.includes("ld+json")) {
        const raw = textOf(nd).trim();
        if (raw) meta.jsonld.push(raw);
      }
    } else if (nd.tag === "html") {
      meta.htmlLang = getAttr(nd, "lang") || getAttr(nd, "xml:lang");
      meta.htmlDir = getAttr(nd, "dir");
    }
  }
  return meta;
}

const ARTICLE_TYPES = /^(NewsArticle|Article|ReportageNewsArticle|BlogPosting|AnalysisNewsArticle|OpinionNewsArticle|TechArticle|ScholarlyArticle|WebPage)$/i;

function parseJsonLd(blobs) {
  const out = [];
  for (const raw of blobs) {
    const cleaned = raw.replace(/^\uFEFF/, "").replace(/;\s*$/, "");
    let data;
    try { data = JSON.parse(cleaned); } catch (e) {
      // tolerate trailing commas and CDATA wrappers seen in the wild
      try { data = JSON.parse(cleaned.replace(/,\s*([}\]])/g, "$1")); } catch (e2) { continue; }
    }
    const queue = Array.isArray(data) ? data.slice() : [data];
    let guard = 0;
    while (queue.length && guard++ < 200) {
      const item = queue.shift();
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item)) { queue.push(...item); continue; }
      if (item["@graph"]) queue.push(...(Array.isArray(item["@graph"]) ? item["@graph"] : [item["@graph"]]));
      out.push(item);
    }
  }
  return out;
}

const asText = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return cleanText(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(", ");
  if (typeof v === "object") return asText(v.name || v["@value"] || v.headline || "");
  return String(v);
};

const asImage = (v) => {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return asImage(v[0]);
  if (typeof v === "object") return v.url || v.contentUrl || asImage(v["@id"]) || null;
  return null;
};

function pickJsonLd(entities, pageUrl) {
  let best = null, bestScore = -1;
  for (const e of entities) {
    const types = [].concat(e["@type"] || []).map(String);
    if (!types.some((t) => ARTICLE_TYPES.test(t))) continue;
    let score = types.some((t) => /NewsArticle|Reportage|Article|BlogPosting/i.test(t)) ? 2 : 0;
    if (e.articleBody) score += 3;
    if (e.headline) score += 1;
    if (e.datePublished) score += 1;
    if (e.author) score += 1;
    if (e.url && pageUrl && sameSite(e.url, pageUrl)) score += 1;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

/* ------------------------------------------------------------------ language */

const SCRIPTS = [
  ["ar", /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g],
  ["he", /[\u0590-\u05FF]/g],
  ["fa", /[\u06A0-\u06FF\uFB50-\uFDFF]/g],
  ["ru", /[\u0400-\u04FF]/g],
  ["el", /[\u0370-\u03FF]/g],
  ["hi", /[\u0900-\u097F]/g],
  ["bn", /[\u0980-\u09FF]/g],
  ["ta", /[\u0B80-\u0BFF]/g],
  ["te", /[\u0C00-\u0C7F]/g],
  ["th", /[\u0E00-\u0E7F]/g],
  ["ko", /[\uAC00-\uD7AF]/g],
  ["ja", /[\u3040-\u30FF]/g],
  ["zh", /[\u4E00-\u9FFF]/g]
];

/* Function-word profiles let us guess Latin-script languages when a page
   declares no lang attribute. Only used when we are reasonably confident. */
const LATIN_HINTS = {
  en: "the and of to in is that for with was were has have this from",
  fr: "les des une est dans pour qui pas sur avec du la le et en ce",
  de: "der die und das nicht ist mit sich auf für ein eine auch von",
  es: "el los las una que con para por del como más se su al es",
  it: "il della che non per con una sono dei anche si ma gli",
  pt: "os das uma que com para não por mais dos ao se na um",
  nl: "de het een van niet dat met op zijn voor aan er ook",
  tr: "bir ve bu ile için olarak daha gibi de da çok ne var",
  pl: "się nie jest oraz dla który tego być jak ale po od",
  sv: "och att det som på för med inte är den av till",
  da: "og at det som på for med ikke er den af til",
  no: "og å det som på for med ikke er den til av",
  fi: "ja on että se ei oli mutta kun myös hän sen",
  cs: "je se na to že který pro ale jako byl jsou",
  ro: "și de la cu care este pentru din nu pe sunt"
};
const LATIN_PROFILES = Object.fromEntries(Object.entries(LATIN_HINTS).map(([code, words]) =>
  [code, new Set(words.split(" "))]));

function guessLatinLang(sample) {
  const words = String(sample).toLowerCase().match(/[a-z\u00C0-\u024F]{2,}/g) || [];
  if (words.length < 12) return "";
  const scores = Object.entries(LATIN_PROFILES).map(([code, set]) => {
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    return [code, hits / words.length];
  }).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = scores[0];
  const second = scores[1] ? scores[1][1] : 0;
  if (bestScore < 0.06) return "";
  if (bestScore < second * 1.35) return ""; // too close to call
  return best;
}

/**
 * Language detection good enough to route translation. Uses the declared
 * lang/og:locale when present, otherwise Unicode-script counting (with a
 * function-word fallback for Latin-script languages).
 */
export function detectLang(text, declared, dir) {
  const sample = String(text || "").slice(0, 6000);
  const counts = SCRIPTS.map(([code, re]) => [code, (sample.match(re) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  const [topCode, topCount] = counts[0] || ["", 0];
  const letters = (sample.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;
  const declaredCode = String(declared || "").toLowerCase().slice(0, 2);
  const declaredOk = /^[a-z]{2}$/.test(declaredCode);

  if (topCount > Math.max(24, sample.length * 0.08) && topCount > letters) return topCode;
  if (declaredOk) return declaredCode;
  if (letters > sample.length * 0.4) return guessLatinLang(sample);
  if (dir === "rtl") return "ar";
  return "";
}

/* --------------------------------------------------------------- main parser */

const MAX_BLOCKS_DEFAULT = 160;

function metaContent(meta, ...keys) {
  for (const k of keys) {
    if (meta.byName[k]) return cleanText(meta.byName[k]);
  }
  return "";
}

function stripSiteSuffix(title, site) {
  let t = cleanText(title);
  if (!t) return "";
  const separators = [" | ", " - ", " — ", " – ", " · ", " :: ", " » "];
  for (const sep of separators) {
    const idx = t.lastIndexOf(sep);
    if (idx > 18) {
      const tail = t.slice(idx + sep.length).trim();
      const siteKey = hostOf(site).split(".")[0].toLowerCase();
      if (tail.length <= 40 || (siteKey && tail.toLowerCase().includes(siteKey))) t = t.slice(0, idx).trim();
      break;
    }
  }
  return t;
}

/**
 * Score a candidate container as "the article".
 */
function scoreContainer(node) {
  let paragraphChars = 0, paragraphs = 0, linkChars = 0, totalChars = 0, headings = 0;
  for (const nd of walkElements(node)) {
    if (nd.tag === "p") {
      const len = cleanText(textOf(nd)).length;
      totalChars += len;
      if (len >= 55) { paragraphs++; paragraphChars += len; }
      for (const a of allByTag(nd, ["a"])) linkChars += cleanText(textOf(a)).length;
    } else if (/^h[1-3]$/.test(nd.tag)) {
      headings++;
    }
  }
  const linkDensity = totalChars ? linkChars / totalChars : 1;
  let score = paragraphChars * (1 - Math.min(0.95, linkDensity)) + paragraphs * 90 + headings * 20;
  const cls = classOf(node);
  if (POSITIVE_RE.test(cls)) score += 900;
  if (JUNK_RE.test(cls) && !POSITIVE_RE.test(cls)) score -= 1200;
  if (node.tag === "article") score += 500;
  else if (node.tag === "main") score += 200;
  if (node.tag === "li" || node.tag === "ul" || node.tag === "table" || node.tag === "nav") score -= 400;
  if ((node.attrs.itemprop || "").toLowerCase() === "articlebody") score += 800;
  return { score, paragraphs, paragraphChars, linkDensity };
}

function findContainer(root) {
  const explicit = [];
  for (const nd of walkElements(root)) {
    if (getAttr(nd, "itemprop") === "articleBody") explicit.push(nd);
    else if (POSITIVE_RE.test(classOf(nd))) explicit.push(nd);
  }
  const scoredExplicit = explicit
    .map((n) => ({ node: n, ...scoreContainer(n) }))
    .filter((c) => c.paragraphs >= 2 && c.paragraphChars >= 180)
    .sort((a, b) => b.score - a.score);
  if (scoredExplicit.length) return { nodes: [scoredExplicit[0].node], explicit: true };

  const candidates = [];
  for (const nd of walkElements(root)) {
    if (["article", "main", "section", "div", "td"].includes(nd.tag) || getAttr(nd, "role") === "main") {
      const s = scoreContainer(nd);
      if (s.paragraphs >= 2 && s.paragraphChars >= 200) candidates.push({ node: nd, ...s });
    }
  }
  if (!candidates.length) {
    const fallback = firstByTag(root, ["article", "main"]) || root;
    return { nodes: [fallback], explicit: false };
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  // Articles are often split across sibling blocks inside one wrapper.
  const nodes = [best.node];
  const parent = best.node.parent;
  if (parent && parent.e) {
    for (const sib of parent.children) {
      if (!sib.e || sib === best.node || nodes.includes(sib)) continue;
      if (sib.tag !== "div" && sib.tag !== "section") continue;
      const s = scoreContainer(sib);
      if (s.paragraphs >= 1 && s.paragraphChars >= 150 && s.score >= best.score * 0.35) nodes.push(sib);
    }
    if (nodes.length === 1 && parent.tag !== "body" && parent.tag !== "html") {
      const ps = scoreContainer(parent);
      if (ps.score > best.score * 0.9 && ps.paragraphs > best.paragraphs) nodes[0] = parent;
    }
  }
  return { nodes, explicit: false };
}

function collectBlocks(containers, opts) {
  const maxBlocks = opts.maxBlocks || MAX_BLOCKS_DEFAULT;
  const blocks = [];
  const seen = new Set();
  const seenImages = new Set();
  let images = 0;

  const pushText = (type, raw) => {
    let t = cleanText(raw);
    if (!t) return;
    t = dedupText(t);
    if (type !== "h") {
      if (t.length < 25) return;
      if (JUNK_TEXT_RE.test(t) || NAV_TEXT_RE.test(t)) return;
      // Menu rows and "read more" link clouds
      if (/^[\w\s,·|/–—:-]{0,40}$/.test(t) && !/[.!?؟…]/.test(t)) return;
      if ((t.match(/https?:\/\//g) || []).length > 1) return;
      // Icon font leakage: "icon-facebook icon-twitter icon-mail"
      if (/(?:[a-z]{6,}[-_]){3,}/i.test(t)) return;
    }
    if (t.length > 6000) t = t.slice(0, 6000);
    const key = t.slice(0, 80).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push({ t: type, x: t });
    return true;
  };

  const pushImage = (node) => {
    if (images >= 6) return;
    const cand = getAttr(node, "src") || getAttr(node, "data-src") || getAttr(node, "data-original") ||
      (getAttr(node, "srcset") || "").split(",")[0].trim().split(" ")[0];
    const src = absUrl(cand, opts.baseUrl);
    if (!src || !/^https?:\/\//.test(src)) return;
    if (seenImages.has(src)) return;
    if (/\.(svg|gif)(\?|$)/i.test(src)) return;
    if (/(sprite|logo|icon|avatar|pixel|spacer|blank|placeholder|1x1)/i.test(src)) return;
    const w = parseInt(getAttr(node, "width") || "0", 10);
    const h = parseInt(getAttr(node, "height") || "0", 10);
    if ((w && w < 200) || (h && h < 120)) return;
    seenImages.add(src);
    images++;
    blocks.push({ t: "img", x: cleanText(getAttr(node, "alt") || ""), src });
  };

  const visit = (node, depth, insideBlock) => {
    if (depth > 60 || blocks.length >= maxBlocks) return;
    if (!node.e) return;
    if (isHidden(node)) return;
    if (node !== containers[0] && isJunkNode(node)) return;
    const tag = node.tag;
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "form" || tag === "iframe" ||
        tag === "nav" || tag === "aside" || tag === "button" || tag === "select" || tag === "input" ||
        tag === "svg" || tag === "video" || tag === "audio" || tag === "footer" || tag === "header") return;

    if (tag === "img") { if (!insideBlock) pushImage(node); return; }

    if (BLOCK_TAGS.has(tag)) {
      const hasNestedP = tag !== "p" && !!firstByTag(node, ["p"]);
      if (!hasNestedP) {
        const text = textOf(node);
        const type = /^h[1-6]$/.test(tag) ? "h" : tag === "li" ? "li" : (tag === "blockquote" || tag === "pre") ? "q" : "p";
        // Link-cloud list items / caption rows are noise
        const links = allByTag(node, ["a"]);
        const linkChars = links.reduce((acc, a) => acc + cleanText(textOf(a)).length, 0);
        const len = cleanText(text).length;
        if (links.length > 2 && len > 0 && linkChars / len > 0.7) return;
        pushText(type, text);
        return;
      }
    }
    for (const ch of node.children) visit(ch, depth + 1, insideBlock || BLOCK_TAGS.has(tag));
  };

  for (const c of containers) visit(c, 0, false);
  return blocks.slice(0, maxBlocks);
}

function fallbackBlocks(root) {
  const blocks = [];
  for (const nd of walkElements(root)) {
    if (nd.tag !== "p" && nd.tag !== "li" && nd.tag !== "h2" && nd.tag !== "h3") continue;
    const t = cleanText(textOf(nd));
    if (t.length < 60) continue;
    if (JUNK_TEXT_RE.test(t)) continue;
    blocks.push({ t: nd.tag === "li" ? "li" : nd.tag === "p" ? "p" : "h", x: t });
    if (blocks.length >= 40) break;
  }
  return blocks;
}

function extractFeedLink(meta, pageUrl) {
  const rels = ["alternate"];
  for (const l of meta.links) {
    if (rels.some((r) => l.rel.split(/\s+/).includes(r)) && /(rss|atom|xml)/.test(l.type || "")) {
      const href = absUrl(l.href, pageUrl);
      if (href) return href;
    }
  }
  return null;
}

function findPaywall(root, meta, jsonld) {
  if (jsonld && String(jsonld.isAccessibleForFree).toLowerCase() === "false") return true;
  const tier = (meta.byName["article:content_tier"] || "").toLowerCase();
  if (tier === "locked" || tier === "metered") return true;
  if (/paywall|subscriber-only|premium-content/i.test(meta.byName["article:tag"] || "")) return true;
  let hits = 0;
  for (const nd of walkElements(root)) {
    const cls = classOf(nd);
    if (!cls) continue;
    if (/(^|[\s_-])(paywall|regwall|subscriber-only|premium-gate)([\s_-]|$)/i.test(cls)) hits++;
    if (hits > 2) return true;
  }
  return false;
}

function findDate(root, meta, jsonld) {
  const cand = jsonld && (jsonld.datePublished || jsonld.dateCreated) ||
    meta.byName["article:published_time"] || meta.byName["datepublished"] ||
    meta.byName["date"] || meta.byName["pubdate"] || meta.byName["publish-date"] ||
    meta.byName["og:article:published_time"] || meta.byName["dc.date"] || "";
  if (cand) {
    const d = new Date(cand);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  for (const nd of walkElements(root)) {
    if (nd.tag === "time") {
      const dt = getAttr(nd, "datetime") || getAttr(nd, "data-datetime") || textOf(nd);
      const d = new Date(dt);
      if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1990) return d.toISOString();
    }
  }
  return null;
}

function findAuthor(root, meta, jsonld) {
  const fromLd = jsonld ? asText(jsonld.author) : "";
  const direct = cleanText(meta.byName["author"] || meta.byName["article:author"] || meta.byName["byl"] || "");
  if (fromLd && fromLd.length < 90) return fromLd;
  if (direct && direct.length < 90 && !/^https?:/i.test(direct)) return direct;
  for (const nd of walkElements(root)) {
    if (getAttr(nd, "rel") === "author" || getAttr(nd, "itemprop") === "author") {
      const t = cleanText(textOf(nd));
      if (t && t.length < 90) return t;
    }
  }
  for (const nd of walkElements(root)) {
    const cls = classOf(nd);
    if (cls && /(^|[\s_-])(byline|author-name|article-author|writer)([\s_-]|$)/i.test(cls)) {
      const t = cleanText(textOf(nd)).replace(/^(by|von|par|por|بقلم|كتب)\s+/i, "");
      if (t && t.length < 90) return t;
    }
  }
  return "";
}

/**
 * Extract a readable article from raw HTML.
 *
 * @param {string} html  raw HTML
 * @param {string} url   final (post-redirect) URL
 * @param {{maxBlocks?:number}} [opts]
 */
export function extractArticle(html, url, opts = {}) {
  const baseUrl = url;
  const root = parseHTML(html);
  const meta = collectMeta(root);
  const jsonld = pickJsonLd(parseJsonLd(meta.jsonld), baseUrl);

  const htmlLang = meta.htmlLang || metaContent(meta, "og:locale", "content-language");
  const ldLang = jsonld ? asText(jsonld.inLanguage || "") : "";
  const declaredLang = ldLang || (htmlLang ? htmlLang.split(/[-_]/)[0] : "");

  const h1 = firstByTag(root, ["h1"]);
  const ogTitle = metaContent(meta, "og:title", "twitter:title");
  const docTitle = (() => {
    const t = firstByTag(root, ["title"]);
    return t ? cleanText(textOf(t)) : "";
  })();

  const site = metaContent(meta, "og:site_name", "application-name") ||
    (jsonld ? asText(jsonld.publisher) : "") || hostOf(baseUrl);

  const title = cleanText(
    (jsonld && asText(jsonld.headline)) ||
    ogTitle ||
    (h1 && cleanText(textOf(h1))) ||
    stripSiteSuffix(docTitle, site) ||
    site
  );

  const excerpt = cleanText(
    (jsonld && asText(jsonld.description)) ||
    metaContent(meta, "og:description", "twitter:description", "description")
  ).slice(0, 400);

  const image = absUrl(
    (jsonld && asImage(jsonld.image)) ||
    metaContent(meta, "og:image", "twitter:image", "twitter:image:src", "image"),
    baseUrl
  );

  const canonical = absUrl(
    (meta.links.find((l) => l.rel.split(/\s+/).includes("canonical")) || {}).href ||
    (jsonld && (jsonld.mainEntityOfPage ? (jsonld.mainEntityOfPage["@id"] || jsonld.mainEntityOfPage) : null)) ||
    (jsonld && jsonld.url) || "",
    baseUrl
  ) || baseUrl;

  const { nodes } = findContainer(root);
  let blocks = collectBlocks(nodes, { baseUrl, maxBlocks: opts.maxBlocks || MAX_BLOCKS_DEFAULT });

  // JSON-LD articleBody is a strong signal when the DOM was unusable.
  if (blocks.filter((b) => b.t === "p").length < 2 && jsonld && typeof jsonld.articleBody === "string" && jsonld.articleBody.length > 120) {
    const paras = jsonld.articleBody.split(/\n{1,}/).map((p) => cleanText(p)).filter((p) => p.length > 40);
    if (paras.length) blocks = paras.slice(0, opts.maxBlocks || MAX_BLOCKS_DEFAULT).map((x) => ({ t: "p", x }));
  }
  if (blocks.filter((b) => b.t === "p").length < 2) {
    const fb = fallbackBlocks(root);
    if (fb.length > blocks.length) blocks = fb;
  }
  // The headline often appears twice (h1 in page + in the container).
  const norm = (s) => cleanText(s).toLowerCase();
  if (title) {
    blocks = blocks.filter((b, i) => !(i === 0 && b.t === "h" && norm(b.x) === norm(title)));
    if (!blocks.length || blocks[0].t !== "h" || norm(blocks[0].x) !== norm(title)) {
      blocks.unshift({ t: "h", x: title });
    }
  }
  // Lead paragraph duplicated as og:description is fine to keep; that is standard.

  const bodyText = blocks.map((b) => b.x).join(" ");
  const wordCount = (bodyText.match(/[\p{L}\p{N}]+/gu) || []).length;
  const lang = detectLang(bodyText, declaredLang, meta.htmlDir);
  const dir = lang && ["ar", "he", "fa", "ur"].includes(lang) ? "rtl" : (meta.htmlDir === "rtl" ? "rtl" : "ltr");
  const paywalled = findPaywall(root, meta, jsonld);
  const thin = blocks.filter((b) => b.t === "p" || b.t === "li").length < 3 || wordCount < 120;

  return {
    ok: true,
    url: baseUrl,
    canonical,
    site,
    title,
    excerpt,
    byline: findAuthor(root, meta, jsonld),
    publishedAt: findDate(root, meta, jsonld),
    image: image && /^https?:/i.test(image) ? image : null,
    lang,
    dir,
    blocks,
    wordCount,
    paywalled,
    thin,
    via: "html",
    version: EXTRACTOR_VERSION,
    feed: extractFeedLink(meta, baseUrl),
    meta: {
      declaredLang: declaredLang || "",
      ogType: metaContent(meta, "og:type"),
      section: metaContent(meta, "article:section"),
      tags: (metaContent(meta, "article:tag") || "").slice(0, 160)
    }
  };
}

/* --------------------------------------------------------------------- feeds */

/* Strip markup out of feed summaries */
const stripTags = (s) => cleanText(String(s || "")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " "));

const firstTag = (xml, tag) => {
  const re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i");
  const m = xml.match(re);
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
};

const attrOfTag = (xml, tag, attr) => {
  const re = new RegExp("<" + tag + "\\b([^>]*)>", "i");
  const m = xml.match(re);
  if (!m) return "";
  const a = m[1].match(new RegExp(attr + "\\s*=\\s*[\"']([^\"']+)[\"']", "i"));
  return a ? decodeEntities(a[1]) : "";
};

function itemsOf(xml, tag) {
  const out = [];
  const re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "gi");
  let m;
  while ((m = re.exec(xml)) && out.length < 300) out.push(m[1]);
  return out;
}

/**
 * Parse RSS 2.0 / Atom / RDF into a normalised item list.
 * Feeds are the most reliable way to discover a publisher's latest articles.
 */
export function parseFeed(xml, baseUrl) {
  const raw = String(xml || "");
  const isAtom = /<feed[\s>]/i.test(raw) && !/<rss[\s>]/i.test(raw);
  const channelTitle = stripTags(firstTag(raw, "title"));
  const siteName = stripTags(firstTag(raw, "name")) || channelTitle;
  const items = [];

  const rawItems = isAtom ? itemsOf(raw, "entry") : itemsOf(raw, "item");
  for (const it of rawItems) {
    const title = stripTags(firstTag(it, "title"));
    let link = "";
    if (isAtom) {
      const alt = (it.match(/<link\b[^>]*rel=["']alternate["'][^>]*>/i) || it.match(/<link\b[^>]*>/i) || [])[0];
      link = alt ? (alt.match(/href=["']([^"']+)["']/i) || [])[1] || "" : "";
      if (!link) link = firstTag(it, "id");
    } else {
      link = cleanText(firstTag(it, "link")) || attrOfTag(it, "link", "href") || firstTag(it, "guid");
    }
    const url = absUrl(link, baseUrl);
    if (!title || !url) continue;

    const dateRaw = firstTag(it, "pubDate") || firstTag(it, "published") || firstTag(it, "updated") ||
      firstTag(it, "dc:date") || firstTag(it, "date");
    const d = dateRaw ? new Date(cleanText(dateRaw)) : null;

    let summary = stripTags(firstTag(it, "description") || firstTag(it, "summary") || firstTag(it, "content"));
    if (summary.length > 300) summary = summary.slice(0, 297).trimEnd() + "…";

    let image = attrOfTag(it, "media:content", "url") || attrOfTag(it, "media:thumbnail", "url") ||
      attrOfTag(it, "enclosure", "url") || "";
    if (!image) {
      const html = (it.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i) ||
                    it.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "";
      image = (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || "";
    }
    image = absUrl(image, baseUrl);

    items.push({
      title,
      url,
      publishedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
      summary,
      image: image && /^https?:/i.test(image) ? image : null,
      section: stripTags(firstTag(it, "category")).slice(0, 60)
    });
  }

  items.sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
  return {
    ok: items.length > 0,
    title: channelTitle || siteName || hostOf(baseUrl),
    site: siteName || hostOf(baseUrl),
    items: items.slice(0, 60),
    via: isAtom ? "atom" : "rss",
    version: EXTRACTOR_VERSION
  };
}

export function looksLikeFeed(text) {
  const head = String(text || "").slice(0, 800);
  return /<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(head) && /<(item|entry)[\s>]/i.test(text);
}

/* Discover a feed from <link rel=alternate> or common paths inside markup */
export function discoverFeed(html, baseUrl) {
  const root = parseHTML(String(html || "").slice(0, 400000), { maxNodes: 20000 });
  let best = null;
  for (const nd of walkElements(root)) {
    if (nd.tag !== "link") continue;
    const rel = (getAttr(nd, "rel") || "").toLowerCase();
    const type = (getAttr(nd, "type") || "").toLowerCase();
    if (!rel.includes("alternate")) continue;
    if (!/(rss|atom)\+xml/.test(type)) continue;
    const href = absUrl(getAttr(nd, "href"), baseUrl);
    if (!href) continue;
    const title = (getAttr(nd, "title") || "").toLowerCase();
    const score = /rss/.test(type) ? 2 : 1;
    const titleScore = /main|news|top|home|rss/i.test(title) ? 1 : 0;
    if (!best || score + titleScore > best.score) best = { href, score: score + titleScore };
  }
  if (best) return best.href;
  for (const nd of walkElements(root)) {
    if (nd.tag !== "a") continue;
    const href = absUrl(getAttr(nd, "href"), baseUrl);
    if (!href) continue;
    if (/(^|\/)(rss|feed|feeds)(\/|\.|$)/i.test(new URL(href).pathname)) return href;
  }
  return null;
}

const SKIP_LINK_RE = /(^|[/._-])(login|signin|signup|register|subscribe|account|privacy|terms|cookie|contact|about|advert|jobs|careers|sitemap|search|tag|tags|author|authors|category|topics|video|videos|live|podcast|newsletter|rss|feed|weather|sport\/?$|عضو|تسجيل|اشتراك|خصوصية|اتصل|عن-الموقع|بحث)([/._-]|$)/i;

/**
 * Homepage → list of likely article links (used when a publisher exposes no feed).
 * Deliberately conservative: a wrong link costs a wasted fetch, not a wrong page.
 */
export function extractLinks(html, baseUrl, limit = 40) {
  const root = parseHTML(String(html || ""), { maxNodes: 40000 });
  const seen = new Map();
  let order = 0;
  for (const a of allByTag(root, ["a"])) {
    const href = absUrl(getAttr(a, "href"), baseUrl);
    if (!href || !/^https?:/i.test(href)) continue;
    if (!sameSite(href, baseUrl)) continue;
    const url = new URL(href);
    url.hash = "";
    if (SKIP_LINK_RE.test(url.pathname)) continue;
    if (url.pathname === "/" || url.pathname.length < 8) continue;
    if (/\.(jpg|jpeg|png|gif|webp|pdf|zip|mp4|mp3)$/i.test(url.pathname)) continue;

    // Prefer links whose path looks like an article slug: /2026/11/02/...
    const segments = url.pathname.split("/").filter(Boolean);
    const sluggy = /[a-z-]{10,}/i.test(url.pathname) || /\d{4}\/\d{2}/.test(url.pathname) || /\/\d{5,}/.test(url.pathname);
    if (!sluggy && segments.length < 2) continue;

    const text = cleanText(textOf(a));
    if (text.length < 25 || text.length > 220) continue;
    if (JUNK_TEXT_RE.test(text) || NAV_TEXT_RE.test(text)) continue;

    let score = Math.min(text.length, 120) + (sluggy ? 30 : 0);
    const parent = a.parent;
    let hasTime = false, hasHeading = false;
    for (let p = parent, d = 0; p && p.e && d < 4; p = p.parent, d++) {
      if (firstByTag(p, ["time"])) hasTime = true;
      if (firstByTag(p, ["h1", "h2", "h3"])) hasHeading = true;
      if (p.tag === "article") score += 25;
    }
    if (hasTime) score += 40;
    if (hasHeading) score += 15;

    const key = url.href;
    const prev = seen.get(key);
    if (prev) { prev.score = Math.max(prev.score, score); continue; }
    seen.set(key, { title: text, url: key, score, order: order++ });
  }
  const items = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ title, url }) => ({ title, url, publishedAt: null, summary: "", image: null }));
  return { ok: items.length > 0, items, via: "links", version: EXTRACTOR_VERSION };
}

/* -------------------------------------------------------------------- guards */

/**
 * Blocks obvious SSRF targets by literal inspection. Hostname *resolution*
 * happens in each runtime (see http.js) — this is the cheap first gate.
 */
export function isBlockedHostname(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }
  if (h.startsWith("[") || h.includes(":")) return true; // IPv6 literals: refuse rather than reason about them
  if (/^0x|^\d+$/.test(h)) return true;
  return false;
}

/** Reject non-http(s), credentials-in-URL and over-long URLs. */
export function parseTargetUrl(input, opts = {}) {
  let u;
  try { u = new URL(String(input || "").trim()); } catch (e) { return { error: "invalid_url" }; }
  if (!/^https?:$/.test(u.protocol)) return { error: "unsupported_protocol" };
  if (u.username || u.password) return { error: "credentials_in_url" };
  if (u.href.length > 2048) return { error: "url_too_long" };
  if (!opts.allowPrivate && isBlockedHostname(u.hostname)) return { error: "blocked_host" };
  return { url: u };
}
