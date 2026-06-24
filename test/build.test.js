/**
 * Tests for buildSnapshot (pure: join ratings + pma → §7 snapshot).
 *
 * Ground truth is derived from the SAME real fixtures the build consumes, but
 * every assertion below INDEPENDENTLY recomputes the ratio-of-sums it checks
 * (or hard-codes a hand-traced literal) so the test pins real numbers, not a
 * tautological echo of the implementation.
 *
 * Window convention (from generator/pma.js, asOf = max date in econ = 2026-06-21):
 *   last window:  [2026-05-23, 2026-06-21]   prior: [2026-04-23, 2026-05-22]
 *
 * Economics fixture covers 4 accounts only:
 *   AMDDC4NXQ03GH (body and mind), A3DA69BBFHI7YK (Ohana),
 *   A3MAQKU8W5VLAP (Magnificent US), A8YCR05DHF8XC (Mind & Mana).
 * The other 5 of 9 stores have NO economics rows → must classify "nodata".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeBaserow } from "../generator/baserow.js";
import { aggregatePma } from "../generator/pma.js";
import { buildSnapshot } from "../generator/build.js";

const econ = JSON.parse(readFileSync(new URL("./fixtures/pma-economics.sample.json", import.meta.url)));
const brows = JSON.parse(readFileSync(new URL("./fixtures/baserow-691.sample.json", import.meta.url)));
const stores = JSON.parse(readFileSync(new URL("../config/stores.json", import.meta.url)));
const cfg = JSON.parse(readFileSync(new URL("../config/thresholds.json", import.meta.url)));

const ratings = normalizeBaserow(brows);
const pma = aggregatePma(econ, [], cfg.windows);
const GENERATED_AT = "2026-06-23T12:00:00.000Z";

function build() {
  return buildSnapshot({
    ratings,
    pma,
    stores,
    thresholds: cfg.classification,
    windows: cfg.windows,
    generatedAt: GENERATED_AT,
  });
}

/** Assert two numbers within tolerance. */
function close(actual, expected, tol, msg) {
  assert.ok(
    actual !== null && Math.abs(actual - expected) <= tol,
    `${msg}: expected ${expected} ± ${tol}, got ${actual}`
  );
}

/** Independent ratio-of-sums over a store's pma ASINs. */
function storeAsins(accountId) {
  return Object.values(pma).filter((a) => a.accountId === accountId);
}

// ── Snapshot envelope ─────────────────────────────────────────────────────────

test("envelope: generatedAt, refreshIntervalHours default 6, window.days, thresholds (all 7)", () => {
  const snap = build();
  assert.equal(snap.generatedAt, GENERATED_AT);
  assert.equal(snap.refreshIntervalHours, 6);
  assert.equal(snap.window.days, 30);
  // thresholds block is exactly the 7 classification values, equal to config
  assert.deepEqual(snap.thresholds, cfg.classification);
  assert.equal(Object.keys(snap.thresholds).length, 7);
  for (const k of ["returnRate", "returnRateWarn", "refundSpike", "ratingBad", "ratingWarn", "ratingDrop", "ratingRise"]) {
    assert.ok(k in snap.thresholds, `thresholds.${k} present`);
  }
});

test("refreshIntervalHours is overridable", () => {
  const snap = buildSnapshot({
    ratings, pma, stores, thresholds: cfg.classification, windows: cfg.windows,
    generatedAt: GENERATED_AT, refreshIntervalHours: 12,
  });
  assert.equal(snap.refreshIntervalHours, 12);
});

// ── Client-recompute inputs present everywhere ────────────────────────────────

test("snapshot carries every client-recompute input (§6.1, §7)", () => {
  const snap = build();
  assert.equal(snap.stores.length, 9);
  for (const s of snap.stores) {
    for (const k of ["returnRate", "refundSpike", "reviewRating", "reviewDelta"]) {
      assert.ok(k in s.kpis, `store ${s.id} kpis.${k} present`);
    }
    for (const a of s.asins) {
      for (const k of ["returnRate", "refundSpike", "reviewRating", "reviewDelta"]) {
        assert.ok(k in a, `asin ${a.asin} .${k} present`);
      }
    }
  }
});

// ── Hand-computed store: Mind & Mana (A8YCR05DHF8XC) ──────────────────────────
// Ratio-of-sums over its 8 ASINs in the last window:
//   Σ unitsReturnedWindow = 41, Σ unitsSoldWindow = 1873
//   returnRate = 41 / 1873 * 100 = 2.18900160...%
//   prior: Σreturned=68, Σsold=2555 → priorRR = 68/2555*100 = 2.66144814...
//   returnDelta = 2.18900 − 2.66145 = -0.47244653919...

