> ⚠️ **ARCHIVED / EXECUTED.** This implementation plan is 100% complete — every task shipped. For the **current** system state, see [`README.md`](../../../README.md) and [`DEPLOY.md`](../../../DEPLOY.md). Retained as a historical execution record. Deferred items from this plan are tracked in [`docs/BACKLOG.md`](../../BACKLOG.md).

# Executive QA Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the QA dashboard into a C-level awareness page — a rating-trajectory verdict, brand-level breakdown, and a pinned-verdict + 3-tab UI — by adding brand rollups and a verdict to the existing snapshot pipeline and reworking the frontend.

**Architecture:** Additive changes on the Phase 1 pipeline (Baserow + PMA → `buildSnapshot` → `data.json` → `index.html`). The generator gains a brand rollup alongside the retained store rollup, plus a verdict. `classify.js` (dual-use, Node + browser) gains the verdict rule so the browser's live threshold recompute keeps working. The frontend becomes a tabbed app reading the enriched `data.json`.

**Tech Stack:** Node ≥22 (ESM, `node --test`), AJV schema validation, vanilla HTML/JS frontend, Playwright smoke tests.

**Spec:** `docs/superpowers/specs/2026-06-24-executive-qa-dashboard-design.md`

**Invariants that must not drift (from Phase 1):**
1. **Ratio-of-sums** — every group rate is `Σreturned / Σsold`, never a mean of per-ASIN rates.
2. **Empty group → "nodata"** — no matching ASINs or `Σ unitsSoldWindow === 0` ⇒ `health: "nodata"`, null KPIs.
3. **Classification lives only in `public/shared/classify.js`** — never reimplemented in `build.js` or `index.html`.

---

## File Structure

**Modified:**
- `config/thresholds.json` — add `ratingRise` (the +0.1 "improving" cutoff).
- `public/shared/classify.js` — add `portfolioVerdict`, add `ratingRise` to `DEFAULT_THRESHOLDS`.
- `generator/build.js` — add `rollupBrand` + `rollupBrands`; add `ratingDelta`, `verdict`, `brands[]` to portfolio; pass `ratingRise` through the thresholds block.
- `generator/schema.js` — schema for `portfolio.ratingDelta`, `portfolio.verdict`, `portfolio.brands[]`, and the new `ratingRise` threshold.
- `public/index.html` — rework into the tabbed app (pinned verdict, Briefing / All Brands / Rankings tabs, detail drawer, Warehouse placeholder).
- `tests-e2e/frontend.smoke.spec.js` — extend smoke coverage for tabs / verdict / live recompute / drawer.

**Test files touched:** `test/classify.test.js`, `test/build.test.js`, `test/schema.test.js` (the existing envelope test that asserts exactly 6 thresholds must move to 7).

**Milestones:** Tasks 1–6 = data layer (produces a valid enriched `data.json`, fully unit-tested, working on its own). Tasks 7–12 = frontend (consumes it).

---

## Task 1: Add `ratingRise` threshold

**Files:**
- Modify: `config/thresholds.json`
- Modify: `test/build.test.js` (envelope test asserts exactly 6 thresholds → becomes 7)

- [ ] **Step 1: Add the threshold to config**

In `config/thresholds.json`, add `ratingRise` to the `classification` block:

```json
  "classification": {
    "returnRate": 5.0,
    "returnRateWarn": 4.0,
    "refundSpike": 25,
    "ratingBad": 3.5,
    "ratingWarn": 4.0,
    "ratingDrop": -0.2,
    "ratingRise": 0.1
  },
```

- [ ] **Step 2: Run the build envelope test to see it fail**

Run: `node --test test/build.test.js`
Expected: FAIL — the "envelope" test asserts `Object.keys(snap.thresholds).length === 6` and `deepEqual(snap.thresholds, cfg.classification)`. It now sees 7 keys.

- [ ] **Step 3: Update the envelope test for 7 thresholds**

In `test/build.test.js`, in the `envelope:` test, change the count assertion to `7` and add `ratingRise` to the key-presence loop:

```js
  assert.equal(Object.keys(snap.thresholds).length, 7);
  for (const k of ["returnRate", "returnRateWarn", "refundSpike", "ratingBad", "ratingWarn", "ratingDrop", "ratingRise"]) {
    assert.ok(k in snap.thresholds, `thresholds.${k} present`);
  }
```

(`deepEqual(snap.thresholds, cfg.classification)` will pass once Task 3 adds `ratingRise` to the passthrough. It may fail here — that is expected and resolved in Task 3. If running tests in isolation, comment a note; do NOT delete the assertion.)

- [ ] **Step 4: Commit**

```bash
git add config/thresholds.json test/build.test.js
git commit -m "feat: add ratingRise threshold (improving-verdict cutoff)"
```

---

