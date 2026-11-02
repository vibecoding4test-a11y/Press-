/* =============================================================================
   Al-Marsad — safe outbound fetching
   -----------------------------------------------------------------------------
   Server-side fetching is what makes the app work where iframes cannot: the
   publisher's X-Frame-Options / CSP frame-ancestors headers never apply to a
   fetch performed by our own runtime.

   Runtime-agnostic: callers supply `resolveHost(host) => Promise<string[]>`
   (Node: dns.lookup, Deno: Deno.resolveDns). Used as an SSRF guard so the
   ingest endpoint cannot be turned into a probe of internal networks.
   ============================================================================= */

import { isBlockedHostname, parseTargetUrl } from "./extract.js";

export const DEFAULT_UA =
  "Mozilla/5.0 (compatible; AlMarsadBot/1.0; +https://github.com/vibecoding4test-a11y/Press-) AppleWebKit/537.36";

export class HttpError extends Error {
  constructor(code, message, status = 502) {
    super(message || code);
    this.name = "HttpError";
    this.code = code;
    this.status = status;
  }
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for loopback / private / link-local / CGNAT / multicast / reserved. */
export function isPrivateAddress(ip) {
  const raw = String(ip || "").trim().toLowerCase();
  if (!raw) return true;
  if (raw.includes(":")) {
    const v6 = raw.split("%")[0];
    if (v6 === "::1" || v6 === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;              // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;              // fe80::/10
    const mapped = v6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v6)) return true;
    return false;
  }
  if (!IPV4_RE.test(raw)) return false;
  const parts = raw.split(".").map(Number);
  const [a, b] = parts;
  if (parts.some((n) => n > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * Validate a URL and (optionally) its resolved addresses.
 * Throws HttpError("blocked_host"|"invalid_url"|...) when unsafe.
 */
export async function assertSafeUrl(input, { resolveHost, allowPrivate = false } = {}) {
  const parsed = parseTargetUrl(input, { allowPrivate });
  if (parsed.error) {
    throw new HttpError(parsed.error, parsed.error === "blocked_host"
      ? "هذا العنوان يشير إلى شبكة داخلية ولا يُسمح بجلبه."
      : "عنوان غير صالح — يجب أن يبدأ بـ http:// أو https://.", 400);
  }
  const u = parsed.url;
  if (allowPrivate) return u;
  if (isBlockedHostname(u.hostname)) throw new HttpError("blocked_host", "عنوان داخلي محجوب.", 400);
  if (typeof resolveHost === "function" && !IPV4_RE.test(u.hostname)) {
    let addrs = [];
    try { addrs = await resolveHost(u.hostname); } catch (e) {
      throw new HttpError("dns_failed", "تعذّر تحويل اسم النطاق: " + u.hostname, 400);
    }
    if (!addrs || !addrs.length) throw new HttpError("dns_failed", "لا عنوان DNS لهذا النطاق.", 400);
    if (addrs.some((a) => isPrivateAddress(a))) throw new HttpError("blocked_host", "النطاق يُحلّ إلى شبكة داخلية.", 400);
  }
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a URL and return text with hard limits.
 *
 * @returns {Promise<{status:number, finalUrl:string, text:string, contentType:string,
 *                    bytes:number, truncated:boolean, redirects:string[]}>}
 */
export async function fetchText(input, opts = {}) {
  const {
    timeoutMs = 15000,
    maxBytes = 2_500_000,
    maxRedirects = 4,
    userAgent = DEFAULT_UA,
    accept = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    acceptLanguage = "en,ar;q=0.8,*;q=0.5",
    resolveHost,
    allowPrivate = false,
    method = "GET",
    headers = {},
    body
  } = opts;

  let current = await assertSafeUrl(input, { resolveHost, allowPrivate });
  const redirects = [];

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current.href, {
        method,
        body,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": userAgent,
          accept,
          "accept-language": acceptLanguage,
          "cache-control": "no-cache",
          ...headers
        }
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") throw new HttpError("timeout", "انتهت مهلة الاتصال بالناشر.", 504);
      const err = new HttpError("fetch_failed",
        "تعذّر الوصول إلى الموقع — قد يكون محجوبًا عن الخادم أو غير متاح الآن.", 502);
      err.detail = e && e.message ? e.message : String(e);
      throw err;
    }

    const status = res.status;
    if (status >= 300 && status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get("location");
      if (!loc) throw new HttpError("bad_redirect", "إعادة توجيه بدون عنوان.", 502);
      if (hop === maxRedirects) throw new HttpError("too_many_redirects", "إعادات توجيه كثيرة.", 508);
      const next = new URL(loc, current);
      current = await assertSafeUrl(next.href, { resolveHost, allowPrivate });
      redirects.push(current.href);
      continue;
    }

    if (!res.ok) {
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch (e) { /* ignore */ }
      const code = status === 404 ? "not_found" : status === 401 || status === 403 ? "forbidden" : status === 429 ? "rate_limited" : "http_error";
      const msg = status === 404 ? "الصفحة غير موجودة (404)."
        : status === 401 || status === 403 ? "الناشر رفض الطلب أو يحجب الجلب الآلي (HTTP " + status + ")."
        : status === 429 ? "الناشر يحدّ من الطلبات الآن (429)."
        : "استجابة غير متوقعة من الناشر (HTTP " + status + ").";
      throw new HttpError(code, msg, status >= 500 ? 502 : 400);
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.body) {
      clearTimeout(timer);
      throw new HttpError("empty_body", "أعاد الناشر استجابة بلا محتوى.", 502);
    }
    let text = "";
    let bytes = 0;
    let truncated = false;

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          chunks.push(value.subarray(0, Math.max(0, value.byteLength - (bytes - maxBytes))));
          truncated = true;
          try { await reader.cancel(); } catch (e) { /* ignore */ }
          break;
        }
        chunks.push(value);
      }
      for (const c of chunks) text += decoder.decode(c, { stream: true });
      text += decoder.decode();
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") throw new HttpError("timeout", "انتهت مهلة قراءة الصفحة.", 504);
      throw new HttpError("read_failed", "تعذّرت قراءة استجابة الناشر.", 502);
    }
    clearTimeout(timer);

    // Some CDNs answer 200 with an empty body for bot traffic.
    if (!text.trim()) throw new HttpError("empty_body", "أعاد الناشر صفحة فارغة (يُرجّح أنه يحجب الجلب الآلي).", 502);

    return { status, finalUrl: current.href, text, contentType, bytes, truncated, redirects };
  }

  throw new HttpError("too_many_redirects", "إعادات توجيه كثيرة.", 508);
}

/** fetch + polite retry for transient failures (429/5xx/timeout). */
export async function fetchTextWithRetry(url, opts = {}) {
  const attempts = opts.attempts || 2;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchText(url, opts); }
    catch (e) {
      lastErr = e;
      const retryable = e && ["timeout", "rate_limited", "http_error", "fetch_failed"].includes(e.code);
      if (!retryable || i === attempts - 1) break;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

export { parseTargetUrl, isBlockedHostname };
