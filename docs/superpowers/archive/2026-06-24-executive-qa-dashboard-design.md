> ⚠️ **ARCHIVED.** This is the design spec that drove the shipped Phase 1 executive dashboard. Phase 1 is now live and has drifted from some details here (auth is Google OAuth; host is a Cloudflare Worker). For the **current** system state, see [`README.md`](../../../README.md) and [`DEPLOY.md`](../../../DEPLOY.md). Retained as historical design provenance.

# Executive QA Dashboard — Design

**Date:** 2026-06-24
**Status:** Approved (design), pending implementation plan
**Builds on:** `2026-06-23-qa-dashboard-live-data-design.md` (the live-data generator + snapshot pipeline, "Phase 1")

## 1. Purpose

Reframe the QA dashboard from an analyst-style data view into a **C-level quality-awareness page**. Same Amazon marketplace user-input data (returns, refunds, reviews), reorganized to answer one executive question: *is product quality getting better or worse, where is it bleeding, and what needs attention?*

This is the **start of an all-in-one QA page**. Today it covers **marketplace user-input QA** (what customers tell us is wrong, via Amazon). A second section for **in-house Warehouse QA** (what we catch before the customer) is planned for a later phase and must slot in without restructuring. The two halves form one quality funnel; this spec builds the first half and reserves the seam for the second.

## 2. Scope

**In scope**
- Brand as the primary breakdown dimension (the "spine").
- A rating-trajectory **verdict** as the top-of-page headline.
- Tabbed presentation: pinned verdict + three views (Briefing, All Brands, Rankings).
- Brand drill-down via a detail drawer.
- A Brand | Store group-by toggle in the Rankings view.
- Generator changes to produce brand-level rollups and the verdict.

**Out of scope (YAGNI)**
- Any workflow, acknowledgement, assignment, or note-taking features. The page is **read-only awareness**.
- Conversion metrics (sessions remain unavailable in Phase 1 → `conversion` stays `null`).
- Warehouse QA data. Only a labeled, inert placeholder marks where it will live.
- No change to data sources, refresh cadence, or auth — this is a presentation + rollup change on top of the existing pipeline.

## 3. Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Primary job | Awareness only (read-only) |
| North-star signal | Review rating trajectory (level + direction) |
| Breakdown spine | By brand (~9 brands, 96% ASIN coverage; unbranded → "Unbranded") |
| Supporting "why" metrics | Return rate, refund spike, refund $ exposure |
| Layout | Pinned verdict header + 3 tabs |
| Brand drill-down | Detail drawer (panel) |
| Store view | Group-by toggle (Brand \| Store) within Rankings |

## 4. Architecture overview

The existing pipeline is unchanged in shape:

```
Baserow (ratings) ─┐
                   ├─► aggregatePma / normalizeBaserow ─► buildSnapshot ─► validate ─► public/data.json ─► public/index.html
PMA (economics) ──┘                                                                                          (live recompute via classify.js)
```

