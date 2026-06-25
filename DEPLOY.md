# Deploy runbook — QA Signal dashboard (Phase 1)

Repo: `rafaelg-noa/QA-Dashboard` (private). Host: Cloudflare Pages + Access. Refresh: GitHub Actions cron.

The build is on `main`. The refresh workflow (`.github/workflows/refresh.yml`) is committed. The steps below are the **manual, UI-side wiring** — done by Kadok under the Novaeo identity (never EGDC).

## 1. GitHub Actions secrets (required before the workflow can run)
Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add both (paste values in the UI, never in chat/commits):
- `BASEROW_TOKEN` — the Baserow read token (database 138).
- `PMA_API_TOKEN` — the PMA headless key.

Then **Actions → refresh-data → Run workflow** to test. Confirm: green run, and a `data: scheduled snapshot refresh` commit authored `rafaelg-noa` appears on `main` (only if data changed).

## 2. Cloudflare Pages
> **Caveat (2026-06-24):** the live site is actually served from a **Worker** at `qa-dashboard.rafaelg-918.workers.dev`, not a Pages `*.pages.dev` domain. The Pages steps below describe the originally-intended host; reconcile this before relying on them. Access gating (§3) is wired to the Worker URL and works regardless.

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → authorize GitHub → pick `rafaelg-noa/QA-Dashboard`.
- **Framework preset:** None.
- **Build command:** *(leave empty)* — the repo is pre-built static; the generator runs in GitHub Actions, not here.
- **Build output directory:** `public`
- Deploy. Confirm the site serves `index.html`, `data.json`, and `shared/classify.js`.
- (No Cloudflare API token needed for Phase 1 — this is the dashboard GitHub integration. Pages auto-redeploys when `main` changes, including the 6-hourly `data.json` commits.)

## 3. Cloudflare Access + Google OAuth (gate the site)
The site is gated by **Cloudflare Access** with **Google OAuth** as the only login method — org-wide, self-service for any `@novaeo.com` Google Workspace account (no per-user list to maintain). Live since 2026-06-24.

Key facts:
- **Protected app:** the Worker at `qa-dashboard.rafaelg-918.workers.dev` (note: this is a Worker, not Pages — see the §2 caveat below).
- **Team domain:** `dawn-dawn-b0f2.cloudflareaccess.com`.
- **Google Cloud project:** `crafty-willow-500420-q6` (OAuth client "QA_Dashboard"). The Google **client secret lives only in Cloudflare** — it is never stored in this repo.

Setup steps (current Cloudflare One dashboard nav, June 2026):
1. **Google Cloud Console** (project above) → **APIs & Services → Credentials → Create OAuth client ID → Web application**. Set the consent screen **Audience = Internal** (this restricts logins to `@novaeo.com` Workspace accounts). Add:
   - **Authorized redirect URI:** `https://dawn-dawn-b0f2.cloudflareaccess.com/cdn-cgi/access/callback`
   - **Authorized JavaScript origin:** `https://dawn-dawn-b0f2.cloudflareaccess.com`
   - Copy the **Client ID** and **Client secret**.
2. **Cloudflare Zero Trust → Integrations → Identity providers → Add new identity provider → Google.** Paste **App ID** = Client ID, **Client secret** = secret → Save → **Test** (must come back green).
3. **Zero Trust → Access controls → Applications →** the QA-dashboard app → **Policies:** Allow → **Include: Emails ending in → `@novaeo.com`**. *(This policy is the real org-wide gate — the Internal consent screen is a second layer.)*
4. Same app → login methods: turn **off** "Accept all available identity providers", select **only Google**, turn **on** **"Apply instant authentication"** → users skip the Cloudflare login page and go straight to Google.
5. **Verify in incognito:** open the Worker URL → bounced straight to Google → dashboard loads. Confirm a non-`@novaeo.com` Google account is denied.

To revoke an individual: disable their Google Workspace account (Cloudflare honors it automatically). There is no allow-list in Cloudflare to edit.

## 4. Rotate the tokens (do this AFTER wiring works)
The `BASEROW_TOKEN` and `PMA_API_TOKEN` transited chat during development — rotate them:
1. Baserow: regenerate the token (read-only, scoped to db 138). PMA: regenerate the headless key.
2. Update both **Actions secrets** (step 1) with the new values.
3. Re-run **refresh-data** → confirm green on the new creds.
4. Confirm the old tokens are dead (an API call with the old Baserow token → 401).

## Known Phase-1 limitations (see `spike/NOTES.md` + the plan's "Spike outcomes")
- **Conversion is "n/a"** — PMA Sessions data is unavailable headlessly + its dataset windows are stale. To restore: refresh the PMA `Sessions` dataset window to current dates (and investigate the `sales_and_traffic_by_asin` timeout). Then conversion KPIs + the trend overlay light up with no code change.
- **WyldSkyn + Sirius show "No data"** — no current Economics rows (no recent sales). They populate automatically when sales resume.
- **4 Amazon→PMA tokens are expired/revoked** — re-auth via `pma_get_token_health_summary` to keep store coverage from eroding.

## Local regen (optional, for debugging)
From a clone with `BASEROW_TOKEN` + `PMA_API_TOKEN` in env (e.g. a gitignored `.env` + `node --env-file=.env`):
`npm ci && npm test && npm run build` → writes `public/data.json`. `npm run smoke` runs the Playwright frontend test (needs `npx playwright install chromium` once).
