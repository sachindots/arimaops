import { expect, test } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  assertZeroNativeSelects,
  attachErrorCollector,
  drawCanvasStroke,
  gotoMock,
  gotoWorkspace,
} from "./helpers";

test.describe("Workflows: Home, Work, Inbox, Meetings & Preview/Annotate (?mock=1)", () => {
  test("Home: quick-action intent bar & compact Waiting on you cards (no clipped inputs)", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    // Compact Waiting on you rail: verify visible cards contain no clipped/overflowing inputs or buttons
    const waitingAside = page.locator('aside[aria-label="Waiting on you and goals"]');
    await expect(waitingAside).toBeVisible();
    const compactCheck = await waitingAside.evaluate((aside) => {
      const asideRect = aside.getBoundingClientRect();
      const inputs = aside.querySelectorAll("input, textarea");
      const clippedButtons: string[] = [];
      for (const btn of Array.from(aside.querySelectorAll("article button"))) {
        const r = btn.getBoundingClientRect();
        if (r.width === 0 || r.right > asideRect.right + 2 || r.left < asideRect.left - 2) {
          clippedButtons.push(btn.textContent?.trim() || "button");
        }
      }
      return {
        cardCount: aside.querySelectorAll("article").length,
        inputCount: inputs.length,
        clippedButtons,
      };
    });
    expect(compactCheck.cardCount).toBeGreaterThan(0);
    expect(compactCheck.inputCount, "Compact Home decision cards must not squeeze full form inputs").toBe(0);
    expect(compactCheck.clippedButtons).toEqual([]);

    // Quick-action intent bar: "open preview"
    const intentInput = page.locator('input[aria-label="Tell the team or quick action"]');
    await expect(intentInput).toBeVisible();
    await intentInput.fill("open preview");
    await page.locator('section[aria-label="Tell the team or run a quick action"] button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "Live preview" })).toBeVisible();

    // Return to Home and run "start a standup"
    await gotoWorkspace(page, "Home");
    await expect(intentInput).toBeVisible();
    await intentInput.fill("start a standup");
    await page.locator('section[aria-label="Tell the team or run a quick action"] button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: /Morning Standup/i }).first()).toBeVisible();

    errors.assertClean("home-intent-and-waiting");
  });

  test("Work: switch Board | PRs | Goals | Flow, waive gate in TaskSheet, and PrDrawer at 900px", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    await gotoWorkspace(page, "Work");
    const workNav = page.getByRole("navigation", { name: "Work sections" });

    // Switch through Board -> PRs -> Goals -> Flow -> Board
    await workNav.getByRole("button", { name: /^PRs/i }).click();
    await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();

    await workNav.getByRole("button", { name: /^Goals/i }).click();
    await expect(page.getByRole("heading", { name: /Goals/i }).first()).toBeVisible();

    await workNav.getByRole("button", { name: /^Flow/i }).click();
    await expect(page.getByRole("heading", { name: /Flow/i }).first()).toBeVisible();

    await workNav.getByRole("button", { name: /^Board/i }).click();
    await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();

    // Open TaskSheet for P3-T01 and waive a gate with rationale
    await page.getByRole("button", { name: /P3-T01 Knowledge upload: open/i }).click();
    const sheet = page.getByRole("dialog", { name: /P3-T01 Knowledge upload/i });
    await expect(sheet).toBeVisible();

    const rationaleInput = sheet.locator('input[aria-label="Gate rationale note"]');
    await expect(rationaleInput).toBeVisible();
    await expect(sheet.getByText(/Stage gates to leave Plan/i)).toBeVisible();
    await rationaleInput.fill("Waived in E2E gate audit");
    await sheet.getByRole("button", { name: "Waive Gate" }).first().click();

    await expect(sheet.getByRole("status")).toContainText(/Gate "covered" waived \(Waived in E2E gate audit\)/i);
    await expect(sheet.getByText(/Stage gates to leave Build/i)).toBeVisible();
    await expect(sheet.getByText(/Gate covered waived by you: Waived in E2E gate audit/i)).toBeVisible();

    // Also test Pass Gate updates state and advances to Review
    await rationaleInput.fill("Verified checks green");
    await sheet.getByRole("button", { name: "Pass Gate" }).first().click();
    await expect(sheet.getByRole("status")).toContainText(/Gate "tests" passed \(Verified checks green\)/i);
    await expect(sheet.getByText(/Stage gates to leave Review/i)).toBeVisible();
    await expect(sheet.getByText(/Gate tests passed by you: Verified checks green/i)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // PrDrawer at 900px tablet viewport: verify Back button + GitHub link
    await page.setViewportSize({ width: 900, height: 1024 });
    await workNav.getByRole("button", { name: /^PRs/i }).click();
    await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();

    // Switch to Merged PRs so deterministic rows exist immediately in mock data
    await page.getByRole("navigation", { name: "Pull request lists" }).getByRole("button", { name: /^Merged/i }).click();
    const firstPrRow = page.getByRole("table", { name: "Merged pull requests" }).locator('[role="row"][tabindex="0"]').first();
    await expect(firstPrRow).toBeVisible();
    await firstPrRow.click();

    const backBtn = page.getByRole("button", { name: /Back to pull request list/i });
    await expect(backBtn).toBeVisible();
    await expect(page.getByRole("button", { name: /Open on GitHub/i }).or(page.getByRole("link", { name: /Open on GitHub/i }))).toBeVisible();

    await backBtn.click();
    await expect(firstPrRow).toBeVisible();
    await assertNoHorizontalOverflow(page, "work-pr-drawer-900");

    errors.assertClean("work-tabs-gates-prs");
  });

  test("Inbox: QuestionCard, SecondOpinionCard, PermissionCard, MeetingRequestCard & no duplicate details at 900px", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 900, height: 1024 });

    await gotoWorkspace(page, "Inbox");
    const list = page.getByRole("listbox", { name: "Waiting on you" });
    await expect(list).toBeVisible();

    // At 900px (< 960px split breakpoint), detail renders inline ONLY (zero duplicate split pane!)
    await expect(page.locator('section[aria-label="Selected item"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Submit answer" })).toHaveCount(1);
    await assertNoHorizontalOverflow(page, "inbox-900");

    // 1. QuestionCard: verify (Recommended) badge & submit answer
    await expect(page.getByText("(Recommended)").first()).toBeVisible();
    await page.getByRole("button", { name: "Submit answer" }).click();
    await expect(list.getByRole("option", { name: /Knowledge ingestion architecture/i })).toHaveCount(0);

    // 2. SecondOpinionCard: verify Pick Option A & Waive Gate both present, pick Option A
    await list.getByRole("option", { name: /Second Opinion: Edge rate-limiting/i }).locator("button").first().click();
    await expect(page.getByRole("button", { name: "Pick Option A" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Waive Gate" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Waive Gate" })).toBeEnabled();
    await page.getByRole("button", { name: "Pick Option A" }).click();
    await expect(list.getByRole("option", { name: /Second Opinion: Edge rate-limiting/i })).toHaveCount(0);

    // 3. PermissionCard: Allow once
    await list.getByRole("option", { name: /Allow database migration command/i }).locator("button").first().click();
    await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(1);
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(list.getByRole("option", { name: /Allow database migration command/i })).toHaveCount(0);

    // 4. MeetingRequestCard: Join now -> routes to Team -> Meetings room
    await list.getByRole("option", { name: /Morning Standup & Blocker Sync/i }).locator("button").first().click();
    const joinNowBtn = page.getByRole("button", { name: "Join now" });
    await expect(joinNowBtn).toHaveCount(1);
    await joinNowBtn.click();

    await expect(page.getByRole("heading", { name: "Morning Standup & Blocker Sync" })).toBeVisible();

    errors.assertClean("inbox-visual-decisions");
  });

  test("Team -> Meetings: toggle Join Call and commit Meeting Minutes modal", async ({ page }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    await gotoWorkspace(page, "Team");
    await page.getByRole("navigation", { name: "Team sections" }).getByRole("button", { name: /^Meetings/i }).click();

    await expect(page.getByRole("heading", { name: "Morning Standup & Blocker Sync" })).toBeVisible();

    // Toggle "Join Call"
    const joinCallBtn = page.getByRole("button", { name: "Join Call" });
    await expect(joinCallBtn).toBeVisible();
    await expect(joinCallBtn).toHaveAttribute("aria-pressed", "false");
    await joinCallBtn.click();

    const inCallBtn = page.getByRole("button", { name: /In Voice Call/i });
    await expect(inCallBtn).toBeVisible();
    await expect(inCallBtn).toHaveAttribute("aria-pressed", "true");

    // Toggle call off cleanly
    await inCallBtn.click();
    await expect(page.getByRole("button", { name: "Join Call" })).toBeVisible();

    // Open 1-Click Meeting Minutes Commit modal & commit decisions/tasks
    await page.getByRole("button", { name: /Commit Minutes/i }).first().click();
    const modal = page.getByRole("dialog", { name: "Commit meeting minutes" });
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/Decisions → Certified Team Memory/i)).toBeVisible();
    await expect(modal.getByText(/Proposed Tasks → Board/i)).toBeVisible();
    await expect(modal.getByText(/Agent Instructions → Outbox/i)).toBeVisible();

    await modal.getByRole("button", { name: /Commit to Memory, Board & Outbox/i }).click();
    await expect(modal).toBeHidden();
    await expect(page.getByRole("button", { name: /Minutes Committed/i })).toBeVisible();

    errors.assertClean("meetings-and-minutes");
  });

  test("Preview & Evidence Annotator: viewport presets, Freeze & Draw stroke + submit, and PR Evidence AnnotateModal", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    // 1. Live Preview viewport switcher & Freeze & Draw
    await gotoWorkspace(page, "Preview");
    await expect(page.getByRole("heading", { name: "Live preview" })).toBeVisible();

    const vpGroup = page.getByRole("group", { name: "Viewport size" });
    await vpGroup.getByRole("button", { name: "Tablet" }).click();
    await expect(page.getByText("820 × 640")).toBeVisible();

    await vpGroup.getByRole("button", { name: "Phone" }).click();
    await expect(page.getByText("390 × 640")).toBeVisible();

    await vpGroup.getByRole("button", { name: "Desktop" }).click();
    await expect(page.getByText("1280 × 640")).toBeVisible();

    // Switch to Freeze & Draw and verify dimension label stays single-line
    const modeGroup = page.getByRole("group", { name: "Preview interaction mode" });
    await modeGroup.getByRole("button", { name: "Freeze and draw" }).click();
    await expect(page.getByRole("toolbar", { name: "Annotation tools" })).toBeVisible();

    const dimHeight = await page.getByText("1280 × 640").evaluate((el) => el.getBoundingClientRect().height);
    expect(dimHeight, "Preview dimension label must stay single-line").toBeLessThanOrEqual(26);

    // Draw stroke on preview annotation canvas
    const previewCanvas = page.locator('canvas[aria-label="Annotation drawing canvas"]');
    await drawCanvasStroke(page, previewCanvas);
    await expect(page.getByText(/Annotations · 1 stroke\b/i)).toBeVisible();

    // Open Submit Feedback modal and submit
    await page.getByRole("button", { name: /Send Feedback/i }).click();
    const feedbackDialog = page.getByRole("dialog", { name: "Send visual feedback" });
    await expect(feedbackDialog).toBeVisible();
    await assertZeroNativeSelects(page, "SubmitFeedbackModal");

    await feedbackDialog.locator("textarea").fill("Tighten spacing on upload dropzone card");
    await feedbackDialog.getByRole("button", { name: /Create Task with Screenshot/i }).click();
    await expect(feedbackDialog).toBeHidden();
    await expect(page.getByText("Tighten spacing on upload dropzone card")).toBeVisible();

    // 2. Verifier PR evidence screenshot -> Annotate in TaskSheet (P0-T01)
    await gotoWorkspace(page, "Work");
    await page.getByRole("navigation", { name: "Boards" }).getByRole("button", { name: /Phase 0/i }).click();
    await page.getByRole("button", { name: /P0-T01 Repo \+ CI: open/i }).click();

    const taskDialog = page.getByRole("dialog", { name: /P0-T01 Repo \+ CI/i });
    await expect(taskDialog).toBeVisible();
    const annotateBtn = taskDialog.getByRole("button", { name: "Annotate" }).first();
    await expect(annotateBtn).toBeVisible();
    await annotateBtn.click();

    const annotateDialog = page.getByRole("dialog", { name: /Annotate evidence:/i });
    await expect(annotateDialog).toBeVisible();
    await assertZeroNativeSelects(page, "AnnotateModal");

    const evCanvas = annotateDialog.locator('canvas[aria-label="Evidence annotation drawing canvas"]');
    await drawCanvasStroke(page, evCanvas);
    await expect(annotateDialog.getByText(/\b1 stroke\b/i)).toBeVisible();

    // Escape closes ONLY AnnotateModal, keeping TaskSheet open
    await page.keyboard.press("Escape");
    await expect(annotateDialog).toBeHidden();
    await expect(taskDialog).toBeVisible();

    errors.assertClean("preview-and-evidence-annotator");
  });
});
