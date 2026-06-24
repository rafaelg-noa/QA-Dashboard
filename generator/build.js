/**
 * generator/build.js
 *
 * The keystone: join Baserow ratings + PMA aggregates, roll up per-store and
 * portfolio metrics (§6), classify with the shipped default thresholds (§6.1),
 * and assemble the `data.json` snapshot (§7).
 *
 * Two rules dominate this file and must not drift:
 *
 *  1. RATIO-OF-SUMS — every store/portfolio rate is computed from summed units
 *     (Σreturned / Σsold), NEVER an average of per-ASIN rates. Same for refund
 *     spike (Σlast vs Σprior) and the weekly trend (per-bucket Σreturned/Σsold).
 *
 *  2. EMPTY-STORE → "nodata" — a store with no matching pma ASINs, or whose
 *     Σ unitsSoldWindow is 0, is forced to health "nodata" (NOT good): kpis all
 *     null (ratingCount 0), empty asins, all-null trend/conv. classify only ever
 *     returns good/warn/bad, so the override happens here, before classify runs.
 *
 * Classification is delegated to public/shared/classify.js (the single dual-use
 * implementation shared with the browser) — do NOT reimplement it here.
 */

import { storeHealth, asinFlags, flaggedCount, portfolioVerdict } from "../public/shared/classify.js";

const WEEKS = 12;

/** Health rank for leaderboard sort: worst first. */
const HEALTH_RANK = { bad: 0, warn: 1, good: 2, nodata: 3 };

/** Round to n decimal places (returns null for null). */
function round(v, n) {
  if (v == null) return null;
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

/**
 * ratingCount-weighted mean of `field` over rated entries.
 * Skips entries whose value or weight is null. Returns { mean, weight }:
 *   mean = Σ(value × weight) / Σweight  (null when Σweight === 0)
 *   weight = Σweight
 */
function weightedMean(entries, field) {
  let num = 0;
  let den = 0;
  for (const r of entries) {
    const value = r?.[field];
    const weight = r?.ratingCount;
    if (value == null || weight == null) continue;
    num += value * weight;
    den += weight;
  }
  return { mean: den === 0 ? null : num / den, weight: den };
}

/**
 * Format refundSpike as the display string used in the flagged table.
 *   null      → "n/a"
 *   >= 0      → "+<rounded>%"
 *   < 0       → "<rounded>%"   (Math.round already carries the minus sign)
 */
function refundDeltaStr(refundSpike) {
  if (refundSpike == null) return "n/a";
  const r = Math.round(refundSpike);
  return (refundSpike >= 0 ? "+" : "") + r + "%";
}

/**
 * Build a single per-ASIN snapshot entry by joining a pma aggregate with its
 * (possibly absent) Baserow rating row.
 */
function buildAsinEntry(agg, rating, thresholds) {
  const reviewRating = rating?.reviewRating ?? null;
  const reviewDelta = rating?.reviewDelta ?? null;
  const ratingCount = rating?.ratingCount ?? null;
  const returnRate = agg.returnRate;
  const refundSpike = agg.refundSpike;

  return {
    asin: agg.asin,
    sku: null, // not available in Phase 1 (Baserow §5.1 + economics carry no SKU)
    title: rating?.title ?? null,
    brand: rating?.brand ?? null,
    returnRate,
    refundSpike,
    refundDelta: refundDeltaStr(refundSpike),
    reviewRating,
    reviewDelta,
    ratingCount,
    conversion: null, // Phase 1: no sessions
    flags: asinFlags({ returnRate, refundSpike, reviewDelta }, thresholds),
  };
}

/**
 * An all-null KPI block for an empty store.
 */
function emptyKpis() {
  return {
    returnRate: null,
    returnDelta: null,
    refundSpike: null,
    reviewRating: null,
    reviewDelta: null,
    ratingCount: 0,
    conversion: null,
  };
}

/**
 * Roll up one store from its matching pma ASIN aggregates + ratings.
 * Returns the §7 store object plus an internal `_flagged` count reused by the
 * portfolio rollup.
 *
 * EMPTY-STORE: no matching ASINs OR Σ unitsSoldWindow === 0 → health "nodata".
 */
function rollupStore(store, pma, ratings, thresholds) {
  const aggs = Object.values(pma).filter((a) => a.accountId === store.accountId);

  // Sum the window/prior/refund/weekly inputs (ratio-of-sums).
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
      store: {
        id: store.id,
        name: store.name,
        health: "nodata",
        kpis: emptyKpis(),
        trend: Array(WEEKS).fill(null),
        conv: Array(WEEKS).fill(null),
        asins: [],
      },
      _flagged: 0,
    };
  }

  // ── Ratio-of-sums metrics ──────────────────────────────────────────────────
  const returnRate = (retWin / soldWin) * 100;
  const priorReturnRate = soldPri === 0 ? 0 : (retPri / soldPri) * 100;
  const returnDelta = returnRate - priorReturnRate;
  const refundSpike = refPri === 0 ? null : ((refLast - refPri) / refPri) * 100;

  const { mean: reviewRating, weight: ratingCount } = weightedMean(ratingRows, "reviewRating");
  const { mean: reviewDelta } = weightedMean(ratingRows, "reviewDelta");

  const trend = weekly.map((w) => (w.sold === 0 ? null : (w.ret / w.sold) * 100));

  const kpis = {
    returnRate,
    returnDelta,
    refundSpike,
    reviewRating,
    reviewDelta,
    ratingCount,
    conversion: null, // Phase 1
  };

  const health = storeHealth(
    { returnRate, reviewRating, reviewDelta, refundSpike },
    thresholds
  );

  // Per-ASIN entries + store flagged count (over raw return/refund/ratingDrop).
  const asins = aggs.map((a) => buildAsinEntry(a, ratings[a.asin], thresholds));
  const flagInputs = aggs.map((a) => ({
    returnRate: a.returnRate,
    refundSpike: a.refundSpike,
    reviewDelta: ratings[a.asin]?.reviewDelta ?? null,
  }));
  const flagged = flaggedCount(flagInputs, thresholds);

  return {
    store: { id: store.id, name: store.name, health, kpis, trend, conv: Array(WEEKS).fill(null), asins },
    _flagged: flagged,
  };
}

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

