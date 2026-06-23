import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS as D, storeHealth, asinFlags, isFlagged,
  rateClass, ratingClass, flaggedCount
} from "../public/shared/classify.js";

test("storeHealth: bad when return rate >= breach (§6)", () => {
  assert.equal(storeHealth({ returnRate: 5.0, reviewRating: 4.5, reviewDelta: 0, refundSpike: 0 }, D), "bad");
});
test("storeHealth: bad when avg rating < ratingBad", () => {
  assert.equal(storeHealth({ returnRate: 1, reviewRating: 3.4, reviewDelta: 0, refundSpike: 0 }, D), "bad");
});
test("storeHealth: warn on returnRateWarn / ratingDrop / refundSpike", () => {
  assert.equal(storeHealth({ returnRate: 4.0, reviewRating: 4.5, reviewDelta: 0, refundSpike: 0 }, D), "warn");
  assert.equal(storeHealth({ returnRate: 1, reviewRating: 4.5, reviewDelta: -0.2, refundSpike: 0 }, D), "warn");
  assert.equal(storeHealth({ returnRate: 1, reviewRating: 4.5, reviewDelta: 0, refundSpike: 26 }, D), "warn");
});
test("storeHealth: good otherwise; null rating doesn't force bad (§5.1)", () => {
  assert.equal(storeHealth({ returnRate: 1, reviewRating: 4.8, reviewDelta: 0.1, refundSpike: 5 }, D), "good");
  assert.equal(storeHealth({ returnRate: 1, reviewRating: null, reviewDelta: 0, refundSpike: 0 }, D), "good");
});
test("asinFlags: each rule + combination (§6)", () => {
  assert.deepEqual(asinFlags({ returnRate: 5, refundSpike: 0, reviewDelta: 0 }, D), ["return"]);
  assert.deepEqual(asinFlags({ returnRate: 0, refundSpike: 26, reviewDelta: 0 }, D), ["refund"]);
  assert.deepEqual(asinFlags({ returnRate: 0, refundSpike: 0, reviewDelta: -0.2 }, D), ["ratingDrop"]);
  assert.deepEqual(asinFlags({ returnRate: 5, refundSpike: 26, reviewDelta: -0.3 }, D), ["return", "refund", "ratingDrop"]);
  assert.equal(isFlagged({ returnRate: 1, refundSpike: 1, reviewDelta: 0 }, D), false);
});
test("rateClass / ratingClass boundaries (§6)", () => {
  assert.equal(rateClass(5, D), "bad");
  assert.equal(rateClass(4, D), "warn");
  assert.equal(rateClass(3.9, D), "good");
  assert.equal(ratingClass(3.4, D), "bad");
  assert.equal(ratingClass(3.9, D), "warn");
  assert.equal(ratingClass(4.0, D), "good");
  assert.equal(ratingClass(null, D), "good"); // no rating ≠ zero
});
test("flaggedCount over a store's ASINs", () => {
  const asins = [
    { returnRate: 6, refundSpike: 0, reviewDelta: 0 },
    { returnRate: 1, refundSpike: 0, reviewDelta: 0 },
    { returnRate: 0, refundSpike: 30, reviewDelta: 0 }
  ];
  assert.equal(flaggedCount(asins, D), 2);
});
test("OVERRIDE: lowering returnRate breach re-colors & re-counts (§6.1, §12)", () => {
  const t = { ...D, returnRate: 3.0, returnRateWarn: 2.0 };
  assert.equal(storeHealth({ returnRate: 3.5, reviewRating: 4.5, reviewDelta: 0, refundSpike: 0 }, t), "bad");
  assert.equal(flaggedCount([{ returnRate: 3.5, refundSpike: 0, reviewDelta: 0 }], t), 1);
});
test("OVERRIDE: raising thresholds clears flags (reset-to-defaults path)", () => {
  const lax = { ...D, returnRate: 9, returnRateWarn: 8, refundSpike: 99, ratingDrop: -9 };
  assert.equal(storeHealth({ returnRate: 6, reviewRating: 4.5, reviewDelta: -0.5, refundSpike: 40 }, lax), "good");
  assert.equal(flaggedCount([{ returnRate: 6, refundSpike: 40, reviewDelta: -0.5 }], lax), 0);
});
