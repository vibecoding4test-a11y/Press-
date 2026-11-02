/* =============================================================================
   Al-Marsad — runtime configuration
   -----------------------------------------------------------------------------
   Leave `apiBase` empty when the app is served by server/server.mjs (or your own
   reverse proxy that exposes /api). When the frontend is hosted statically
   (GitHub Pages, Netlify, Vercel…) point it at the deployed ingestion function:

     supabaseFunction: "https://<project-ref>.supabase.co/functions/v1/ingest"

   Both values can also be set at runtime from the ⚙ settings dialog, which
   stores the choice in localStorage.
   ============================================================================= */
window.AL_MARSAD_CONFIG = {
  apiBase: "",
  supabaseFunction: "",
  autoTranslate: true,
  maxBlocks: 120,
  requestTimeoutMs: 30000,
  version: "1.1.0"
};
