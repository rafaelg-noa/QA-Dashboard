# Spike notes — QA Dashboard Phase 1

## Resolved dependency versions

- `@modelcontextprotocol/sdk`: **1.29.0** (resolved from `^1.0.0` during `npm install`)

## PMA reconnaissance — in-session OAuth tools, 2026-06-23 (controller-curated)

**MCP endpoint (from repo `.mcp.json`):** `https://pma-mcp.web.app/` — `type: http`. Headless auth = `Authorization: Bearer <PMA_API_TOKEN>` (key in `.env`, Kadok-approved handoff value; rotate in Task 17).

### The 9 in-scope stores (`amazonmws` connector) — all `has_data`, synced 2026-06-22/23
Account name → `account_id` (this is the authoritative `config/stores.json` seed):

| Store (spec §3) | account_id |
|---|---|
| body and mind   | `amazonmws-AMDDC4NXQ03GH` |
| StandMore       | `amazonmws-AS8CSQPR9M3FS` |
| Ohana           | `amazonmws-A3DA69BBFHI7YK` |
| WyldSkyn        | `amazonmws-A387O5GH8GCHW` |
| Magnificent US  | `amazonmws-A3MAQKU8W5VLAP` |
| Kreativ Farms   | `amazonmws-A46Y3YEAL88YG` |
| Veganexus US    | `amazonmws-A1PHGG2N6N5I0P` |
| Sirius          | `amazonmws-A26KHELG1S2YF0` |
| Mind & Mana     | `amazonmws-A8YCR05DHF8XC` |

Note: in Economics rows `account_id` appears WITHOUT the `amazonmws-` prefix (bare `AMDDC4NXQ03GH`). Confirm exact form when pulling and normalize in the store map.

### Data does NOT live in connector report types
`amazonmws` connector exposes only ONE report type: `orders` (1.4M rows, 2021-07-19 → 2026-06-22). `orders` lacks returns/refunds fields. The returns/refunds/conversion data lives in **PMA saved datasets** (below), NOT the connector. So the generator pulls **datasets**, via `pma_get_dataset_data` / `pma_get_data_table_data` (not `pma_query_custom`).

### Economics — dataset `Automation` (id `SpMe1IhD71zWB07dW24F`), table `Economics` (id `fDxh2ntzou2GOZ8T4n2L`)
- 62 fields, granularity **per `amazonmws_asin` × `amazonmws_account_id` × `amazonmws_date_actual`**. ✅ has everything spec §5.2 needs:
  `amazonmws_units_returned`, `amazonmws_units_sold`, `amazonmws_net_units_sold`, `amazonmws_refunded_product_sales`,
  `amazonmws_RefundCommissionFee_total`, `amazonmws_net_sales`, `amazonmws_account_id`, `amazonmws_asin`, `amazonmws_date_actual`,
  plus `amazonmws_average_sales_price`, `amazonmws_sales`.
- **Configured window = "Last 1 month" (2026-06-01 → 06-22, ~3wk).** ⚠️ 12-week trend (§6/§11.3) feasibility depends on whether `pma_get_dataset_data(date_start, date_end)` can pull OLDER history than the configured window. **UNRESOLVED — Spike B must test.**

### Sessions — dataset `Sessions` (id `AxGyj23eWbeHtwUwAUom`)
- Table `Sessions_By_ASIN_By_Date` (id `SWVj32RZcCkwmSFOqCcJ`, 20 fields): `date`, `amazonmws_asin`, `amazonmws_trafficByAsin_unitSessionPercentage` (= conversion, §5.2), `amazonmws_trafficByAsin_sessions`, `amazonmws_salesByAsin_unitsOrdered`, `amazonmws_title`.
- Table `Sessions_Data` (id `lB0NLTGWMKekSGwiCvmE`, same 20 fields but `amazonmws_date_actual`).
- ⚠️ **No `account_id` field** → conversion attributes to a store via ASIN → (Economics `account_id`). Depends on ASIN being unique to one account (check ambiguous ASINs in Spike A).
- ⚠️ **Configured windows look STALE** (`Sessions_By_ASIN_By_Date` 2026-01-06→01-19; `Sessions_Data` 2025-11-22→12-21). **Freshness UNRESOLVED — Spike B must test a recent range.** If conversion data is stale/unavailable, conversion is "informational" (§6) so degrade gracefully; flag to Kadok.

### Performance finding
`pma_get_dataset_data(SpMe1IhD71zWB07dW24F, 2026-03-25..06-22, limit 40)` (full 7-table `Automation` blend over 3mo) **timed out**. The generator must pull **narrowly** — single tables (`pma_get_data_table_data` by table id) and/or tight date windows, paced under PMA's 30 req/min. Do NOT blend the whole `Automation` dataset.

