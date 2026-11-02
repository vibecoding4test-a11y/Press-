/* =============================================================================
   Al-Marsad — cache layers
   -----------------------------------------------------------------------------
   L1: per-isolate memory (free, fast, disappears with the isolate).
   L2: Postgres via PostgREST (survives cold starts, shared across isolates).

   The pipeline only needs `{ get(key), set(key, value, ttlMs) }`, so any of
   these can be swapped for Redis/KV without touching the ingestion code.
   ============================================================================= */

import { createMemoryCache } from "./pipeline.js";

/**
 * PostgREST-backed cache. Requires the `ingest_cache` table (see
 * supabase/schema.sql) and a service-role key. Failures are swallowed: a cache
 * outage must never break ingestion.
 */
export function createPostgrestCache({ url, serviceKey, table = "ingest_cache", timeoutMs = 4000 }) {
  if (!url || !serviceKey) return null;
  const base = String(url).replace(/\/+$/, "");
  const headers = {
    apikey: serviceKey,
    authorization: "Bearer " + serviceKey,
    "content-type": "application/json"
  };

  const withTimeout = async (fn) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fn(controller.signal); } finally { clearTimeout(timer); }
  };

  return {
    async get(key) {
      try {
        return await withTimeout(async (signal) => {
          const res = await fetch(
            `${base}/rest/v1/${table}?select=payload,expires_at&key=eq.${encodeURIComponent(key)}&limit=1`,
            { headers, signal }
          );
          if (!res.ok) return null;
          const rows = await res.json();
          if (!Array.isArray(rows) || !rows.length) return null;
          const row = rows[0];
          if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
          return row.payload || null;
        });
      } catch (e) { return null; }
    },
    async set(key, value, ttlMs = 600000) {
      try {
        await withTimeout(async (signal) => {
          await fetch(`${base}/rest/v1/${table}?on_conflict=key`, {
            method: "POST",
            headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              key,
              payload: value,
              expires_at: new Date(Date.now() + ttlMs).toISOString()
            }),
            signal
          });
        });
      } catch (e) { /* cache writes are best-effort */ }
    }
  };
}

/** Memory in front of Postgres: reads hit memory first, writes go to both. */
export function createLayeredCache(layers, limit = 150) {
  const memory = createMemoryCache(limit);
  const db = layers.filter(Boolean);
  return {
    async get(key) {
      const hit = await memory.get(key);
      if (hit) return hit;
      for (const layer of db) {
        const value = await layer.get(key).catch(() => null);
        if (value) {
          await memory.set(key, value, 60_000).catch(() => null);
          return value;
        }
      }
      return null;
    },
    async set(key, value, ttlMs) {
      await memory.set(key, value, ttlMs).catch(() => null);
      for (const layer of db) await layer.set(key, value, ttlMs).catch(() => null);
    }
  };
}
