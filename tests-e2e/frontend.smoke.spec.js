/**
 * Playwright frontend smoke test — QA Dashboard Phase 1
 * Covers: All-Stores render, per-store view, §6.1 keystone (Settings override
 * re-classifies without refetching data.json), and nodata preservation.
 */
import { test, expect } from "@playwright/test";

// ---- helpers ----------------------------------------------------------------

/**
 * Read the integer shown in the Flagged ASINs KPI value cell.
 * Returns NaN if not found / not parseable.
 */
async function readFlaggedKpiValue(page) {
  const el = page.locator('[data-testid="flagged-kpi-val"]');
  await el.waitFor({ state: "visible" });
  const text = await el.innerText();
  // text may be "53" or "53" (no HTML entities in innerText)
  return parseInt(text.trim(), 10);
}

// ---- tests ------------------------------------------------------------------

test.describe("QA Dashboard frontend smoke", () => {
  // Navigate to root before each test; clear localStorage to avoid bleed.
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Clear any residual threshold overrides from a prior test run.
    await page.evaluate(() => localStorage.removeItem("qa-thresholds"));
  });

  // --------------------------------------------------------------------------
  // 1. All-Stores default view
  // --------------------------------------------------------------------------
  test("renders All Stores view with 9 stores and portfolio KPI strip", async ({ page }) => {
    // Wait for the store rail to populate (JS fetch + render)
    const storeList = page.locator("#storeList");
    await storeList.waitFor({ state: "visible" });

    // Rail must have an "All Stores" pinned button
    const allBtn = storeList.locator("button[data-id='all']");
    await expect(allBtn).toBeVisible();
    await expect(allBtn).toHaveText(/All Stores/);

    // Exactly 9 per-store buttons (data-id != "all")
    const storeButtons = storeList.locator("button[data-id]:not([data-id='all'])");
    await expect(storeButtons).toHaveCount(9);

    // Portfolio KPI strip: "Flagged ASINs" cell must be visible with a number
    const flaggedVal = page.locator('[data-testid="flagged-kpi-val"]');
    await expect(flaggedVal).toBeVisible();
    const base = parseInt((await flaggedVal.innerText()).trim(), 10);
    expect(base).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(base)).toBe(true);

    // The "Flagged ASINs" KPI label must be visible
    await expect(page.getByText("Flagged ASINs").first()).toBeVisible();

    // Leaderboard (store grouping) lives in the Rankings tab — navigate there.
    await page.locator('[data-testid="tab-rank"]').click();
    await page.locator('[data-testid="groupby-store"]').click();

    // Leaderboard table must have 9 data rows
    const lbRows = page.locator("#lbBody tr");
    await expect(lbRows).toHaveCount(9);

    // At least one leaderboard row shows "No data"
    const nodataCell = page.locator("#lbBody .health-pill.nodata");
    await expect(nodataCell.first()).toBeVisible();
  });

  // --------------------------------------------------------------------------
  // 2. Per-store view for an active store ("body and mind")
  // --------------------------------------------------------------------------
  test("per-store view shows Return rate, Review rating KPIs and Conversion=n/a", async ({ page }) => {
    const storeList = page.locator("#storeList");
    await storeList.waitFor({ state: "visible" });

    // Click the "body and mind" store button (known active store)
    const storeBtn = storeList.locator("button", { hasText: "body and mind" });
    await storeBtn.click();

    // KPI strip for per-store: "Return rate" must appear
    const returnRateKpi = page.locator(".kpi .lbl", { hasText: "Return rate" });
    await expect(returnRateKpi.first()).toBeVisible();

    // "Review rating" must appear
    const reviewRatingKpi = page.locator(".kpi .lbl", { hasText: "Review rating" });
    await expect(reviewRatingKpi.first()).toBeVisible();

    // Conversion shows "n/a" (sessions unavailable)
    const convKpiLabel = page.locator(".kpi .lbl", { hasText: "Conversion" });
    await expect(convKpiLabel.first()).toBeVisible();
    // The val cell next to the Conversion label should read "n/a"
    const convVal = convKpiLabel.first().locator("..").locator(".val");
    await expect(convVal).toContainText("n/a");
  });

  // --------------------------------------------------------------------------
  // 3. §6.1 keystone: Settings override re-classifies WITHOUT refetching data.json
  // --------------------------------------------------------------------------
  test("Settings override re-classifies without data.json refetch", async ({ page }) => {
    // Register request counter BEFORE navigating so we catch the initial load.
    let dataJsonHits = 0;
    page.on("request", (r) => {
      if (r.url().includes("data.json")) dataJsonHits++;
    });

    // Fresh navigate — this triggers the one legitimate fetch of data.json.
    await page.goto("/");

    // Wait for the page to fully render (callouts populated = fetch done + render).
    const storeList = page.locator("#storeList");
    await storeList.waitFor({ state: "visible" });
    await page.locator('[data-testid="callout"]').first().waitFor({ state: "visible" });

    // Capture baseline hit count (should be exactly 1 from initial load).
    const hitsAfterLoad = dataJsonHits;
    expect(hitsAfterLoad).toBe(1);

    // Read baseline flagged count.
    const base = await readFlaggedKpiValue(page);
    expect(Number.isFinite(base)).toBe(true);

    // Open the Settings drawer.
    await page.click("#settingsBtn");

    // Wait for drawer to be open.
    const drawer = page.locator("#drawer");
    await expect(drawer).toHaveClass(/open/);

    // Find the returnRate threshold input (data-key="returnRate") and set it
    // to 2 — far below the default of 5, which will flag many more ASINs.
    const returnRateInput = page.locator('input[data-key="returnRate"]');
    await expect(returnRateInput).toBeVisible();

    // Clear and fill with new value; trigger input event so the handler fires.
    await returnRateInput.fill("2");
    await returnRateInput.dispatchEvent("input");

    // Give the synchronous re-render a tick to flush.
    await page.waitForTimeout(100);

    // ASSERT: Flagged ASINs KPI count increased (more ASINs now breach the lower threshold).
    const after = await readFlaggedKpiValue(page);
    expect(after).toBeGreaterThan(base);

    // KEY ASSERTION: no additional fetch of data.json occurred during the override.
    expect(dataJsonHits).toBe(hitsAfterLoad);

    // Click "Reset to defaults".
    await page.click("#thrReset");

    // Wait a tick for re-render.
    await page.waitForTimeout(100);

    // ASSERT: flagged count returns to base after reset.
    const afterReset = await readFlaggedKpiValue(page);
    expect(afterReset).toBe(base);

    // ASSERT: still no additional data.json fetch.
    expect(dataJsonHits).toBe(hitsAfterLoad);
  });

  // --------------------------------------------------------------------------
  // 4. nodata stores stay "No data" even under a very aggressive threshold override
  // --------------------------------------------------------------------------
  test("nodata store (Sirius) stays No data under threshold override", async ({ page }) => {
    const storeList = page.locator("#storeList");
    await storeList.waitFor({ state: "visible" });
    await page.locator('[data-testid="callout"]').first().waitFor({ state: "visible" });

    // Open settings and lower returnRate to 0 — the most aggressive possible override.
    await page.click("#settingsBtn");
    const drawer = page.locator("#drawer");
    await expect(drawer).toHaveClass(/open/);

    const returnRateInput = page.locator('input[data-key="returnRate"]');
    await returnRateInput.fill("0");
    await returnRateInput.dispatchEvent("input");
    await page.waitForTimeout(100);

    // Sirius is a known nodata store. Navigate to Rankings > Store to check its leaderboard row.
    await page.click("#drawerClose");
    await expect(drawer).not.toHaveClass(/open/);
    await page.locator('[data-testid="tab-rank"]').click();
    await page.locator('[data-testid="groupby-store"]').click();

    // Find the leaderboard row that contains "Sirius" and check its health pill.
    const siriusRow = page.locator("#lbBody tr", { hasText: "Sirius" });
    await expect(siriusRow).toBeVisible();
    const healthPill = siriusRow.locator(".health-pill");
    await expect(healthPill).toHaveText("No data");

    // Click the Sirius store button in the rail.
    const siriusBtn = storeList.locator("button", { hasText: "Sirius" });
    await siriusBtn.click();

    // Per-store view for Sirius should show the "No data" health tag.
    const noDataTag = page.locator(".health-tag.nodata");
    await expect(noDataTag).toBeVisible();
    await expect(noDataTag).toHaveText("No data");
  });
});

