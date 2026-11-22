import { expect, type Locator, type Page } from "@playwright/test";

export interface ErrorCollector {
  consoleErrors: string[];
  pageErrors: string[];
  assertClean: (context?: string) => void;
}

/** Attaches listeners for console errors and uncaught page errors on a Playwright Page. */
export function attachErrorCollector(
  page: Page,
  opts?: { allowAuthCheck401?: boolean },
): ErrorCollector {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (
        opts?.allowAuthCheck401 &&
        /Failed to load resource: the server responded with a status of 401/i.test(text)
      ) {
        return;
      }
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err instanceof Error ? err.stack || err.message : String(err));
  });

  return {
    consoleErrors,
    pageErrors,
    assertClean(context = "page") {
      expect(
        consoleErrors,
        `Expected 0 console errors on ${context}, got:\n${consoleErrors.join("\n")}`,
      ).toEqual([]);
      expect(
        pageErrors,
        `Expected 0 uncaught page errors on ${context}, got:\n${pageErrors.join("\n")}`,
      ).toEqual([]);
    },
  };
}

/** Asserts that no horizontal page overflow occurs at the current viewport. */
export async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    metrics.scrollWidth,
    `Horizontal overflow detected on ${label}: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth} + 1`,
  ).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

/** Asserts that zero native <select> elements exist anywhere in the current DOM. */
export async function assertZeroNativeSelects(page: Page, label: string): Promise<void> {
  const count = await page.locator("select").count();
  expect(count, `Found ${count} native <select> element(s) on ${label}`).toBe(0);
}

/** Asserts Inter font is loaded in document.fonts and applied via --font-sans on body (and combobox if present). */
export async function assertInterFontLoaded(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    const loadedFamilies = Array.from(document.fonts)
      .filter((f) => f.status === "loaded")
      .map((f) => f.family.replace(/^['"]|['"]$/g, ""));
    const rootFontSans = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-sans")
      .trim();
    const bodyFont = getComputedStyle(document.body).fontFamily;
    const combobox = document.querySelector<HTMLElement>('button[role="combobox"]');
    const comboboxFont = combobox ? getComputedStyle(combobox).fontFamily : null;
    return {
      interLoaded: loadedFamilies.some((fam) => /inter/i.test(fam)),
      loadedFamilies: Array.from(new Set(loadedFamilies)),
      rootFontSans,
      bodyFont,
      comboboxFont,
    };
  });

  expect(
    result.interLoaded,
    `Expected Inter in loaded fonts, found: ${result.loadedFamilies.join(", ")}`,
  ).toBe(true);
  expect(result.rootFontSans).toMatch(/Inter/i);
  expect(result.bodyFont).toMatch(/Inter/i);
  if (result.comboboxFont !== null) {
    expect(result.comboboxFont).toMatch(/Inter/i);
  }
}

/** Draws a synthetic freehand stroke across a canvas element. */
export async function drawCanvasStroke(page: Page, canvas: Locator): Promise<void> {
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box || box.width < 20 || box.height < 20) {
    throw new Error(`Canvas bounding box too small or missing: ${JSON.stringify(box)}`);
  }
  const startX = box.x + box.width * 0.25;
  const startY = box.y + box.height * 0.3;
  const midX = box.x + box.width * 0.5;
  const midY = box.y + box.height * 0.45;
  const endX = box.x + box.width * 0.7;
  const endY = box.y + box.height * 0.35;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(midX, midY, { steps: 6 });
  await page.mouse.move(endX, endY, { steps: 6 });
  await page.mouse.up();
}

/** Opens the mock app cleanly with dark scheme default (clean localStorage/sessionStorage). */
export async function gotoMock(
  page: Page,
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto("/?mock=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[aria-label="ArimaOps"], header').first()).toBeVisible();
  // Wait for primary navigation buttons (either desktop rail or compact bottom bar)
  await expect(
    page.locator('nav[aria-label="Primary workspaces"] button, nav[aria-label="Navigation"] button').first(),
  ).toBeVisible();
}

/**
 * Clicks one of the 5 primary workspaces (Home, Work, Inbox, Team, Preview)
 * in whichever responsive navigation bar is currently visible (desktop rail or compact bottom bar).
 */
export async function gotoWorkspace(
  page: Page,
  name: "Home" | "Work" | "Inbox" | "Team" | "Preview",
): Promise<void> {
  const nav = page.locator(
    'nav[aria-label="Primary workspaces"]:visible, nav[aria-label="Navigation"]:visible',
  ).first();
  await expect(nav).toBeVisible();
  const btn = nav.getByRole("button", { name: new RegExp(`^${name}(?:,|$)`, "i") }).first();
  await expect(btn).toBeVisible();
  await btn.click();
}

/** Opens Settings from the visible header Settings button. */
export async function openSettings(page: Page): Promise<void> {
  const btn = page.locator('header button[aria-label="Settings"]:visible').first();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
}

/**
 * Opens Ops (desktop rail menu or compact header OpsPage) and navigates to Usage & Budgets.
 * On compact viewports (< 1000px) this also verifies OpsPage itself has 0 native selects and 0 overflow.
 */
export async function openOpsUsage(page: Page, label = "Ops"): Promise<void> {
  const opsBtn = page
    .locator('button[aria-label^="Ops menu"]:visible')
    .first();
  await expect(opsBtn).toBeVisible();
  const hasPopup = await opsBtn.getAttribute("aria-haspopup");
  await opsBtn.click();

  if (hasPopup === "menu") {
    const usageItem = page.getByRole("menuitem", { name: /Usage/i }).first();
    await expect(usageItem).toBeVisible();
    await usageItem.click();
    return;
  }

  // Compact viewport (< 1000px): Ops button opens OpsPage directly
  await expect(page.getByRole("heading", { name: "Ops & Tools" })).toBeVisible();
  await assertZeroNativeSelects(page, `${label}:OpsPage`);
  await assertNoHorizontalOverflow(page, `${label}:OpsPage`);
  await page.getByRole("button", { name: /Usage & budgets/i }).click();
}
