import { expect, test } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  assertZeroNativeSelects,
  attachErrorCollector,
  gotoMock,
  openSettings,
} from "./helpers";

test.describe("Milestone 5 (v2.0-GA): Factory & Benchmarks, Vaulted Connections & Ed25519 License (?mock=1)", () => {
  test("Factory & Benchmarks: metrics window, task scorer, nightly proposals Accept/Dismiss & replay benchmark", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    // Open Ops menu -> Factory & Benchmarks
    const opsBtn = page.locator('button[aria-label^="Ops menu"]:visible').first();
    await expect(opsBtn).toBeVisible();
    await opsBtn.click();
    await page.getByRole("menuitem", { name: /Factory & Benchmarks/i }).click();

    await expect(page.getByRole("heading", { name: "Factory & Benchmarks" })).toBeVisible();
    await assertZeroNativeSelects(page, "Factory");
    await assertNoHorizontalOverflow(page, "Factory");

    // 1. 14-day metrics cards visible
    const metricsRegion = page.getByRole("region", { name: "Factory metrics window" });
    await expect(metricsRegion).toBeVisible();
    for (const label of ["Completed Tasks", "Avg Score", "Pass Rate", "Total Cost", "Avg Cycle Time"]) {
      await expect(metricsRegion.getByText(label, { exact: true })).toBeVisible();
    }

    // 2. Score task trigger
    await page.getByRole("button", { name: "Score task" }).click();
    await expect(page.getByRole("status")).toContainText(/Scored .*\/100/i);

    // 3. Nightly Improvement Proposals: Run nightly analysis + Accept & Dismiss
    const proposalsRegion = page.getByRole("region", { name: "Nightly improvement proposals" });
    await expect(proposalsRegion).toBeVisible();
    const initialProposals = await proposalsRegion.locator("ul > li").count();
    expect(initialProposals).toBeGreaterThanOrEqual(2);

    await proposalsRegion.getByRole("button", { name: /Run nightly analysis/i }).click();
    await expect(proposalsRegion.locator("ul > li")).toHaveCount(initialProposals + 1);

    // Accept the newest open proposal
    const firstProposal = proposalsRegion.locator("ul > li").first();
    await firstProposal.getByRole("button", { name: "Accept" }).click();
    await expect(firstProposal.getByText("accepted", { exact: true })).toBeVisible();

    // Dismiss the next open proposal
    const secondProposal = proposalsRegion.locator("ul > li").nth(1);
    await secondProposal.getByRole("button", { name: "Dismiss" }).click();
    await expect(secondProposal.getByText("dismissed", { exact: true })).toBeVisible();

    // 4. Replay Benchmark Harness: Run replay benchmark & inspect results
    const benchmarkRegion = page.getByRole("region", { name: "Replay benchmark harness" });
    await expect(benchmarkRegion).toBeVisible();
    await benchmarkRegion.getByRole("button", { name: /Run replay benchmark/i }).click();
    await expect(page.getByRole("status")).toContainText(/Replay benchmark finished/i);
    await expect(benchmarkRegion.getByText("v2.0 Replay Regression Suite")).toBeVisible();
    await expect(benchmarkRegion.getByText(/Pass 100%/i)).toBeVisible();
    const caseItems = benchmarkRegion.getByRole("list", { name: "Benchmark cases" }).locator("li");
    await expect(caseItems).toHaveCount(3);

    await assertZeroNativeSelects(page, "Factory-after");
    errors.assertClean("m5-factory-benchmarks");
  });

  test("Settings -> MCP and connections: add and remove vaulted tool connection without echoing secret", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    await openSettings(page);
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "MCP and connections" })
      .click();

    const connSection = page.getByRole("region", { name: "Tool connections through HQ" });
    await expect(connSection).toBeVisible();
    await assertZeroNativeSelects(page, "Settings/Connections");
    await assertNoHorizontalOverflow(page, "Settings/Connections");

    const connList = connSection.getByRole("list", { name: "Configured tool connections" });
    const initialCount = await connList.locator("li").count();
    expect(initialCount).toBeGreaterThanOrEqual(2);

    // Add a new vaulted connection via custom <Select>
    const addForm = connSection.getByRole("form", { name: "Add tool connection" });
    await addForm.locator('input[aria-label="Connection ID"]').fill("ops-webhook");

    const kindSelect = addForm.locator('button[role="combobox"][aria-label="Connection kind"]');
    await kindSelect.click();
    const kindListbox = page.locator('[role="listbox"][aria-label="Connection kind"]');
    await expect(kindListbox).toBeVisible();
    await kindListbox.getByRole("option", { name: "Webhook / HTTP" }).click();
    await expect(kindListbox).toBeHidden();

    const secretValue = "whsec_e2e_never_echo_987654321";
    await addForm.locator('input[aria-label="Connection label"]').fill("Ops Alert Webhook");
    await addForm.locator('input[aria-label="Connection endpoint"]').fill("https://hooks.example.test/ops");
    await addForm.locator('input[aria-label="Connection secret"]').fill(secretValue);
    await addForm.getByRole("button", { name: "Add connection" }).click();

    await expect(connList.locator("li")).toHaveCount(initialCount + 1);
    const addedItem = connList.locator("li", { hasText: "Ops Alert Webhook" });
    await expect(addedItem).toBeVisible();
    await expect(addedItem).toContainText("Vaulted secret");
    // Raw secret must NEVER appear anywhere in DOM text
    await expect(connSection).not.toContainText(secretValue);

    // Remove the added connection cleanly
    await addedItem.getByRole("button", { name: "Remove connection ops-webhook" }).click();
    await expect(connList.locator("li")).toHaveCount(initialCount);
    await expect(connList.locator("li", { hasText: "Ops Alert Webhook" })).toHaveCount(0);

    errors.assertClean("m5-connections");
  });

  test("Settings -> License & Plan: tier/seat meter display, invalid key rejection & valid key activation", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    await openSettings(page);
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "License & Plan" })
      .click();

    const licenseRegion = page.locator('[aria-label="License and Plan"]');
    await expect(licenseRegion).toBeVisible();
    await assertZeroNativeSelects(page, "Settings/License");
    await assertNoHorizontalOverflow(page, "Settings/License");

    // Community tier & seat meter visible
    await expect(licenseRegion.getByText("community", { exact: true }).first()).toBeVisible();
    await expect(licenseRegion.getByText("1 / 5 seats")).toBeVisible();
    await expect(licenseRegion.getByText("Max active projects: 3")).toBeVisible();

    const keyInput = licenseRegion.locator('textarea[aria-label="Ed25519 license key"]');
    const activateBtn = licenseRegion.getByRole("button", { name: "Activate license" });
    await expect(activateBtn).toBeDisabled();

    // Invalid key shows clear validation error alert
    await keyInput.fill("not-a-valid-key");
    await expect(activateBtn).toBeEnabled();
    await activateBtn.click();
    await expect(licenseRegion.getByRole("alert")).toContainText(/Invalid Ed25519 license key format/i);

    // Valid canonical token activates Enterprise tier in mock mode
    await keyInput.fill("ARIMA1.eyJ0aWVyIjoiZW50ZXJwcmlzZSJ9.c2lnbmF0dXJlLW1vY2stdmFsaWQtZWRkMjU1MTk");
    await activateBtn.click();
    await expect(licenseRegion.getByRole("status")).toContainText(/Enterprise Ed25519 license verified/i);
    await expect(licenseRegion.getByText("enterprise", { exact: true }).first()).toBeVisible();
    await expect(licenseRegion.getByText("1 / 25 seats")).toBeVisible();
    await expect(licenseRegion.getByText("Acme Engineering Inc.")).toBeVisible();

    errors.assertClean("m5-license");
  });
});