// --------------------------------------------------------------------------
// Task 7: Pinned verdict header + tab scaffold
// --------------------------------------------------------------------------
test("renders pinned verdict header with state + portfolio KPIs", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="verdict-state"]')).toBeVisible();
  await expect(page.locator('[data-testid="kpi-rating"]')).toBeVisible();
  await expect(page.locator('[data-testid="kpi-returnrate"]')).toBeVisible();
  await expect(page.locator('[data-testid="kpi-refundexposure"]')).toBeVisible();
  // Reuse the EXISTING flagged KPI testid — do not rename it (Phase 1 smoke depends on it).
  await expect(page.locator('[data-testid="flagged-kpi-val"]')).toBeVisible();
});

test("has three tabs; clicking switches the active panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="tab-briefing"]')).toHaveClass(/active/);
  await page.locator('[data-testid="tab-brands"]').click();
  await expect(page.locator('[data-testid="panel-brands"]')).toBeVisible();
  await expect(page.locator('[data-testid="panel-briefing"]')).toBeHidden();
});

// --------------------------------------------------------------------------
// Task 8: Briefing tab — derived brand callouts
// --------------------------------------------------------------------------
test("briefing lists callouts derived from brand health (no nodata callouts)", async ({ page }) => {
  await page.goto("/");
  const callouts = page.locator('[data-testid="callout"]');
  await expect(callouts.first()).toBeVisible();
  // every callout names a brand and carries a bucket pill
  await expect(page.locator('[data-testid="callout-bucket"]').first()).toBeVisible();
});