## Task 2: `portfolioVerdict` in classify.js

**Files:**
- Modify: `public/shared/classify.js`
- Test: `test/classify.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/classify.test.js` (import `portfolioVerdict` and add `ratingRise` to the destructured import is NOT needed — `D` already comes from `DEFAULT_THRESHOLDS`; just add `portfolioVerdict` to the import list):

```js
import {
  DEFAULT_THRESHOLDS as D, storeHealth, asinFlags, isFlagged,
  rateClass, ratingClass, flaggedCount, portfolioVerdict
} from "../public/shared/classify.js";

test("portfolioVerdict: slipping when ratingDelta <= ratingDrop", () => {
  assert.equal(portfolioVerdict({ ratingDelta: -0.2, decliningBrands: 0 }, D), "slipping");
  assert.equal(portfolioVerdict({ ratingDelta: -0.5, decliningBrands: 0 }, D), "slipping");
});
test("portfolioVerdict: slipping when >= 2 brands declining (even if ratingDelta ok)", () => {
  assert.equal(portfolioVerdict({ ratingDelta: 0.05, decliningBrands: 2 }, D), "slipping");
});
test("portfolioVerdict: improving when ratingDelta >= ratingRise", () => {
  assert.equal(portfolioVerdict({ ratingDelta: 0.1, decliningBrands: 0 }, D), "improving");
  assert.equal(portfolioVerdict({ ratingDelta: 0.3, decliningBrands: 1 }, D), "improving");
});
test("portfolioVerdict: stable in the middle and when ratingDelta is null", () => {
  assert.equal(portfolioVerdict({ ratingDelta: 0.0, decliningBrands: 1 }, D), "stable");
  assert.equal(portfolioVerdict({ ratingDelta: null, decliningBrands: 1 }, D), "stable");
});
test("portfolioVerdict: slipping precedence — null ratingDelta but 2 decliners", () => {
  assert.equal(portfolioVerdict({ ratingDelta: null, decliningBrands: 2 }, D), "slipping");
});
test("OVERRIDE: tightening ratingDrop flips stable→slipping (live recompute)", () => {
  const t = { ...D, ratingDrop: -0.05 };
  assert.equal(portfolioVerdict({ ratingDelta: -0.1, decliningBrands: 0 }, t), "slipping");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/classify.test.js`
Expected: FAIL — `portfolioVerdict is not a function` / `not exported`.

- [ ] **Step 3: Implement `portfolioVerdict` and update defaults**

In `public/shared/classify.js`, add `ratingRise: 0.1` to `DEFAULT_THRESHOLDS`, and add the function:

```js
export const DEFAULT_THRESHOLDS = {
  returnRate: 5.0, returnRateWarn: 4.0, refundSpike: 25,
  ratingBad: 3.5, ratingWarn: 4.0, ratingDrop: -0.2, ratingRise: 0.1
};

// Portfolio rating-trajectory verdict (spec §6). Pure: (aggregates + thresholds) -> label.
//   slipping  : trajectory at/below ratingDrop, OR >= 2 brands individually declining
//   improving : trajectory at/above ratingRise
//   stable    : otherwise (incl. ratingDelta === null)
export function portfolioVerdict(p, t) {
  if ((p.ratingDelta != null && p.ratingDelta <= t.ratingDrop) || p.decliningBrands >= 2) return "slipping";
  if (p.ratingDelta != null && p.ratingDelta >= t.ratingRise) return "improving";
  return "stable";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/classify.test.js`
Expected: PASS (all classify tests).

- [ ] **Step 5: Commit**

```bash
git add public/shared/classify.js test/classify.test.js
git commit -m "feat: portfolioVerdict classification (dual-use, slipping/stable/improving)"
```

---

## Task 3: Pass `ratingRise` through the snapshot thresholds block

**Files:**
- Modify: `generator/build.js` (the `thresholds:` block in `buildSnapshot`)
- Test: `test/build.test.js` (envelope test from Task 1 now fully passes)

- [ ] **Step 1: Run the envelope test to confirm the gap**

Run: `node --test test/build.test.js`
Expected: FAIL — `deepEqual(snap.thresholds, cfg.classification)` fails because `snap.thresholds` still emits only 6 keys while config has 7.

- [ ] **Step 2: Add `ratingRise` to the thresholds passthrough**

In `generator/build.js`, in `buildSnapshot`'s returned object, extend the `thresholds` block:

```js
    thresholds: {
      returnRate: thresholds.returnRate,
      returnRateWarn: thresholds.returnRateWarn,
      refundSpike: thresholds.refundSpike,
      ratingBad: thresholds.ratingBad,
      ratingWarn: thresholds.ratingWarn,
      ratingDrop: thresholds.ratingDrop,
      ratingRise: thresholds.ratingRise,
    },
```

