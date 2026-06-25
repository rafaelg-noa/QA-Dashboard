# Backlog

Deferred work for the QA Signal dashboard, captured when Phase 1 shipped (2026-06-24). Items are grouped by type, not strictly prioritized. Source references point to the archived specs/plans in [`superpowers/archive/`](superpowers/archive/).

## Phase 2 — in-house Warehouse QA (the reserved direction)

The dashboard is designed as one quality funnel; Phase 1 built the *marketplace user-input* half (what customers report via Amazon). Phase 2 is the *Warehouse QA* half — defects caught **before** the customer ships. The UI already reserves the seam: an inert, labeled placeholder marks where it lands, so it can slot in without restructuring.

- **Not yet specced or planned.** First step is a brainstorm → spec → plan cycle of its own.
- Needs a data source for in-house inspection/defect data (none wired today).

## Phase 2+ candidates — deeper marketplace data

From the original live-data spec's "Phase 2" list (archived `2026-06-23-qa-dashboard-live-data-design.md`, §13). These were descoped from Phase 1; revisit if marketplace depth is prioritized over Warehouse QA:

- **Amazon SP-API direct** (≥2 authorized stores): FBA return **reason codes**, Customer Feedback **themes / sentiment**.
- **Triage pipeline**: classify → investigate → resolve, with persisted workflow state. (Note: Phase 1 is deliberately *read-only awareness* — adding workflow is a significant scope shift.)
- **True on-demand refresh**: Worker → `repository_dispatch` → Action → poll, instead of cron-only.
- **Multi-channel expansion**: Walmart / eBay / TikTok alongside Amazon.

## Tech debt & polish

- **`ratingRise` not in the settings drawer.** Only 6 of the 7 classification thresholds are live-tunable in the UI; `ratingRise` is missing. Surface it for parity.
- **Duplicated sort logic.** The worst-first sort comparator and `HEALTH_RANK` are duplicated across `generator/build.js` and `public/index.html`. Dedupe into a shared module (candidate: `public/shared/classify.js`).
- **`DEPLOY.md` §2 — Pages vs Worker.** The deploy runbook still describes a Cloudflare **Pages** host in §2 (with a caveat), but the live site is a **Worker** (`qa-dashboard.rafaelg-918.workers.dev`). Reconcile §2 to the actual Worker deploy pipeline once it's confirmed. `.github/workflows/refresh.yml`'s comment ("Cloudflare Pages watches main") has the same drift.
- **Extract spike findings, then retire `spike/NOTES.md`.** A few hard-won facts (why the generator uses `pma_query_custom` rather than the dataset API; the PMA Sessions timeout root cause) live only in `spike/NOTES.md`. Migrate them into a comment in `generator/pma.js`, then delete the spike. (Deferred — `spike/NOTES.md` is currently left in place.)

## Data & ops health

- **Restore conversion KPIs.** Conversion is `n/a` because PMA Sessions data is unavailable headlessly and its dataset windows are stale. Refresh the PMA `Sessions` dataset window to current dates and investigate the `sales_and_traffic_by_asin` timeout. Once Sessions returns, conversion KPIs + the trend overlay light up **with no code change**.
- **Re-authorize expired Amazon→PMA tokens.** A handful of Amazon→PMA tokens are expired/revoked, eroding store coverage. Re-auth via `pma_get_token_health_summary`. Recurs over time — worth a periodic check.
- **Stores showing "No data"** (e.g. WyldSkyn, Sirius) have no recent Amazon economics rows. They populate automatically when sales resume; no action unless coverage is expected.
