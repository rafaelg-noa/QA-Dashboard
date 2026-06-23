/**
 * Baserow table 691 — fetch + normalize to ASIN-keyed ratings map.
 * §5.1: null ratings stay null (inactive/no-velocity products are not zero).
 */

/**
 * Extract a value from a Baserow field that may be:
 *   - a linked-record array: [{id, value: {id, value: "Name", color}}]  → field[0]?.value?.value
 *   - a single-select object: {id, value: "Active", color}              → field?.value
 *   - a plain scalar (string, number, null)                             → field
 * Returns null for missing/empty.
 */
function extractLinkedRecord(field) {
  if (!Array.isArray(field) || field.length === 0) return null;
  return field[0]?.value?.value ?? null;
}

function extractSingleSelect(field) {
  if (field == null || typeof field !== "object" || Array.isArray(field)) return null;
  return field.value ?? null;
}

/**
 * Coerce a numeric field that arrives as a string or null.
 * Returns null when the value is null/undefined/empty, otherwise parseFloat.
 */
function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/**
 * Compute reviewDelta rounded to 2 decimal places.
 * Returns null if either rating is null.
 */
function computeDelta(current, previous) {
  if (current === null || previous === null) return null;
  return Math.round((current - previous) * 100) / 100;
}

/**
 * PURE — Map raw Baserow rows → object keyed by ASIN.
 * Each entry: { title, brand, listingStatus, reviewRating, ratingCount,
 *               previousRating, reviewDelta, velocity, salePrice, inventoryHealth }
 *
 * @param {object[]} rows  Raw rows from the Baserow REST API
 * @returns {Record<string, object>}
 */
export function normalizeBaserow(rows) {
  const result = {};
  for (const row of rows) {
    const reviewRating = toNum(row["Amazon Review Rating"]);
    const previousRating = toNum(row["Previous Review Rating"]);
    result[row["ASIN"]] = {
      title: row["Amazon Title"] ?? null,
      brand: extractLinkedRecord(row["Brand"]),
      listingStatus: extractSingleSelect(row["Amazon Listing Status"]),
      reviewRating,
      ratingCount: toNum(row["Amazon Rating Count"]),
      previousRating,
      reviewDelta: computeDelta(reviewRating, previousRating),
      velocity: toNum(row["30 Day Velocity"]),
      salePrice: toNum(row["Sale Price"]),
      inventoryHealth: extractSingleSelect(row["Inventory Health"]),
    };
  }
  return result;
}

/**
 * ASYNC I/O — Paginate the Baserow table 691 REST API and return all rows.
 * Uses global fetch (Node 22). No external deps.
 *
 * @param {{ token: string }} options
 * @returns {Promise<object[]>}
 */
export async function fetchBaserow({ token }) {
  const BASE = "https://baserow.novaeo.com/api/database/rows/table/691/";
  const headers = { Authorization: `Token ${token}` };
  const rows = [];
  let page = 1;

  while (true) {
    const url = `${BASE}?user_field_names=true&size=200&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Baserow API error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    rows.push(...data.results);
    if (!data.next) break;
    page++;
  }

  return rows;
}
