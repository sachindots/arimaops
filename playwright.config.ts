import fs from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const E2E_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 5179);
const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

const LOCAL_CHROME_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => Boolean(p));

const localChromePath = !process.env.CI
  ? LOCAL_CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
  : undefined;

const browserUse = localChromePath
  ? {
      ...devices["Desktop Chrome"],
      launchOptions: {
        executablePath: localChromePath,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      },
    }
  : {
      ...devices["Desktop Chrome"],
      ...(process.env.CI ? {} : { channel: "chrome" as const }),
    };

const hasProdDist = fs.existsSync("dist/index.html");
const webServerCommand = hasProdDist
  ? `pnpm exec vite preview --port ${E2E_PORT} --strictPort --host 127.0.0.1`
  : `pnpm exec vite --port ${E2E_PORT} --strictPort --host 127.0.0.1`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 2,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    ...browserUse,
  },
  projects: [
    {
      name: "mock-ui",
      testMatch: /(shell-and-ux|workflows|m4-beta|m5-ga)\.spec\.ts/,
    },
    {
      name: "live-rust-hq",
      testMatch: /live-rust-hq\.spec\.ts/,
    },
  ],
  webServer: {
    command: webServerCommand,
    url: `${BASE_URL}/?mock=1`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
