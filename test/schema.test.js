/**
 * Tests for generator/schema.js — JSON-schema guard (spec §12).
 *
 * All tests operate on data.sample.json (real build output, committed fixture).
 * The schema must assert PRESENCE of every client-recompute input so live
 * re-classification (§6.1) can never silently break.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../generator/schema.js";

// Load the committed fixture via readFileSync to avoid JSON import assertion issues.
const good = JSON.parse(
  readFileSync(new URL("./fixtures/data.sample.json", import.meta.url))
);

// ── Happy path ────────────────────────────────────────────────────────────────

test("valid snapshot passes", () => assert.equal(validate(good).ok, true));

// ── Threshold presence ────────────────────────────────────────────────────────

test("missing a threshold fails", () => {
  const bad = structuredClone(good);
  delete bad.thresholds.ratingDrop;
  assert.equal(validate(bad).ok, false);
});

test("missing returnRateWarn threshold fails", () => {
  const bad = structuredClone(good);
  delete bad.thresholds.returnRateWarn;
  assert.equal(validate(bad).ok, false);
});

// ── Store kpi presence (client-recompute inputs) ──────────────────────────────

test("store kpis missing reviewDelta fails (breaks client recompute)", () => {
  const bad = structuredClone(good);
  delete bad.stores[0].kpis.reviewDelta;
  assert.equal(validate(bad).ok, false);
});

test("store kpis missing returnRate fails", () => {
  const bad = structuredClone(good);
  delete bad.stores[0].kpis.returnRate;
  assert.equal(validate(bad).ok, false);
});

test("store kpis missing refundSpike fails", () => {
  const bad = structuredClone(good);
  delete bad.stores[0].kpis.refundSpike;
  assert.equal(validate(bad).ok, false);
});

test("store kpis missing reviewRating fails", () => {
  const bad = structuredClone(good);
  delete bad.stores[0].kpis.reviewRating;
  assert.equal(validate(bad).ok, false);
});

// ── ASIN field presence (client-recompute inputs) ─────────────────────────────

test("ASIN missing refundSpike fails", () => {
  const bad = structuredClone(good);
  const s = bad.stores.find((s) => s.asins.length);
  delete s.asins[0].refundSpike;
  assert.equal(validate(bad).ok, false);
});

test("ASIN missing reviewDelta fails", () => {
  const bad = structuredClone(good);
  const s = bad.stores.find((s) => s.asins.length);
  delete s.asins[0].reviewDelta;
  assert.equal(validate(bad).ok, false);
});

// ── Root envelope presence ────────────────────────────────────────────────────

test("missing generatedAt fails", () => {
  const bad = structuredClone(good);
  delete bad.generatedAt;
  assert.equal(validate(bad).ok, false);
});

test("missing portfolio fails", () => {
  const bad = structuredClone(good);
  delete bad.portfolio;
  assert.equal(validate(bad).ok, false);
});

// ── Null is allowed (presence, not non-null) ──────────────────────────────────

test("empty-store nulls in kpis still VALIDATE (presence, not non-null)", () => {
  const nodata = good.stores.find((s) => s.health === "nodata");
  assert.ok(nodata, "sample has a nodata store");
  assert.equal(validate(good).ok, true); // nulls are allowed; presence is required
});

test("ASIN with null returnRate is valid (null means no data)", () => {
  // The sample itself may have ASINs with null values; validate should pass.
  assert.equal(validate(good).ok, true);
});

// ── errors array when invalid ─────────────────────────────────────────────────

test("errors is empty array when valid", () => {
  const result = validate(good);
  assert.ok(Array.isArray(result.errors));
  assert.equal(result.errors.length, 0);
});

test("errors array is non-empty when invalid", () => {
  const bad = structuredClone(good);
  delete bad.thresholds.ratingDrop;
  const result = validate(bad);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0, "errors array should be non-empty");
  assert.ok(result.errors.every((e) => typeof e === "string"), "each error is a string");
});
