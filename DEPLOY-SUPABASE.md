# Publishing Al-Marsad with Supabase — checklist

Goal: the app lives on GitHub Pages, and the **ingest function** runs on Supabase.
Your project: **Ya-Khabr** → ref `lvueoclwctzmoiqoqdrn`.

```
Browser (GitHub Pages)  ──▶  Supabase Edge Function  ──▶  publisher websites
   static files                ingest?op=article             (extraction)
                               ingest?op=translate           (translation)
```

Work in the folder that contains `package.json` and the `supabase/` folder, in **PowerShell**.

---

## 1 · Database cache (optional, 2 min — recommended)

- [ ] Supabase dashboard → **SQL Editor** → **New query**
- [ ] Paste the whole of `supabase/schema.sql` → **Run** → “Success. No rows returned”
- [ ] Table `ingest_cache` now exists (Table Editor)

Skipping this still works — you just lose caching between cold starts.

## 2 · Install + log in to the Supabase CLI

No global install needed (`npx` fetches it per command):

```powershell
npx supabase --version
npx supabase login          # opens the browser → Authorise → token pasted back automatically
```

- [ ] `supabase --version` prints a version
- [ ] `supabase login` says “Logged in”

## 3 · Link this folder to the project

```powershell
npx supabase link --project-ref lvueoclwctzmoiqoqdrn
```

If it asks for a **database password**: Project Settings → Database → *Database password*
(or leave blank — it is only needed for `db push`/migrations, which we don’t use).

- [ ] “Finished supabase link”

## 4 · Deploy the function

```powershell
npx supabase functions deploy ingest --no-verify-jwt
```

- `--no-verify-jwt` is required: the static page has no user session.
  (`supabase/config.toml` already sets `verify_jwt = false`; the flag makes it explicit.)

- [ ] Output ends with `Deployed Functions on project lvueoclwctzmoiqoqdrn: ingest`

Your endpoint is now:

```
https://lvueoclwctzmoiqoqdrn.supabase.co/functions/v1/ingest
```

## 5 · Set the secrets

```powershell
npx supabase secrets set ALLOWED_ORIGINS="https://vibecoding4test-a11y.github.io,http://localhost:3000"
```

Optional but strongly recommended (reliable translation, no rate-limit surprises):

```powershell
npx supabase secrets set GOOGLE_TRANSLATE_API_KEY=your_key_here
```

| Secret | Needed? | Value |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | **yes** | exact origins, comma-separated, **no path, no trailing slash** |
| `GOOGLE_TRANSLATE_API_KEY` | recommended | Cloud Translation v2 key |
| `DEEPL_API_KEY` | alternative | DeepL key |
| `TRANSLATE_PROVIDER` | optional | `auto` (default) / `google` / `deepl` / `free` / `none` |

- [ ] `npx supabase secrets list` shows them

## 6 · Test the function before touching the website

Open in the browser:

```
https://lvueoclwctzmoiqoqdrn.supabase.co/functions/v1/ingest?op=health
```

- [ ] JSON with `"ok":true`, `"service":"al-marsad-ingest"`, `"runtime":"edge"`
- [ ] Then an article, still in the browser or with curl:

```powershell
curl.exe -s "https://lvueoclwctzmoiqoqdrn.supabase.co/functions/v1/ingest?op=article&url=https%3A%2F%2Fwww.bbc.com%2Fnews" | more
```

- [ ] Returns `kind:"article"` (or `kind:"feed"` for a homepage)

## 7 · Point the app at the function

Pick one:

**A. Quick test (this browser only)**
- [ ] `npm start` → open http://localhost:3000 → **⚙** → paste the function URL → **حفظ وإعادة الفحص**
- [ ] Badge switches to **«Supabase Edge يعمل»**

**B. Permanent (every visitor)** — edit `assets/config.js`:

```js
window.AL_MARSAD_CONFIG = {
  apiBase: "",
  supabaseFunction: "https://lvueoclwctzmoiqoqdrn.supabase.co/functions/v1/ingest",
  autoTranslate: true
};
```

- [ ] Committed and pushed

## 8 · Publish the static site

GitHub → your repo → **Settings → Pages** → *Build and deployment* → Source: **Deploy from a branch**

- Branch: `arena/871390a2-press`  (or `main`, once the work is merged)
- Folder: `/ (root)` → **Save**

- [ ] After ~1 min the site is at `https://vibecoding4test-a11y.github.io/Press-/`

⚠️ The Pages **origin** is `https://vibecoding4test-a11y.github.io` (no `/Press-/`). That exact string
must be in `ALLOWED_ORIGINS`, otherwise the browser blocks the requests.

## 9 · Final verification on the live site

- [ ] Badge (top-right) says **«Supabase Edge يعمل»**
- [ ] Paste a real article URL → headline, date, paragraphs render
- [ ] Right pane fills with Arabic; progress bar runs to `n / n`
- [ ] **«اقرأ عند المصدر ↗»** opens the publisher
- [ ] F12 → Console: no CORS / 401 errors
- [ ] Mobile width: tabs **«الخبر/الترجمة»** work

## 10 · Optional polish

- [ ] `supabase secrets set MAX_BLOCKS=120 FETCH_TIMEOUT_MS=15000` (defaults are fine)
- [ ] Custom domain on Pages → add it to `ALLOWED_ORIGINS` too
- [ ] Watch usage: dashboard → **Edge Functions → ingest → Logs** (each request logs one line)
- [ ] `select public.purge_expired_ingest_cache();` occasionally, or schedule with pg_cron

---

## Troubleshooting

| What you see | Cause | Fix |
| --- | --- | --- |
| `401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}` | JWT verification still on | redeploy with `--no-verify-jwt`, or dashboard → function → disable *Verify JWT* |
| Browser console: *blocked by CORS policy* | origin not allowed | `ALLOWED_ORIGINS` must match the page origin exactly (scheme + host, no path, no slash) |
| `404` on the function URL | wrong URL shape | must end with `/functions/v1/ingest` |
| `permission denied for table ingest_cache` | `schema.sql` not run | run step 1 (or ignore — the function falls back to memory) |
| Response `{"ok":false,"code":"forbidden"}` | publisher blocks datacenter IPs | try another source; some outlets (Cloudflare-heavy) block cloud IPs |
| Translation stops mid-article | keyless provider quota | set `GOOGLE_TRANSLATE_API_KEY` |
| Site loads but badge says «بلا خادم» | `supabaseFunction` empty / stale ⚙ value | set it in `assets/config.js` or clear the ⚙ value and re-enter |
| Function times out on big pages | very large/JS-heavy page | `thin` content is expected; the app links to the source |

**Never** put the service-role key or provider keys in `assets/config.js` — they belong to
`supabase secrets set` / `.env` only.
