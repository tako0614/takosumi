import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

/**
 * Browser E2E for the cloud dashboard SPA. Assumes local-substrate is up
 * (accounts.takosumi.test reachable + dashboard-ui .output/public served by
 * Caddy + the cloud worker behind /v1/*).
 *
 * TLS trust: Pebble's root is installed into NSS DB by globalSetup
 * (test/e2e/_setup.ts) so Chromium actually validates the cert chain.
 * If you delete `globalSetup` or set `ignoreHTTPSErrors: true`, the
 * tls-trust.spec.ts test will catch the regression.
 */
export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/_setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "https://accounts.takosumi.test",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
