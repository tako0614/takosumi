import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(configDirectory, "../..");
export const DEFAULT_DOCS_BROWSER_PORT = 4180;

type DocsBrowserEnvironment = {
  [key: string]: string | undefined;
  TAKOSUMI_DOCS_BROWSER_PORT?: string;
  TAKOSUMI_E2E_BROWSER_CHANNEL?: string;
};

export function resolveDocsBrowserPort(
  environment: DocsBrowserEnvironment = process.env,
): number {
  const value = environment.TAKOSUMI_DOCS_BROWSER_PORT?.trim();

  if (!value) {
    return DEFAULT_DOCS_BROWSER_PORT;
  }

  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `TAKOSUMI_DOCS_BROWSER_PORT must be an integer between 1 and 65535; received ${JSON.stringify(value)}`,
    );
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `TAKOSUMI_DOCS_BROWSER_PORT must be an integer between 1 and 65535; received ${JSON.stringify(value)}`,
    );
  }

  return port;
}

export function createDocsBrowserConfig(
  environment: DocsBrowserEnvironment = process.env,
) {
  const port = resolveDocsBrowserPort(environment);
  const baseURL = `http://127.0.0.1:${port}`;

  return defineConfig({
    testDir: resolve(configDirectory, "tests"),
    testMatch: "mobile-navigation_test.ts",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 45_000,
    expect: { timeout: 10_000 },
    reporter: "line",
    outputDir: resolve(repositoryRoot, "test-results/docs-mobile"),
    projects: [
      {
        name: "docs-mobile",
        use: {
          baseURL,
          channel: environment.TAKOSUMI_E2E_BROWSER_CHANNEL?.trim() || "chrome",
          viewport: { width: 390, height: 844 },
        },
      },
    ],
    webServer: {
      command: `docs/node_modules/.bin/vitepress preview docs --host 127.0.0.1 --port ${port}`,
      cwd: repositoryRoot,
      url: `${baseURL}/docs/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  });
}

export default createDocsBrowserConfig();
