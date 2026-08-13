import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveExternalStorageState,
  validateExpectedWorkerVersionId,
} from "./dashboard-browser-e2e/live-inputs.ts";

const mode = process.argv[2] ?? "";
if (mode !== "portable" && mode !== "live") {
  throw new Error(
    "usage: bun scripts/run-dashboard-browser-e2e.ts <portable|live> [-- --playwright-args]",
  );
}

const repoRoot = resolve(import.meta.dir, "..");
const spec = "tests/dashboard/e2e/dashboard_test.ts";
const config = "tests/dashboard/e2e/playwright.config.ts";
const extraArgs = process.argv.slice(3);
if (extraArgs[0] === "--") extraArgs.shift();

if (mode === "portable") {
  const distIndex = resolve(repoRoot, "dashboard/dist/index.html");
  if (!existsSync(distIndex)) {
    throw new Error(
      "portable dashboard browser E2E requires dashboard/dist/index.html; run `bun run check:dashboard` first",
    );
  }
} else {
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
