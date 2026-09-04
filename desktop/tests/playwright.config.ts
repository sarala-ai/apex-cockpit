import { defineConfig } from "@playwright/test";

// Electron product-validator suite for the desktop app. No baseURL/webServer —
// each spec launches the built app itself (see helpers/launch.ts) via
// Playwright's Electron support, so there is no browser project to select.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  // Electron app launches are not cheap and each spec owns a whole app
  // lifecycle (window creation, IPC) — run them one at a time for stability.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "./test-results",
});
