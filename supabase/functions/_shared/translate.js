/* =============================================================================
   Al-Marsad — translation providers
   -----------------------------------------------------------------------------
   Server-side translation keeps publisher pages out of a third-party iframe and
   avoids the CORS/rate problems the browser-only version had.

   Providers (auto-selected from env):
     google  — official Cloud Translation v2  (GOOGLE_TRANSLATE_API_KEY)
     deepl   — DeepL API                      (DEEPL_API_KEY)
     libre   — self-hosted LibreTranslate     (LIBRE_TRANSLATE_URL, LIBRE_TRANSLATE_API_KEY)
     free    — Google's public dict endpoint  (no key, best-effort, rate limited)
     none    — disable server-side translation (client asks for raw text only)
   ============================================================================= */

import { decodeEntities } from "./extract.js";

export class TranslateError extends Error {
  constructor(code, message, provider) {
    super(message || code);
    this.name = "TranslateError";
    this.code = code;
    this.provider = provider;
    this.status = code === "quota" ? 429 : code === "disabled" ? 501 : 502;
  }
}

const MAX_CHARS = 4200;
const MAX_ITEMS = 24;

export function pickProvider(env = {}) {
  const forced = String(env.TRANSLATE_PROVIDER || "auto").toLowerCase();
  if (forced === "none") return "none";
  if (forced !== "auto" && forced !== "") return forced;
  if (env.GOOGLE_TRANSLATE_API_KEY) return "google";
  if (env.DEEPL_API_KEY) return "deepl";
  if (env.LIBRE_TRANSLATE_URL) return "libre";
  return "free";
}

export function providerInfo(env = {}) {
  const name = pickProvider(env);
  const detail = {
    google: "Google Cloud Translation",
    deepl: "DeepL",
    libre: "LibreTranslate",
    free: "Google (واجهة عامة، بلا مفتاح)",
    none: "معطّلة — الترجمة في المتصفح"
  }[name] || name;
  return { name, detail };
}

function chunkTexts(texts) {
  const chunks = [];
  let cur = [], chars = 0, offset = 0;
  texts.forEach((t, i) => {
    const s = String(t == null ? "" : t);
    if (cur.length && (chars + s.length > MAX_CHARS || cur.length >= MAX_ITEMS)) {
      chunks.push({ items: cur, offset });
      offset = i; cur = []; chars = 0;
    }
    cur.push(s); chars += s.length;
  });
  if (cur.length) chunks.push({ items: cur, offset });
  return chunks;
}

async function postForm(url, form, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      body: form,
      signal: controller.signal,
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, payload, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      body: JSON.stringify(payload),
      signal: controller.signal,
      headers: { "content-type": "application/json", ...headers }
    });
  } finally {
    clearTimeout(timer);
  }
}

/* Google's public dictionary endpoint returns several shapes depending on
   input size; normalise all of them to one array aligned with the input. */
function normaliseFree(json, n) {
  const asStr = (v) => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return asStr(v[0]);
    if (typeof v === "object") return asStr(v.translatedText || v.translation || v[0]);
    return String(v);
  };
  if (typeof json === "string") return Array(n).fill(json);
  if (!Array.isArray(json)) throw new TranslateError("bad_response", "استجابة ترجمة غير متوقعة.", "free");

  let arr;
  if (Array.isArray(json[0])) arr = json.map(asStr);
  else arr = json.map(asStr);

  if (arr.length === n + 1 && /^[a-z-]{2,10}$/i.test(String(arr[n]).trim())) arr = arr.slice(0, n);
  if (arr.length === 1 && n === 1) return [arr[0]];
  if (arr.length < n) while (arr.length < n) arr.push("");
  return arr.slice(0, n).map((s) => decodeEntities(s));
}

async function translateGoogle(texts, sl, tl, env) {
  const key = env.GOOGLE_TRANSLATE_API_KEY;
  const url = "https://translation.googleapis.com/language/translate/v2?key=" + encodeURIComponent(key);
  const out = [];
  for (let i = 0; i < texts.length; i += MAX_ITEMS) {
    const slice = texts.slice(i, i + MAX_ITEMS).map((t) => String(t).slice(0, MAX_CHARS));
    const payload = { q: slice, target: tl, format: "text" };
    if (sl && sl !== "auto") payload.source = sl;
    const r = await postJson(url, payload);
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      if (r.status === 403 || r.status === 429) throw new TranslateError("quota", "حصة الترجمة مستنفدة أو المفتاح غير صالح.", "google");
      throw new TranslateError("provider_error", "Google Translate: HTTP " + r.status + " " + detail.slice(0, 120), "google");
    }
    const j = await r.json();
    const list = (j && j.data && j.data.translations) || [];
    for (let k = 0; k < slice.length; k++) out.push(decodeEntities((list[k] && list[k].translatedText) || ""));
  }
  return out;
}

