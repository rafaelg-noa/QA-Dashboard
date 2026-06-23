/**
 * generator/pma.js
 *
 * PURE function:  aggregatePma(econRows, sessRows, opts)
 * THIN I/O wrapper: fetchPma({ token, asOf })
 *
 * ──────────────────────────────────────────────────────────────
 * Window boundary convention (INCLUSIVE both ends, UTC days):
 *
 *   last_window : [asOf - (windowDays-1), asOf]
 *                 = 30 consecutive days whose last day is asOf
 *   prior_window: [asOf - (2*windowDays-1), asOf - windowDays]
 *                 = the 30 days immediately preceding last_window (non-overlapping)
 *
 * Example — windowDays=30, asOf=2026-06-21:
 *   last_window:  2026-05-23 → 2026-06-21  (inclusive)
 *   prior_window: 2026-04-23 → 2026-05-22  (inclusive)
 *
 * Weekly buckets (trendWeeks=12):
 *   12 consecutive 7-day buckets ending at asOf.
 *   bucket[11] (newest): [asOf-6, asOf]
 *   bucket[10]:          [asOf-13, asOf-7]
 *   ...
 *   bucket[0]  (oldest): [asOf-(trendWeeks*7-1), asOf-(trendWeeks-1)*7]
 *   Rows older than bucket[0].start are ignored for weekly.
 * ──────────────────────────────────────────────────────────────
 */

/**
 * Return the number of UTC days since the Unix epoch for a Date (strips time).
 * Used for window boundary checks — avoids string parsing in the hot loop.
 */
function utcDay(date) {
  return Math.floor(date.getTime() / 86_400_000);
}

/**
 * Parse the date field from a PMA Economics row into a UTC-midnight Date.
 * Field value is an ISO8601 UTC string like "2026-06-21T00:00:00.000Z".
 */
function parseRowDate(row) {
  return new Date(row.date);
}

// ─── Pure aggregate ───────────────────────────────────────────────────────────

/**
 * aggregatePma(econRows, sessRows, opts) → { [asin]: AsinAggregate }
 *
 * Turns raw PMA Economics daily rows into per-ASIN windowed aggregates.
 * All numeric values in econRows are strings → coerced with Number().
 *
 * @param {object[]} econRows  - Raw rows from pma_query_custom (economics).
 * @param {object[]} sessRows  - Raw sessions rows (empty in Phase 1 → conversion = null).
 * @param {object}   opts
 * @param {number}   [opts.windowDays=30]         - Window/prior length in days.
 * @param {number}   [opts.refundBaselineDays=30]  - Refund baseline length (same as windowDays unless overridden).
 * @param {number}   [opts.trendWeeks=12]          - Number of 7-day weekly buckets.
 * @param {Date}     [opts.asOf]                   - Reference "today". Defaults to max `date` in econRows.
 *
 * @returns {{ [asin: string]: AsinAggregate }}
 */
