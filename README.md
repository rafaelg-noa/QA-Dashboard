# QA Signal — Novaeo Executive QA Dashboard

A read-only, C-level quality-awareness dashboard for Novaeo's Amazon marketplace stores. It answers one question at a glance: **is product quality getting better or worse, where is it bleeding, and what needs attention?** — using returns, refunds, and review-rating signals.

This is **Phase 1** (live). It covers *marketplace user-input QA* — what customers report via Amazon. A second section for in-house *Warehouse QA* (defects caught before the customer) is reserved as an inert placeholder in the UI and is not yet built. See [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Live access

- **URL:** `https://qa-dashboard.rafaelg-918.workers.dev/` (a Cloudflare Worker).
- **Login:** Google OAuth, organization-wide — any `@novaeo.com` Google Workspace account gets in automatically; everyone else is blocked. The login is gated by **Cloudflare Access** with auto-redirect (instant auth), so the flow is: open link → Google → dashboard. There is no allow-list to maintain; access follows Google Workspace account status. Setup and operations are documented in [`DEPLOY.md`](DEPLOY.md).

## How it works

A Node generator pulls live data, builds a single JSON snapshot, validates it, and writes it next to a static HTML page. The browser renders the snapshot and can recompute classifications live as thresholds are tuned — without re-fetching.

```
Baserow (review ratings) ─┐
                          ├─► generator/ ─► public/data.json ─► public/index.html
PMA (Amazon economics) ───┘   (fetch → aggregate → buildSnapshot → validate → write)   (live recompute via shared/classify.js)
```

- **`generator/index.js`** orchestrates: token guard → fetch Baserow + PMA → aggregate → `buildSnapshot` → `validate` → atomically write `public/data.json`. **It never writes a snapshot that fails validation**, so the last good `data.json` always survives a bad run.
- **`public/index.html`** is the whole frontend: a pinned verdict header + three tabs (Briefing / All Brands / Rankings, with a Brand|Store toggle) + a brand detail drawer + the inert Warehouse-QA placeholder. `computeBrands()` is the live client-side recompute that feeds every view.
- **`public/shared/classify.js`** holds the dual-use classification logic (used by both the build and the browser), so live threshold recompute matches build-time results.

Two invariants the data layer must never break:
1. **Ratio-of-sums** — every rate is `Σreturned / Σsold` over the group, never a mean of per-ASIN rates.
2. **Empty group → `nodata`** — a brand/store with no matching ASINs (or zero units sold) is forced to `health: "nodata"` with null KPIs.

## Repository layout

| Path | What |
|---|---|
| `generator/` | The build: `baserow.js`, `pma.js`, `build.js`, `schema.js`, orchestrated by `index.js` |
| `public/` | The deployed static site: `index.html`, `data.json` (generated), `shared/classify.js` |
| `config/stores.json` | Store → ASIN mapping and brand labels |
| `config/thresholds.json` | Classification thresholds + data windows (see below) |
| `test/` | Unit tests (`node --test`): baserow, pma, build, classify, schema |
| `tests-e2e/` | Playwright smoke test + a static server for local serving |
| `.github/workflows/refresh.yml` | Scheduled snapshot regeneration (every 12h) |
| `DEPLOY.md` | Deploy + auth runbook (Cloudflare, Google OAuth, secrets, token rotation) |
| `docs/BACKLOG.md` | Deferred work and Phase 2 |
| `docs/superpowers/archive/` | Superseded design specs + implementation plans (historical provenance) |

## Local development

Requires **Node ≥ 22**.

```bash
npm ci                  # install
npm test                # unit tests (node --test)
npm run smoke           # Playwright frontend smoke test (needs: npx playwright install chromium, once)
npm run build           # regenerate public/data.json — requires BASEROW_TOKEN + PMA_API_TOKEN in env
```

To regenerate the snapshot locally, supply both tokens (e.g. a gitignored `.env` + `node --env-file=.env generator/index.js`). The PMA pull takes several minutes.

To preview the UI without rebuilding data:

```bash
node tests-e2e/static-server.js 8091   # then open http://localhost:8091/
```

Validate a snapshot against the schema:

```bash
node --input-type=module -e "import {validate} from './generator/schema.js'; import {readFileSync} from 'fs'; console.log(validate(JSON.parse(readFileSync('public/data.json'))))"
```

## Data refresh

`.github/workflows/refresh.yml` runs every 12 hours (and on manual dispatch): it runs the unit tests as a gate, regenerates `public/data.json` from the live sources using the `BASEROW_TOKEN` / `PMA_API_TOKEN` Actions secrets, and commits the result only if the data changed. A failed or schema-invalid run writes nothing, preserving the last good snapshot.

## Configuration

`config/thresholds.json` drives classification and is the main tuning surface:

- **Classification:** `returnRate` / `returnRateWarn` (%), `refundSpike` (% jump), `ratingBad` / `ratingWarn` (stars), `ratingDrop` / `ratingRise` (star delta).
- **Windows:** `windowDays` (30), `refundBaselineDays` (30), `trendWeeks` (12), `pullDays` (91).

Most thresholds are also live-tunable in the dashboard's settings drawer, which recomputes classifications in-browser without a rebuild.

## Known limitations (Phase 1)

- **Conversion is `n/a`.** PMA Sessions data is unavailable in headless runs and its dataset windows are stale, so conversion KPIs stay null. Restoring it needs no code change once the PMA Sessions window is refreshed (tracked in [`docs/BACKLOG.md`](docs/BACKLOG.md)).
- **Some stores show "No data"** when there are no recent Amazon economics rows (no recent sales). They populate automatically when sales resume.
- **A few Amazon→PMA tokens are expired/revoked**, which erodes store coverage until re-authorized.

## Documentation map

- [`DEPLOY.md`](DEPLOY.md) — deploy + auth + secrets runbook (the operational source of truth).
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — deferred work and Phase 2 (Warehouse QA).
- [`docs/superpowers/archive/`](docs/superpowers/archive/) — the original design specs and implementation plans, retained as historical provenance. **Superseded** — do not use them as the source of truth for the current build.