- [ ] **Step 3: Run to verify pass**

Run: `node --test test/build.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add generator/build.js
git commit -m "feat: emit ratingRise in snapshot thresholds block"
```

---

## Task 4: `rollupBrand` + `rollupBrands` → `portfolio.brands[]`

**Files:**
- Modify: `generator/build.js`
- Test: `test/build.test.js`

**Design:** `rollupBrand` mirrors `rollupStore` but its input is a pre-filtered array of pma aggregates for one brand. It reuses `weightedMean`, ratio-of-sums, `flaggedCount`, `storeHealth`, and the empty→`nodata` rule. It additionally surfaces `refundExposure = round(Σ refundLast, 2)` (which `rollupStore` computes internally but discards). `rollupBrands` groups all aggregates by `ratings[asin].brand` (null → `"Unbranded"`), builds one entry per brand, and sorts worst-first using the existing `HEALTH_RANK` then `returnRate` desc (nulls last) — identical to the store leaderboard sort.

- [ ] **Step 1: Write failing tests**

Add to `test/build.test.js`. These recompute ground truth from the fixtures (same philosophy as the existing store tests) — do not echo the implementation. The `brandAsins` helper goes at **module scope** (alongside the existing `storeAsins`/`close` helpers), not inside a test; it reuses the module-scope `pma`, `ratings`, `cfg`, `build`, and `close` already defined at the top of the file.

```js
// Helper: independent brand grouping straight from fixtures.
function brandAsins(brandName) {
  return Object.values(pma).filter((a) => (ratings[a.asin]?.brand ?? "Unbranded") === brandName);
}

test("portfolio.brands: one entry per distinct brand present (+ Unbranded if any null-brand ASIN)", () => {
  const snap = build();
  const names = new Set(snap.portfolio.brands.map((b) => b.name));
  const expected = new Set(
    Object.values(pma).map((a) => ratings[a.asin]?.brand ?? "Unbranded")
  );
  assert.deepEqual(names, expected);
});

test("portfolio.brands: ratio-of-sums returnRate for a known brand", () => {
  const snap = build();
  // Pick the first brand that has sales in window.
  const brand = snap.portfolio.brands.find((b) => b.health !== "nodata");
  const aggs = brandAsins(brand.name);
  const sold = aggs.reduce((n, a) => n + a.unitsSoldWindow, 0);
  const ret = aggs.reduce((n, a) => n + a.unitsReturnedWindow, 0);
  const expected = sold === 0 ? null : (ret / sold) * 100;
  close(brand.returnRate, expected, 1e-6, `brand ${brand.name} returnRate`);
});

test("portfolio.brands: refundExposure = round(Σ refundLast)", () => {
  const snap = build();
  const brand = snap.portfolio.brands.find((b) => b.health !== "nodata");
  const aggs = brandAsins(brand.name);
  const expected = Math.round(aggs.reduce((n, a) => n + a.refundLast, 0) * 100) / 100;
  close(brand.refundExposure, expected, 1e-6, `brand ${brand.name} refundExposure`);
});

test("portfolio.brands: sorted worst-health-first", () => {
  const snap = build();
  const RANK = { bad: 0, warn: 1, good: 2, nodata: 3 };
  const ranks = snap.portfolio.brands.map((b) => RANK[b.health]);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] >= ranks[i - 1], "brands not in worst-first health order");
  }
});

test("portfolio.brands: each entry has the §5.3 shape", () => {
  const snap = build();
  for (const b of snap.portfolio.brands) {
    for (const k of ["id", "name", "health", "rating", "ratingDelta", "returnRate", "refundSpike", "refundExposure", "flagged", "trend"]) {
      assert.ok(k in b, `brand entry missing ${k}`);
    }
    assert.equal(b.trend.length, 12);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/build.test.js`
Expected: FAIL — `snap.portfolio.brands` is undefined.

- [ ] **Step 3: Implement `rollupBrand` + `rollupBrands`**

In `generator/build.js`, add a slug helper and the two functions (place near `rollupStore`):

