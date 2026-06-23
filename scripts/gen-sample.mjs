/**
 * scripts/gen-sample.mjs
 *
 * Regenerate test/fixtures/data.sample.json from the committed sample fixtures.
 * This keeps the fixture deterministic (fixed generatedAt, uses real build output).
 *
 * Usage:  node scripts/gen-sample.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeBaserow } from "../generator/baserow.js";
import { aggregatePma } from "../generator/pma.js";
import { buildSnapshot } from "../generator/build.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Load fixtures
const econ = JSON.parse(readFileSync(join(root, "test/fixtures/pma-economics.sample.json")));
const brows = JSON.parse(readFileSync(join(root, "test/fixtures/baserow-691.sample.json")));
const stores = JSON.parse(readFileSync(join(root, "config/stores.json")));
const cfg = JSON.parse(readFileSync(join(root, "config/thresholds.json")));

// Build the snapshot using EXACTLY the same pattern as build.test.js
const ratings = normalizeBaserow(brows);
const pma = aggregatePma(econ, [], cfg.windows);

const snap = buildSnapshot({
  ratings,
  pma,
  stores,
  thresholds: cfg.classification,
  windows: cfg.windows,
  generatedAt: "2026-06-23T12:00:00.000Z", // FIXED — deterministic
});

const outPath = join(root, "test/fixtures/data.sample.json");
writeFileSync(outPath, JSON.stringify(snap, null, 2) + "\n");
console.log(`Written: ${outPath}`);
console.log(`  stores: ${snap.stores.length}`);
console.log(`  total asins: ${snap.stores.reduce((n, s) => n + s.asins.length, 0)}`);
console.log(`  nodata stores: ${snap.stores.filter((s) => s.health === "nodata").length}`);
