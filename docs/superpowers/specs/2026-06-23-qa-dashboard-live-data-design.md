# QA Dashboard — Live Data, Phase 1 (Design Spec)

**Date:** 2026-06-23
**Project:** Novaeo — Store Quality Monitor ("QA Signal")
**Status:** Approved design, pre-implementation
**Identity:** Kadok → Novaeo. GitHub `rafaelg-noa`, Novaeo Cloudflare / PMA / Baserow. Never EGDC accounts.

## 1. Purpose

Take the existing static `qa-dashboard.html` prototype online with **real data** for Novaeo's Amazon stores. Replace hardcoded mock data with a live snapshot built from the two data sources we have access to, deployed behind authentication so the team can use it.

This is **Phase 1**: ship the ~70% of the dashboard that has a live source today. **Phase 2** (separate spec) adds Amazon SP-API return reasons + customer-feedback themes and the triage pipeline.

## 2. Goals / Non-goals

**Goals**
- Live data for all Amazon stores: return rate, refund spike, conversion, review ratings.
- "All Stores" portfolio overview + per-store drill-down.
- Deployed on Cloudflare, gated by Cloudflare Access, auto-refreshed on a schedule.
- Strict project isolation (Novaeo identity only).

**Non-goals (Phase 1)**
- Return reason codes, customer-feedback theme extraction, repeat-purchase rate (no live source — Phase 2 via SP-API).
- Triage pipeline (internal workflow state — Phase 2).
- True on-demand "pull from source now" refresh (deferred; cron + re-fetch only).
- Multi-channel (Walmart / eBay / TikTok) — Amazon only for now.

## 3. Stores in scope

**9 Amazon Seller Central accounts** (PMA `amazonmws`, all syncing daily, all `has_data`):
body and mind · StandMore · Ohana · WyldSkyn · Magnificent US · Kreativ Farms · Veganexus US · Sirius · Mind & Mana.

Within these sit multiple product brands (NatriSweet, DivaStuff, Purisure, …). Stores are grouped by **seller account**; brand is a secondary label. Per-store data coverage (which of the 9 have complete returns + ratings) is verified during implementation.

## 4. Architecture

```
GitHub Actions (cron ~every 6h, full Node)
  ├─ fetch Baserow REST  → ratings/product master (db 138, table 691; 782/783)
  ├─ fetch PMA (MCP, API token) → returns/refunds/conversion (Economics + Sessions datasets)
  ├─ join on ASIN → group by store → compute KPIs, trends, flags, portfolio rollup
  └─ write + commit  public/data.json
                          │
                          ▼
 Cloudflare Pages  → serves dashboard (static) + data.json
        └─ Cloudflare Access (email SSO)  ◀── Novaeo team
```

No secrets reach the browser. The page only `fetch()`es `data.json`.

### Why this shape
- Generator in **full Node CI**, not a Worker → the PMA MCP SDK works without Workers-runtime friction.
- **Cron snapshot**, not per-request fetch → respects PMA's 30 req/min cap; last good snapshot survives a failed refresh.
- **Cloudflare** → existing Novaeo vendor, free tier, Cloudflare Access for proper internal auth.

## 5. Data sources

### 5.1 Baserow (ratings / product master)
- Endpoint: `https://baserow.novaeo.com/api/database/rows/table/{id}/?user_field_names=true`
- Auth: `Authorization: Token <BASEROW_TOKEN>` (read-only, scoped to database 138).
- **Table 691** (765 rows, per ASIN) — fields used:
  `ASIN`, `Amazon Title`, `Brand`, `Amazon Listing Status`, `Amazon Review Rating`,
  `Amazon Rating Count`, `Previous Review Rating`, `30 Day Velocity`, `Sale Price`, `Inventory Health`.
- Tables **782 / 783** — supplementary product-level `Star Rating` / `Review Count` (fallback/cross-check).
- Note: many ASINs have null ratings (inactive / no velocity). Treated as "no rating", not zero.