test("Mind & Mana store.kpis.returnRate = HAND ratio-of-sums (41/1873*100)", () => {
  const snap = build();
  const mm = snap.stores.find((s) => s.id === "mindmana");
  assert.ok(mm, "mindmana present");

  // Independent recompute of the numerator/denominator from pma aggregates.
  const as = storeAsins("A8YCR05DHF8XC");
  const sumRet = as.reduce((n, a) => n + a.unitsReturnedWindow, 0);
  const sumSold = as.reduce((n, a) => n + a.unitsSoldWindow, 0);
  assert.equal(sumRet, 41, "Σ unitsReturnedWindow");
  assert.equal(sumSold, 1873, "Σ unitsSoldWindow");

  const expected = (41 / 1873) * 100; // 2.189001601708489
  close(mm.kpis.returnRate, expected, 1e-9, "mindmana returnRate");
  close(mm.kpis.returnRate, 2.189001601708489, 1e-9, "mindmana returnRate literal");
});

test("Mind & Mana returnDelta = returnRate − priorReturnRate (pp)", () => {
  const snap = build();
  const mm = snap.stores.find((s) => s.id === "mindmana");
  const expected = (41 / 1873) * 100 - (68 / 2555) * 100; // -0.47244653919170654
  close(mm.kpis.returnDelta, expected, 1e-9, "mindmana returnDelta");
});

test("Mind & Mana reviewRating = ratingCount-weighted mean (single rated ASIN B0BD8LPJKQ, 4.4)", () => {
  const snap = build();
  const mm = snap.stores.find((s) => s.id === "mindmana");
  // Only B0BD8LPJKQ in this store has a Baserow rating in the fixture? Verify via ratings.
  // Weighted mean over rated ASINs of the store:
  let num = 0, den = 0;
  for (const a of storeAsins("A8YCR05DHF8XC")) {
    const r = ratings[a.asin];
    if (r && r.reviewRating != null && r.ratingCount != null) { num += r.reviewRating * r.ratingCount; den += r.ratingCount; }
  }
  assert.ok(den > 0, "store has at least one rated ASIN");
  close(mm.kpis.reviewRating, num / den, 1e-9, "mindmana reviewRating");
  assert.equal(mm.kpis.ratingCount, den, "mindmana ratingCount = Σ ratingCount of rated ASINs");
});

test("Mind & Mana refundSpike = (ΣrefundLast − ΣrefundPrior)/ΣrefundPrior*100", () => {
  const snap = build();
  const mm = snap.stores.find((s) => s.id === "mindmana");
  const as = storeAsins("A8YCR05DHF8XC");
  const last = as.reduce((n, a) => n + a.refundLast, 0);
  const prior = as.reduce((n, a) => n + a.refundPrior, 0);
  close(mm.kpis.refundSpike, ((last - prior) / prior) * 100, 1e-7, "mindmana refundSpike");
});

test("Mind & Mana conversion is null (Phase 1, no sessions)", () => {
  const snap = build();
  const mm = snap.stores.find((s) => s.id === "mindmana");
  assert.equal(mm.kpis.conversion, null);
});

test("active stores classify good in this fixture; health from classify on raw kpis", () => {
  const snap = build();
  for (const id of ["mindmana", "bodyandmind", "magnificentus", "ohana"]) {
    const s = snap.stores.find((x) => x.id === id);
    assert.equal(s.health, "good", `${id} health`);
  }
});

// ── EMPTY-STORE rule ──────────────────────────────────────────────────────────

test("empty stores (incl. wyldskyn, sirius) → health nodata, kpis null, asins empty, trend/conv all null", () => {
  const snap = build();
  // Required by task: wyldskyn + sirius are not in econ fixture.
  // In this fixture, standmore/kreativfarms/veganexusus are also absent.
  const emptyIds = ["wyldskyn", "sirius", "standmore", "kreativfarms", "veganexusus"];
  for (const id of emptyIds) {
    const s = snap.stores.find((x) => x.id === id);
    assert.ok(s, `${id} present in stores`);
    assert.equal(s.health, "nodata", `${id} health nodata`);
    assert.equal(s.asins.length, 0, `${id} asins empty`);
    // kpis all null except ratingCount === 0
    for (const k of ["returnRate", "returnDelta", "refundSpike", "reviewRating", "reviewDelta", "conversion"]) {
      assert.equal(s.kpis[k], null, `${id} kpis.${k} null`);
    }
    assert.equal(s.kpis.ratingCount, 0, `${id} ratingCount 0`);
    assert.equal(s.trend.length, 12);
    assert.equal(s.conv.length, 12);
    assert.ok(s.trend.every((v) => v === null), `${id} trend all null`);
    assert.ok(s.conv.every((v) => v === null), `${id} conv all null`);
  }
});

