import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeBaserow } from "../generator/baserow.js";

const rows = JSON.parse(
  readFileSync(new URL("./fixtures/baserow-691.sample.json", import.meta.url))
);

test("normalizeBaserow keys by ASIN, extracts nested Brand/status, preserves null rating, computes delta", () => {
  const m = normalizeBaserow(rows);

  // Must have 20 entries (one per fixture row)
  assert.equal(Object.keys(m).length, 20);

  // --- B018SWE5DY: NatriSweet, Active, rating 4.1, prev 4.1, delta 0.00 ---
  const natri = m["B018SWE5DY"];
  assert.ok(natri, "B018SWE5DY should exist");
  assert.equal(natri.brand, "NatriSweet");
  assert.equal(natri.listingStatus, "Active");
  assert.equal(natri.reviewRating, 4.1);
  assert.equal(natri.ratingCount, 6962);
  assert.equal(natri.previousRating, 4.1);
  assert.equal(natri.reviewDelta, 0.00);
  assert.equal(natri.velocity, 100.20);
  assert.equal(natri.salePrice, 16.99);
  assert.equal(natri.inventoryHealth, "ORANGE");
  assert.equal(natri.title, "Stevia Liquid Drops, 8 Fl oz, 1823 Servings, Pure Concentrated Drops with Zero Calories & Zero Carbs, Delicious Sugar Substitute Great for Keto & Paleo Diets, by Natrisweet");

  // --- B01BPCAWK4: TreeActiv, Inactive, Inactive listing, TEAL inventory ---
  const treeActiv = m["B01BPCAWK4"];
  assert.ok(treeActiv, "B01BPCAWK4 should exist");
  assert.equal(treeActiv.brand, "TreeActiv");
  assert.equal(treeActiv.listingStatus, "Inactive");
  assert.equal(treeActiv.reviewRating, 4.1);
  assert.equal(treeActiv.ratingCount, 7320);
  assert.equal(treeActiv.inventoryHealth, "TEAL");

  // --- B00H4A36JG: DivaStuff, Active, NULL ratings, 0 velocity, NO VELOCITY health ---
  const diva = m["B00H4A36JG"];
  assert.ok(diva, "B00H4A36JG should exist");
  assert.equal(diva.brand, "DivaStuff");
  assert.equal(diva.listingStatus, "Active");
  assert.equal(diva.reviewRating, null, "null rating must stay null (not 0)");
  assert.equal(diva.ratingCount, null, "null count must stay null");
  assert.equal(diva.previousRating, null);
  assert.equal(diva.reviewDelta, null, "delta must be null when both ratings are null");
  assert.equal(diva.velocity, 0.00);
  assert.equal(diva.salePrice, null);
  assert.equal(diva.inventoryHealth, "NO VELOCITY");

  // --- B08B789MG6: Purisure, null title, NO VELOCITY ---
  const purisure = m["B08B789MG6"];
  assert.ok(purisure, "B08B789MG6 should exist");
  assert.equal(purisure.brand, "Purisure");
  assert.equal(purisure.title, null);
  assert.equal(purisure.reviewRating, null);
  assert.equal(purisure.reviewDelta, null);
  assert.equal(purisure.inventoryHealth, "NO VELOCITY");
});

test("normalizeBaserow reviewDelta is null when either rating is null", () => {
  // Verify delta rule: null when either input is null
  const m = normalizeBaserow(rows);

  // All NO VELOCITY rows have null ratings → delta must be null
  const noVelocityAsins = [
    "B00H4A36JG", "B00ES0Z206", "B016E012MY", "B08B789MG6",
    "B08F5J12YF", "B00Z3MHEK4", "B08B78K8S2", "B07491MKT8",
    "B081NLTJXQ", "B0B8ZKS4VP", "B07DNKN94L"
  ];
  for (const asin of noVelocityAsins) {
    assert.equal(m[asin].reviewDelta, null, `${asin}: delta must be null when ratings are null`);
  }
});

test("normalizeBaserow reviewDelta rounds to 2dp when both ratings present", () => {
  // B08KBLNPGZ: rating 3.9, prev 3.9 → delta 0.00
  const m = normalizeBaserow(rows);
  const ayadara = m["B08KBLNPGZ"];
  assert.equal(ayadara.reviewRating, 3.9);
  assert.equal(ayadara.previousRating, 3.9);
  assert.equal(ayadara.reviewDelta, 0.00);
});