```js
/** Brand name → stable slug id. */
function brandSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Roll up one brand from its pre-filtered pma ASIN aggregates + ratings.
 * Mirrors rollupStore (ratio-of-sums, weightedMean, classify, empty→nodata),
 * and additionally surfaces refundExposure = round(Σ refundLast).
 */
function rollupBrand(name, aggs, ratings, thresholds) {
  let soldWin = 0, retWin = 0, soldPri = 0, retPri = 0, refLast = 0, refPri = 0;
  const weekly = Array.from({ length: WEEKS }, () => ({ sold: 0, ret: 0 }));
  const ratingRows = [];

  for (const a of aggs) {
    soldWin += a.unitsSoldWindow;
    retWin += a.unitsReturnedWindow;
    soldPri += a.unitsSoldPrior;
    retPri += a.unitsReturnedPrior;
    refLast += a.refundLast;
    refPri += a.refundPrior;
    for (let w = 0; w < WEEKS; w++) {
      weekly[w].sold += a.weekly[w].unitsSold;
      weekly[w].ret += a.weekly[w].unitsReturned;
    }
    ratingRows.push(ratings[a.asin] ?? null);
  }

  const isEmpty = aggs.length === 0 || soldWin === 0;
  if (isEmpty) {
    return {
      id: brandSlug(name), name, health: "nodata",
      rating: null, ratingDelta: null, returnRate: null,
      refundSpike: null, refundExposure: round(refLast, 2), flagged: 0,
      trend: Array(WEEKS).fill(null),
    };
  }

  const returnRate = (retWin / soldWin) * 100;
  const refundSpike = refPri === 0 ? null : ((refLast - refPri) / refPri) * 100;
  const { mean: rating } = weightedMean(ratingRows, "reviewRating");
  const { mean: ratingDelta } = weightedMean(ratingRows, "reviewDelta");
  const trend = weekly.map((w) => (w.sold === 0 ? null : (w.ret / w.sold) * 100));
  const health = storeHealth({ returnRate, reviewRating: rating, reviewDelta: ratingDelta, refundSpike }, thresholds);

  const flagInputs = aggs.map((a) => ({
    returnRate: a.returnRate,
    refundSpike: a.refundSpike,
    reviewDelta: ratings[a.asin]?.reviewDelta ?? null,
  }));
  const flagged = flaggedCount(flagInputs, thresholds);

  return {
    id: brandSlug(name), name, health,
    rating: round(rating, 2), ratingDelta: round(ratingDelta, 2),
    returnRate, refundSpike, refundExposure: round(refLast, 2), flagged, trend,
  };
}

/**
 * Group ALL pma aggregates by brand (null → "Unbranded"), roll up each,
 * and sort worst-health-first (HEALTH_RANK then returnRate desc, nulls last).
 */
function rollupBrands(pma, ratings, thresholds) {
  const byBrand = new Map();
  for (const a of Object.values(pma)) {
    const name = ratings[a.asin]?.brand ?? "Unbranded";
    if (!byBrand.has(name)) byBrand.set(name, []);
    byBrand.get(name).push(a);
  }
  const brands = [...byBrand].map(([name, aggs]) => rollupBrand(name, aggs, ratings, thresholds));
  return brands.sort((a, b) => {
    const rank = HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
    if (rank !== 0) return rank;
    const ar = a.returnRate, br = b.returnRate;
    if (ar == null && br == null) return 0;
    if (ar == null) return 1;
    if (br == null) return -1;
    return br - ar;
  });
}
```

Then in `buildSnapshot`, after the portfolio rollup, attach brands:

```js
  const portfolio = rollupPortfolio(pma, ratings, storeResults, storeList.length, thresholds);
  portfolio.brands = rollupBrands(pma, ratings, thresholds);
```

