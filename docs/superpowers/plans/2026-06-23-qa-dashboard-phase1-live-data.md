# QA Dashboard — Phase 1 Live Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the static `qa-dashboard.html` prototype online with live Amazon-store quality data for Novaeo, generated on a cron and served behind Cloudflare Access.

**Architecture:** A full-Node generator runs in GitHub Actions (cron ~6h), pulls Baserow (ratings) + PMA (returns/refunds/conversion), joins on ASIN, groups by store, computes the §6 metrics, classifies with config defaults, validates against a JSON schema, and commits `public/data.json`. Cloudflare Pages serves the static dashboard, which `fetch()`es only `data.json` and re-classifies client-side when the user tunes thresholds. No secret ever reaches the browser.

**Tech Stack:** Node 22 (ESM, `node --test`, global `fetch` — no transpiler/bundler), `@modelcontextprotocol/sdk` (PMA MCP client), `ajv` (snapshot schema), `@playwright/test` (frontend smoke only). Vanilla HTML/CSS/ES-module frontend (no framework, no build step). GitHub Actions + Cloudflare Pages/Access.

**Source spec:** `docs/superpowers/specs/2026-06-23-qa-dashboard-live-data-design.md` (approved). Every metric, threshold, and contract in this plan traces to a spec section — cited inline as `§N`.

---

## Spike outcomes (2026-06-23) — BINDING deltas to the spec/plan

Spikes A+B ran and de-risked the build. Full evidence in `spike/NOTES.md` (committed). These corrections **override** the spec where they conflict and are mandatory for the build tasks:

