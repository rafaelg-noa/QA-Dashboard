/**
 * generator/index.js — Orchestrator (spec §4)
 *
 * Pulls Baserow ratings + PMA economics, assembles the snapshot,
 * validates it, and atomically writes public/data.json.
 *
 * Guarantees:
 *   - Never writes public/data.json when validation fails (last good snapshot survives).
 *   - Exits 1 on missing tokens, validation failure, or any thrown error.
 *   - Logs progress so the operator sees life during the ~12-minute PMA pull.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { fetchBaserow, normalizeBaserow } from "./baserow.js";
import { fetchPma, aggregatePma } from "./pma.js";
import { buildSnapshot } from "./build.js";
import { validate } from "./schema.js";

/** Resolve a path relative to this file (ESM-safe). */
function resolve(relativePath) {
  return new URL(relativePath, import.meta.url).pathname;
}

export async function main() {
  // ── 1. Token guard ──────────────────────────────────────────────────────────
  const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
  const PMA_API_TOKEN = process.env.PMA_API_TOKEN;

  if (!BASEROW_TOKEN || !PMA_API_TOKEN) {
    const missing = [
      !BASEROW_TOKEN && "BASEROW_TOKEN",
      !PMA_API_TOKEN && "PMA_API_TOKEN",
    ]
      .filter(Boolean)
      .join(", ");
    console.error(`Error: missing required environment variable(s): ${missing}`);
    console.error("Set them before running: BASEROW_TOKEN=... PMA_API_TOKEN=... node generator/index.js");
    process.exit(1);
  }

  // ── 2. Load config ──────────────────────────────────────────────────────────
  const cfg = JSON.parse(readFileSync(resolve("../config/thresholds.json"), "utf8"));
  const stores = JSON.parse(readFileSync(resolve("../config/stores.json"), "utf8"));

  // ── 3. Runtime "now" ────────────────────────────────────────────────────────
  const generatedAt = new Date().toISOString();

  try {
    // ── 4. Fetch Baserow ──────────────────────────────────────────────────────
    console.log("Fetching Baserow…");
    const ratings = normalizeBaserow(await fetchBaserow({ token: BASEROW_TOKEN }));
    console.log(`  Baserow: ${Object.keys(ratings).length} ASINs`);

    // ── 5. Fetch PMA ─────────────────────────────────────────────────────────
    console.log("Fetching PMA (this takes several minutes)…");
    const { econRows, sessRows } = await fetchPma({ token: PMA_API_TOKEN });
    console.log(`  PMA economics: ${econRows.length} rows`);

    // ── 6. Aggregate PMA ─────────────────────────────────────────────────────
    const pma = aggregatePma(econRows, sessRows, cfg.windows);
    console.log(`  PMA aggregated: ${Object.keys(pma).length} ASINs`);

    // ── 7. Build snapshot ────────────────────────────────────────────────────
    const snapshot = buildSnapshot({
      ratings,
      pma,
      stores,
      thresholds: cfg.classification,
      windows: cfg.windows,
      generatedAt,
      refreshIntervalHours: 12,
    });

    // ── 8. Validate ──────────────────────────────────────────────────────────
    const { ok, errors } = validate(snapshot);

    if (!ok) {
      // DO NOT write — preserve the last good snapshot (spec §4).
      console.error("Snapshot validation failed — public/data.json NOT updated.");
      for (const e of errors) {
        console.error(`  ${e}`);
      }
      process.exit(1);
    }

    // ── 9. Write output ──────────────────────────────────────────────────────
    const outPath = resolve("../public/data.json");
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

    const nodataCount = snapshot.stores.filter((s) => s.health === "nodata").length;
    console.log(
      `Done. generatedAt=${generatedAt} stores=${snapshot.portfolio.storeCount} ` +
        `nodata=${nodataCount} returnRate=${snapshot.portfolio.returnRate?.toFixed(2) ?? "null"}% ` +
        `flagged=${snapshot.portfolio.flaggedCount}`
    );
  } catch (err) {
    // Propagate all unexpected errors loudly; never write a partial file.
    console.error(err);
    process.exit(1);
  }
}

// ── Entry-point guard (ESM) ─────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
