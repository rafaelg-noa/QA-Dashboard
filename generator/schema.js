/**
 * generator/schema.js — JSON-schema guard (spec §12).
 *
 * Validates the data.json snapshot against an AJV schema.
 *
 * Key design: the schema ASSERTS PRESENCE (required) of every client-recompute
 * input (§6.1) so live re-classification can never silently break due to a
 * missing field. Null values are explicitly ALLOWED for nullable numbers
 * (type: ["number","null"]) — absence of the key is what fails validation.
 *
 * Export: validate(snapshot) → { ok: boolean, errors: string[] }
 */

import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true });

// ── Reusable sub-schemas ───────────────────────────────────────────────────────

/** Nullable number: present but may be null (§6.1 — null is legitimate, missing is not). */
const numOrNull = { type: ["number", "null"] };

/** Non-nullable number. */
const num = { type: "number" };

/** Non-nullable string. */
const str = { type: "string" };

// ── window ────────────────────────────────────────────────────────────────────

const windowSchema = {
  type: "object",
  required: ["days"],
  properties: { days: num },
  additionalProperties: false,
};

// ── thresholds ────────────────────────────────────────────────────────────────
// All 7 thresholds required (spec §12): these are the client-recompute config.

const thresholdsSchema = {
  type: "object",
  required: [
    "returnRate",
    "returnRateWarn",
    "refundSpike",
    "ratingBad",
    "ratingWarn",
    "ratingDrop",
    "ratingRise",
  ],
  properties: {
    returnRate: num,
    returnRateWarn: num,
    refundSpike: num,
    ratingBad: num,
    ratingWarn: num,
    ratingDrop: num,
    ratingRise: num,
  },
  additionalProperties: false,
};

// ── brand item ────────────────────────────────────────────────────────────────

const brandItemSchema = {
  type: "object",
  required: ["id", "name", "health", "rating", "ratingDelta", "returnRate", "refundSpike", "refundExposure", "flagged", "trend"],
  properties: {
    id: str,
    name: str,
    health: { type: "string", enum: ["good", "warn", "bad", "nodata"] },
    rating: numOrNull,
    ratingDelta: numOrNull,
    returnRate: numOrNull,
    refundSpike: numOrNull,
    refundExposure: num,
    flagged: num,
    trend: { type: "array", items: numOrNull },
  },
};

// ── verdict ───────────────────────────────────────────────────────────────────

const verdictSchema = {
  type: "object",
  required: ["state", "ratingDelta", "decliningBrands"],
  properties: {
    state: { type: "string", enum: ["improving", "stable", "slipping"] },
    ratingDelta: numOrNull,
    decliningBrands: num,
  },
  additionalProperties: false,
};

// ── leaderboard item ──────────────────────────────────────────────────────────

const leaderboardItemSchema = {
  type: "object",
  required: ["id", "name", "health", "returnRate", "refundSpike", "avgRating", "flagged"],
  properties: {
    id: str,
    name: str,
    health: { type: "string", enum: ["good", "warn", "bad", "nodata"] },
    returnRate: numOrNull,
    refundSpike: numOrNull,
    avgRating: numOrNull,
    flagged: num,
  },
};

// ── portfolio ─────────────────────────────────────────────────────────────────

const portfolioSchema = {
  type: "object",
  required: [
    "returnRate",
    "returnDelta",
    "refundExposure",
    "flaggedCount",
    "avgRating",
    "ratingDelta",
    "storeCount",
    "trend",
    "conv",
    "leaderboard",
    "verdict",
    "brands",
  ],
  properties: {
    returnRate: numOrNull,
    returnDelta: numOrNull,
    refundExposure: num,
    flaggedCount: num,
    avgRating: numOrNull,
    ratingDelta: numOrNull,
    storeCount: num,
    trend: { type: "array", items: numOrNull },
    conv: { type: "array", items: { type: ["null"] } },
    leaderboard: { type: "array", items: leaderboardItemSchema },
    verdict: verdictSchema,
    brands: { type: "array", items: brandItemSchema },
  },
};

// ── store kpis ────────────────────────────────────────────────────────────────
// ALL 7 keys required (spec §12 client-recompute inputs):
//   returnRate, returnDelta, refundSpike, reviewRating, reviewDelta → nullable
//   ratingCount → number (0 for nodata stores)
//   conversion  → nullable (always null in Phase 1)

const kpisSchema = {
  type: "object",
  required: [
    "returnRate",
    "returnDelta",
    "refundSpike",
    "reviewRating",
    "reviewDelta",
    "ratingCount",
    "conversion",
  ],
  properties: {
    returnRate: numOrNull,
    returnDelta: numOrNull,
    refundSpike: numOrNull,
    reviewRating: numOrNull,
    reviewDelta: numOrNull,
    ratingCount: num,
    conversion: numOrNull,
  },
};

// ── ASIN entry ────────────────────────────────────────────────────────────────
// Client-recompute inputs required (spec §12):
//   returnRate, refundSpike, reviewRating, reviewDelta

const asinSchema = {
  type: "object",
  required: [
    "asin",
    "sku",
    "title",
    "brand",
    "returnRate",
    "refundSpike",
    "refundDelta",
    "reviewRating",
    "reviewDelta",
    "ratingCount",
    "conversion",
    "flags",
  ],
  properties: {
    asin: str,
    sku: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    brand: { type: ["string", "null"] },
    returnRate: numOrNull,
    refundSpike: numOrNull,
    refundDelta: str,
    reviewRating: numOrNull,
    reviewDelta: numOrNull,
    ratingCount: numOrNull,
    conversion: { type: ["number", "null"] },
    flags: { type: "array", items: str },
  },
};

// ── store entry ───────────────────────────────────────────────────────────────

const storeSchema = {
  type: "object",
  required: ["id", "name", "health", "kpis", "trend", "conv", "asins"],
  properties: {
    id: str,
    name: str,
    health: { type: "string", enum: ["good", "warn", "bad", "nodata"] },
    kpis: kpisSchema,
    trend: { type: "array", items: numOrNull },
    conv: { type: "array", items: { type: ["null"] } },
    asins: { type: "array", items: asinSchema },
  },
};

// ── Root snapshot schema ──────────────────────────────────────────────────────

const snapshotSchema = {
  type: "object",
  required: [
    "generatedAt",
    "refreshIntervalHours",
    "window",
    "thresholds",
    "portfolio",
    "stores",
  ],
  properties: {
    generatedAt: str,
    refreshIntervalHours: num,
    window: windowSchema,
    thresholds: thresholdsSchema,
    portfolio: portfolioSchema,
    stores: { type: "array", items: storeSchema },
  },
};

// ── Compile schema ────────────────────────────────────────────────────────────

const _validate = ajv.compile(snapshotSchema);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * validate(snapshot) → { ok: boolean, errors: string[] }
 *
 * @param {object} snapshot  The data.json snapshot to validate.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validate(snapshot) {
  const ok = _validate(snapshot);
  if (ok) return { ok: true, errors: [] };
  const errors = (_validate.errors ?? []).map((e) => {
    // AJV instancePath is e.g. "/thresholds/ratingDrop", message is "must have required property"
    const path = e.instancePath || e.schemaPath;
    return `${path} ${e.message}${e.params?.missingProperty ? ` '${e.params.missingProperty}'` : ""}`;
  });
  return { ok: false, errors };
}