1. **PMA pull path corrected.** The returns/refunds data is NOT reachable via the dataset tools (`pma_get_dataset_data`/`pma_get_data_table_data` fail/timeout headlessly). The working headless path is **`pma_query_custom(connector_type:'amazonmws', report_type:'economics', dimensions:['account_id','asin','date'], metrics:[…≤10])`**, paginated (`limit:100`,`offset`), paced ~2.2s/call (<30 req/min). Transport = `StreamableHTTPClientTransport` to `https://pma-mcp.web.app/` + `Authorization: Bearer`. (Affects Tasks 6, 9.)
2. **Conversion (Sessions) is UNAVAILABLE in Phase 1.** `sales_and_traffic_by_asin` times out headlessly; dataset windows are stale. `unitSessionPercentage` cannot be pulled. → **Conversion degrades to "n/a": no conversion KPI value, no trend conversion overlay.** Build + frontend must treat conversion as optional/null and never crash. Recoverable later when Kadok fixes the Sessions dataset. (Affects Tasks 6, 7, 11, 12, 13.) Spec §1's "~70%" shrinks slightly; returns/refunds/ratings remain fully live.
3. **`account_id` is BARE** in economics rows (`A8YCR05DHF8XC`); `config/stores.json` `accountId` is stored bare to match — join directly, no prefix-stripping. (Task 6/7.)
4. **Economics metric values arrive as STRINGS** (`"132"`,`"53.54"`) → coerce with `Number()` before arithmetic. (Task 6.)
5. **Baserow field shapes are nested:** `Brand` = linked-record array `[{value:{value:"Name"}}]`; `Amazon Listing Status` / `Inventory Health` = single-select `{value:"Active"}`. `normalizeBaserow` must extract `.value.value` / `.value` (see `extractValue` in NOTES). The committed fixture preserves these shapes. (Task 5.)
6. **2 of 9 stores (WyldSkyn, Sirius) have no current Economics data**; StandMore is barely active (5 units). Build + frontend must render a store with no data as "no data", not crash. Portfolio rollups must skip empty stores cleanly. (Tasks 7, 11, 12.)
7. **History ≥12 weeks confirmed** → 12-week return-rate trend is feasible (no degrade needed for the return-rate series; only the conversion overlay is absent).
8. **Inputs already produced by the spikes (reuse, don't rebuild):** `config/stores.json` (9 stores), `test/fixtures/pma-economics.sample.json` (203 real rows, ~12wk), `test/fixtures/baserow-691.sample.json` (20 rows), `spike/asin-universe.json` (gitignored, 46 ASINs).

**Open items for Kadok (PMA-side, non-blocking):** (a) restore the Sessions dataset window / investigate the `sales_and_traffic_by_asin` timeout to bring conversion back; (b) re-auth the **4 Amazon→PMA accounts with expired/revoked tokens** (`pma_get_token_health_summary`) before coverage erodes.

---

## Identity guardrails (read before every commit)

This repo is **Novaeo-isolated**. The whole project is void if it touches EGDC identity.

- Local git identity is `rafaelg-noa` / `rafaelg-noa@users.noreply.github.com`. **Verify before each commit:** `git -C . log -1 --format='%an <%ae>'` must never show EGDC. If a commit lands as EGDC, `git commit --amend --reset-author` after fixing `git config user.name/email` locally.
- Never use the workspace-global `gh` / `GH_TOKEN` (those are EGDC). The remote uses a dedicated fine-grained PAT (see Prerequisites).
- Credentials (`BASEROW_TOKEN`, `PMA_API_TOKEN`) live in env vars locally and GitHub Actions secrets in CI. **Never** commit them, never echo them into a file under git, never put them in `data.json`.

## Prerequisites & blockers

These gate specific tasks; the local build (Tasks 0–13) does **not** wait on them.

| Item | Owner | Blocks | Status |
|---|---|---|---|
| `BASEROW_TOKEN` available as env var locally | Kadok (have it) | Spike A, Task 6 live run | ready |
| `PMA_API_TOKEN` (headless key) as env var locally | Kadok (have it) | Spike B, Task 7 live run | ready |
| Fine-grained PAT for `rafaelg-noa/QA-Dashboard` (Contents RW + Workflows RW), remote wired | Kadok | Tasks 15–16 (CI, deploy) | **open** |
| GitHub repo `rafaelg-noa/QA-Dashboard` created | Kadok | Tasks 15–16 | **open** |
| Cloudflare Access (Novaeo Zero Trust) | Kadok — confirmed (All) | Task 16 | ready |
| Rotate PMA + Baserow tokens (transited chat) | Kadok + agent | Task 17 (after wiring) | pending |

**Sequencing rule (from handoff):** the two spikes (Tasks 1–2) run **first** and gate the build. If a spike fails its exit criteria, stop and surface to Kadok before writing build code — the spec calls these the highest-risk unknowns (§11).

## Conventions

- **ESM everywhere.** `package.json` has `"type": "module"`. Imports use explicit `.js` extensions.
- **Test runner:** built-in `node --test` + `node:assert/strict`. No Jest. Run a single file: `node --test test/classify.test.js`.
- **Pure-logic-first.** Network/MCP calls are thin wrappers; the testable logic (normalize, aggregate, compute, classify) is pure and unit-tested against captured fixtures. Unit tests **never** hit the network.
- **`shared/classify.js` is dual-use** — imported by the Node generator *and* the browser. It therefore physically lives at **`public/shared/classify.js`** (so Cloudflare Pages serves it and the frontend can `import` it), and the generator imports it via `../public/shared/classify.js`. It must contain **no** `node:*` imports, no DOM, no globals. This single-file-no-copy choice realizes the spec's "one implementation shared by generator and frontend" (§6.1, §8).
- **`public/` = everything served to the browser:** `index.html`, `shared/classify.js` (source, committed) + `data.json` (generated, committed by CI). The generator writes only `data.json`.
- **TDD** (@superpowers:test-driven-development) for every pure-logic task: failing test → run-it-fail → minimal impl → run-it-pass → commit. **Frequent commits**, one per task minimum. DRY, YAGNI.
- When a test or spike misbehaves, use @superpowers:systematic-debugging — do not patch around red.

## File structure

```
QA/
├─ package.json                  # ESM; scripts: test, build, smoke
├─ config/
│  ├─ thresholds.json            # classification defaults + compute windows (§6.1)
│  └─ stores.json                # store-name → PMA account_id + brand labels (Spike A output)
├─ public/                       # served by Cloudflare Pages
│  ├─ index.html                 # dashboard (ported from dashboards/qa-dashboard.html)
│  ├─ shared/classify.js         # PURE dual-use module (Node + browser)
│  └─ data.json                  # generated snapshot (only file the generator writes here)
├─ generator/
│  ├─ baserow.js                 # fetch + normalize table 691 → ASIN→ratings map
│  ├─ pma.js                     # MCP client: Economics+Sessions → per-ASIN/day rows + ASIN→store map
│  ├─ build.js                   # join + metrics §6 + classify(defaults) + assemble snapshot §7
│  ├─ schema.js                  # JSON schema for data.json + validate()
│  └─ index.js                   # orchestrate → validate → write public/data.json
├─ spike/                        # throwaway exploration (gitignored except notes)
│  └─ NOTES.md                   # confirmed IDs, endpoint, coverage findings (committed)
├─ test/
│  ├─ fixtures/                  # real samples captured by spikes (NO secrets)
│  │  ├─ baserow-691.sample.json
│  │  ├─ pma-economics.sample.json
│  │  ├─ pma-sessions.sample.json
│  │  └─ data.sample.json        # known-good snapshot for the frontend smoke test
│  ├─ classify.test.js
│  ├─ baserow.test.js
│  ├─ pma.test.js
│  ├─ build.test.js
│  ├─ schema.test.js
│  └─ static-server.js           # tiny no-dep http server for the smoke test
├─ tests-e2e/frontend.smoke.spec.js   # @playwright/test
├─ .github/workflows/refresh.yml
└─ dashboards/qa-dashboard.html  # original prototype — git mv'd into public/index.html in Task 11
```

## Milestones

- **M0 — Scaffold** (Task 0)
- **M1 — De-risk** (Tasks 1–2, spikes; gate the rest)
- **M2 — Pure core** (Tasks 3–4: config + classify)
- **M3 — Generator** (Tasks 5–9: baserow, pma, build, schema, orchestrate → real `data.json`)
- **M4 — Frontend** (Tasks 10–14: port, All-Stores, panels, settings, smoke)
- **M5 — Ship** (Tasks 15–17: CI, Cloudflare, rotate)

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`, `config/thresholds.json` (placeholder filled in Task 3), `spike/NOTES.md`
- Modify: `.gitignore`
- Create dirs: `generator/`, `public/shared/`, `test/fixtures/`, `tests-e2e/`, `spike/`

- [ ] **Step 1: Init package.json**

```jsonc
{
  "name": "qa-dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test",
    "build": "node generator/index.js",
    "smoke": "playwright test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ajv": "^8.17.1"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0"
  }
}
```

- [ ] **Step 2: Install deps** — Run: `npm install`. Expected: lockfile created, `node_modules/` present. (Pin `@modelcontextprotocol/sdk` to the latest 1.x actually resolved — record the version in `spike/NOTES.md`.)

- [ ] **Step 3: Harden `.gitignore`** — ensure it contains `node_modules/`, `.env`, `*.key`, `spike/*` **except** `!spike/NOTES.md`, `/scratch/`, `test-results/`, `playwright-report/`. (Per spec §10.)

- [ ] **Step 4: Sanity-check the toolchain** — create `test/smoke0.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
test("toolchain alive", () => { assert.equal(1 + 1, 2); });
```

Run: `npm test`. Expected: `1 passing`. Then delete `test/smoke0.test.js`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore spike/NOTES.md
git commit -m "chore: scaffold Node ESM project (test runner, deps, gitignore)"
```

---

## Task 1 — SPIKE A: ASIN → store mapping (highest risk, §11.1)

**Goal:** prove the ASIN→store join is clean and complete enough to build on, and emit the `config/stores.json` lookup the generator needs. This is exploration, not TDD — exit on the criteria below, capture a fixture, write findings.

**Files:**
- Create: `config/stores.json`, `test/fixtures/baserow-691.sample.json`
- Append to: `spike/NOTES.md`

- [ ] **Step 1: Pull Baserow table 691 (paginated).** Use `BASEROW_TOKEN` from env. Endpoint per §5.1: `https://baserow.novaeo.com/api/database/rows/table/691/?user_field_names=true&size=200&page=N`. Header `Authorization: Token $BASEROW_TOKEN`. Page until `next` is null (765 rows ≈ 4 pages). Write a throwaway `spike/pull-baserow.mjs`.

- [ ] **Step 2: Capture a redacted fixture.** Save ~20 representative rows (mix of: rated, null-rating, each Brand present) to `test/fixtures/baserow-691.sample.json`, preserving the exact field names from §5.1 (`ASIN`, `Amazon Title`, `Brand`, `Amazon Listing Status`, `Amazon Review Rating`, `Amazon Rating Count`, `Previous Review Rating`, `30 Day Velocity`, `Sale Price`, `Inventory Health`). No tokens in the file.

- [ ] **Step 3: Enumerate PMA accounts + ASINs.** In this session, call `pma_list_data_sources` (find the `amazonmws` connectors → 9 `account_id`s, §3) and pull a small Economics slice per account to collect the set of `asin` values and their `account_id`. (Headless Node proof is Spike B; here use the in-session `pma_*` tools to discover structure fast.)

- [ ] **Step 4: Build `config/stores.json`.** Map each of the 9 store names (§3) → its PMA `account_id`, with brand labels as secondary. Shape:

```jsonc
{
  "stores": [
    { "id": "bodyandmind", "name": "body and mind", "accountId": "<pma account_id>", "brands": ["NatriSweet"] }
    // ...9 total. id = slugified name (§6): lowercase, strip non-alphanumerics.
  ]
}
```

- [ ] **Step 5: Measure join health (exit criteria).** Compute and record in `spike/NOTES.md`:
  - **% of in-scope ASINs** (appearing in PMA Economics for the 9 accounts) that have a matching Baserow 691 row. **Exit: ≥ ~90%**, or an explained, acceptable gap.
  - **Rating coverage** (§11.4): share of in-scope ASINs with a non-null `Amazon Review Rating`. Record the number; confirm it's "useful" (spec leaves the bar to judgment — flag to Kadok if very low, e.g. < 40%).
  - Any ASIN in **two** accounts (ambiguous mapping) — list them; decide a tie-break rule (e.g. primary account by units) and note it.

- [ ] **Step 6: Decision gate.** If completeness/coverage fail, **stop and surface to Kadok** with the numbers — do not proceed to the build on a broken join. If pass, commit.

- [ ] **Step 7: Commit** (note: throwaway `spike/pull-baserow.mjs` is gitignored; only the lookup, fixture, and notes are committed)

```bash
git add config/stores.json test/fixtures/baserow-691.sample.json spike/NOTES.md
git commit -m "spike: confirm ASIN→store join + emit store lookup (Spike A)"
```

---

## Task 2 — SPIKE B: PMA pull from Node CI (§11.2, §11.3)

**Goal:** prove a standalone Node process using `@modelcontextprotocol/sdk` + a Bearer headless token can reach the PMA MCP endpoint and pull the data the build needs, and confirm the exact dataset/table IDs, field names, history depth, and rate-limit headroom. Capture fixtures for the TDD tasks.

**Files:**
- Create: `test/fixtures/pma-economics.sample.json`, `test/fixtures/pma-sessions.sample.json`
- Append to: `spike/NOTES.md`

- [ ] **Step 1: Discover datasets/tables/fields (in-session).** Using the `pma_*` tools: identify the **Economics** table (per ASIN/day: `units_returned`, `units_sold`/`net_units_sold`, `refunded_product_sales`, `RefundCommissionFee_total`, `net_sales`, `account_id`, `asin`, `date` — §5.2) and the **Sessions** table (`unitSessionPercentage`, `sessions`, `unitsOrdered` — §5.2). Record exact dataset IDs / table IDs / field names in `spike/NOTES.md`. Confirm granularity is per-ASIN/day.

- [ ] **Step 2: Confirm history depth (§11.3).** Query the earliest available `date` for a sample ASIN in both datasets. **Need ≥ 12 weeks (84d)** for trends, and a 91-day pull window (covers 12-week trend + 30d-vs-prior-30d refund baseline). Record actual depth. If < 12 weeks, note the graceful-degrade target (render longest available, labelled — §6 trends).

- [ ] **Step 3: Capture fixtures.** Save a representative multi-day, multi-ASIN slice from each dataset to `test/fixtures/pma-economics.sample.json` and `pma-sessions.sample.json` — enough to exercise: a 30d window, a prior-30d baseline, and ≥2 weekly buckets. Exact field names preserved. No tokens.

- [ ] **Step 4: Prove the headless Node transport.** Write `spike/pma-smoke.mjs`: instantiate the MCP `Client` with an HTTP transport (try `StreamableHTTPClientTransport` first, fall back to `SSEClientTransport`) pointed at the PMA MCP endpoint, `Authorization: Bearer $PMA_API_TOKEN`. Call `pma_list_data_sources` then one Economics query. Run with `node spike/pma-smoke.mjs`. **Record the working endpoint URL + transport class in `spike/NOTES.md`** — this is the exact config `generator/pma.js` will use.

- [ ] **Step 5: Rate-limit headroom (§11.2).** Estimate calls for a full pull: 9 stores × (Economics + Sessions) × pagination over ~91 days. Confirm it fits PMA's **30 req/min** cap, or design batching/sleep. Record the call budget + chosen pacing in `spike/NOTES.md`.

- [ ] **Step 6: Decision gate.** If headless transport fails, or IDs/fields differ materially from §5.2, **stop and surface to Kadok** with specifics. Else commit.

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/pma-economics.sample.json test/fixtures/pma-sessions.sample.json spike/NOTES.md
git commit -m "spike: confirm PMA headless Node pull + dataset IDs + history depth (Spike B)"
```

---

## Task 3: `config/thresholds.json` (defaults + windows)

**Files:** Create/overwrite `config/thresholds.json`. Per §6.1 — classification thresholds (shipped in snapshot) + compute windows (generator-only).

- [ ] **Step 1: Write config**

```json
{
  "classification": {
    "returnRate": 5.0,
    "returnRateWarn": 4.0,
    "refundSpike": 25,
    "ratingBad": 3.5,
    "ratingWarn": 4.0,
    "ratingDrop": -0.2
  },
  "windows": {
    "windowDays": 30,
    "refundBaselineDays": 30,
    "trendWeeks": 12,
    "pullDays": 91
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add config/thresholds.json
git commit -m "feat: add threshold + window config defaults (§6.1)"
```

---

## Task 4: `public/shared/classify.js` (pure dual-use classification)

The single most error-prone path (§12): the same code colours store health, ASIN flags, pills, and counts in both the generator and the browser. Heaviest TDD.

**Files:**
- Create: `public/shared/classify.js`
- Test: `test/classify.test.js`

- [ ] **Step 1: Write failing tests** (`test/classify.test.js`). Cover each function + override scenarios (§6, §12):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS as D, storeHealth, asinFlags, isFlagged,
  rateClass, ratingClass, flaggedCount
} from "../public/shared/classify.js";

test("storeHealth: bad when return rate >= breach (§6)", () => {
  assert.equal(storeHealth({ returnRate: 5.0, reviewRating: 4.5, reviewDelta: 0, refundSpike: 0 }, D), "bad");
});
test("storeHealth: bad when avg rating < ratingBad", () => {
  assert.equal(storeHealth({ returnRate: 1, reviewRating: 3.4, reviewDelta: 0, refundSpike: 0 }, D), "bad");
});
test("storeHealth: warn on returnRateWarn / ratingDrop / refundSpike", () => {
  assert.equal(storeHealth({ returnRate: 4.0, reviewRating: 4.5, reviewDelta: 0, refundSpike: 0 }, D), "warn");
  assert.equal(storeHealth({ returnRate: 1, reviewRating: 4.5, reviewDelta: -0.2, refundSpike: 0 }, D), "warn");
  assert.equal(storeHealth({ returnRate: 1, reviewRating: 4.5, reviewDelta: 0, refundSpike: 26 }, D), "warn");
});
test("storeHealth: good otherwise; null rating doesn't force bad (§5.1)", () => {
  assert.equal(storeHealth({ returnRate: 1, reviewRating: 4.8, reviewDelta: 0.1, refundSpike: 5 }, D), "good");
  assert.equal(storeHealth({ returnRate: 1, reviewRating: null, reviewDelta: 0, refundSpike: 0 }, D), "good");
});
test("asinFlags: each rule + combination (§6)", () => {
  assert.deepEqual(asinFlags({ returnRate: 5, refundSpike: 0, reviewDelta: 0 }, D), ["return"]);
  assert.deepEqual(asinFlags({ returnRate: 0, refundSpike: 26, reviewDelta: 0 }, D), ["refund"]);
  assert.deepEqual(asinFlags({ returnRate: 0, refundSpike: 0, reviewDelta: -0.2 }, D), ["ratingDrop"]);
  assert.deepEqual(asinFlags({ returnRate: 5, refundSpike: 26, reviewDelta: -0.3 }, D), ["return", "refund", "ratingDrop"]);
  assert.equal(isFlagged({ returnRate: 1, refundSpike: 1, reviewDelta: 0 }, D), false);
});
test("rateClass / ratingClass boundaries (§6)", () => {
  assert.equal(rateClass(5, D), "bad");
  assert.equal(rateClass(4, D), "warn");
  assert.equal(rateClass(3.9, D), "good");
  assert.equal(ratingClass(3.4, D), "bad");
  assert.equal(ratingClass(3.9, D), "warn");
  assert.equal(ratingClass(4.0, D), "good");
  assert.equal(ratingClass(null, D), "good"); // no rating ≠ zero
});
test("flaggedCount over a store's ASINs", () => {
  const asins = [
    { returnRate: 6, refundSpike: 0, reviewDelta: 0 },
    { returnRate: 1, refundSpike: 0, reviewDelta: 0 },
    { returnRate: 0, refundSpike: 30, reviewDelta: 0 }
  ];
  assert.equal(flaggedCount(asins, D), 2);
});
test("OVERRIDE: lowering returnRate breach re-colors & re-counts (§6.1, §12)", () => {
  const t = { ...D, returnRate: 3.0, returnRateWarn: 2.0 };
  assert.equal(storeHealth({ returnRate: 3.5, reviewRating: 4.5, reviewDelta: 0, refundSpike: 0 }, t), "bad");
  assert.equal(flaggedCount([{ returnRate: 3.5, refundSpike: 0, reviewDelta: 0 }], t), 1);
});
test("OVERRIDE: raising thresholds clears flags (reset-to-defaults path)", () => {
  const lax = { ...D, returnRate: 9, returnRateWarn: 8, refundSpike: 99, ratingDrop: -9 };
  assert.equal(storeHealth({ returnRate: 6, reviewRating: 4.5, reviewDelta: -0.5, refundSpike: 40 }, lax), "good");
  assert.equal(flaggedCount([{ returnRate: 6, refundSpike: 40, reviewDelta: -0.5 }], lax), 0);
});
```

- [ ] **Step 2: Run, verify all fail** — Run: `node --test test/classify.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`public/shared/classify.js`). Note exact operators from §6: return-rate `≥`, refund-spike `>`, rating `<`, rating-drop `≤`.

```js
// Pure classification: (raw numbers + thresholds) -> labels. Imported by the Node
// generator (build.js) AND the browser (index.html). No node:* / DOM / globals.

export const DEFAULT_THRESHOLDS = {
  returnRate: 5.0, returnRateWarn: 4.0, refundSpike: 25,
  ratingBad: 3.5, ratingWarn: 4.0, ratingDrop: -0.2
};

export function storeHealth(s, t) {
  if (s.returnRate >= t.returnRate || (s.reviewRating != null && s.reviewRating < t.ratingBad)) return "bad";
  if (s.returnRate >= t.returnRateWarn || s.reviewDelta <= t.ratingDrop || s.refundSpike > t.refundSpike) return "warn";
  return "good";
}

export function asinFlags(a, t) {
  const f = [];
  if (a.returnRate >= t.returnRate) f.push("return");
  if (a.refundSpike > t.refundSpike) f.push("refund");
  if (a.reviewDelta != null && a.reviewDelta <= t.ratingDrop) f.push("ratingDrop");
  return f;
}
export const isFlagged = (a, t) => asinFlags(a, t).length > 0;

export function rateClass(r, t) {
  if (r >= t.returnRate) return "bad";
  if (r >= t.returnRateWarn) return "warn";
  return "good";
}
export function ratingClass(r, t) {
  if (r == null) return "good";          // "no rating", not zero (§5.1)
  if (r < t.ratingBad) return "bad";
  if (r < t.ratingWarn) return "warn";
  return "good";
}
export const flaggedCount = (asins, t) => asins.reduce((n, a) => n + (isFlagged(a, t) ? 1 : 0), 0);
```

- [ ] **Step 4: Run, verify pass** — Run: `node --test test/classify.test.js`. Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add public/shared/classify.js test/classify.test.js
git commit -m "feat: pure dual-use classify module + tests (§6, §6.1)"
```

---

## Task 5: `generator/baserow.js` (fetch + normalize ratings)

**Files:** Create `generator/baserow.js`; Test `test/baserow.test.js`. Split: pure `normalizeBaserow(rows)` (tested) + thin `fetchBaserow(token)` (paginated, exercised live in Task 9).

- [ ] **Step 1: Failing test** — feed `test/fixtures/baserow-691.sample.json` to `normalizeBaserow`, assert it returns a `Map`/object keyed by ASIN with `{ title, brand, listingStatus, reviewRating, ratingCount, previousRating, reviewDelta, velocity }`, that **null ratings stay null** (not 0, §5.1), and `reviewDelta = reviewRating − previousRating` (null if either side null).

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeBaserow } from "../generator/baserow.js";
const rows = JSON.parse(readFileSync(new URL("./fixtures/baserow-691.sample.json", import.meta.url)));

test("normalizeBaserow keys by ASIN, preserves null rating, computes delta", () => {
  const m = normalizeBaserow(rows);
  const any = Object.values(m)[0];
  assert.ok("reviewRating" in any && "reviewDelta" in any);
  const nullRated = Object.values(m).find(r => r.reviewRating == null);
  if (nullRated) assert.equal(nullRated.reviewDelta, null);
  const rated = Object.values(m).find(r => r.reviewRating != null && r.previousRating != null);
  if (rated) assert.equal(rated.reviewDelta, +(rated.reviewRating - rated.previousRating).toFixed(2));
});
```

- [ ] **Step 2: Run → fail.** `node --test test/baserow.test.js`.

- [ ] **Step 3: Implement** `normalizeBaserow(rows)` (pure) + `fetchBaserow({ token })` (paginate `?user_field_names=true&size=200&page=N` until `next` null; §5.1). `fetchBaserow` returns raw rows; `normalizeBaserow` maps field names → normalized keys.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat: baserow fetch + normalize to ASIN→ratings (§5.1)"`

---

## Task 6: `generator/pma.js` (MCP pull + aggregate)

**Files:** Create `generator/pma.js`; Test `test/pma.test.js`. Split: pure `aggregatePma(econRows, sessRows, { windowDays, refundBaselineDays, trendWeeks })` (tested against fixtures) + thin `fetchPma({ token, accountIds, pullDays })` MCP client (uses the endpoint/transport/IDs confirmed in Spike B; exercised live in Task 9).

- [ ] **Step 1: Failing test** — using the two PMA fixtures, assert `aggregatePma` returns, per `asin`: `{ accountId, returnRateWindow, returnRatePrior, unitsSold, unitsReturned, refundLast30, refundPrior30, refundSpike, conversion, weekly: { returnRate[], conversion[] } }` where:
  - `returnRateWindow = Σunits_returned / Σunits_sold` over last `windowDays` (×100, §6).
  - `refundSpike = (refundLast30 − refundPrior30) / refundPrior30 × 100`; `refundPrior30 === 0` → guard (define as `null`/`0`, render "n/a").
  - `conversion = mean(unitSessionPercentage)` over window (§6).
  - `weekly.returnRate` has `trendWeeks` buckets (or fewer + a `weeksAvailable` marker if history is short, §6).

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aggregatePma } from "../generator/pma.js";
const econ = JSON.parse(readFileSync(new URL("./fixtures/pma-economics.sample.json", import.meta.url)));
const sess = JSON.parse(readFileSync(new URL("./fixtures/pma-sessions.sample.json", import.meta.url)));

test("aggregatePma computes return rate, refund spike, conversion, weekly buckets", () => {
  const out = aggregatePma(econ, sess, { windowDays: 30, refundBaselineDays: 30, trendWeeks: 12 });
  const a = Object.values(out)[0];
  assert.ok(a.accountId);
  assert.equal(typeof a.returnRateWindow, "number");
  assert.ok(Array.isArray(a.weekly.returnRate));
  // hand-computed expectation from the fixture goes here once the fixture is real:
  // assert.equal(+a.returnRateWindow.toFixed(2), <expected>);
});
```

> During execution, replace the commented assertion with a value hand-computed from the actual captured fixture — the test must pin a real number, not just types.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `aggregatePma` (pure date-window math) + `fetchPma` (MCP `Client` + transport from Spike B; loops the 9 `accountIds`; pulls `pullDays`; respects the §11.2 pacing from Spike B). The ASIN→store map falls out of each row's `account_id` → `config/stores.json`.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat: pma MCP pull + per-ASIN aggregation (§5.2, §6)"`

---

## Task 7: `generator/build.js` (join + metrics + classify + assemble)

The heart of §6/§7. Pure: `buildSnapshot({ ratings, pma, stores, thresholds, windows, generatedAt })` → the exact `data.json` object (§7). Classification uses **config defaults** via `public/shared/classify.js` (§6.1 compute boundary).

**Files:** Create `generator/build.js`; Test `test/build.test.js`.

- [ ] **Step 1: Failing tests** — assert, from joined fixtures:
  - Per-store `kpis` carry every raw recompute input (§6.1, §7): `returnRate`, `returnDelta`, `refundSpike`, `reviewRating`, `reviewDelta`, `ratingCount`, `conversion`.
  - Each ASIN carries raw numerics `returnRate`, `refundSpike` (numeric), `reviewRating`, `reviewDelta` **plus** display `refundDelta` string and default `flags` (§7).
  - Store-level `returnRate = Σunits_returned/Σunits_sold` across the store's ASINs; `returnDelta = returnRateWindow − returnRatePrior` (pp).
  - Store `reviewRating` = rating-count-weighted mean of its ASINs; `health` = `storeHealth(...)` with defaults.
  - **Portfolio** (§6, §7): `returnRate` = Σreturned/Σsold across all stores; `refundExposure` = Σ`refunded_product_sales` (30d); `flaggedCount` = Σ flagged ASINs; `avgRating` = rating-count-weighted mean; `leaderboard` sorted worst-health-first; `storeCount = 9`.
  - `trend`/`conv` arrays present at portfolio and store level (12 or labelled-shorter).
  - `thresholds` block = the 6 classification defaults; `window.days = 30`.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../generator/build.js";
// ...assemble ratings+pma+stores from fixtures, then:
test("snapshot carries every client-recompute input (§6.1, §7)", () => {
  const snap = buildSnapshot(/* ... */);
  for (const s of snap.stores) {
    for (const k of ["returnRate","refundSpike","reviewRating","reviewDelta"]) assert.ok(k in s.kpis);
    for (const a of s.asins) for (const k of ["returnRate","refundSpike","reviewRating","reviewDelta"]) assert.ok(k in a);
  }
  assert.equal(Object.keys(snap.thresholds).length, 6);
  assert.equal(snap.window.days, 30);
});
test("portfolio rollup: weighted avg rating + worst-health-first leaderboard (§6)", () => { /* ... */ });
test("store health/flags match classify on the same raw numbers (§6.1)", () => { /* ... */ });
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `buildSnapshot`. Join ratings (by ASIN) onto pma aggregates; group by `accountId` → store via `stores.json`; compute store + portfolio metrics (§6); call `storeHealth`/`asinFlags`/`flaggedCount` from `classify.js` with the config-default thresholds (§6.1 — generator ships the default classification); assemble the §7 object. Keep `refundDelta` as a display string (`"+14%"`) **and** `refundSpike` as a number.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat: build.js join + §6 metrics + default classification + §7 snapshot"`

