# Island Hills Land Corporation — Christmas Party & Annual Awards Night 2026 RSVP (Vercel + Neon)

"A Night in Paris" · Midnight Blue, Silver & Ice · **December 11, 2026**
Made by Love, Anne (@loveanne.ph) & Nexcellent Solutions.

| Page | URL |
|---|---|
| Guest RSVP | `/` |
| Admin dashboard | `/admin` (also `/?page=admin`) |
| Setup check | `/api/health` |

## Setup (one time)
1. **Database:** Vercel → this project → **Storage → Create Database → Neon**. Connect it to this project with the prefix **`DATABASE`** and tick Production and Preview. Leave "Create Database Branch For Deployment" unchecked.
2. **Redeploy:** Deployments → ⋯ → Redeploy.
3. Open `/api/health`. It should start with `"ok":true`. Tables are created automatically.

## Admin password
- Starts as the `ADMIN_PASSWORD` environment variable (or `admin123` if it's not set).
- Change it any time in the dashboard → **Settings**. The new one is stored hashed in the database and replaces the starting password. Changing it signs out other devices.
- **Forgot it?** In the Neon SQL Editor run `DELETE FROM settings WHERE key = 'admin_password_hash';` — sign-in goes back to `ADMIN_PASSWORD`.

## Fuzzy guest search
Ignores case, accents, punctuation, titles (Mr./Mrs./Dr./Engr./Atty.…), word order, middle names, merged surnames and small typos.
- Close but unsure → "Did you mean…?" names; the guest taps **This is me**.
- A first name alone never opens an invitation, it only suggests.
- Tune `FUZZY_ACCEPT` (0.84) in `lib/fuzzy.js` — higher means stricter.

## Files
- `public/index.html` — guest RSVP page (`logo.webp` = company logo, `title.webp` = event title)
- `public/admin.html` — admin dashboard (guest list, import/export, responses, RSVP on/off, password)
- `api/rpc.js` — single endpoint replacing `google.script.run`
- `lib/rsvp.js` — server logic ported from `Code.gs`
- `lib/fuzzy.js` — name matcher · `lib/auth.js` — admin sessions · `lib/db.js` — Neon client + auto schema
- `db/schema.sql` — table definitions (optional, for reference)
