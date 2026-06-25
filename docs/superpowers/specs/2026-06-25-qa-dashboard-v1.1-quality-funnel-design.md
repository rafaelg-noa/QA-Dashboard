# QA Dashboard v1.1 — Quality Funnel + Live Conversion & Rating Trajectory (Design)

**Date:** 2026-06-25
**Status:** Approved (design), pending implementation plan
**Builds on:** the shipped Phase 1 executive dashboard (see `README.md`; archived design in `docs/superpowers/archive/2026-06-24-executive-qa-dashboard-design.md`).

## 1. Purpose

Make the dashboard the visible surface of Novaeo's **Quality Information Flow** — the funnel of post-purchase customer-experience signals (returns/refunds, reviews, seller feedback, CS inquiries, social) that converge into "all customer experience data" and produce a quality verdict. v1.1 reorganizes the dashboard around that funnel and lights up the signals we already have but don't yet use. It does **not** start the physical/warehouse half (v2).

The reference is Novaeo's "Quality Information Flow Diagram": **Cx Inputs → Customer Identification → Customer Follow-Up (diagnose: puncture/seal/formula) → Cx Data Collection → (this dashboard)**, with Batch Testing feeding in from the physical side.

## 2. Scope

**In scope**
- A new **Quality Funnel** overview — a live map of the funnel, each node showing a status (`live` / `partial` / `coming-soon` / `future`), a headline metric + sparkline when live, and a click-through to the relevant existing view.
- **Conversion, live** — read sessions/traffic from Baserow and populate the conversion KPI + trend (today it is `n/a`).
- **Rich rating trajectory** — read the historical ratings time-series from Baserow so the north-star verdict rests on a real multi-period trend, not a two-point delta.
- **Return-reason / defect breakdown** — built against a defined Baserow contract + fixtures, surfaced in the brand/store detail drawer and the funnel's Returns node. Degrades to `coming-soon` until its source table exists.
- Advance the **single-source-of-truth** architecture: ratings and conversion read from Baserow.

**Out of scope (YAGNI)**
- Any workflow/acknowledgement/assignment features. The page stays **read-only awareness**. The funnel's Identification and Follow-Up nodes are shown as part of the story; we do not build the work they represent.
- The **puncture/seal/formula** taxonomy. v1.1 surfaces Amazon's own return reasons + customer comments; the Novaeo taxonomy is a fast-follow.
- Wiring **CS/Gorgias** and **seller feedback** data (no Baserow source yet — they remain `coming-soon` nodes).
- Migrating **returns/refunds** off the PMA-direct pull (no Baserow source yet — see §4).
- **Social** channel (the flow diagram itself marks it "future").
- Phase 2 / Warehouse QA (physical assets).

## 3. Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| What v1.1 represents | The whole Cx quality funnel, as a dedicated overview |
| Funnel placement | A new top-level **Quality Funnel** view; existing verdict + Brands/Rankings tabs become its drill-downs |
| Node status model | `live` / `partial` / `coming-soon` / `future`; a node is `live` exactly when its Baserow source exists and has rows |
| Headline v1.1 wins | Conversion (Baserow `#872`) + rating trajectory (Baserow `#862`) — both available now |
| Return reasons | Coarse Amazon reason codes + customer comments first; puncture/seal/formula taxonomy = fast-follow |
| Defect breakdown placement | Brand/store detail drawer + funnel Returns node |
| Source of truth | Baserow (target). Read ratings + conversion from Baserow now; keep returns/refunds on PMA-direct until a Baserow source lands |
| Cx Data Collection downstream | This dashboard is the funnel's terminal/output node |

## 4. Architecture

The pipeline shape is unchanged: sources → `generator/` → `public/data.json` → `public/index.html` (live recompute via `shared/classify.js`).

**Source strategy — incremental migration toward "Baserow is the single source of truth":**

