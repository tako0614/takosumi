import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveExternalStorageState,
  validateExpectedWorkerVersionId,
} from "./dashboard-browser-e2e/live-inputs.ts";
import { resolvePortableE2EPort } from "./dashboard-browser-e2e/port.ts";

const mode = process.argv[2] ?? "";
if (mode !== "portable" && mode !== "live" && mode !== "public-live") {
  throw new Error(
    "usage: bun scripts/run-dashboard-browser-e2e.ts <portable|live|public-live> [-- --playwright-args]",
  );
}

const repoRoot = resolve(import.meta.dir, "..");
const spec = "tests/dashboard/e2e/dashboard_test.ts";
const config = "tests/dashboard/e2e/playwright.config.ts";
const extraArgs = process.argv.slice(3);
if (extraArgs[0] === "--") extraArgs.shift();

/** Allow the read-only public profile to be run without shell env mutation. */
if (mode === "public-live") {
  const publicArgs: string[] = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index]!;
    const match = arg.match(
      /^--(?:base-url|expected-worker-version-id|worker-version-id)=(.*)$/u,
    );
    if (match) {
      const key = arg.startsWith("--base-url")
        ? "TAKOSUMI_E2E_BASE_URL"
        : "TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID";
      process.env[key] = match[1];
      continue;
    }
    if (
      arg === "--base-url" ||
      arg === "--expected-worker-version-id" ||
      arg === "--worker-version-id"
    ) {
      const value = extraArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      process.env[
        arg === "--base-url"
          ? "TAKOSUMI_E2E_BASE_URL"
          : "TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID"
      ] = value;
      index += 1;
      continue;
    }
    publicArgs.push(arg);
  }
  extraArgs.splice(0, extraArgs.length, ...publicArgs);
}

if (mode === "portable") {
  const distIndex = resolve(repoRoot, "dashboard/dist/index.html");
  if (!existsSync(distIndex)) {
    throw new Error(
      "portable dashboard browser E2E requires dashboard/dist/index.html; run `bun run check:dashboard` first",
    );
  }
  // Publish one port for the config, the spec, and the fixture server so two
  // checkouts on the same host do not fight over a fixed one.
  const port = await resolvePortableE2EPort(process.env);
  console.error(`[dashboard-e2e] portable fixture server port: ${port}`);
} else if (mode === "live") {
  const required = [
    "TAKOSUMI_E2E_BASE_URL",
    "TAKOSUMI_E2E_STORAGE_STATE",
    "TAKOSUMI_E2E_WORKSPACE_NAME",
    "TAKOSUMI_E2E_SWITCH_WORKSPACE_NAME",
    "TAKOSUMI_E2E_APP_NAME",
    "TAKOSUMI_E2E_APP_URL",
    "TAKOSUMI_E2E_OBJECT_BUCKET_NAME",
    "TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `live dashboard browser E2E is fail-closed; missing: ${missing.join(", ")}`,
    );
  }
  const storageState = resolveExternalStorageState(
    repoRoot,
    process.env.TAKOSUMI_E2E_STORAGE_STATE!.trim(),
  );
  process.env.TAKOSUMI_E2E_STORAGE_STATE = storageState;
  process.env.TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID =
    validateExpectedWorkerVersionId(
      process.env.TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID!.trim(),
    );
} else {
  const required = [
    "TAKOSUMI_E2E_BASE_URL",
    "TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `public live dashboard browser E2E is fail-closed; missing: ${missing.join(", ")}`,
    );
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(process.env.TAKOSUMI_E2E_BASE_URL!.trim());
  } catch {
    throw new Error("TAKOSUMI_E2E_BASE_URL must be an absolute http(s) URL");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("TAKOSUMI_E2E_BASE_URL must use http or https");
  }
  if (baseUrl.username || baseUrl.password) {
    throw new Error(
      "TAKOSUMI_E2E_BASE_URL must not contain credentials; public live is unauthenticated",
    );
  }
  process.env.TAKOSUMI_E2E_BASE_URL = baseUrl.toString().replace(/\/$/u, "");
  process.env.TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID =
    validateExpectedWorkerVersionId(
      process.env.TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID!.trim(),
    );
}

const child = Bun.spawn(
  [
    "bunx",
    "playwright",
    "test",
    spec,
    `--config=${config}`,
    `--project=${mode}`,
    ...extraArgs,
  ],
  {
    cwd: repoRoot,
    env: { ...process.env, TAKOSUMI_E2E_MODE: mode },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

const exitCode = await child.exited;
process.exit(exitCode);