### 5.2 PMA (returns / refunds / conversion)
- Headless MCP over HTTP, `Authorization: Bearer <PMA_API_TOKEN>`, via `@modelcontextprotocol/sdk`.
- **Economics** dataset table (per ASIN/day): `units_returned`, `units_sold` / `net_units_sold`,
  `refunded_product_sales`, `RefundCommissionFee_total`, `net_sales`, `account_id`, `asin`, `date`.
- **Sessions** dataset table (per ASIN/day): `unitSessionPercentage` (conversion), `sessions`, `unitsOrdered`.
- `account_id` provides the **ASIN → store** mapping.

## 6. Metric definitions (single source of truth)

All windows configurable; defaults below.

| Metric | Definition | Threshold |
|---|---|---|
| Return rate (store) | Σ`units_returned` / Σ`units_sold` over window (default 30d) | breach ≥ 5.0% |
| Return rate (ASIN) | same, per ASIN | warn ≥ 4%, bad ≥ 5% |
| Refund spike | `refunded_product_sales` last 30d vs prior 30d, % change | breach > 25% |
| Conversion | mean `unitSessionPercentage` over window | informational |
| Review rating | `Amazon Review Rating` (current) | warn < 4.0, bad < 3.5 |
| Review Δ | `Amazon Review Rating` − `Previous Review Rating` | flag if ≤ −0.2 |
| Health (store) | bad if return rate ≥ 5% **or** avg rating < 3.5; warn if return rate ≥ 4% **or** rating Δ ≤ −0.2 **or** refund spike > 25%; else good | — |
| Flagged ASIN | breaches any of: return rate ≥ 5%, refund spike > 25%, rating Δ ≤ −0.2 | — |

**Trends:** 12-week weekly series — return rate (Economics by week) + conversion overlay (Sessions by week). Requires ≥12 weeks of history in source; if unavailable, render the longest available window and label it.

**Portfolio (All Stores):** return rate = Σ`units_returned` / Σ`units_sold` across all stores; refund exposure = Σ`refunded_product_sales` (30d); flagged count = Σ flagged ASINs; avg rating = rating-count-weighted mean; store leaderboard ranked worst-health first.

## 7. Snapshot contract — `data.json`

Shaped to mirror the existing dashboard's `STORES` model so the frontend changes stay minimal.

```jsonc
{
  "generatedAt": "2026-06-23T12:00:00Z",
  "refreshIntervalHours": 6,
  "window": { "days": 30 },
  "thresholds": { "returnRate": 5.0, "refundSpike": 25, "ratingBad": 3.5, "ratingDrop": -0.2 },
  "portfolio": {
    "returnRate": 4.1, "returnDelta": 0.3, "refundExposure": 12840.50,
    "flaggedCount": 7, "avgRating": 4.0, "storeCount": 9,
    "trend": [/* 12 weekly return-rate values */],
    "conv":  [/* 12 weekly conversion values */],
    "leaderboard": [ { "id": "northgate", "name": "…", "health": "bad",
        "returnRate": 6.4, "refundSpike": 38, "avgRating": 3.6, "flagged": 3 } ]
  },
  "stores": [
    {
      "id": "bodyandmind", "name": "body and mind", "health": "warn",
      "kpis": { "returnRate": 4.6, "returnDelta": 0.5, "refundSpike": 14,
                "reviewRating": 4.1, "reviewDelta": 0.0, "ratingCount": 6961, "conversion": 10.1 },
      "trend": [/* 12 */], "conv": [/* 12 */],
      "asins": [ { "asin": "B0…", "sku": "…", "title": "…", "brand": "NatriSweet",
                   "returnRate": 5.2, "refundDelta": "+14%", "reviewRating": 4.1,
                   "reviewDelta": -0.3, "ratingCount": 412, "flags": ["return","ratingDrop"] } ]
    }
  ]
}
```