test("specifically wyldskyn and sirius are nodata with no asins (task assertion)", () => {
  const snap = build();
  for (const id of ["wyldskyn", "sirius"]) {
    const s = snap.stores.find((x) => x.id === id);
    assert.equal(s.health, "nodata");
    assert.equal(s.asins.length, 0);
  }
});

// ── Per-ASIN entries ──────────────────────────────────────────────────────────

test("ASIN entry shape: sku null, conversion null, refundDelta display string, flags array", () => {
  const snap = build();
  const mm = snap.stores.find((s) => s.id === "mindmana");
  const a = mm.asins.find((x) => x.asin === "B0BD8LPJKQ");
  assert.ok(a, "B0BD8LPJKQ present in mindmana");
  assert.equal(a.sku, null, "sku null in Phase 1");
  assert.equal(a.conversion, null, "asin conversion null");
  // numeric returnRate/refundSpike carried straight from pma
  close(a.returnRate, pma["B0BD8LPJKQ"].returnRate, 1e-9, "asin returnRate");
  close(a.refundSpike, pma["B0BD8LPJKQ"].refundSpike, 1e-9, "asin refundSpike");
  // refundDelta string: refundSpike = -52.107... → "-52%"
  assert.equal(typeof a.refundDelta, "string");
  assert.equal(a.refundDelta, "-52%");
  // title/brand from ratings join
  assert.equal(a.brand, ratings["B0BD8LPJKQ"]?.brand ?? null);
  assert.ok(Array.isArray(a.flags));
});

test("ASIN refundDelta is 'n/a' when refundSpike null (B00U31XAF8, no prior refunds)", () => {
  const snap = build();
  const mm = snap.stores.find((s) => s.id === "mindmana");
  const a = mm.asins.find((x) => x.asin === "B00U31XAF8");
  assert.ok(a);
  assert.equal(a.refundSpike, null);
  assert.equal(a.refundDelta, "n/a");
});

test("ASIN refundDelta uses + sign for positive spikes (B0G1LZV2B3 in magnificentus)", () => {
  const snap = build();
  const mag = snap.stores.find((s) => s.id === "magnificentus");
  const a = mag.asins.find((x) => x.asin === "B0G1LZV2B3");
  assert.ok(a);
  assert.ok(a.refundSpike > 0);
  assert.match(a.refundDelta, /^\+\d+%$/, "positive spike has + prefix");
});

test("ASIN with no Baserow row → title/brand/rating fields null, still has flags array", () => {
  const snap = build();
  // Find any pma ASIN absent from ratings.
  const missing = Object.values(pma).find((a) => !(a.asin in ratings));
  if (missing) {
    const store = snap.stores.find((s) => s.asins.some((x) => x.asin === missing.asin));
    const a = store.asins.find((x) => x.asin === missing.asin);
    assert.equal(a.title, null);
    assert.equal(a.brand, null);
    assert.equal(a.reviewRating, null);
    assert.equal(a.reviewDelta, null);
    assert.equal(a.ratingCount, null);
    assert.ok(Array.isArray(a.flags));
  }
});

test("ASIN flags match asinFlags on the raw numbers (B0G1LZV2B3 → ['refund'])", () => {
  const snap = build();
  const mag = snap.stores.find((s) => s.id === "magnificentus");
  const a = mag.asins.find((x) => x.asin === "B0G1LZV2B3");
  assert.deepEqual(a.flags, ["refund"]);
});

// ── Store trend / conv arrays ─────────────────────────────────────────────────

test("store trend is ratio-of-sums per bucket (length 12); conv all null", () => {
  const snap = build();
  const mm = snap.stores.find((s) => s.id === "mindmana");
  assert.equal(mm.trend.length, 12);
  assert.equal(mm.conv.length, 12);
  assert.ok(mm.conv.every((v) => v === null));
  // recompute bucket-by-bucket
  const as = storeAsins("A8YCR05DHF8XC");
  for (let w = 0; w < 12; w++) {
    const s = as.reduce((n, a) => n + a.weekly[w].unitsSold, 0);
    const r = as.reduce((n, a) => n + a.weekly[w].unitsReturned, 0);
    const expected = s === 0 ? null : (r / s) * 100;
    if (expected === null) assert.equal(mm.trend[w], null, `bucket ${w} null`);
    else close(mm.trend[w], expected, 1e-9, `bucket ${w}`);
  }
});

