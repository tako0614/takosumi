import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(configDirectory, "../..");

export default defineConfig({
  testDir: resolve(configDirectory, "tests"),
  testMatch: "mobile-navigation_test.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "line",
  projects: [
    {
      name: "docs-mobile",
      use: {
        baseURL: "http://127.0.0.1:4180",
        channel: process.env.TAKOSUMI_E2E_BROWSER_CHANNEL?.trim() || "chrome",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command:
      "docs/node_modules/.bin/vitepress preview docs --host 127.0.0.1 --port 4180",
    cwd: repositoryRoot,
    url: "http://127.0.0.1:4180/docs/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
