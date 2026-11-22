import { expect, test } from "@playwright/test";
import {
  assertInterFontLoaded,
  assertNoHorizontalOverflow,
  assertZeroNativeSelects,
  attachErrorCollector,
  gotoMock,
  gotoWorkspace,
  openOpsUsage,
  openSettings,
} from "./helpers";

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-900", width: 900, height: 1024 },
  { name: "phone-390", width: 390, height: 844 },
] as const;

test.describe("Responsive Shell, Visual Invariants & Controls (?mock=1)", () => {
  for (const vp of VIEWPORTS) {
    test(`[${vp.name}] all workspaces have 0 errors, 0 native <select>, 0 overflow, and Dark <-> Light toggle`, async ({
      page,
    }) => {
      const errors = attachErrorCollector(page);
      await gotoMock(page, { width: vp.width, height: vp.height });

      // Dark-Glass default
      const initialScheme = await page.evaluate(() => document.documentElement.dataset.scheme);
      expect(initialScheme).toBe("dark");

      // 1-click Dark <-> Light theme toggle in header
      const toLight = page.locator('header button[aria-label="Switch to light theme"]:visible').first();
      await expect(toLight).toBeVisible();
      await toLight.click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.scheme))
        .toBe("light");

      const toDark = page.locator('header button[aria-label="Switch to dark theme"]:visible').first();
      await expect(toDark).toBeVisible();
      await toDark.click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.scheme))
        .toBe("dark");

      // Home
      await assertZeroNativeSelects(page, `${vp.name}:Home`);
      await assertNoHorizontalOverflow(page, `${vp.name}:Home`);

      // Work (also check Inter font on body + button[role="combobox"])
      await gotoWorkspace(page, "Work");
      await expect(page.getByRole("navigation", { name: "Work sections" })).toBeVisible();
      await assertZeroNativeSelects(page, `${vp.name}:Work`);
      await assertNoHorizontalOverflow(page, `${vp.name}:Work`);
      await expect(page.locator('button[role="combobox"]').first()).toBeVisible();
      await assertInterFontLoaded(page);

      // Inbox
      await gotoWorkspace(page, "Inbox");
      await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
      await assertZeroNativeSelects(page, `${vp.name}:Inbox`);
      await assertNoHorizontalOverflow(page, `${vp.name}:Inbox`);

      // Team
      await gotoWorkspace(page, "Team");
      await expect(page.getByRole("navigation", { name: "Team sections" })).toBeVisible();
      await assertZeroNativeSelects(page, `${vp.name}:Team`);
      await assertNoHorizontalOverflow(page, `${vp.name}:Team`);

      // Preview
      await gotoWorkspace(page, "Preview");
      await expect(page.getByRole("heading", { name: "Live Preview" })).toBeVisible();
      await assertZeroNativeSelects(page, `${vp.name}:Preview`);
      await assertNoHorizontalOverflow(page, `${vp.name}:Preview`);

      // Ops -> Usage
      await openOpsUsage(page, vp.name);
      await expect(page.getByRole("heading", { name: /Usage/i }).first()).toBeVisible();
      await assertZeroNativeSelects(page, `${vp.name}:Ops/Usage`);
      await assertNoHorizontalOverflow(page, `${vp.name}:Ops/Usage`);

      // Settings (check multiple tabs with custom <Select>s)
      await openSettings(page);
      await assertZeroNativeSelects(page, `${vp.name}:Settings/General`);
      await assertNoHorizontalOverflow(page, `${vp.name}:Settings/General`);

      await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Agents and roles" }).click();
      await assertZeroNativeSelects(page, `${vp.name}:Settings/Team`);
      await assertNoHorizontalOverflow(page, `${vp.name}:Settings/Team`);

      await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Review and merge" }).click();
      await assertZeroNativeSelects(page, `${vp.name}:Settings/Workflow`);
      await assertNoHorizontalOverflow(page, `${vp.name}:Settings/Workflow`);

      errors.assertClean(vp.name);
    });
  }

  test("custom <Select> dropdown selection and Escape closes ONLY popover inside TaskSheet and Settings", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    // 1. Board filter custom <Select>
    await gotoWorkspace(page, "Work");
    const agentFilter = page.locator('button[role="combobox"][aria-label="Filter by agent"]');
    await expect(agentFilter).toBeVisible();
    await agentFilter.click();

    const listbox = page.locator('[role="listbox"][aria-label="Filter by agent"]');
    await expect(listbox).toBeVisible();
    await listbox.getByRole("option", { name: "Ghost" }).click();
    await expect(listbox).toBeHidden();
    await expect(agentFilter).toContainText("Ghost");
    await page.getByRole("button", { name: "Clear" }).click();

    // 2. TaskSheet <Select> Escape isolation
    const taskCard = page.getByRole("button", { name: /P3-T01 Knowledge upload: open/i });
    await expect(taskCard).toBeVisible();
    await taskCard.click();

    const taskDialog = page.getByRole("dialog", { name: /P3-T01 Knowledge upload/i });
    await expect(taskDialog).toBeVisible();
    await assertZeroNativeSelects(page, "TaskSheet");

    const cliSelect = taskDialog.locator('button[role="combobox"][aria-label="P3-T01 runs on"]');
    await expect(cliSelect).toBeVisible();
    await cliSelect.click();

    const cliListbox = page.locator('[role="listbox"][aria-label="P3-T01 runs on"]');
    await expect(cliListbox).toBeVisible();

    // Press Escape: must close ONLY the Select popover, keeping TaskSheet open
    await page.keyboard.press("Escape");
    await expect(cliListbox).toBeHidden();
    await expect(taskDialog).toBeVisible();

    // Reopen and pick an option cleanly
    await cliSelect.click();
    await expect(cliListbox).toBeVisible();
    await cliListbox.getByRole("option", { name: /Claude Code/i }).click();
    await expect(cliListbox).toBeHidden();
    await expect(cliSelect).toContainText(/Claude Code/i);

    // Pressing Escape when no listbox is open closes TaskSheet
    await page.keyboard.press("Escape");
    await expect(taskDialog).toBeHidden();

    // 3. Settings <Select> Escape isolation
    await openSettings(page);
    const settingsNav = page.getByRole("navigation", { name: "Settings sections" });
    await settingsNav.getByRole("button", { name: "Review and merge" }).click();

    const reviewSelect = page.locator('button[role="combobox"][aria-label="Review tool"]');
    await expect(reviewSelect).toBeVisible();
    await reviewSelect.click();

    const reviewListbox = page.locator('[role="listbox"][aria-label="Review tool"]');
    await expect(reviewListbox).toBeVisible();

    // Press Escape: must close ONLY the Select popover, keeping Settings open
    await page.keyboard.press("Escape");
    await expect(reviewListbox).toBeHidden();
    await expect(settingsNav).toBeVisible();

    // Reopen and select a different review tool
    await reviewSelect.click();
    await expect(reviewListbox).toBeVisible();
    await reviewListbox.getByRole("option", { name: /Human review/i }).click();
    await expect(reviewListbox).toBeHidden();
    await expect(reviewSelect).toContainText(/Human review/i);

    errors.assertClean("custom-select-and-escape");
  });

  test("viewport resize 1440 -> 900 -> 390 -> 1440 preserves Team -> Chat thread and unsent draft", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    await gotoWorkspace(page, "Team");
    await page.getByRole("navigation", { name: "Team sections" }).getByRole("button", { name: /^Chat/i }).click();

    const chatsNav = page.getByRole("navigation", { name: "Chats" });
    await expect(chatsNav).toBeVisible();
    await chatsNav
      .locator("button", { has: page.locator("span", { hasText: /^Ghost$/ }) })
      .click();

    const composer = page.locator('textarea[aria-label="Message Ghost"]');
    await expect(composer).toBeVisible();
    const draftText = "Keep this exact draft intact across desktop, tablet, and phone resizes!";
    await composer.fill(draftText);
    await expect(composer).toHaveValue(draftText);

    // Desktop 1440 -> Tablet 900
    await page.setViewportSize({ width: 900, height: 1024 });
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(draftText);
    await assertNoHorizontalOverflow(page, "resize-900-chat");

    // Tablet 900 -> Phone 390
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(draftText);
    await assertNoHorizontalOverflow(page, "resize-390-chat");

    // Phone 390 -> Desktop 1440
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(draftText);
    await assertNoHorizontalOverflow(page, "resize-1440-chat");

    errors.assertClean("resize-state-preservation");
  });
});
