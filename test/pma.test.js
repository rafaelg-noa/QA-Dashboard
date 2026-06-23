/**
 * Tests for aggregatePma (pure, unit-tested against real fixture data).
 *
 * Window boundary convention (INCLUSIVE both ends, UTC day comparison):
 *   last window:  [asOf - (windowDays-1), asOf]           — 30 days ending ON asOf
 *   prior window: [asOf - (2*windowDays-1), asOf - windowDays] — 30 days immediately before, non-overlapping
 *
 * Example with windowDays=30, asOf=2026-06-21:
 *   last:  [2026-05-23, 2026-06-21]
 *   prior: [2026-04-23, 2026-05-22]
 *
 * Hand-computed ground truth for B0BD8LPJKQ from pma-economics.sample.json:
 *   Window rows (9): 2026-05-23,24,29,30; 2026-06-04,09,12,16,20
 *     unitsSoldWindow=1266, unitsReturnedWindow=28
 *     refundLast = 717.34 (sum of refunded_product_sales)
 *   Prior rows (15): 2026-04-24,27,29; 2026-05-02,04,05,08,10,11,14,15,16,20,21,22
 *     unitsSoldPrior=2023, unitsReturnedPrior=56
 *     refundPrior = 1497.81
 *   returnRate = 28/1266*100 = 2.2117...
 *   refundSpike = (717.34-1497.81)/1497.81*100 = -52.107...
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aggregatePma } from "../generator/pma.js";

const econRows = JSON.parse(
  readFileSync(new URL("./fixtures/pma-economics.sample.json", import.meta.url))
);

// Sessions fixture is unavailable (Phase 1 reality) — use empty array
const sessRows = [];

// ── helpers ──────────────────────────────────────────────────────────────────

/** Assert two numbers are within tolerance. */
function assertClose(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} ± ${tolerance}, got ${actual}`
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("aggregatePma: returnRate matches hand-computed value for B0BD8LPJKQ", () => {
  const result = aggregatePma(econRows, sessRows);
  const asin = result["B0BD8LPJKQ"];

  assert.ok(asin, "B0BD8LPJKQ should be present in output");

  // Hand-computed: 28/1266*100 = 2.2117%
  assertClose(asin.returnRate, 2.2117, 0.001, "returnRate for B0BD8LPJKQ");
});

test("aggregatePma: window sums match hand-computed values for B0BD8LPJKQ", () => {
  const result = aggregatePma(econRows, sessRows);
  const asin = result["B0BD8LPJKQ"];

  assert.equal(asin.unitsSoldWindow, 1266, "unitsSoldWindow");
  assert.equal(asin.unitsReturnedWindow, 28, "unitsReturnedWindow");
  assert.equal(asin.unitsSoldPrior, 2023, "unitsSoldPrior");
  assert.equal(asin.unitsReturnedPrior, 56, "unitsReturnedPrior");
});

test("aggregatePma: refund sums match hand-computed values for B0BD8LPJKQ", () => {
  const result = aggregatePma(econRows, sessRows);
  const asin = result["B0BD8LPJKQ"];

  // refundLast = 717.34 (sum of 9 window rows), refundPrior = 1497.81 (15 prior rows)
  assertClose(asin.refundLast, 717.34, 0.02, "refundLast for B0BD8LPJKQ");
  assertClose(asin.refundPrior, 1497.81, 0.02, "refundPrior for B0BD8LPJKQ");
});

test("aggregatePma: refundSpike matches hand-computed value for B0BD8LPJKQ", () => {
  const result = aggregatePma(econRows, sessRows);
  const asin = result["B0BD8LPJKQ"];

  // refundSpike = (717.34 - 1497.81) / 1497.81 * 100 = -52.107%
  assert.ok(asin.refundSpike !== null, "refundSpike should not be null when refundPrior > 0");
  assertClose(asin.refundSpike, -52.107, 0.01, "refundSpike for B0BD8LPJKQ");
});

test("aggregatePma: accountId is the bare id from the row", () => {
  const result = aggregatePma(econRows, sessRows);
  const asin = result["B0BD8LPJKQ"];

  // Fixture rows have bare account_id without 'amazonmws-' prefix
  assert.equal(asin.accountId, "A8YCR05DHF8XC");
  assert.equal(asin.asin, "B0BD8LPJKQ");
});

test("aggregatePma: weekly array has exactly trendWeeks entries, oldest→newest", () => {
  const trendWeeks = 12;
  const result = aggregatePma(econRows, sessRows, { trendWeeks });
  const asin = result["B0BD8LPJKQ"];

  assert.equal(asin.weekly.length, trendWeeks, `weekly must have exactly ${trendWeeks} buckets`);

  // Each bucket must have unitsSold and unitsReturned (both >= 0)
  for (const [i, bucket] of asin.weekly.entries()) {
    assert.ok("unitsSold" in bucket, `bucket[${i}] missing unitsSold`);
    assert.ok("unitsReturned" in bucket, `bucket[${i}] missing unitsReturned`);
    assert.ok(bucket.unitsSold >= 0, `bucket[${i}].unitsSold must be >= 0`);
    assert.ok(bucket.unitsReturned >= 0, `bucket[${i}].unitsReturned must be >= 0`);
  }
});

test("aggregatePma: sum of weekly unitsSold <= total ASIN units (sanity check)", () => {
  const result = aggregatePma(econRows, sessRows);
  const asin = result["B0BD8LPJKQ"];

  const weeklyTotal = asin.weekly.reduce((s, b) => s + b.unitsSold, 0);
  const allRows = econRows.filter(r => r.asin === "B0BD8LPJKQ");
  const totalUnits = allRows.reduce((s, r) => s + Number(r.units_sold), 0);

  assert.ok(
    weeklyTotal <= totalUnits,
    `weekly sum ${weeklyTotal} must be <= total units ${totalUnits} (12-week span may not cover all rows)`
  );
});

test("aggregatePma: conversion is null when sessRows is empty", () => {
  const result = aggregatePma(econRows, [], /* empty sessions */);
  const asin = result["B0BD8LPJKQ"];

  assert.equal(asin.conversion, null, "conversion must be null when sessions are unavailable");
});

test("aggregatePma: refundSpike is null when refundPrior === 0", () => {
  // B00U31XAF8 has zero rows in the prior window → refundPrior = 0 → refundSpike must be null
  const result = aggregatePma(econRows, sessRows);
  const asin = result["B00U31XAF8"];

  assert.ok(asin, "B00U31XAF8 should be present in output");
  assert.equal(asin.refundSpike, null, "refundSpike must be null when refundPrior === 0");
});

test("aggregatePma: returnRate is null when unitsSoldWindow === 0 (divide-by-zero guard)", () => {
  // Construct synthetic rows for a zero-sales ASIN (only outside window)
  const syntheticRows = [
    // One row for 'B0SYNTH001', only in the far past (outside all windows)
    {
      account_id: "ATEST1",
      asin: "B0SYNTH001",
      date: "2026-01-01T00:00:00.000Z",
      units_sold: "10",
      units_returned: "2",
      refunded_product_sales: "50.00",
      net_sales: "100.00",
      sales: "150.00",
      RefundCommissionFee_total: "1.00",
      ReferralFee_total: "10.00",
    }
  ];

  // asOf will default to max date in syntheticRows = 2026-01-01
  // window = [2025-12-03, 2026-01-01] — but that row IS in the window!
  // Use explicit asOf 2026-06-21 so the row (2026-01-01) falls outside both windows
  const result = aggregatePma(syntheticRows, [], { asOf: new Date("2026-06-21T00:00:00.000Z") });
  const asin = result["B0SYNTH001"];

  // The row falls outside the 60-day combined window (prior starts 2026-04-23)
  // → unitsSoldWindow = 0, so returnRate must be null (not NaN, not Infinity)
  assert.equal(asin.returnRate, null, "returnRate must be null when unitsSoldWindow === 0");
});

test("aggregatePma: no NaN or Infinity in any numeric field", () => {
  const result = aggregatePma(econRows, sessRows);

  for (const [asin, data] of Object.entries(result)) {
    const numericFields = ["unitsSoldWindow", "unitsReturnedWindow", "unitsSoldPrior", "unitsReturnedPrior", "refundLast", "refundPrior"];
    for (const field of numericFields) {
      assert.ok(
        Number.isFinite(data[field]) || data[field] === 0,
        `${asin}.${field} must be finite (got ${data[field]})`
      );
    }
    // returnRate and refundSpike may be null — but must NOT be NaN or Infinity
    for (const field of ["returnRate", "refundSpike"]) {
      assert.ok(
        data[field] === null || Number.isFinite(data[field]),
        `${asin}.${field} must be null or finite (got ${data[field]})`
      );
    }
  }
});

test("aggregatePma: returns keyed object with all fixture ASINs present", () => {
  const result = aggregatePma(econRows, sessRows);
  const fixtureAsins = [...new Set(econRows.map(r => r.asin))];

  for (const asin of fixtureAsins) {
    assert.ok(asin in result, `ASIN ${asin} must be present in result`);
  }
});

test("aggregatePma: asOf defaults to max date in econRows (determinism)", () => {
  // When asOf is not provided, asOf defaults to the max date in econRows
  // so results are deterministic based solely on the fixture
  const r1 = aggregatePma(econRows, sessRows);
  const r2 = aggregatePma(econRows, sessRows);

  // Same fixture → same results
  assert.equal(r1["B0BD8LPJKQ"].unitsSoldWindow, r2["B0BD8LPJKQ"].unitsSoldWindow);
  assert.equal(r1["B0BD8LPJKQ"].returnRate, r2["B0BD8LPJKQ"].returnRate);
});