---

## Task 8: `generator/schema.js` (snapshot JSON schema + validate)

Bad data must never ship (§12). The schema **asserts presence of every client-recompute input** + all six thresholds.

**Files:** Create `generator/schema.js`; Test `test/schema.test.js`.

- [ ] **Step 1: Failing tests** — `validate(goodSnapshot)` passes; dropping any of `thresholds.*` (must have all 6), or a per-store/per-ASIN raw numeric (`returnRate`/`refundSpike`/`reviewRating`/`reviewDelta`), fails (§12). Use the Task 7 output (or `test/fixtures/data.sample.json`) as the good case.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../generator/schema.js";
import good from "./fixtures/data.sample.json" with { type: "json" };

test("valid snapshot passes", () => assert.equal(validate(good).ok, true));
test("missing a threshold fails", () => {
  const bad = structuredClone(good); delete bad.thresholds.ratingDrop;
  assert.equal(validate(bad).ok, false);
});
test("ASIN missing reviewDelta fails (breaks client recompute)", () => {
  const bad = structuredClone(good); delete bad.stores[0].asins[0].reviewDelta;
  assert.equal(validate(bad).ok, false);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** an `ajv` schema mirroring §7 with `required` on the recompute inputs + the 6 thresholds; export `validate(obj) → { ok, errors }`. **Path note:** the store-level raw numerics live under `store.kpis.*` (§7), so `required` for them targets the `kpis` object, not the store root; the ASIN raw numerics are on the asin object directly.

- [ ] **Step 4: Run → pass.** Also generate `test/fixtures/data.sample.json` here (a real `buildSnapshot` output, hand-verified) for downstream tasks.

- [ ] **Step 5: Commit** — `git commit -m "feat: snapshot JSON schema asserts recompute inputs + thresholds (§12)"`

---

## Task 9: `generator/index.js` (orchestrate → write `public/data.json`)

**Files:** Create `generator/index.js`. No new unit test (it's I/O orchestration); verified by a live smoke run.

- [ ] **Step 1: Implement** — read `config/thresholds.json` + `config/stores.json`; `fetchBaserow` + `fetchPma` (env tokens); `normalizeBaserow`, `aggregatePma`, `buildSnapshot` (stamp `generatedAt` = run time, `refreshIntervalHours` = 6); `validate()` — **exit non-zero without writing if invalid** (last good snapshot survives, §4); else write pretty `public/data.json`.

- [ ] **Step 2: Live smoke run** — Run: `BASEROW_TOKEN=… PMA_API_TOKEN=… npm run build`. Expected: `public/data.json` written, schema-valid, 9 stores, portfolio present. Spot-check 2–3 numbers against PMA/Baserow directly (@superpowers:verification-before-completion — evidence, not assumption).

- [ ] **Step 3: Refresh `test/fixtures/data.sample.json`** from this real output (redact nothing — it carries no secrets) so the frontend smoke test runs on realistic data.

- [ ] **Step 4: Commit** — `git commit -m "feat: orchestrate generator → validated public/data.json"` (commit `public/data.json` + the refreshed sample).

---

## Task 10: Frontend — port + data loading + classify wiring

Now the HTML. Spec §8 "Frontend changes (minimal)". Work in `public/index.html`.

**Files:** `git mv dashboards/qa-dashboard.html public/index.html`; modify it.

- [ ] **Step 1:** `git mv dashboards/qa-dashboard.html public/index.html`. Commit the move alone so the diff is reviewable.
- [ ] **Step 2:** Convert `<script>` → `<script type="module">`; `import { ... } from "./shared/classify.js"`.
- [ ] **Step 3:** Replace the hardcoded `STORES` const + `RETURN_THRESHOLD` with: `const SNAP = await fetch("./data.json").then(r => r.json());` and derive `STORES = SNAP.stores`, default thresholds from `SNAP.thresholds`. Guard for fetch failure (render an error panel).
- [ ] **Step 4:** Verify existing per-store render still works against the new shape (KPIs read `kpis.*`; trend reads `store.trend`/`store.conv`). Adjust field reads to match §7.
- [ ] **Step 5:** Manual check (@superpowers:webapp-testing): serve `public/` (`node test/static-server.js` or `python3 -m http.server -d public`), load it, confirm a store renders from real `data.json`.
- [ ] **Step 6: Commit** — `git commit -m "refactor: load dashboard from data.json via shared classify (§8)"`

---

## Task 11: Frontend — "All Stores" portfolio overview

- [ ] **Step 1:** Add an **"All Stores"** entry pinned atop the store rail (§8); selecting it sets a portfolio view mode.
- [ ] **Step 2:** Render portfolio overview from `SNAP.portfolio`: KPI strip (return rate, refund exposure, flagged count, avg rating), the 12-week trend+conv chart (reuse `renderTrend`), and a **leaderboard** (worst-health first) + **worst ASINs** roll-up.
- [ ] **Step 3:** Per-store selection still renders the existing detail layout.
- [ ] **Step 4:** Manual check both views render.
- [ ] **Step 5: Commit** — `git commit -m "feat: All Stores portfolio overview + leaderboard (§8)"`

---

## Task 12: Frontend — panel swaps (reviews replace sentiment; table; remove Phase-2)

Per §8, all sourced from real data:
- [ ] **Step 1:** Replace the **sentiment-themes** card with a **review-ratings** panel (rating, rating count, Δ) driven by `kpis.reviewRating/ratingCount/reviewDelta`.
- [ ] **Step 2:** Flagged-ASIN table: drop `Top return reason` + `Neg. themes` columns; add **`Review rating`** + **`Δ`**; keep ASIN/SKU, Return rate (pill via `rateClass`), Refund Δ. Build rows from `store.asins` filtered by `isFlagged`.
- [ ] **Step 3:** **Remove** the Triage pipeline card and the Repeat-purchase KPI (Phase 2, §8/§2). Replace the 4th KPI slot with Conversion (informational, §6).
- [ ] **Step 4:** Rewrite the **footnote** to the real sources (Baserow ratings + PMA Economics/Sessions) — delete the SP-API/Customer-Feedback claims. Update tooltip `src` strings + remove `negThemes`/`repeatRate`/`triage`/`sentiment` tips; add a `reviewRating`/`reviewDelta`/`conversion` tip.
- [ ] **Step 5: Scrub remaining SP-API framing in the rail.** The prototype hardcodes a brand subtitle `"SP-API quality monitor"` (`index.html` ~line 196) and a "Coverage" widget (`"2 connected · 10 pending SP-API"`, ~lines 200–203 + the `covConnected`/`covPending` writes ~lines 522–523). Replace the subtitle with accurate framing (e.g. "Amazon store quality monitor") and either repurpose the Coverage widget to real numbers (e.g. stores in scope / ASINs covered, from `SNAP`) or remove it. No dangling `getElementById("covConnected"/"covPending")` left behind.
- [ ] **Step 6:** Manual check; no console errors; no dangling references to removed data.
- [ ] **Step 7: Commit** — `git commit -m "feat: review-ratings panel + table swap; remove Phase-2 panels (§8)"`

---

## Task 13: Frontend — Settings panel (live thresholds) + refresh affordances

The §6.1 live re-classification path + §8 sync affordances.

- [ ] **Step 1: Refresh affordances (§8):** show **"last synced"** (from `SNAP.generatedAt`) + a **"next refresh in ~Xh"** countdown (from `refreshIntervalHours`), and a **re-fetch button** that re-`fetch()`es `./data.json` (cache-busted) and re-renders. Label it clearly: re-loads the committed snapshot, does **not** pull upstream (§2 non-goal, §8).
- [ ] **Step 2: Settings panel (gear icon):** number inputs for the 6 classification thresholds (`returnRate`, `returnRateWarn`, `refundSpike`, `ratingBad`, `ratingWarn`, `ratingDrop`) + a **"reset to defaults"** button. One input per threshold — single value across scopes (§6.1).
- [ ] **Step 3: Effective thresholds (§6.1):** `effective[k] = localStorage override ?? SNAP.thresholds[k]`. Persist overrides in `localStorage` (personal, per-browser). "Reset" clears the override → view returns to shipped default classification.
- [ ] **Step 4: Client recompute:** when effective ≠ defaults, recompute `health`, `flags`, `flaggedCount`, and leaderboard order **from the snapshot's raw numbers** using the **same `classify.js`** (§6.1). Re-render instantly, **no refetch**. (Render path must read these from classify, not from the shipped labels, whenever an override is active.) **Leaderboard source:** recompute each store's `health` from `store.kpis.*` (which carries `reviewDelta`/`refundSpike`) and re-sort worst-health-first — do **not** rely on `portfolio.leaderboard[].health`, which is only the shipped default view and lacks `reviewDelta`.
- [ ] **Step 4a: Trend breach line follows the threshold.** The ported `renderTrend` hardcodes the dashed breach line + legend at the old 5% `RETURN_THRESHOLD`. Drive it from the **effective** `returnRate` threshold so the line (and the legend text) moves when the user retunes it; update the last-point breach coloring to the same value. (Out of §6.1's strict recompute list but needed so the chart doesn't contradict the recolored pills.)
- [ ] **Step 5: Manual check** — change a threshold → colors/counts/leaderboard update without network; reset → returns to shipped view; reload page → override persists.
- [ ] **Step 6: Commit** — `git commit -m "feat: live Settings panel (localStorage overrides) + refresh countdown/re-fetch (§6.1, §8)"`

---

## Task 14: Frontend smoke test (@playwright/test)

Per §12: renders overview + a store from a sample `data.json`; a Settings override re-renders without a refetch. Use @superpowers:webapp-testing.

**Files:** Create `tests-e2e/frontend.smoke.spec.js`, `test/static-server.js`, `playwright.config.js`.

- [ ] **Step 1:** Write `test/static-server.js` — a ~15-line `node:http` static server over `public/` (serves `index.html`, `shared/classify.js`, and `data.json` = the Task 9 sample). No dependency.
- [ ] **Step 2:** Playwright config: `webServer` launches the static server; single Chromium project; `baseURL` to it.
- [ ] **Step 3:** Spec:
  - loads `/`, asserts the store rail has **"All Stores" + 9 stores**, portfolio KPIs visible;
  - clicks a store → detail KPIs + flagged table render;
  - records flagged count, opens Settings, lowers `returnRate` to a value that must flag more, asserts the count/colors change **with no `data.json` network request** (assert via `page.on("request")`), and that "reset" restores it.
- [ ] **Step 4:** One-time `npx playwright install chromium`. Run: `npm run smoke`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "test: Playwright frontend smoke (render + live override, no refetch) (§12)"`

---

## Task 15: `.github/workflows/refresh.yml` (cron generator → commit data.json)

**Blocked by:** repo + PAT/remote (Prerequisites).

**Files:** Create `.github/workflows/refresh.yml`.

- [ ] **Step 1:** Workflow: `on: schedule: cron "0 */6 * * *"` + `workflow_dispatch`. Job: checkout, `setup-node@v4` (node 22, cache npm), `npm ci`, `npm test` (unit gate — don't ship if logic is red), `npm run build` with `env: BASEROW_TOKEN: ${{ secrets.BASEROW_TOKEN }}`, `PMA_API_TOKEN: ${{ secrets.PMA_API_TOKEN }}`.
- [ ] **Step 2:** Commit step: if `public/data.json` changed, commit as `rafaelg-noa` and push. Use `permissions: contents: write`. **If `npm run build` exits non-zero (schema invalid), the job fails and does not commit** — last good snapshot stays (§4).
- [ ] **Step 3:** Add `BASEROW_TOKEN` + `PMA_API_TOKEN` as **GitHub Actions secrets** via the GitHub UI (§10) — not committed.
- [ ] **Step 4:** Trigger `workflow_dispatch` once; confirm green + a fresh `data.json` commit authored `rafaelg-noa`.
- [ ] **Step 5: Commit** — `git commit -m "ci: 6h cron refresh — build + validate + commit data.json (§9)"`

---

## Task 16: Cloudflare Pages + Access

**Blocked by:** repo + Cloudflare (confirmed). Ops runbook, not code. Record steps in `spike/NOTES.md` (or a `DEPLOY.md`).

- [ ] **Step 1:** Cloudflare Pages → connect `rafaelg-noa/QA-Dashboard` (dashboard GitHub integration — no CF API token for Phase 1, §9). Build config: **no build command**, output dir `public`.
- [ ] **Step 2:** Deploy; confirm the site serves `index.html` + `data.json` + `shared/classify.js`.
- [ ] **Step 3:** Cloudflare Access (Zero Trust) → application over the Pages domain, email policy limited to allowed Novaeo users (§9, §10).
- [ ] **Step 4:** Verify from an allowed account: SSO prompt → dashboard loads; an unlisted email is denied. @superpowers:verification-before-completion — actually load it, both cases.
- [ ] **Step 5:** Document the final URL + policy in `DEPLOY.md`; commit.

---

## Task 17: Rotate secrets (post-wiring, §10)

- [ ] **Step 1:** Rotate the **Baserow token** (regenerate, scoped read-only to db 138) and the **PMA headless key**; update the two GitHub Actions secrets; re-run `workflow_dispatch` to confirm green on the new creds.
- [ ] **Step 2:** Confirm the old tokens are dead (a call with the old Baserow token → 401).
- [ ] **Step 3:** Note completion in `DEPLOY.md`. No code commit needed beyond docs.

---

## Done / review

- [ ] All unit + smoke tests green: `npm test && npm run smoke`.
- [ ] @superpowers:requesting-code-review before declaring Phase 1 complete (diff vs spec — every §8 frontend change, every §6 metric, the §6.1 boundary, §12 schema).
- [ ] @superpowers:finishing-a-development-branch to integrate.
- [ ] Phase 2 items (SP-API reasons/themes, triage, on-demand, multi-channel) remain out of scope (§13).