| Signal | v1.1 source | Notes |
|---|---|---|
| Catalog, brand, listing status | Baserow `#691` (today) | unchanged |
| **Review rating + trajectory** | **Baserow `#862`** (new) | ASIN×Date star + count; replaces the `#691` two-point delta as the trend basis (`#691` still used for catalog/brand) |
| **Conversion (sessions)** | **Baserow `#872`** (new) | Store×ASIN×Date units/sessions/page-views; was `n/a` |
| Returns / refunds (counts) | **PMA-direct (unchanged)** | No Baserow source yet. **Do not remove the working PMA pull.** Migrate only when a Baserow returns table exists. |
| Return reasons + comments | **Baserow contract + fixtures** | No source yet; UI/aggregation built to a contract, lights up when ingested |

**Sequencing guard:** never remove a live feed before its Baserow replacement exists and validates. The returns/refunds PMA pull (`generator/pma.js → fetchPma`) stays exactly as-is in v1.1.

**Invariants from Phase 1 that must not drift:**
1. **Ratio-of-sums** — every rate is `Σ / Σ` over the group, never a mean of per-ASIN rates. (Conversion = `Σ units / Σ sessions`; rating uses the existing ratingCount-weighted mean.)
2. **Empty group → `nodata`** — a brand/store with no matching ASINs or zero denominator is `health: "nodata"` with null KPIs.
3. **Honest live recompute** — rates that are ratio-of-sums are build-time facts; the browser recomputes only health/flags/verdict from thresholds, never the rates.

## 5. Data contracts

### 5.1 Ratings trajectory — Baserow `#862`
Fields: `ASIN`, `Date`, `Star Rating`, `Review Count` (nullable on older rows), `Source` (`csv` historical / `scraper` current). ~64k rows, daily, back to 2019.

- Per ASIN: take the latest rating as current; the rating as of `asOf − windowDays` (nearest prior row) as previous → `reviewDelta`. Build the 12-week trend from weekly-bucketed latest-in-bucket ratings.
- Null `Review Count` → fall back to `#691` rating count for weighting, else weight 1. Null star rating rows are skipped.
- `#691` remains the source for current rating where `#862` lacks a recent row, so no ASIN regresses to null. (Reconciliation rule to be finalized in the plan.)

### 5.2 Conversion — Baserow `#872`
Fields: `Store`, `ASIN`, `Date`, `Units`, `Revenue`, `Sessions`, `Page Views`. Sessions/Page-Views populated for current data (null on some historical rows).

- Conversion (window) = `Σ Units / Σ Sessions` over the window per ASIN, rolled up ratio-of-sums to store/brand/portfolio. Null when `Σ Sessions == 0` (keeps the `nodata`/null discipline).
- **Store alias map (required):** `#872.Store` uses labels (`BnM`, `Kreativ`, …) that match neither `id`, `name`, nor `accountId` in `config/stores.json`. Add a `baserowStore` alias (string or list) to each store entry; the plan enumerates `#872`'s distinct `Store` values and maps each to a store `id`. Unmapped stores are logged, not silently dropped.
- Units here are an independent sales figure from `#872`; returns/refunds continue to come from PMA. Conversion does not depend on the PMA pull.

### 5.3 Return reasons — Baserow contract (source not yet present)
Define the table the SP-API FBA Customer Returns ingestion should land (research-confirmed obtainable: `order-id`, `reason`, `customer-comments`, disposition). Proposed contract:

| Field | Type | Purpose |
|---|---|---|
| `ASIN` | string | join to catalog/store/brand |
| `Return Date` | date | windowing |
| `Reason` | string (Amazon reason code/label) | the breakdown dimension |
| `Customer Comment` | string (nullable) | free-text, for later taxonomy/NLP |
| `Disposition` | string (nullable) | sellable/defective/etc. |
| `Order ID` | string | dedup/trace |
| `Store` | string | uses the same alias map as §5.2 |