### Net effect on the spikes
- **Spike A (§11.1 join) is largely DE-RISKED:** store assignment is the per-row Economics `account_id` (authoritative), not brand inference. Residual = rating *coverage* (share of in-scope ASINs with a Baserow rating) — a quality metric, not a go/no-go.
- **Spike B is now the critical-path unknown:** (a) prove headless Node transport to the endpoint; (b) **history depth** — can we pull ≥12 weeks of Economics? (c) **Sessions freshness** — is recent conversion data present? Because of the circular data dependency (A's coverage needs B's ASIN universe), run **B before A**.

---

## Spike B results — 2026-06-23 (headless Node pull)

### Transport — CONFIRMED WORKING
**Class:** `StreamableHTTPClientTransport` (from `@modelcontextprotocol/sdk/client/streamableHttp.js`)  
**Auth:** `requestInit: { headers: { Authorization: 'Bearer <PMA_API_TOKEN>' } }`

Minimal connect code (basis for `generator/pma.js`):
```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('https://pma-mcp.web.app/'),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.PMA_API_TOKEN}` } } }
);
const client = new Client({ name: 'qa-generator', version: '1.0.0' });
await client.connect(transport);
```

### CORRECTION to prior reconnaissance
The prior notes said "data lives in saved datasets via `pma_get_dataset_data` / `pma_get_data_table_data`". **This is wrong for headless use:**
- `pma_get_data_table_data` fails with "Cannot read properties of null (reading 'replace')" for all dataset tables where `connector: null` (i.e., computed/blended tables). **Unusable.**
- `pma_get_dataset_data` times out consistently when pulling the 7-table `Automation` blend, even with tight 2-day windows. **Unusable.**
- **Correct tool: `pma_query_custom`** (no `account_id` param, with `dimensions` + `metrics`) against the `amazonmws` connector's `economics` report type. This returns per-date per-ASIN per-account rows with actual metric values. Limit ≤ 100 rows, metrics ≤ 10 per call.

### Unknown 1 — Economics history depth ✅ RESOLVED
**Oldest reachable date: 2026-03-27** (confirmed with 1160 rows in DB for the Mar 27-31 window).  
**Conclusion: ≥12 weeks of Economics IS available.** The 12-week trend (spec §6/§11.3) is fully feasible. `pma_query_custom(economics)` can pull any date range back to at least 2026-03-27 (likely further — the `orders` connector goes to 2021).

Evidence:
- 2026-03-27→03-31 (≈12 weeks ago): **1160 rows** in DB, 50 pulled, dates confirmed
- 2026-04-24→05-23 (prior 30 days): **7616 rows** in DB
- 2026-05-24→06-22 (current 30 days): **7939 rows** in DB

### Unknown 2 — Sessions freshness ⚠️ BLOCKED / DEGRADED
`pma_query_custom(sales_and_traffic_by_asin)` **times out (MCP -32001)** for every tested range (Jun 2026, Jan 2026). `pma_query_performance(sales_and_traffic_by_asin)` returns 0 rows for all date ranges. The configured dataset windows (`Sessions_By_ASIN_By_Date`: Jan 6-19 2026; `Sessions_Data`: Nov-Dec 2025) are stale and not refreshing.

**Conclusion: Conversion data (unitSessionPercentage) is UNAVAILABLE headlessly.** This is an "informational" metric per spec §6 — degrade gracefully, flag to Kadok. Recommended action: Kadok should update the Sessions dataset configured window to current dates; if the underlying `sales_and_traffic_by_asin` report type times out, this may require PMA support investigation.

### Unknown 3 — Granularity + account_id form ✅ RESOLVED
- **Granularity:** Perfect one-row-per-asin-per-account-per-date. Fixture: 203 rows, 203 unique `(asin|account_id|date)` keys. Zero duplicates.
- **account_id form in Economics rows:** **BARE** (e.g., `A8YCR05DHF8XC`) — WITHOUT the `amazonmws-` prefix. Generator must normalize: `store_map` keys use `amazonmws-XXXXX`, but Economics rows contain bare `XXXXX`. Map is confirmed in NOTES.md stores table (e.g., `amazonmws-A8YCR05DHF8XC` → Mind & Mana).
- **Date format:** ISO8601 UTC (`2026-06-15T00:00:00.000Z`)
- **Economics fields returned by `pma_query_custom`:** `account_id`, `asin`, `date`, `units_sold`, `units_returned`, `net_units_sold`, `refunded_product_sales`, `RefundCommissionFee_total`, `net_sales`, `sales`, `average_sales_price`, `total_fees`, `ReferralFee_total`, `FbaFulfilmentFee_total`, `FbaStorageFee_total`, `net_proceeds_per_unit` (request up to 10 at a time — note `net_units_sold` not returned in final fixture due to 10-metric cap; use `units_sold - units_returned` as a formula or pull separately).

### Fixtures written
- `test/fixtures/pma-economics.sample.json` — 203 rows, 4 accounts, 24 ASINs, date range 2026-03-27→2026-06-21 (≈12 weeks). Fields: `account_id`, `asin`, `date`, `units_sold`, `units_returned`, `net_sales`, `refunded_product_sales`, `sales`, `RefundCommissionFee_total`, `ReferralFee_total`. Perfect granularity (one per asin+account+date).
- `test/fixtures/pma-sessions.sample.json` — Empty (see `_note` field). Sessions unavailable headlessly; conversion is informational per spec §6.

### ASIN universe (spike/asin-universe.json — gitignored)
46 distinct ASINs across **6 of 9 accounts** appear in the Economics dataset for Jun 2026. **3 accounts absent from Economics data in Jun 2026:** StandMore (`AS8CSQPR9M3FS`), WyldSkyn (`A387O5GH8GCHW`), Sirius (`A26KHELG1S2YF0`). This may mean those stores have no Economics activity in this period, or their data is under a different date range. Zero ASINs appear under >1 account (no cross-account ASIN ambiguity detected in the sampled subset).

### Recommended generator pull strategy
Use `pma_query_custom(connector_type: 'amazonmws', report_type: 'economics')` with `dimensions: ['account_id', 'asin', 'date']` and up to 10 metrics. Pull in 30-day windows with `limit: 100` and paginate via `offset`. For the generator, pull current-30d and prior-30d windows in sequence (6 pages × 2 windows = 12 calls at 2.2s spacing ≈ 26s total, comfortably under 30 req/min). For 12-week trend, pull 3 additional 30-day windows (another 6 pages, paced identically). Do NOT use `pma_get_dataset_data` or `pma_get_data_table_data` — both fail headlessly for computed dataset tables.

### Surprises / concerns for Kadok
1. **`pma_get_data_table_data` is broken for blended tables.** The controller's prior reconnaissance said to use it — it cannot be used. `pma_query_custom` is the correct path.
2. **Sessions permanently timed out.** `sales_and_traffic_by_asin` report type always times out when called headlessly. Even the Jan 2026 fallback timed out. Conversion data is a blocker for the spec §5.2 conversion metric — but classified as informational (§6) so dashboard can degrade gracefully.
3. **3 accounts missing from Economics Jun 2026.** StandMore, WyldSkyn, Sirius have no rows in the `economics` report for this window. May be seasonal/product gaps. Spike A coverage check will flag this.
4. **`net_units_sold` requires special handling.** The field name in the PMA report type differs from what the dataset table exposes. In `pma_query_custom`, request it separately or compute as `units_sold - units_returned`.
5. **Total Economics volume is high** (7939 rows/30 days across all accounts+ASINs+dates). The generator should always paginate and NOT assume a single 100-row pull is complete.

### Controller verification (2026-06-23) — corrects/augments the above
Ran `pma_query_custom(economics, dimensions:['account_id'], metrics:[units_sold,units_returned,refunded_product_sales], 2026-05-24→06-22)` in-session — authoritative per-store coverage for the current 30d:
- **7 of 9 stores active** (not 6): Mind & Mana 8934 sold/218 ret; body and mind 7562/150; Magnificent US 6626/156; Kreativ Farms 1371/34; Ohana 986/28; Veganexus US 436/11; **StandMore 5/0 (barely active but PRESENT — Spike B's partial pull missed it)**.
- **2 stores absent** in the current 30d: **WyldSkyn (`A387O5GH8GCHW`)** and **Sirius (`A26KHELG1S2YF0`)**. The frontend/build must render a store with no current Economics data gracefully (no crash, show "no data").
- All active stores' return rates are 0–2.8% (store-level) — under the 4%/5% thresholds; real & sane.
- **⚠️ PMA token health:** the query returned `_token_warning: "4 account(s) have expired or revoked tokens and were excluded"`. Some Amazon→PMA connections are expiring — flag to Kadok to re-auth (`pma_get_token_health_summary`). Not a Phase-1 blocker (7 stores have data) but coverage will erode if ignored.
- **⚠️ Data typing:** Economics metric values come back as STRINGS (`"132"`, `"53.54"`). `aggregatePma` (Task 6) MUST coerce with `Number()`/`parseFloat` before arithmetic.
