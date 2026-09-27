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
  testMatch: /(hero-overlay|areas-map|hero-gap)\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8080",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:8080",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});