(Leave `portfolio.verdict`/`ratingDelta` for Task 5.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/build.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add generator/build.js test/build.test.js
git commit -m "feat: brand rollup -> portfolio.brands[] (ratio-of-sums, worst-first)"
```

---

## Task 5: `portfolio.ratingDelta` + `portfolio.verdict`

**Files:**
- Modify: `generator/build.js` (`rollupPortfolio` + `buildSnapshot`)
- Test: `test/build.test.js`

**Ordering dependency (spec §6):** brands must exist before counting decliners, and decliners feed the verdict. Compute `brands` first, then `decliningBrands`, then `verdict`.

- [ ] **Step 1: Write failing tests**

Add to `test/build.test.js` (import `portfolioVerdict` at the top of the file from `../public/shared/classify.js`):

```js
import { portfolioVerdict } from "../public/shared/classify.js";

test("portfolio.ratingDelta: ratingCount-weighted reviewDelta over all rated ASINs", () => {
  const snap = build();
  let num = 0, den = 0;
  for (const a of Object.values(pma)) {
    const r = ratings[a.asin];
    if (!r || r.reviewDelta == null || r.ratingCount == null) continue;
    num += r.reviewDelta * r.ratingCount; den += r.ratingCount;
  }
  const expected = den === 0 ? null : num / den;
  if (expected === null) assert.equal(snap.portfolio.ratingDelta, null);
  else close(snap.portfolio.ratingDelta, expected, 1e-6, "portfolio.ratingDelta");
});

test("portfolio.verdict: shape + matches classify over computed inputs", () => {
  const snap = build();
  const v = snap.portfolio.verdict;
  assert.ok(["improving", "stable", "slipping"].includes(v.state));
  const decliners = snap.portfolio.brands.filter(
    (b) => b.ratingDelta != null && b.ratingDelta <= cfg.classification.ratingDrop
  ).length;
  assert.equal(v.decliningBrands, decliners);
  assert.equal(v.state, portfolioVerdict({ ratingDelta: snap.portfolio.ratingDelta, decliningBrands: decliners }, cfg.classification));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/build.test.js`
Expected: FAIL — `portfolio.ratingDelta` / `portfolio.verdict` undefined.

- [ ] **Step 3: Implement**

In `generator/build.js`, import the verdict fn at the top alongside the existing classify imports:

```js
import { storeHealth, asinFlags, flaggedCount, portfolioVerdict } from "../public/shared/classify.js";
```

In `rollupPortfolio`, add the weighted reviewDelta next to `avgRating` and include `ratingDelta` in the returned object:

```js
  const { mean: avgRating } = weightedMean(ratingRows, "reviewRating");
  const { mean: ratingDelta } = weightedMean(ratingRows, "reviewDelta");
  // ...
  return {
    returnRate, returnDelta, refundExposure, flaggedCount: flagged,
    avgRating, ratingDelta: round(ratingDelta, 2), storeCount, trend,
    conv: Array(WEEKS).fill(null), leaderboard,
  };
```

In `buildSnapshot`, after attaching `portfolio.brands`, compute the verdict:

```js
  portfolio.brands = rollupBrands(pma, ratings, thresholds);
  const decliningBrands = portfolio.brands.filter(
    (b) => b.ratingDelta != null && b.ratingDelta <= thresholds.ratingDrop
  ).length;
  portfolio.verdict = {
    state: portfolioVerdict({ ratingDelta: portfolio.ratingDelta, decliningBrands }, thresholds),
    ratingDelta: portfolio.ratingDelta,
    decliningBrands,
  };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/build.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add generator/build.js test/build.test.js
git commit -m "feat: portfolio ratingDelta + verdict (brands -> decliners -> verdict)"
```

---

## Task 6: Schema validation for the new fields

**Files:**
- Modify: `generator/schema.js`
- Test: `test/schema.test.js`

**CRITICAL — how `schema.test.js` actually works:** it does **not** call `buildSnapshot` and has **no** `validSnapshot()` helper. It loads the committed fixture `test/fixtures/data.sample.json` via `readFileSync` into `const good`, and every test does `const bad = structuredClone(good); delete bad.<path>; assert.equal(validate(bad).ok, false)`. The fixture currently has **no** `verdict`/`ratingDelta`/`brands` and only 6 thresholds. Therefore: once the schema requires the new fields, the existing `"valid snapshot passes"` test will go RED until `data.sample.json` is regenerated. **Both** the fixture (`test/fixtures/data.sample.json`) and `public/data.json` must be regenerated in this task (Step 5), and the new tests must follow the `structuredClone(good)` pattern — do NOT invent a `validSnapshot()` helper.

- [ ] **Step 1: Regenerate the `good` fixture FIRST**

The new "valid passes" path needs an enriched fixture. Regenerate `test/fixtures/data.sample.json` from the test fixtures using the same imports as `test/build.test.js` (write a tiny throwaway ESM script that builds the snapshot from `pma-economics.sample.json` + `baserow-691.sample.json` + the configs and writes the result, then delete the script). The regenerated fixture must contain `portfolio.verdict`, `portfolio.ratingDelta`, `portfolio.brands[]`, and `thresholds.ratingRise`.

- [ ] **Step 2: Write failing tests (structuredClone pattern)**

Add to `test/schema.test.js`:

```js
test("missing portfolio.verdict fails", () => {
  const bad = structuredClone(good);
  delete bad.portfolio.verdict;
  assert.equal(validate(bad).ok, false);
});
test("missing portfolio.brands fails", () => {
  const bad = structuredClone(good);
  delete bad.portfolio.brands;
  assert.equal(validate(bad).ok, false);
});
test("missing portfolio.ratingDelta fails", () => {
  const bad = structuredClone(good);
  delete bad.portfolio.ratingDelta;
  assert.equal(validate(bad).ok, false);
});
test("missing thresholds.ratingRise fails", () => {
  const bad = structuredClone(good);
  delete bad.thresholds.ratingRise;
  assert.equal(validate(bad).ok, false);
});
test("a brand entry missing health fails", () => {
  const bad = structuredClone(good);
  delete bad.portfolio.brands[0].health;
  assert.equal(validate(bad).ok, false);
});
```

The existing `"valid snapshot passes"` test now also exercises the new required fields (because `good` carries them after Step 1).

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/schema.test.js`
Expected: FAIL — the new `delete → expect false` cases still pass validation because the fields aren't required yet (and/or `"valid snapshot passes"` fails if Step 1's fixture has fields the schema's `additionalProperties:false` blocks — that's resolved in Step 4).

- [ ] **Step 4: Implement schema additions**

In `generator/schema.js`:

Add `ratingRise` to `thresholdsSchema` (both `required` and `properties: { ratingRise: num }`).

Add a brand-item sub-schema:

```js
const brandItemSchema = {
  type: "object",
  required: ["id", "name", "health", "rating", "ratingDelta", "returnRate", "refundSpike", "refundExposure", "flagged", "trend"],
  properties: {
    id: str,
    name: str,
    health: { type: "string", enum: ["good", "warn", "bad", "nodata"] },
    rating: numOrNull,
    ratingDelta: numOrNull,
    returnRate: numOrNull,
    refundSpike: numOrNull,
    refundExposure: num,
    flagged: num,
    trend: { type: "array", items: numOrNull },
  },
};

const verdictSchema = {
  type: "object",
  required: ["state", "ratingDelta", "decliningBrands"],
  properties: {
    state: { type: "string", enum: ["improving", "stable", "slipping"] },
    ratingDelta: numOrNull,
    decliningBrands: num,
  },
  additionalProperties: false,
};
```

In `portfolioSchema`, add `ratingDelta`, `verdict`, `brands` to `required` and to `properties`:

```js
    ratingDelta: numOrNull,
    verdict: verdictSchema,
    brands: { type: "array", items: brandItemSchema },
```

- [ ] **Step 5: Run to verify pass + full suite**

Run: `node --test test/schema.test.js` then `npm test`
Expected: PASS (all suites, including the existing `"valid snapshot passes"` against the regenerated fixture).

- [ ] **Step 6: Regenerate `public/data.json` for the frontend tasks**

The frontend tasks need an enriched `public/data.json`. If `BASEROW_TOKEN`/`PMA_API_TOKEN` are available, run `npm run build`. Otherwise reuse the throwaway-script approach from Step 1 (same `buildSnapshot` imports) to emit `public/data.json` from the fixtures, then delete the script. Verify it validates:

Run: `node --input-type=module -e "import {validate} from './generator/schema.js'; import {readFileSync} from 'fs'; console.log(validate(JSON.parse(readFileSync('public/data.json'))))"`
Expected: `{ ok: true, errors: [] }`

- [ ] **Step 7: Commit**

```bash
git add generator/schema.js test/schema.test.js test/fixtures/data.sample.json public/data.json
git commit -m "feat: schema for portfolio verdict, ratingDelta, brands[]"
```

---

## Task 7: Frontend — pinned verdict header + tab scaffold

**Files:**
- Modify: `public/index.html`
- Test: `tests-e2e/frontend.smoke.spec.js`

**Note on the frontend:** `public/index.html` is a single vanilla HTML/JS file that fetches `data.json` and uses `classify.js` for live recompute. Keep that structure. These tasks are verified by Playwright behavior assertions; visual structure is confirmed by running. Read the existing file first to match its render/recompute pattern (look at how it loads `data.json`, applies `DEFAULT_THRESHOLDS`, and re-renders on threshold change).

- [ ] **Step 1: Write the failing smoke test**

Add to `tests-e2e/frontend.smoke.spec.js`:

```js
test("renders pinned verdict header with state + portfolio KPIs", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="verdict-state"]')).toBeVisible();
  await expect(page.locator('[data-testid="kpi-rating"]')).toBeVisible();
  await expect(page.locator('[data-testid="kpi-returnrate"]')).toBeVisible();
  await expect(page.locator('[data-testid="kpi-refundexposure"]')).toBeVisible();
  // Reuse the EXISTING flagged KPI testid — do not rename it (Phase 1 smoke depends on it).
  await expect(page.locator('[data-testid="flagged-kpi-val"]')).toBeVisible();
});

test("has three tabs; clicking switches the active panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="tab-briefing"]')).toHaveClass(/active/);
  await page.locator('[data-testid="tab-brands"]').click();
  await expect(page.locator('[data-testid="panel-brands"]')).toBeVisible();
  await expect(page.locator('[data-testid="panel-briefing"]')).toBeHidden();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run smoke`
Expected: FAIL — testids not present.

- [ ] **Step 3: Implement the header + tab scaffold**

Rework `public/index.html`: add the pinned verdict header (state from `portfolio.verdict.state` with ↑/—/↓ glyph + color, portfolio `avgRating` + `ratingDelta`, one-line summary) and the KPI strip (rating+trajectory, return rate, refund exposure $, flagged count) with the `data-testid`s above. **Preserve the existing `flagged-kpi-val` testid** for the flagged KPI (the Phase 1 smoke test at `tests-e2e/frontend.smoke.spec.js` references it); reuse the current KPI-render code rather than renaming. Add a tab bar (`tab-briefing`, `tab-brands`, `tab-rank`) and three panels (`panel-briefing`, `panel-brands`, `panel-rank`), Briefing active by default. Keep the existing `data.json` fetch + `classify.js` import; the verdict state must derive via `portfolioVerdict(...)` on the client so it recomputes live (Task 11).

- [ ] **Step 4: Run to verify pass**

Run: `npm run smoke`
Expected: PASS for the two new tests (plus existing smoke tests still green).

- [ ] **Step 5: Commit**

```bash
git add public/index.html tests-e2e/frontend.smoke.spec.js
git commit -m "feat(ui): pinned verdict header + 3-tab scaffold"
```

---

## Task 8: Frontend — Briefing tab (derived callouts)

**Files:**
- Modify: `public/index.html`
- Test: `tests-e2e/frontend.smoke.spec.js`

- [ ] **Step 1: Write the failing smoke test**

```js
test("briefing lists callouts derived from brand health (no nodata callouts)", async ({ page }) => {
  await page.goto("/");
  const callouts = page.locator('[data-testid="callout"]');
  await expect(callouts.first()).toBeVisible();
  // every callout names a brand and carries a bucket pill
  await expect(page.locator('[data-testid="callout-bucket"]').first()).toBeVisible();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run smoke`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the Briefing panel, render one callout per brand from `portfolio.brands[]`, bucketed by health: `bad`→Worst, `warn`→Watch, `good`→OK; **omit `nodata`**. Each callout text is derived (brand name + rating Δ + return rate + refund spike + flagged count). Generate client-side so it recomputes when thresholds change.

- [ ] **Step 4: Run to verify pass**

Run: `npm run smoke`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/index.html tests-e2e/frontend.smoke.spec.js
git commit -m "feat(ui): briefing tab with derived brand callouts"
```

---

## Task 9: Frontend — All Brands cockpit grid

**Files:**
- Modify: `public/index.html`
- Test: `tests-e2e/frontend.smoke.spec.js`

- [ ] **Step 1: Failing test**

```js
test("brands tab shows one health-colored card per brand", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="tab-brands"]').click();
  const cards = page.locator('[data-testid="brand-card"]');
  await expect(cards.first()).toBeVisible();
  // count matches portfolio.brands length from the served data.json
  const data = await page.evaluate(() => fetch("/data.json").then(r => r.json()));
  await expect(cards).toHaveCount(data.portfolio.brands.length);
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run smoke`
- [ ] **Step 3: Implement** the card grid in `panel-brands`: one `brand-card` per `portfolio.brands[]` entry, health-colored, showing rating + trajectory + return rate (+ refund spike when flagged).
- [ ] **Step 4: Run — expect PASS.** `npm run smoke`
- [ ] **Step 5: Commit**

```bash
git add public/index.html tests-e2e/frontend.smoke.spec.js
git commit -m "feat(ui): all-brands cockpit grid"
```

---

## Task 10: Frontend — Rankings table + Brand|Store toggle

**Files:**
- Modify: `public/index.html`
- Test: `tests-e2e/frontend.smoke.spec.js`

- [ ] **Step 1: Failing test**

```js
test("rankings table renders brand rows; toggle switches to store grouping", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="tab-rank"]').click();
  await expect(page.locator('[data-testid="rank-row"]').first()).toBeVisible();
  await page.locator('[data-testid="groupby-store"]').click();
  const data = await page.evaluate(() => fetch("/data.json").then(r => r.json()));
  await expect(page.locator('[data-testid="rank-row"]')).toHaveCount(data.portfolio.leaderboard.length);
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run smoke`
- [ ] **Step 3: Implement** the Rankings table in `panel-rank` with the §5.3 brand columns, plus a group-by toggle (`groupby-brand` default / `groupby-store`). Brand grouping reads `portfolio.brands[]`; store grouping reads `portfolio.leaderboard` (+ `stores[]`). Each `rank-row` is clickable (the drawer is wired in Task 12 — here, just ensure each row carries its brand/store id as a data attribute).
- [ ] **Step 4: Run — expect PASS.** `npm run smoke`
- [ ] **Step 5: Commit**

```bash
git add public/index.html tests-e2e/frontend.smoke.spec.js
git commit -m "feat(ui): rankings table + brand|store group-by toggle"
```

---

## Task 11: Frontend — live threshold recompute across all tabs

**Files:**
- Modify: `public/index.html`
- Test: `tests-e2e/frontend.smoke.spec.js`

This preserves the Phase 1 "live override without refetch" behavior (Phase 1 spec §12), now extended to the verdict, brand health, and briefing.

- [ ] **Step 1: Failing test**

**Use the EXISTING threshold controls** (confirmed in `index.html`): a settings drawer opened by `#settingsBtn`, containing `input[data-key="<thresholdKey>"]` fields that apply **live on `oninput`** (instant re-render, no apply button). Do not invent `threshold-*` testids.

```js
test("tightening ratingDrop re-derives verdict WITHOUT an extra data.json fetch", async ({ page }) => {
  let dataFetches = 0;
  page.on("request", (r) => { if (r.url().includes("data.json")) dataFetches += 1; });
  await page.goto("/");
  await expect(page.locator('[data-testid="verdict-state"]')).toBeVisible();
  const fetchesAfterLoad = dataFetches;            // baseline (initial load)

  await page.locator("#settingsBtn").click();      // open settings drawer
  const drop = page.locator('input[data-key="ratingDrop"]');
  await drop.fill("-0.01");                          // tightens "declining" → likely flips toward slipping
  await drop.dispatchEvent("input");                // ensure oninput fires

  // No new data.json fetch was triggered by the threshold change (live recompute).
  expect(dataFetches).toBe(fetchesAfterLoad);
  // verdict still renders a valid state after recompute
  await expect(page.locator('[data-testid="verdict-state"]')).toBeVisible();
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run smoke`
- [ ] **Step 3: Implement** — route all rendering through the in-memory snapshot + current thresholds, re-rendering on override change, no refetch. **Critical:** the shipped `portfolio.brands[]` and `portfolio.verdict` are frozen at the build-time thresholds, so live recompute must **rebuild brand aggregates client-side** from `stores[].asins` (group ASINs by `brand`, ratio-of-sums for returnRate/refundSpike, `ratingCount`-weighted `rating` + `ratingDelta`, `storeHealth` for health, `flaggedCount` for flags). Then `decliningBrands = count(brand.ratingDelta <= thresholds.ratingDrop)` and the verdict = `portfolioVerdict({ ratingDelta: <weighted reviewDelta over all ASINs>, decliningBrands }, thresholds)`. Reading the static `portfolio.brands[].ratingDelta` would make `decliningBrands` immovable and the "verdict recomputes live" assertion hollow. Brand health (All Brands grid), briefing buckets, and flags all derive from these recomputed aggregates so overrides take effect everywhere.

  Note: extract the brand-aggregation logic into a small client helper so it is the single source of truth for the All Brands grid, Rankings table, briefing, and verdict (DRY) — the build-time `data.json` brands become the first render, then this helper takes over on any threshold change.
- [ ] **Step 4: Run — expect PASS.** `npm run smoke`
- [ ] **Step 5: Commit**

```bash
git add public/index.html tests-e2e/frontend.smoke.spec.js
git commit -m "feat(ui): live threshold recompute for verdict/brands/briefing"
```

---

## Task 12: Frontend — brand detail drawer + Warehouse placeholder

**Files:**
- Modify: `public/index.html`
- Test: `tests-e2e/frontend.smoke.spec.js`

- [ ] **Step 1: Failing test**

```js
test("clicking a ranking row opens the detail drawer with that brand's ASINs", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="tab-rank"]').click();
  await page.locator('[data-testid="rank-row"]').first().click();
  await expect(page.locator('[data-testid="drawer"]')).toBeVisible();
  await expect(page.locator('[data-testid="drawer-asin"]').first()).toBeVisible();
});

test("warehouse QA placeholder is present and inert", async ({ page }) => {
  await page.goto("/");
  const ph = page.locator('[data-testid="warehouse-placeholder"]');
  await expect(ph).toBeVisible();
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run smoke`
- [ ] **Step 3: Implement** the drawer (slides in for the clicked brand/store; lists ASINs filtered from `stores[].asins` by brand — title, rating, return rate, refund spike, flags — plus a mini 12-week trend from the brand `trend`). **Note:** the existing settings panel already uses `#drawer`; give this brand-detail drawer a distinct element/testid (`[data-testid="drawer"]` on a separate node) so the two never collide. Add the inert Warehouse QA placeholder (disabled 4th tab or footer marker). Wire the Task 10 row click to open the drawer.
- [ ] **Step 4: Run full suites.**

Run: `npm test && npm run smoke`
Expected: PASS (all unit + smoke).

- [ ] **Step 5: Commit**

```bash
git add public/index.html tests-e2e/frontend.smoke.spec.js
git commit -m "feat(ui): brand detail drawer + warehouse-QA placeholder"
```

---

## Done criteria

- `npm test` green (classify, build, schema unit tests including new brand/verdict cases).
- `npm run smoke` green (verdict header, 3 tabs, briefing, brand grid, rankings + toggle, live recompute without refetch, drawer, placeholder).
- `public/data.json` validates against the extended schema and carries `portfolio.verdict`, `portfolio.ratingDelta`, `portfolio.brands[]`.
- Existing store rollup/leaderboard untouched and still feeding the store toggle.
- No workflow/acknowledgement features, no conversion, no warehouse data — only the inert placeholder.
