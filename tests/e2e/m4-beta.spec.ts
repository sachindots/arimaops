import { expect, test } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  assertZeroNativeSelects,
  attachErrorCollector,
  gotoMock,
  gotoWorkspace,
  openSettings,
} from "./helpers";

test.describe("Milestone 4 (v2.0-beta): Memory FTS5, Encrypted Backups, Voice Adapters & Findings CVSS 4.0 (?mock=1)", () => {
  test("Settings -> Memory: FTS5 search, Certify/Promote, Encrypted Backup create + verify manifest + RESTORE guard", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    await openSettings(page);
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Memory" }).click();
    await expect(page.getByRole("region", { name: "Team Memory Explorer" })).toBeVisible();
    await assertZeroNativeSelects(page, "Settings/Memory");
    await assertNoHorizontalOverflow(page, "Settings/Memory");

    const memoryList = page.getByRole("list", { name: "Memory entries" });
    await expect(memoryList).toBeVisible();
    const initialMemCount = await memoryList.locator("li").count();
    expect(initialMemCount).toBeGreaterThanOrEqual(4);

    // Contradiction warning & 30-day decay countdown badges visible on pending memories
    await expect(memoryList.getByText(/Contradicts M-17/i)).toBeVisible();
    await expect(memoryList.getByText(/Decays in \d+d/i).first()).toBeVisible();

    // FTS5 search filtering
    const searchInput = page.locator('input[aria-label="Search team memory"]');
    await searchInput.fill("Clerk");
    await expect(memoryList.locator("li")).toHaveCount(1);
    await expect(memoryList).toContainText("M-41");

    // Clear search and test status filter custom <Select>
    await searchInput.fill("");
    await expect(memoryList.locator("li")).toHaveCount(initialMemCount);

    const statusSelect = page.locator('button[role="combobox"][aria-label="Memory status filter"]');
    await statusSelect.click();
    const statusListbox = page.locator('[role="listbox"][aria-label="Memory status filter"]');
    await expect(statusListbox).toBeVisible();
    await statusListbox.getByRole("option", { name: /Pending review/i }).click();
    await expect(statusListbox).toBeHidden();
    const pendingItems = await memoryList.locator("li").count();
    expect(pendingItems).toBeGreaterThanOrEqual(1);
    expect(pendingItems).toBeLessThan(initialMemCount);

    // Switch back to All
    await statusSelect.click();
    await statusListbox.getByRole("option", { name: /^All\b/i }).click();
    await expect(memoryList.locator("li")).toHaveCount(initialMemCount);

    // Certify a pending memory (M-42 supersedes conflicting M-17)
    const m42Card = memoryList.locator("li", { hasText: "M-42" });
    await expect(m42Card).toBeVisible();
    await m42Card.getByRole("button", { name: "Certify" }).click();
    await expect(page.getByText(/Certified M-42/i)).toBeVisible();
    await expect(m42Card.getByText("Certified", { exact: true })).toBeVisible();

    // Promote M-42 to template lesson
    await m42Card.getByRole("button", { name: "Promote to Lesson" }).click();
    await expect(page.getByText(/Promoted M-42 to template lessons/i)).toBeVisible();
    await expect(m42Card.getByText("Promoted lesson")).toBeVisible();

    // Encrypted Backups & Restore section
    const backupSection = page.getByRole("region", { name: "Encrypted Backups and Restore" });
    await expect(backupSection).toBeVisible();
    const archiveList = backupSection.getByRole("list", { name: "Encrypted backup archives" });
    const beforeCount = await archiveList.locator("li").count();

    // Create encrypted backup
    await backupSection.getByRole("button", { name: /Create encrypted backup/i }).click();
    await expect(archiveList.locator("li")).toHaveCount(beforeCount + 1);
    await expect(backupSection.getByText(/Created encrypted archive/i)).toBeVisible();

    // Verify archive -> manifest card with integrity OK & counts
    await archiveList.locator("li").first().getByRole("button", { name: /Verify archive/i }).click();
    const manifest = backupSection.getByRole("status", { name: "Verified backup manifest" });
    await expect(manifest).toBeVisible();
    await expect(manifest).toContainText(/Integrity OK/i);
    await expect(manifest).toContainText(/\bproject/i);
    await expect(manifest).toContainText(/\buser/i);
    await expect(manifest).toContainText(/evidence files/i);
    await expect(manifest).toContainText(/feedback files/i);

    // Restore backup confirmation guard requiring exact "RESTORE"
    await archiveList.locator("li").first().getByRole("button", { name: /Restore backup/i }).click();
    const restoreDialog = page.getByRole("dialog", { name: "Confirm encrypted backup restore" });
    await expect(restoreDialog).toBeVisible();

    const confirmInput = restoreDialog.locator('input[aria-label="Type RESTORE to confirm"]');
    const confirmBtn = restoreDialog.getByRole("button", { name: "Confirm Restore" });
    await expect(confirmBtn).toBeDisabled();

    // Lowercase or partial text must keep Confirm Restore locked
    await confirmInput.fill("restore");
    await expect(confirmBtn).toBeDisabled();

    // Exact "RESTORE" unlocks Confirm Restore
    await confirmInput.fill("RESTORE");
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    await expect(restoreDialog).toBeHidden();
    await expect(backupSection.getByText(/Pre-restore safety snapshot saved; restored/i)).toBeVisible();

    await assertZeroNativeSelects(page, "Settings/Memory-after");
    errors.assertClean("m4-memory-and-backups");
  });

  test("Team -> Meetings -> MeetingRoom: Voice Adapter <Select> switches cleanly across all 4 providers", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    await gotoWorkspace(page, "Team");
    await page.getByRole("navigation", { name: "Team sections" }).getByRole("button", { name: /^Meetings/i }).click();
    await expect(page.getByRole("heading", { name: "Morning Standup & Blocker Sync" })).toBeVisible();
    await assertZeroNativeSelects(page, "MeetingRoom-Voice");

    const voiceSelect = page.locator('button[role="combobox"][aria-label="Voice adapter"]');
    await expect(voiceSelect).toBeVisible();
    await expect(voiceSelect).toContainText(/Browser Web Speech/i);

    const pickVoice = async (labelPattern: RegExp) => {
      await voiceSelect.click();
      const lb = page.locator('[role="listbox"][aria-label="Voice adapter"]');
      await expect(lb).toBeVisible();
      await lb.getByRole("option", { name: labelPattern }).click();
      await expect(lb).toBeHidden();
    };

    // Switch to OpenAI Voice (Vault)
    await pickVoice(/OpenAI Voice/i);
    await expect(voiceSelect).toContainText(/OpenAI Voice/i);
    await expect(page.getByText(/OpenAI Voice \(Vault\) selected/i)).toBeVisible();

    // Switch to Gemini Voice (Vault)
    await pickVoice(/Gemini Voice/i);
    await expect(voiceSelect).toContainText(/Gemini Voice/i);
    await expect(page.getByText(/Gemini Voice \(Vault\) selected/i)).toBeVisible();

    // Switch to Off
    await pickVoice(/^Off$/i);
    await expect(voiceSelect.locator("span").first()).toHaveText("Off");

    // Switch back to Browser Web Speech (Free)
    await pickVoice(/Browser Web Speech/i);
    await expect(voiceSelect).toContainText(/Browser Web Speech/i);

    // Join Call works cleanly
    await page.getByRole("button", { name: "Join Call" }).click();
    await expect(page.getByRole("button", { name: /In Voice Call \(Web Speech\)/i })).toBeVisible();
    await page.getByRole("button", { name: /In Voice Call \(Web Speech\)/i }).click();

    await assertNoHorizontalOverflow(page, "MeetingRoom-Voice");
    errors.assertClean("m4-voice-adapter");
  });

  test("Work -> Findings: CVSS 4.0 pills & vector detail, Scope rules, and 6-format Export Report", async ({
    page,
  }) => {
    const errors = attachErrorCollector(page);
    await gotoMock(page, { width: 1440, height: 900 });

    await gotoWorkspace(page, "Work");
    const workNav = page.getByRole("navigation", { name: "Work sections" });
    await workNav.getByRole("button", { name: /^Findings/i }).click();
    await expect(page.getByRole("heading", { name: "Findings" })).toBeVisible();
    await assertZeroNativeSelects(page, "Work/Findings");
    await assertNoHorizontalOverflow(page, "Work/Findings");

    // Verify CVSS 4.0 score pills render in table rows
    await expect(page.getByText("CVSS 9.3")).toBeVisible();
    await expect(page.getByText("CVSS 8.7")).toBeVisible();
    await expect(page.getByText("CVSS 5.3")).toBeVisible();

    // Open finding detail slide-over & verify CVSS 4.0 vector card
    await page.getByText("F-001").first().click();
    const detailPanel = page.getByRole("dialog").or(page.locator('[aria-label*="F-001"]')).first();
    await expect(detailPanel).toBeVisible();
    await expect(page.getByText(/CVSS:4\.0\//i).first()).toBeVisible();
    await page.keyboard.press("Escape");

    // Open Scope panel & verify IMDS protection notice
    await page.getByRole("button", { name: "Scope" }).click();
    await expect(page.getByText("169.254.169.254", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    // Verify all 6 export formats in custom <Select> & run exports
    const formatSelect = page.locator('button[role="combobox"][aria-label="Export report format"]');
    await expect(formatSelect).toBeVisible();
    await formatSelect.click();

    const formatListbox = page.locator('[role="listbox"][aria-label="Export report format"]');
    await expect(formatListbox).toBeVisible();
    for (const label of ["HTML / PDF", "Markdown", "HackerOne", "Bugcrowd", "JSON", "SARIF"]) {
      await expect(formatListbox.getByRole("option", { name: label, exact: true })).toBeVisible();
    }

    // Export SARIF
    await formatListbox.getByRole("option", { name: "SARIF", exact: true }).click();
    await page.getByRole("button", { name: "Export Report" }).click();
    await expect(page.getByText(/Exported SARIF report/i)).toBeVisible();
    await expect(page.getByText(/"version": "2\.1\.0"/)).toBeVisible();

    // Export HTML / PDF
    await formatSelect.click();
    await formatListbox.getByRole("option", { name: "HTML / PDF", exact: true }).click();
    await page.getByRole("button", { name: "Export Report" }).click();
    await expect(page.getByText(/Exported HTML \/ PDF report/i)).toBeVisible();
    await expect(page.getByText(/<!doctype html>/i)).toBeVisible();

    // Export HackerOne
    await formatSelect.click();
    await formatListbox.getByRole("option", { name: "HackerOne", exact: true }).click();
    await page.getByRole("button", { name: "Export Report" }).click();
    await expect(page.getByText(/Exported HackerOne report/i)).toBeVisible();

    await assertZeroNativeSelects(page, "Work/Findings-after");
    errors.assertClean("m4-findings-cvss-export");
  });
});
