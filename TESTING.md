# Testing Al-Marsad — a simple checklist

> **Short on time?** Do sections **0 → 2 → 4**. That covers the whole idea: a news URL goes to the
> server, comes back as clean text, and gets translated.

Legend: ✅ = pass, ❌ = file a note. The app UI is Arabic; Arabic labels are quoted.

---

## Where do I type these commands?

Everything in this file is typed into a **terminal** (a.k.a. command line) — never into the website
and never into an HTML/JS file.

| Your computer | Open this | Get into the project folder |
| --- | --- | --- |
| macOS | **Terminal** (⌘ + Space, type “Terminal”) | `cd ~/Projects/Press-` |
| Windows | **PowerShell** or Windows Terminal | `cd C:\Users\<you>\Projects\Press-` |
| Linux | your terminal | `cd ~/Press-` |
| VS Code | **Terminal → New Terminal** | already opens in the folder ✔ |

First time on your machine:

```bash
git clone https://github.com/vibecoding4test-a11y/Press-.git
cd Press-
git checkout arena/871390a2-press
npm start                                   # keep this window open; Ctrl+C stops it
```

Then, in a **second** terminal window (same folder):
`npm test`, the `curl` lines, etc.

What goes where:

- `node -v`, `npm start`, `npm test`, `git …`, `curl …` → **terminal**
- `http://localhost:3000` → **browser address bar**
- Nothing on this list needs you to edit a file. (Configuration is optional: copy `.env.example`
  to `.env` only if you want to add translation keys.)

---

## 0. Setup (2 minutes)

- [ ] Node 18.17+ installed → `node -v`
- [ ] In the project folder: `npm start`
- [ ] Open <http://localhost:3000>
- [ ] Top-right badge says **«الخادم المحلي يعمل»** (green dot)

**No internet?** Use the bundled fake publisher instead:

```bash
npm run fixtures                  # terminal 1 → fake news site on :8899
ALLOW_PRIVATE_HOSTS=1 npm start   # terminal 2 → app on :3000
```

Then paste `http://127.0.0.1:8899/` where a real link is used below.

---

## 1. Interface basics (no network needed)

- [ ] Sidebar shows many publishers (≈223 with the **«مجانية»** filter on)
- [ ] Search typing `bbc` or `فرنسا` filters the list instantly
- [ ] Filter **«كل المصادر»** → count becomes 289
- [ ] Click a publisher's ☆ → reload the page → it is still starred, and **«★ مفضلتي»** shows it
- [ ] ☾ button switches dark/light; the choice survives a reload
- [ ] Drag the vertical dividers; double-click resets the width
- [ ] **?** button opens the help dialog; **Esc** closes it
- [ ] Press `/` → focus jumps to search; press `Esc`

## 2. Paste a news link (the core path)

Use a real article, e.g. `https://www.bbc.com/news` → open any article → copy its URL.

- [ ] Paste the article URL in the bar at the top → press **«استخرج»**
- [ ] Within a few seconds you get: headline, source, language, date, word count
- [ ] Images (hero) load; body paragraphs are readable, no menus/ads/“share” junk
- [ ] Title appears **once** (not repeated as the first paragraph)
- [ ] **«اقرأ عند المصدر ↗»** opens the original article in a new tab
- [ ] Browser URL gained `?url=…` → copy it into a new tab → the same article reopens
- [ ] **F12 → Elements →** search for `iframe` → **none**. (This is the whole point: no frame.)

Try 2–3 publishers in different languages (e.g. Le Monde, Der Spiegel, Al Jazeera English) — the
reader should adapt LTR/RTL automatically.

## 3. Publisher → headlines → article

- [ ] Click a publisher in the sidebar → a list of its latest headlines appears (RSS)
- [ ] Each card shows title, time, and often a thumbnail
- [ ] Click a headline → the full article opens inside Al-Marsad
- [ ] **←** (back button) returns to the headline list
- [ ] Refresh icon re-fetches from the server (bypasses cache)