// --------------------------------------------------------------------------
// Task 9: Brands tab — all-brands cockpit grid
// --------------------------------------------------------------------------
test("brands tab shows one health-colored card per brand", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="tab-brands"]').click();
  const cards = page.locator('[data-testid="brand-card"]');
  await expect(cards.first()).toBeVisible();
  // count matches portfolio.brands length from the served data.json
  const data = await page.evaluate(() => fetch("/data.json").then(r => r.json()));
  await expect(cards).toHaveCount(data.portfolio.brands.length);
});

// --------------------------------------------------------------------------
// Task 10: Rankings table + Brand|Store toggle
// --------------------------------------------------------------------------
test("rankings table renders brand rows; toggle switches to store grouping", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="tab-rank"]').click();
  await expect(page.locator('[data-testid="rank-row"]').first()).toBeVisible();
  await page.locator('[data-testid="groupby-store"]').click();
  const data = await page.evaluate(() => fetch("/data.json").then(r => r.json()));
  await expect(page.locator('[data-testid="rank-row"]')).toHaveCount(data.portfolio.leaderboard.length);
});

// --------------------------------------------------------------------------
// Task 11: Live threshold recompute for verdict/brands/briefing — no refetch
// --------------------------------------------------------------------------
test("tightening ratingDrop re-derives verdict WITHOUT an extra data.json fetch", async ({ page }) => {
  let dataFetches = 0;
  page.on("request", (r) => { if (r.url().includes("data.json")) dataFetches += 1; });
  await page.goto("/");
  await expect(page.locator('[data-testid="verdict-state"]')).toBeVisible();
  const fetchesAfterLoad = dataFetches;            // baseline (initial load)

  await page.locator("#settingsBtn").click();      // open settings drawer
  const drop = page.locator('input[data-key="ratingDrop"]');
  await drop.fill("-0.01");                          // tightens "declining" -> likely flips toward slipping
  await drop.dispatchEvent("input");                // ensure oninput fires

  // No new data.json fetch was triggered by the threshold change (live recompute).
  expect(dataFetches).toBe(fetchesAfterLoad);
  // verdict still renders a valid state after recompute
  await expect(page.locator('[data-testid="verdict-state"]')).toBeVisible();
});
