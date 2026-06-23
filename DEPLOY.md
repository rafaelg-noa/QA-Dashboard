# Deploy runbook — QA Signal dashboard (Phase 1)

Repo: `rafaelg-noa/QA-Dashboard` (private). Host: Cloudflare Pages + Access. Refresh: GitHub Actions cron.

The build is on `main`. The refresh workflow (`.github/workflows/refresh.yml`) is committed. The steps below are the **manual, UI-side wiring** — done by Kadok under the Novaeo identity (never EGDC).

## 1. GitHub Actions secrets (required before the workflow can run)
Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add both (paste values in the UI, never in chat/commits):
- `BASEROW_TOKEN` — the Baserow read token (database 138).
- `PMA_API_TOKEN` — the PMA headless key.

Then **Actions → refresh-data → Run workflow** to test. Confirm: green run, and a `data: scheduled snapshot refresh` commit authored `rafaelg-noa` appears on `main` (only if data changed).

## 2. Cloudflare Pages
Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → authorize GitHub → pick `rafaelg-noa/QA-Dashboard`.
- **Framework preset:** None.
- **Build command:** *(leave empty)* — the repo is pre-built static; the generator runs in GitHub Actions, not here.
- **Build output directory:** `public`
- Deploy. Confirm the site serves `index.html`, `data.json`, and `shared/classify.js`.
- (No Cloudflare API token needed for Phase 1 — this is the dashboard GitHub integration. Pages auto-redeploys when `main` changes, including the 6-hourly `data.json` commits.)

## 3. Cloudflare Access (gate the site)
Cloudflare **Zero Trust → Access → Applications → Add an application → Self-hosted**:
- Application domain = the Pages domain (e.g. `qa-dashboard.pages.dev` or a custom domain).
- **Policy:** Allow → Emails / Emails ending in → the allowed Novaeo team addresses.
- Save. Verify from an allowed account (SSO prompt → dashboard loads) **and** that an unlisted email is denied.

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