Changes are additive:
- `build.js` gains a **brand rollup** and a **verdict**, alongside the existing store rollup (which is retained to feed the store toggle).
- `schema.js` gains schema for the new `portfolio.verdict`, `portfolio.ratingDelta`, and `portfolio.brands[]`.
- `classify.js` gains a **`portfolioVerdict`** function (dual-use, so the browser's live-threshold recompute keeps working).
- `index.html` is reworked into the tabbed app.

The two invariants from Phase 1 still hold and must not drift:
1. **Ratio-of-sums** — every rate is `Σreturned / Σsold` over the group, never a mean of per-ASIN rates.
2. **Empty group → "nodata"** — a brand/store with no matching ASINs or `Σ unitsSoldWindow === 0` is forced to `health: "nodata"` with null KPIs.

## 5. Data model changes (`data.json` contract)

All additions are under `portfolio`. Existing fields (`stores[]`, `portfolio.leaderboard`, etc.) are **unchanged** so nothing downstream breaks.

### 5.1 `portfolio.ratingDelta` (new)
ratingCount-weighted mean of per-ASIN `reviewDelta` across all rated ASINs (via the existing `weightedMean`). Nullable. This is the numeric basis for the verdict.

### 5.2 `portfolio.verdict` (new)
```jsonc
{
  "state": "improving" | "stable" | "slipping",
  "ratingDelta": <number|null>,     // mirror of portfolio.ratingDelta, for convenience
  "decliningBrands": <number>       // count of brands with ratingDelta <= ratingDrop
}
```

### 5.3 `portfolio.brands[]` (new)
One entry per brand, worst-health-first (same sort as the store leaderboard: `HEALTH_RANK` then `returnRate` desc, nulls last):
```jsonc
{
  "id": "<slug>",            // brand slug
  "name": "WHYZ",
  "health": "good"|"warn"|"bad"|"nodata",
  "rating": <number|null>,        // ratingCount-weighted
  "ratingDelta": <number|null>,   // ratingCount-weighted
  "returnRate": <number|null>,
  "refundSpike": <number|null>,
  "refundExposure": <number>,     // Σ refundLast for the brand, $
  "flagged": <number>,            // flagged ASIN count
  "trend": [<number|null> × 12]   // weekly return-rate buckets (ratio-of-sums)
}
```

Per-ASIN entries already carry `brand`, so the drawer's ASIN list is filtered client-side from `stores[].asins` by brand (no new per-ASIN fields needed).

## 6. Verdict logic (`classify.js`, dual-use)

New pure function, defined once and imported by both `build.js` and the browser:

```js
export function portfolioVerdict(p, t) {
  // p: { ratingDelta, decliningBrands }, t: thresholds
  if ((p.ratingDelta != null && p.ratingDelta <= t.ratingDrop) || p.decliningBrands >= 2) return "slipping";
  if (p.ratingDelta != null && p.ratingDelta >= 0.1) return "improving";
  return "stable";
}
```

- "Slipping" — portfolio rating trajectory at/below the `ratingDrop` threshold (−0.2), **or** two-plus brands individually declining.
- "Improving" — portfolio rating up by ≥ 0.1.
- "Stable" — everything in between, including `ratingDelta === null` (no rating data).

The `0.1` improving cutoff is the one literal not currently in `thresholds.json`. It will be added as `thresholds.classification.ratingRise` so it is configurable and flows through the existing live-recompute path.

A brand is **"declining"** when its brand-level `ratingDelta <= ratingDrop`. Note the field name: brand entries expose `ratingDelta` (§5.3); the per-ASIN field of the same value is `reviewDelta`. Use the brand field. `decliningBrands` (§5.2) is therefore a count over `portfolio.brands[]`, which forces an **ordering dependency**: `rollupBrands` must run first, then `decliningBrands` is counted, then `portfolioVerdict` is evaluated. The implementation plan must sequence these.

## 7. Brand rollup (`build.js`)

New `rollupBrand(brandName, aggs, ratings, thresholds)` mirrors `rollupStore`, grouping by `ratings[asin].brand` instead of `accountId`:
- ASINs with `brand == null` collect into a single `"Unbranded"` bucket.
- Reuses `weightedMean` (rating, ratingDelta), ratio-of-sums (returnRate, refundSpike, weekly trend), `flaggedCount`, and `storeHealth` (the health rule is metric-shaped, not store-specific, so it applies unchanged).
- **Must surface `Σ refundLast`** as the brand's `refundExposure`. `rollupStore` already sums `refLast` internally but discards it (it only emits `refundSpike`); `rollupBrand` keeps it.
- Empty/zero-sales brand → `nodata`.

A `rollupBrands(...)` driver builds the set of brands from the distinct `brand` values present in the joined data, then sorts worst-first into `portfolio.brands[]`. `portfolio.ratingDelta` and `portfolio.verdict` are computed in `rollupPortfolio` (which already aggregates across all ASINs).

## 8. Schema changes (`schema.js`)

Add required schema for `portfolio.ratingDelta` (nullable number), `portfolio.verdict` (object with `state` enum, `ratingDelta` nullable, `decliningBrands` number), and `portfolio.brands[]` (array of brand items, fields per §5.3). Following the Phase 1 rule, every client-recompute input asserts **presence** (required), with `null` allowed for nullable numbers. The new `thresholds.ratingRise` becomes a required threshold field.

## 9. Frontend (`public/index.html`)

Reworked into the tabbed app. `classify.js` continues to drive live threshold recompute across all tabs (the existing "live override without refetch" behavior is preserved — see Phase 1 §12 smoke test).

- **Pinned verdict header (always visible)**
  - Verdict state with direction glyph (Improving ↑ / Stable — / Slipping ↓), colored.
  - Portfolio rating + trajectory (`avgRating` `ratingDelta`), one-line summary.
  - KPI strip: avg rating + trajectory, return rate, refund exposure $, flagged ASIN count.
- **Tab — Briefing** (default): auto-generated plain-language callouts from the worst brands. Each callout is derived, not authored: brand name + what moved (rating Δ, return rate, refund spike) + flagged count. Bucketing maps from brand health: `bad` → **Worst**, `warn` → **Watch**, `good` → **OK**; `nodata` brands are omitted from callouts (no signal to report). Generated client-side from `portfolio.brands[]` + flags so it recomputes live with threshold changes.
- **Tab — All Brands**: cockpit card grid, one card per brand, health-colored, showing rating + trajectory + return rate (+ refund spike when flagged).
- **Tab — Rankings**: sortable brand table (the columns of §5.3) with a **group-by: Brand | Store** toggle. Store grouping reuses the existing `portfolio.leaderboard` + `stores[]`. Clicking a row opens the detail drawer.
- **Detail drawer**: slides in for the clicked brand (or store), listing its ASINs (title, rating, return rate, refund spike, flags) and a mini 12-week trend. ASINs filtered from `stores[].asins`.
- **Warehouse QA placeholder**: an inert, labeled section (e.g. a disabled 4th tab or a footer marker) indicating where Phase 2 lands. No data, no logic.

## 10. Testing

- **Unit (`node --test`)**: `rollupBrand` ratio-of-sums and weighting; unbranded bucketing; empty-brand → nodata; `portfolioVerdict` across the improving/stable/slipping boundaries (including null ratingDelta and the ≥2-declining-brands trigger).
- **Schema**: snapshot validates with the new required fields; missing any new field fails validation.
- **Playwright smoke (extends Phase 1 §12)**: page renders with verdict + 3 tabs; tab switching works; threshold live-override re-classifies brands and re-derives the briefing **without** refetching `data.json`; drawer opens with brand ASINs.

## 11. Risks / notes

- **Brand ↔ store is not strictly 1:1** — some stores hold multiple brands (e.g. body and mind → OPTML, Purisure, TreeActiv). Brand rollup must group purely by the Baserow `brand` field, independent of `accountId`, so a multi-brand store splits correctly and the Brand and Store views legitimately differ.
- **Unbranded tail** (~4% of ASINs) must remain visible as an "Unbranded" group, never silently dropped.
- **Verdict cutoffs** (`ratingDrop`, `ratingRise`, decliningBrands ≥ 2) are deliberately simple and threshold-driven. They are config, not code, so they can be tuned without a redeploy.