Aggregation: `reason → count / %` per ASIN, rolled up to brand/store/portfolio over the window. Absent/empty table → the defect breakdown renders `coming-soon`.

## 6. Snapshot (`public/data.json`) changes

Additive only; existing fields unchanged.
- `conversion` populated (portfolio, per store, per brand) where `#872` has sessions; null otherwise.
- Rating fields fed from `#862` (richer trend array); `ratingDelta`/`verdict` semantics unchanged.
- New `returnReasons` breakdown (portfolio + per brand/store), present only when the source table exists.
- A small `funnel` section describing each node's `status` and headline metric, so the overview renders from data, not hard-coded assumptions. Status derives from "does this Baserow source have rows."

## 7. Frontend (`public/index.html`)

- **Quality Funnel overview** (new top-level view): renders the funnel left-to-right/top-to-bottom — Cx Inputs (Returns, Reviews `live`; Seller Feedback, CS `coming-soon`; Social `future`) → Identification & Follow-Up (ops/process nodes, shown not computed) → Cx Data Collection → Verdict. Each node: status chip, headline number + sparkline when live, click-through to the matching existing view.
- **Conversion** surfaces in the existing KPI areas/trend (no longer `n/a`) and as the Cx Data Collection / Reviews-adjacent metric where appropriate.
- **Rating trajectory** powers the verdict header and brand/store trends as a real multi-period line.
- **Defect breakdown**: "why they're returning" mini-bars in the brand/store detail drawer; the funnel Returns node shows the top reasons. Renders `coming-soon` until the source exists.
- Live recompute (`computeBrands`) continues to drive verdict/brands/briefing from thresholds; new rates are build-time facts.

## 8. Testing

- **Unit:** conversion aggregation (ratio-of-sums, null/empty sessions), rating-trajectory derivation from `#862` (delta windowing, null review-count weighting, `#691` reconciliation), return-reason aggregation (ratio-of-sums, absent-table degradation), store-alias mapping (unmapped → logged).
- **Schema:** validate the new `conversion`, `returnReasons`, and `funnel` fields; snapshot still validates with sources absent (graceful `coming-soon`).
- **Smoke (Playwright):** the Quality Funnel view renders with correct node statuses; conversion shows a value (not `n/a`) given fixture sessions; the detail drawer shows a reason breakdown given fixture returns; live threshold recompute still flips verdict/brand classification.
- All new Baserow reads are exercised against **fixtures**; no live tokens in tests.

## 9. Risks & open questions

- **Store alias map** — must enumerate `#872.Store` distinct values and map all to store `id`s before conversion is trustworthy (examples seen: `BnM`→`bodyandmind`, `Kreativ`→`kreativfarms`).
- **`#862` coverage** — confirm every active ASIN has recent rows; define the `#691` fallback precisely so no ASIN loses its current rating.
- **`#872` store/ASIN coverage & session completeness** — verify sessions are populated across all reporting stores, not just recent batches, before declaring conversion `live` portfolio-wide (else mark `partial`).
- **Return-reason ingestion ownership/timing** — the SP-API→Baserow returns ingestion is a separate (user-side) task; v1.1 ships the dashboard side to the §5.3 contract and lights up when it lands.
- **Generator runtime** — reading `#862` (64k) + `#872` (46k) adds Baserow pagination; keep within the CI window. The PMA pull remains the slow path.

## 10. Deferred / fast-follow

- puncture/seal/formula taxonomy over `Customer Comment` (manual or NLP).
- CS/Gorgias and seller-feedback channels (need Baserow sources).
- Migrate returns/refunds + the full economics pull off PMA into Baserow (bundle with the conversion/sessions retention; expected to also harden the slow PMA path).
- Repeat-purchase surface (`#873`) — available in Baserow, not in v1.1 scope.
- Phase 2 / Warehouse QA (physical assets) — its data already largely exists in Baserow.
