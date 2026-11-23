import { defineConfig, devices } from "@playwright/test";

/**
 * Standalone Playwright config for local visual-regression runs of the
 * hero-overlay check. Does not depend on the lovable agent fixture, so it
 * runs anywhere `@playwright/test` is installed.
 *
 * Run with:
 *   npx playwright test -c playwright.standalone.config.ts
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /(hero-overlay|areas-map|hero-gap|cabinet-mobile)\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8080",
    ...devices["Desktop Chrome"],
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 8080 --strictPort",
    url: "http://127.0.0.1:8080",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});