async function translateDeepl(texts, sl, tl, env) {
  const key = env.DEEPL_API_KEY;
  const base = key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const out = [];
  for (let i = 0; i < texts.length; i += 20) {
    const slice = texts.slice(i, i + 20).map((t) => String(t).slice(0, MAX_CHARS));
    const form = new URLSearchParams();
    form.set("target_lang", tl.toUpperCase());
    if (sl && sl !== "auto") form.set("source_lang", sl.toUpperCase());
    slice.forEach((t) => form.append("text", t));
    const r = await postForm(base + "/v2/translate", form, { headers: { authorization: "DeepL-Auth-Key " + key } });
    if (r.status === 456 || r.status === 429) throw new TranslateError("quota", "حصة DeepL مستنفدة.", "deepl");
    if (!r.ok) throw new TranslateError("provider_error", "DeepL: HTTP " + r.status, "deepl");
    const j = await r.json();
    const list = j.translations || [];
    for (let k = 0; k < slice.length; k++) out.push(decodeEntities((list[k] && list[k].text) || ""));
  }
  return out;
}

async function translateLibre(texts, sl, tl, env) {
  const url = String(env.LIBRE_TRANSLATE_URL).replace(/\/+$/, "") + "/translate";
  const out = [];
  for (const t of texts) {
    const payload = { q: String(t).slice(0, MAX_CHARS), source: sl && sl !== "auto" ? sl : "auto", target: tl, format: "text" };
    if (env.LIBRE_TRANSLATE_API_KEY) payload.api_key = env.LIBRE_TRANSLATE_API_KEY;
    const r = await postJson(url, payload);
    if (!r.ok) throw new TranslateError("provider_error", "LibreTranslate: HTTP " + r.status, "libre");
    const j = await r.json();
    out.push(decodeEntities(j.translatedText || ""));
  }
  return out;
}

async function translateFree(texts, sl, tl) {
  const source = sl && sl !== "auto" ? sl : "auto";
  const form = new URLSearchParams();
  texts.forEach((t) => form.append("q", String(t).slice(0, 4800)));
  const url = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=" +
    encodeURIComponent(source) + "&tl=" + encodeURIComponent(tl);

  const r = await postForm(url, form);
  if (r.status === 429) throw new TranslateError("quota", "خدمة الترجمة العامة تحدّ الطلبات الآن (429).", "free");
  if (!r.ok) throw new TranslateError("provider_error", "خدمة الترجمة العامة: HTTP " + r.status, "free");
  let j;
  try { j = await r.json(); } catch (e) { throw new TranslateError("bad_response", "استجابة ترجمة غير قابلة للقراءة.", "free"); }
  return normaliseFree(j, texts.length);
}

/**
 * Translate an array of strings, preserving order.
 * @returns {Promise<{texts:string[], provider:string}>}
 */
export async function translateTexts(texts, { sl = "auto", tl = "ar", env = {}, provider } = {}) {
  const list = texts.map((t) => String(t == null ? "" : t));
  const chosen = provider || pickProvider(env);
  if (chosen === "none") throw new TranslateError("disabled", "الترجمة عبر الخادم معطّلة.", "none");

  const out = new Array(list.length).fill("");
  const chunks = chunkTexts(list);
  const CONCURRENCY = chosen === "free" ? 2 : 4;
  let next = 0;

  const runOne = async (chunk, idx) => {
    let res;
    if (chosen === "google") res = await translateGoogle(chunk, sl, tl, env);
    else if (chosen === "deepl") res = await translateDeepl(chunk, sl, tl, env);
    else if (chosen === "libre") res = await translateLibre(chunk, sl, tl, env);
    else if (chosen === "free") res = await translateFree(chunk, sl, tl);
    else throw new TranslateError("bad_provider", "مزوّد ترجمة غير معروف: " + chosen, chosen);
    res.forEach((v, k) => { out[idx[k]] = v; });
  };

  let failed = null;
  const worker = async () => {
    while (next < chunks.length && !failed) {
      const { items: chunk, offset } = chunks[next++];
      const idx = [];
      for (let k = 0; k < chunk.length; k++) idx.push(offset + k);
      try { await runOne(chunk, idx); }
      catch (e) { failed = failed || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  if (failed) throw failed;
  return { texts: out, provider: chosen };
}