## 8. Components (each independently testable)

| Unit | Responsibility | Depends on |
|---|---|---|
| `generator/baserow.js` | Pull + normalize table 691 → ASIN→ratings map | Baserow token |
| `generator/pma.js` | Pull Economics + Sessions → per-ASIN/day returns/refunds/conversion + ASIN→store map | PMA token, MCP SDK |
| `generator/build.js` | Join, compute metrics §6, assemble snapshot §7 | the two above |
| `generator/index.js` | Orchestrate → write `public/data.json` | build.js |
| `public/index.html` | Dashboard: load `data.json`, render overview + per-store | data.json contract |
| `.github/workflows/refresh.yml` | Cron, run generator, commit `data.json` | GH secrets |
| Cloudflare Pages + Access | Host + auth | repo, Novaeo CF |

### Frontend changes (minimal)
- Replace hardcoded `STORES` const with `await fetch('./data.json')`.
- Add **"All Stores"** entry pinned atop the rail → renders portfolio overview (KPIs + leaderboard + worst ASINs); stores render existing detail layout.
- Replace **sentiment-themes** panel → **review-ratings** panel (rating, count, Δ).
- Flagged-ASIN table: swap `top return reason` / `neg themes` columns → `review rating` + `Δ`.
- Remove triage + repeat-purchase panels (Phase 2). Correct the footnote to real sources.
- Add **"last synced / next refresh in ~Xh"** countdown + a re-fetch button.

## 9. Hosting, auth, refresh

- **Cloudflare Pages** project connected to `rafaelg-noa/QA-Dashboard` (dashboard GitHub integration — no CF API token needed for Phase 1).
- **Cloudflare Access** application (Zero Trust) gates the site by email to allowed Novaeo users.
- **Refresh:** GitHub Actions cron (~every 6h) runs the generator and commits `data.json`; Pages redeploys. Page shows last-synced + countdown; re-fetch button reloads the snapshot.

## 10. Security / identity isolation

- All credentials server-side only: **GitHub Actions secrets** (`PMA_API_TOKEN`, `BASEROW_TOKEN`), added via the GitHub UI. Frontend holds none.
- **Identity:** isolated git repo at `projects/Novaea/QA` with local Novaeo identity; remote `rafaelg-noa/QA-Dashboard` via a fine-grained PAT scoped to that repo (Contents RW + Workflows RW). EGDC global git / `gh` / `GH_TOKEN` are never used for this project.
- PMA + Baserow tokens are rotatable; rotate after setup since they transited chat.
- `.gitignore` blocks `.env`, keys, `node_modules`, scratch.

## 11. Risks / spikes (verify first in implementation)

1. **ASIN → store mapping** is clean and complete across Baserow (brand) and PMA (`account_id`). *Highest risk.*
2. **PMA pull from Node CI** with the MCP SDK works headless; confirm the exact dataset/table IDs and that 30 req/min suffices for a full 9-store, 12-week pull.
3. **History depth** — does the source hold ≥12 weeks for the trend? If not, degrade gracefully.
4. **Baserow rating coverage** — share of in-scope ASINs with non-null ratings; confirm it's useful.
5. **Cloudflare/GitHub access** under Novaeo accounts is actually available to Kadok.

## 12. Testing

- `generator/*` unit tests against fixtures: join correctness, each metric in §6, snapshot schema validity.
- Snapshot validated against a JSON schema before commit (bad data never ships).
- Frontend smoke test: renders overview + a store from a sample `data.json`.

## 13. Phase 2 (future, separate spec)

- Amazon SP-API direct (≥2 authorized stores): FBA return **reason codes**, Customer Feedback **themes/sentiment**.
- Triage pipeline (classify → investigate → resolve) with persisted workflow state.
- Possible true on-demand refresh (Worker → `repository_dispatch` → Action → poll).
- Multi-channel expansion (Walmart / eBay / TikTok).
