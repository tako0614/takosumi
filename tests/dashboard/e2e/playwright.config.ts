import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import {
  resolveExternalStorageState,
  validateExpectedWorkerVersionId,
} from "../../../scripts/dashboard-browser-e2e/live-inputs.ts";

const configDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(configDir, "../../..");
const mode = process.env.TAKOSUMI_E2E_MODE ?? "portable";

if (mode !== "portable" && mode !== "live" && mode !== "public-live") {
  throw new Error(
    "TAKOSUMI_E2E_MODE must be portable, live, or public-live",
  );
}

function requiredLiveEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`live dashboard E2E requires ${name}`);
  return value;
}

function liveConfig(): {
  readonly baseURL: string;
  readonly storageState: string;
} {
  const baseURL = requiredLiveEnv("TAKOSUMI_E2E_BASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("TAKOSUMI_E2E_BASE_URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("TAKOSUMI_E2E_BASE_URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "TAKOSUMI_E2E_BASE_URL must not contain credentials; use storage state",
    );
  }
  const storageState = resolveExternalStorageState(
    repoRoot,
    requiredLiveEnv("TAKOSUMI_E2E_STORAGE_STATE"),
  );
  validateExpectedWorkerVersionId(
    requiredLiveEnv("TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID"),
  );
  return { baseURL: parsed.toString().replace(/\/$/u, ""), storageState };
}

function publicLiveConfig(): { readonly baseURL: string } {
  const baseURL = requiredLiveEnv("TAKOSUMI_E2E_BASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("TAKOSUMI_E2E_BASE_URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("TAKOSUMI_E2E_BASE_URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "TAKOSUMI_E2E_BASE_URL must not contain credentials; public live is unauthenticated",
    );
  }
  validateExpectedWorkerVersionId(
    requiredLiveEnv("TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID"),
  );
  return { baseURL: parsed.toString().replace(/\/$/u, "") };
}

const live = mode === "live" ? liveConfig() : undefined;
const publicLive = mode === "public-live" ? publicLiveConfig() : undefined;
const baseURL =
  live?.baseURL ?? publicLive?.baseURL ?? "http://127.0.0.1:4179";
const portableStorageState = {
    cookies: [
      {
        name: "takosumi_session",
        value: "portable-e2e",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
const storageState =
  live?.storageState ?? (mode === "portable" ? portableStorageState : undefined);

export default defineConfig({
  testDir: configDir,
  testMatch: "dashboard_test.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "line",
  projects: [
    {
      name: mode,
      use: {
        baseURL,
        storageState,
        // Prefer the already-installed system Chrome. This keeps the portable
        // check offline and still uses Playwright's real browser protocol.
        channel: process.env.TAKOSUMI_E2E_BROWSER_CHANNEL?.trim() || "chrome",
        viewport: { width: 1440, height: 1000 },
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
      },
    },
  ],
  webServer:
    mode === "portable"
      ? {
          command: "bun tests/dashboard/e2e/fixture-server.ts",
          cwd: repoRoot,
          url: "http://127.0.0.1:4179/__e2e/ready",
          reuseExistingServer: false,
          timeout: 120_000,
          env: { ...process.env, TAKOSUMI_E2E_PORT: "4179" },
        }
      : undefined,
});
