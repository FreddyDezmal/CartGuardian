# Deploying CartGuardian (GitHub → Supabase → Vercel)

One Vercel project serves both the React app (static files) and the API (one Vercel Function at `/api/*`). Same domain, so no cross-origin setup. Supabase holds evaluations and orders, which serverless needs: the request that creates a PayPal order and the one that captures it can run on different instances.

Do the parts in order. Each ends with a check. Don't move on until it passes.

---

## Part 1 · Database: Supabase (≈10 min)

1. Sign in at **supabase.com** → **New project**.
   - Name: `cartguardian`. Set a database password and store it in your password manager (the app doesn't need it).
   - Region: **East US (North Virginia)**, close to Vercel's default function region (Washington, D.C.), so every API call to the database is short.
2. When the project is ready: **SQL Editor → New query**. Paste the whole of `supabase/schema.sql` and click **Run**. Expect "Success. No rows returned". Re-running it is safe.
3. **Settings → API Keys**. Copy:
   - the **Project URL** (`https://<project-ref>.supabase.co`, also shown in the **Connect** dialog)
   - a **Secret key** (`sb_secret_...`; create one if the list is empty). **Not** the publishable key.
4. Add both to `apps\server\.env` (never commit this file, never paste the key into chat):
   ```
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   ```
5. Check:
   ```powershell
   npm install
   npm run db:check -w @cartguardian/server
   ```
   Expect three ✓ lines ending in `Database ready`.
6. Restart `npm run dev:server`. The banner shows `Database    : Supabase (https://...)`.
7. **Restart test** (the reason we added a database): run a trial, click PayPal, and **while the popup is open, stop and restart the API**. Then approve in the popup. The purchase should still complete. Before Supabase it failed with "order not found".
8. In Supabase **Table Editor**, `orders` shows your order with status `COMPLETED`.

## Part 2 · Code: public GitHub repo (≈10 min)

Devpost requires a **public** repo with a visible open-source licence.

1. Before anything goes public:
   ```powershell
   git status
   git check-ignore -v apps/server/.env apps/web/.env
   ```
   `check-ignore` must print a `.gitignore` line for **both** files. If either `.env` appears under "Changes" in `git status`, stop.
2. Look through `docs\Prompts` (the folder you added): it will be public. Remove anything you don't want published.
3. Commit:
   ```powershell
   git add -A
   git commit -m "Supabase store, Vercel deployment"
   ```
4. On github.com: **New repository** → name `cartguardian` → **Public** → do **not** add a README, .gitignore or licence (the repo has them) → Create.
5. Push (replace `<you>`):
   ```powershell
   git branch -M main
   git remote add origin https://github.com/<you>/cartguardian.git
   git push -u origin main
   ```
6. Check: the repo page shows the README, and the **About** sidebar shows **MIT license**. If it doesn't, click the gear next to About and confirm the licence is detected.

## Part 3 · Hosting: Vercel (≈15 min)

1. Sign in at **vercel.com** with GitHub → **Add New… → Project** → import `cartguardian`.
2. On the configure screen:
   - **Root Directory:** leave as the repo root (`./`).
   - **Framework Preset:** Other. Build settings come from `vercel.json`, so leave the overrides off.
3. Open **Environment Variables** and add these (Production and Preview):

   | Name | Value |
   |---|---|
   | `AI_PROVIDER` | `gemini` |
   | `GEMINI_API_KEY` | your key |
   | `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
   | `GEMINI_FALLBACK_MODELS` | `gemini-3.1-flash-lite,gemini-3.5-flash` |
   | `PAYPAL_CLIENT_ID` | Sandbox client ID |
   | `PAYPAL_CLIENT_SECRET` | Sandbox secret |
   | `SUPABASE_URL` | from Part 1 |
   | `SUPABASE_SECRET_KEY` | from Part 1 |
   | `TRUST_PROXY` | `1` |
   | `NODEJS_HELPERS` | `0` |
   | `WEB_ORIGIN` | leave out for now (set in step 5) |

4. **Deploy.** The first build takes a couple of minutes.
5. Copy the production URL (e.g. `https://cartguardian-xyz.vercel.app`, shown under **Domains**). Add it as `WEB_ORIGIN` (no trailing slash), then **Deployments → ⋯ → Redeploy**. Environment variables only apply to new deployments.
6. Checks, in order:
   - `https://<your-url>/api/health` → JSON with `"store":"supabase"`, `"paypal":{"configured":true}` and your Gemini model.
   - Open `https://<your-url>`. Both header pills show the real setup.
   - Run a trial, then complete a Sandbox purchase with the **Personal** sandbox account. You should get the green receipt.
   - The order appears in Supabase **Table Editor → orders** as `COMPLETED`.

## If something fails

| Symptom | Cause | Fix |
|---|---|---|
| Build fails at `npm ci` | `package-lock.json` out of date | Run `npm install` locally, commit the lockfile, push |
| `/api/health` returns 500; **Logs** shows "Running on Vercel without a database" | Supabase variables missing | Add `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, redeploy |
| App loads but every action says **"Origin … is not allowed"** (403) | `WEB_ORIGIN` missing or not the exact URL in the address bar | Set it to the URL exactly (https, no trailing slash), redeploy. Preview URLs differ from production: test on the production URL |
| `/api/...` returns `{"error":{"code":"NOT_FOUND"...}}` for valid routes | Rewritten path not restored | Check **Logs**; send me the request URL it shows |
| Trial fails with `AI_RATE_LIMITED` / `AI_TIMEOUT` | Gemini free-tier load or quota | Retry; check the model chain with `npm run ai:check -- probe` locally |
| PayPal button missing | `PAYPAL_CLIENT_ID` not set, or set after the build | Set it, redeploy |
| Capture fails after approving | Approved with the Business account, or PayPal returned an error | Use the Sandbox **Personal** account; the error shows a PayPal debug ID |

The Vercel **Logs** tab shows every server error with the same messages you'd see in your terminal locally.

## What runs where

```
Browser ── https://<app>.vercel.app ──┬── /            → static React build (apps/web/dist)
                                      └── /api/*       → Vercel Function api/index.mjs
                                                           = Express app bundled from apps/server (dist/vercel.mjs)
                                                           ├── Gemini (AI)
                                                           ├── PayPal Sandbox (Orders v2)
                                                           └── Supabase Postgres (evaluations, orders, capture lock)
```