export function aggregatePma(econRows, sessRows, opts = {}) {
  const {
    windowDays = 30,
    refundBaselineDays = 30,
    trendWeeks = 12,
    asOf: asOfOpt,
  } = opts;

  // ── 1. Resolve asOf ────────────────────────────────────────────────────────
  // Default to max date in econRows so tests are deterministic without an explicit asOf.
  let asOf;
  if (asOfOpt instanceof Date) {
    asOf = asOfOpt;
  } else if (typeof asOfOpt === "string") {
    asOf = new Date(asOfOpt);
  } else {
    // Compute from econRows
    let maxMs = -Infinity;
    for (const row of econRows) {
      const t = new Date(row.date).getTime();
      if (t > maxMs) maxMs = t;
    }
    if (!Number.isFinite(maxMs)) {
      // Empty input — nothing to aggregate
      return {};
    }
    asOf = new Date(maxMs);
  }

  // Work in UTC-day integers for cheap boundary checks
  const asOfDay = utcDay(asOf);

  // Window (last): [asOf-(windowDays-1), asOf]
  const winStart = asOfDay - (windowDays - 1);
  const winEnd   = asOfDay;

  // Window (prior): [asOf-(2*windowDays-1), asOf-windowDays]
  const priorEnd   = asOfDay - windowDays;
  const priorStart = asOfDay - (2 * windowDays - 1);

  // Refund windows (may differ from windowDays if refundBaselineDays ≠ windowDays)
  const refWinStart   = asOfDay - (refundBaselineDays - 1);
  const refWinEnd     = asOfDay;
  const refPriorEnd   = asOfDay - refundBaselineDays;
  const refPriorStart = asOfDay - (2 * refundBaselineDays - 1);

  // Weekly bucket boundaries (12 × 7 = 84 days)
  // bucket k (0=oldest): start = asOf - (trendWeeks - k)*7 + 1, end = asOf - (trendWeeks - k - 1)*7
  // In UTC-day terms:
  //   bucketEnd[k]   = asOfDay - (trendWeeks - 1 - k) * 7
  //   bucketStart[k] = bucketEnd[k] - 6
  const weeklySpanStart = asOfDay - trendWeeks * 7 + 1; // oldest eligible day

  // ── 2. Group rows by ASIN ──────────────────────────────────────────────────
  /** @type {Map<string, { rows: object[], accountId: string }>} */
  const byAsin = new Map();

  for (const row of econRows) {
    const { asin, account_id } = row;
    if (!byAsin.has(asin)) {
      byAsin.set(asin, { rows: [], accountId: account_id });
    }
    byAsin.get(asin).rows.push(row);
  }

  // ── 3. Sessions index (Phase 1: empty → all conversions null) ──────────────
  // sessRows would be keyed by (asin, date) → unitSessionPercentage.
  // In Phase 1, sessRows is always [] → no conversion data.
  const hasSessions = Array.isArray(sessRows) && sessRows.length > 0;

  /** @type {Map<string, number[]>} asin → array of unitSessionPercentage values in window */
  const sessIndex = new Map();

  if (hasSessions) {
    for (const row of sessRows) {
      const d = utcDay(parseRowDate(row));
      if (d < winStart || d > winEnd) continue;
      const pct = Number(row.unitSessionPercentage ?? row.amazonmws_trafficByAsin_unitSessionPercentage);
      if (!Number.isFinite(pct)) continue;
      if (!sessIndex.has(row.asin)) sessIndex.set(row.asin, []);
      sessIndex.get(row.asin).push(pct);
    }
  }

  // ── 4. Per-ASIN aggregation ────────────────────────────────────────────────
  /** @type {{ [asin: string]: object }} */
  const result = {};

  for (const [asin, { rows, accountId }] of byAsin) {
    let unitsSoldWindow    = 0;
    let unitsReturnedWindow = 0;
    let unitsSoldPrior     = 0;
    let unitsReturnedPrior  = 0;
    let refundLast  = 0;
    let refundPrior = 0;

    // Weekly buckets: index 0 = oldest, trendWeeks-1 = newest
    const weekly = Array.from({ length: trendWeeks }, () => ({ unitsSold: 0, unitsReturned: 0 }));

    for (const row of rows) {
      const d = utcDay(new Date(row.date));

      const sold     = Number(row.units_sold)              || 0;
      const returned = Number(row.units_returned)          || 0;
      const refund   = Number(row.refunded_product_sales)  || 0;

      // Main window sums
      if (d >= winStart && d <= winEnd) {
        unitsSoldWindow    += sold;
        unitsReturnedWindow += returned;
      } else if (d >= priorStart && d <= priorEnd) {
        unitsSoldPrior    += sold;
        unitsReturnedPrior += returned;
      }

      // Refund window sums (may equal main window if refundBaselineDays === windowDays)
      if (d >= refWinStart && d <= refWinEnd) {
        refundLast += refund;
      } else if (d >= refPriorStart && d <= refPriorEnd) {
        refundPrior += refund;
      }

      // Weekly buckets
      if (d >= weeklySpanStart && d <= asOfDay) {
        // How many complete 7-day periods back from asOf does this day fall?
        const daysFromEnd = asOfDay - d;           // 0 = asOf, 1 = yesterday, …
        const bucketIdx   = trendWeeks - 1 - Math.floor(daysFromEnd / 7);
        if (bucketIdx >= 0 && bucketIdx < trendWeeks) {
          weekly[bucketIdx].unitsSold     += sold;
          weekly[bucketIdx].unitsReturned += returned;
        }
      }
    }

    // ── Derived metrics ──────────────────────────────────────────────────────

    // returnRate: null when no sales in window (div-by-zero guard)
    const returnRate =
      unitsSoldWindow === 0
        ? null
        : (unitsReturnedWindow / unitsSoldWindow) * 100;

    // refundSpike: null when prior refund period is zero (div-by-zero guard)
    const refundSpike =
      refundPrior === 0
        ? null
        : ((refundLast - refundPrior) / refundPrior) * 100;

    // conversion: mean unitSessionPercentage in window, null when sessions unavailable
    let conversion = null;
    if (hasSessions) {
      const vals = sessIndex.get(asin);
      if (vals && vals.length > 0) {
        conversion = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
    }

    result[asin] = {
      asin,
      accountId,
      unitsSoldWindow,
      unitsReturnedWindow,
      unitsSoldPrior,
      unitsReturnedPrior,
      refundLast,
      refundPrior,
      returnRate,
      refundSpike,
      conversion,
      weekly,
    };
  }

  return result;
}

// ─── Thin I/O wrapper (exercised live in Task 9, not unit-tested here) ────────

/**
 * fetchPma({ token, asOf }) → { econRows: object[], sessRows: [] }
 *
 * Pulls PMA Economics rows via pma_query_custom (MCP SDK), paginating until
 * has_more is false. Covers trendWeeks (≈91 days) of history back from asOf.
 * Sessions data is unavailable in Phase 1; always returns sessRows: [].
 *
 * Pace: ~2.2s between calls to stay under PMA's 30 req/min limit.
 *
 * @param {{ token: string, asOf?: Date }} opts
 * @returns {Promise<{ econRows: object[], sessRows: [] }>}
 */
export async function fetchPma({ token, asOf }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const ENDPOINT = "https://pma-mcp.web.app/";
  const PACE_MS  = 2200;      // ~2.2s between calls → stays under 30 req/min
  const LIMIT    = 100;       // PMA max rows per call
  const METRICS  = [
    "units_sold",
    "units_returned",
    "refunded_product_sales",
    "net_sales",
    "sales",
    "RefundCommissionFee_total",
    "ReferralFee_total",
  ];

  // Resolve asOf
  const refDate = asOf instanceof Date ? asOf : new Date();
  const dateTo   = refDate.toISOString().slice(0, 10);

  // Pull enough history to cover trendWeeks (12 × 7 = 84 days) + prior window (30 days)
  // → 84 + 30 = 114 days; round up to 120 for safety
  const HISTORY_DAYS = 120;
  const dateFrom = new Date(refDate.getTime() - HISTORY_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Connect
  const transport = new StreamableHTTPClientTransport(
    new URL(ENDPOINT),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
  );
  const client = new Client({ name: "qa-generator", version: "1.0.0" });
  await client.connect(transport); // throws on connection failure

  /** Sleep helper */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Paginate pma_query_custom until has_more is false.
   * @param {string} date_from
   * @param {string} date_to
   * @returns {Promise<object[]>}
   */
  async function paginate(date_from, date_to) {
    const rows  = [];
    let   offset = 0;
    let   first  = true;

    while (true) {
      if (!first) await sleep(PACE_MS);
      first = false;

      const toolResult = await client.callTool({
        name: "pma_query_custom",
        arguments: {
          connector_type: "amazonmws",
          report_type:    "economics",
          dimensions:     ["account_id", "asin", "date"],
          metrics:        METRICS,
          date_from,
          date_to,
          limit:          LIMIT,
          offset,
          format:         "json",
        },
      });

      // Parse result — content is a JSON text block
      const content = toolResult?.content;
      if (!Array.isArray(content) || content.length === 0) {
        throw new Error(`pma_query_custom returned no content (offset=${offset})`);
      }

      let parsed;
      try {
        parsed = JSON.parse(content[0].text);
      } catch (err) {
        throw new Error(`Failed to parse pma_query_custom response: ${err.message}`);
      }

      // Accumulate rows
      const batch = parsed.rows ?? parsed.data ?? parsed;
      if (Array.isArray(batch)) {
        rows.push(...batch);
      }

      if (!parsed.has_more) break;
      offset += LIMIT;
    }

    return rows;
  }

  // Pull the full history window in a single date range
  // (PMA Economics can handle ≥120 days; paginate via offset)
  const econRows = await paginate(dateFrom, dateTo);

  await client.close().catch(() => {}); // best-effort disconnect

  // Sessions are unavailable in Phase 1 (sales_and_traffic_by_asin times out).
  // Caller should pass sessRows to aggregatePma as [].
  return { econRows, sessRows: [] };
}