## 4. Translation

- [ ] Open a non-Arabic article → the right pane fills with Arabic paragraphs automatically
- [ ] A progress bar appears while translating (`n / n`), then the Arabic headline + paragraphs
- [ ] **«نص أصلي»** (b / the split icon) shows the original text under each paragraph; press again to hide
- [ ] **أ+ / أ-** change the Arabic font size
- [ ] Copy icon → toast **«نُسخ النص ✓»** → paste somewhere and check paragraphs + source URL
- [ ] Print icon → only the Arabic translation is printed (no sidebar/toolbars)
- [ ] Open an Arabic source (e.g. **الجزيرة نت**) → pane says **«المصدر عربي»**, no machine translation
- [ ] Open a paywalled article → an amber banner **«جزء مدفوع»** and the text stops where the wall starts

## 5. Error handling (should never be silent)

- [ ] Type `nonsense` in the URL bar → clear Arabic error, not a blank screen
- [ ] Blocked/bot-protected site (e.g. a Cloudflare-protected page) → message + **«فتح عند الناشر»**
- [ ] Stop the server (`Ctrl+C`) → reload → badge says **«بلا خادم — وضع محدود»**
- [ ] A JavaScript-only page → notice **«استُخرج نص محدود»** + link to the source
- [ ] Settings ⚙ → paste a wrong function URL → **حفظ وإعادة الفحص** → “not found” message, no crash

## 6. API + automated tests (copy-paste)

```bash
npm test                                          # → 19 pass, 0 fail

curl -s localhost:3000/api/health | head -c 120    # → ok:true, service al-marsad-ingest
curl -s "localhost:3000/api/article?url=https%3A%2F%2Fwww.bbc.com%2Fnews" | head -c 200
curl -s "localhost:3000/api/feed?url=https%3A%2F%2Fwww.france24.com%2Fen%2F" | head -c 200

# security guards:
curl -s -o /dev/null -w "%{http_code}\n" "localhost:3000/api/article?url=http%3A%2F%2F169.254.169.254%2F"   # → 400
curl -s -o /dev/null -w "%{http_code}\n" "localhost:3000/../.env"                                            # → 403
```

- [ ] `npm test` → 19 passing
- [ ] `/api/health` returns JSON
- [ ] Internal-IP request is refused with 400
- [ ] `.env` / traversal is refused with 403

## 7. Mobile & print

- [ ] Narrow the window below ~980px → two bottom tabs **«الخبر» / «الترجمة»**
- [ ] ☰ opens the publisher drawer; tapping outside closes it
- [ ] The URL bar and buttons stay inside the screen
- [ ] Print preview (Ctrl/Cmd+P) shows the Arabic article only

## 8. Deployment check (optional — only before publishing)

- [ ] `supabase/schema.sql` run in the SQL editor (creates `ingest_cache`)
- [ ] `supabase functions deploy ingest --no-verify-jwt`
- [ ] `supabase secrets set ALLOWED_ORIGINS="https://<you>.github.io"`
- [ ] Function works: open `https://<ref>.supabase.co/functions/v1/ingest?op=health`
- [ ] In ⚙ paste that function URL → badge switches to **«Supabase Edge يعمل»**
- [ ] Open the GitHub Pages site → paste a link → article + translation work

---

### If something fails

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Badge “بلا خادم” | app not served by `server.mjs` | `npm start`, or set the function URL in ⚙ |
| “تعذّر الوصول إلى الموقع” | publisher blocks bots / network | try another source; check the source link |
| “استُخرج نص محدود” | JS-rendered article | expected — use “فتح عند الناشر” |
| Translation stops mid-way | keyless provider rate limit | set `GOOGLE_TRANSLATE_API_KEY` in `.env` |
| Headline list empty | no RSS on that site | app falls back to homepage links (`via: links`) |

Report ❌ items with: the URL you used, the visible Arabic message, and the `code:` line shown at the
bottom of the error card.