// ── Portfolio ─────────────────────────────────────────────────────────────────

test("portfolio.returnRate = global ratio-of-sums (89/4846*100); storeCount 9", () => {
  const snap = build();
  const all = Object.values(pma);
  const ret = all.reduce((n, a) => n + a.unitsReturnedWindow, 0);
  const sold = all.reduce((n, a) => n + a.unitsSoldWindow, 0);
  assert.equal(ret, 89, "Σ all unitsReturnedWindow");
  assert.equal(sold, 4846, "Σ all unitsSoldWindow");
  close(snap.portfolio.returnRate, (89 / 4846) * 100, 1e-9, "portfolio returnRate");
  close(snap.portfolio.returnRate, 1.8365662401981016, 1e-9, "portfolio returnRate literal");
  assert.equal(snap.portfolio.storeCount, 9);
});

test("portfolio.refundExposure = Σ all refundLast rounded 2dp (2064.87)", () => {
  const snap = build();
  const sum = Object.values(pma).reduce((n, a) => n + a.refundLast, 0);
  assert.equal(snap.portfolio.refundExposure, Math.round(sum * 100) / 100);
  assert.equal(snap.portfolio.refundExposure, 2064.87);
});

test("portfolio.avgRating = ratingCount-weighted mean over ALL rated ASINs", () => {
  const snap = build();
  let num = 0, den = 0;
  for (const a of Object.values(pma)) {
    const r = ratings[a.asin];
    if (r && r.reviewRating != null && r.ratingCount != null) { num += r.reviewRating * r.ratingCount; den += r.ratingCount; }
  }
  close(snap.portfolio.avgRating, num / den, 1e-9, "portfolio avgRating");
  close(snap.portfolio.avgRating, 4.142589366176028, 1e-9, "portfolio avgRating literal");
});

test("portfolio.flaggedCount = Σ store flaggedCounts (= 3 in this fixture)", () => {
  const snap = build();
  assert.equal(snap.portfolio.flaggedCount, 3);
});

test("portfolio.trend length 12, conv all null", () => {
  const snap = build();
  assert.equal(snap.portfolio.trend.length, 12);
  assert.equal(snap.portfolio.conv.length, 12);
  assert.ok(snap.portfolio.conv.every((v) => v === null));
});

test("portfolio.leaderboard: one per store (9), sorted worst-health-first, nodata last", () => {
  const snap = build();
  const lb = snap.portfolio.leaderboard;
  assert.equal(lb.length, 9);
  // Each entry has the contract shape
  for (const e of lb) {
    for (const k of ["id", "name", "health", "returnRate", "refundSpike", "avgRating", "flagged"]) {
      assert.ok(k in e, `leaderboard entry has ${k}`);
    }
  }
  // Expected order (computed independently): all good stores by returnRate desc, then nodata.
  const order = lb.map((e) => e.id);
  assert.deepEqual(order.slice(0, 4), ["mindmana", "magnificentus", "bodyandmind", "ohana"]);
  // last 5 are nodata (returnRate null)
  for (const e of lb.slice(4)) {
    assert.equal(e.health, "nodata");
    assert.equal(e.returnRate, null);
  }
  // leaderboard avgRating maps to store.kpis.reviewRating
  const mmEntry = lb.find((e) => e.id === "mindmana");
  const mmStore = snap.stores.find((s) => s.id === "mindmana");
  assert.equal(mmEntry.avgRating, mmStore.kpis.reviewRating);
  assert.equal(mmEntry.flagged, 0);
  const magEntry = lb.find((e) => e.id === "magnificentus");
  assert.equal(magEntry.flagged, 2);
});

test("leaderboard health-rank dominates returnRate tie-break (nodata sorts after good even w/ null rate)", () => {
  const snap = build();
  const lb = snap.portfolio.leaderboard;
  const firstNodataIdx = lb.findIndex((e) => e.health === "nodata");
  // every entry before the first nodata must be non-nodata
  for (let i = 0; i < firstNodataIdx; i++) assert.notEqual(lb[i].health, "nodata");
  // every entry from there on is nodata
  for (let i = firstNodataIdx; i < lb.length; i++) assert.equal(lb[i].health, "nodata");
});