/**
 * Roll up the portfolio from all pma ASIN aggregates + the per-store results.
 * All rates are ratio-of-sums across ALL ASINs (not means of store rates).
 */
function rollupPortfolio(pma, ratings, storeResults, storeCount, thresholds) {
  const aggs = Object.values(pma);

  let soldWin = 0, retWin = 0, soldPri = 0, retPri = 0, refLast = 0;
  const weekly = Array.from({ length: WEEKS }, () => ({ sold: 0, ret: 0 }));
  const ratingRows = [];

  for (const a of aggs) {
    soldWin += a.unitsSoldWindow;
    retWin += a.unitsReturnedWindow;
    soldPri += a.unitsSoldPrior;
    retPri += a.unitsReturnedPrior;
    refLast += a.refundLast;
    for (let w = 0; w < WEEKS; w++) {
      weekly[w].sold += a.weekly[w].unitsSold;
      weekly[w].ret += a.weekly[w].unitsReturned;
    }
    ratingRows.push(ratings[a.asin] ?? null);
  }

  const returnRate = soldWin === 0 ? null : (retWin / soldWin) * 100;
  const priorReturnRate = soldPri === 0 ? 0 : (retPri / soldPri) * 100;
  const returnDelta = returnRate === null ? null : returnRate - priorReturnRate;
  const refundExposure = round(refLast, 2);
  const flagged = storeResults.reduce((n, r) => n + r._flagged, 0);
  const { mean: avgRating } = weightedMean(ratingRows, "reviewRating");
  const { mean: ratingDelta } = weightedMean(ratingRows, "reviewDelta");
  const trend = weekly.map((w) => (w.sold === 0 ? null : (w.ret / w.sold) * 100));

  // Leaderboard: one entry per store, worst-health-first, tie-break returnRate desc (nulls last).
  const leaderboard = storeResults
    .map(({ store, _flagged }) => ({
      id: store.id,
      name: store.name,
      health: store.health,
      returnRate: store.kpis.returnRate,
      refundSpike: store.kpis.refundSpike,
      avgRating: store.kpis.reviewRating,
      flagged: _flagged,
    }))
    .sort((a, b) => {
      const rank = HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
      if (rank !== 0) return rank;
      const ar = a.returnRate, br = b.returnRate;
      if (ar == null && br == null) return 0;
      if (ar == null) return 1; // nulls last
      if (br == null) return -1;
      return br - ar; // returnRate desc
    });

  return {
    returnRate,
    returnDelta,
    refundExposure,
    flaggedCount: flagged,
    avgRating,
    ratingDelta: round(ratingDelta, 2),
    storeCount,
    trend,
    conv: Array(WEEKS).fill(null),
    leaderboard,
  };
}

/**
 * buildSnapshot — assemble the full §7 snapshot.
 *
 * @param {object}   args
 * @param {Record<string,object>} args.ratings  normalizeBaserow output (ASIN→rating)
 * @param {Record<string,object>} args.pma      aggregatePma output (ASIN→aggregate)
 * @param {{ stores: object[] }}  args.stores    config/stores.json
 * @param {object}   args.thresholds            config .classification (the 6 values)
 * @param {object}   args.windows               config .windows (uses windowDays)
 * @param {string}   args.generatedAt           ISO timestamp (passed through)
 * @param {number}   [args.refreshIntervalHours=6]
 * @returns {object} snapshot (spec §7)
 */
export function buildSnapshot({
  ratings,
  pma,
  stores,
  thresholds,
  windows,
  generatedAt,
  refreshIntervalHours = 6,
}) {
  const storeList = stores.stores;

  // Per-store rollups (every store appears, empty ones forced to "nodata").
  const storeResults = storeList.map((s) => rollupStore(s, pma, ratings, thresholds));

  const portfolio = rollupPortfolio(
    pma,
    ratings,
    storeResults,
    storeList.length,
    thresholds
  );
  portfolio.brands = rollupBrands(pma, ratings, thresholds);
  const decliningBrands = portfolio.brands.filter(
    (b) => b.ratingDelta != null && b.ratingDelta <= thresholds.ratingDrop
  ).length;
  portfolio.verdict = {
    state: portfolioVerdict({ ratingDelta: portfolio.ratingDelta, decliningBrands }, thresholds),
    ratingDelta: portfolio.ratingDelta,
    decliningBrands,
  };

  return {
    generatedAt,
    refreshIntervalHours,
    window: { days: windows.windowDays },
    thresholds: {
      returnRate: thresholds.returnRate,
      returnRateWarn: thresholds.returnRateWarn,
      refundSpike: thresholds.refundSpike,
      ratingBad: thresholds.ratingBad,
      ratingWarn: thresholds.ratingWarn,
      ratingDrop: thresholds.ratingDrop,
      ratingRise: thresholds.ratingRise,
    },
    portfolio,
    stores: storeResults.map((r) => r.store),
  };
}
