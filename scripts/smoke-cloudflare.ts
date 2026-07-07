/**
 * Real-Cloudflare GA smoke (layer 1: provider/module integration).
 *
 * Applies the official `cloudflare-hello-worker` Capsule against a REAL
 * Cloudflare account, verifies the Worker script exists through the Cloudflare
 * API, probes the workers.dev URL when possible, then destroys it. This keeps
 * the smoke focused on Takosumi's current first-party Cloudflare service form:
 * a runnable Worker sample. Object storage is intentionally not tested here;
 * R2/S3/GCS should use existing OpenTofu providers in ordinary Stack flows.
 *
 * Credentials come ONLY from the environment — never the repo. Set them inline
 * or in a gitignored `.env.smoke` (auto-loaded if present):
 *
 *   CLOUDFLARE_API_TOKEN      # token with Workers Scripts: Edit on the account
 *   CLOUDFLARE_ACCOUNT_ID     # scratch/dedicated account id
 *   CLOUDFLARE_WORKERS_SUBDOMAIN
 *
 * Optional:
 *   CLOUDFLARE_PROVIDER_VERSION  # pin the cloudflare provider
 *   SMOKE_WORKER_PREFIX          # default "takosumi-smoke"
 *   SMOKE_KEEP=1                 # keep the temp workdir for inspection
 *
 * Run:  bun run smoke:cloudflare
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_TF = join(
  HERE,
  "../providers/cloudflare/modules/cloudflare-hello-worker/module/main.tf",
);
const CF_API = "https://api.cloudflare.com/client/v4";
const PLAN_FILE = "tfplan";

function loadDotEnvSmoke(): void {
  const path = join(HERE, "../.env.smoke");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(
      `x ${name} is not set. The Cloudflare smoke needs real operator credentials from the environment:\n` +
        `    export CLOUDFLARE_API_TOKEN=...      # Workers Scripts: Edit\n` +
        `    export CLOUDFLARE_ACCOUNT_ID=...\n` +
        `    export CLOUDFLARE_WORKERS_SUBDOMAIN=...\n` +
        `  or put them in a gitignored takosumi/.env.smoke`,
    );
    process.exit(2);
  }
  return v.trim();
}

async function tofu(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const proc = Bun.spawn(["tofu", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tofu ${args[0]} exited ${code}`);
}

async function workerScriptExists(
  accountId: string,
  token: string,
  scriptName: string,
): Promise<boolean> {
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (res.ok) return true;
  if (res.status === 404) return false;
  const body = await res.text();
  throw new Error(
    `cloudflare worker probe returned ${res.status}: ${body.slice(0, 200)}`,
  );
}

async function probeWorkerUrl(url: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(url);
    const text = await res.text();
    if (res.ok && text.includes("This Worker was provisioned by a Takosumi Capsule")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`worker URL did not return the expected sample page: ${url}`);
}

async function main(): Promise<void> {
  loadDotEnvSmoke();
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const workersSubdomain = requireEnv("CLOUDFLARE_WORKERS_SUBDOMAIN");
  const prefix = (process.env.SMOKE_WORKER_PREFIX ?? "takosumi-smoke").toLowerCase();
  const appName = `${prefix}-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 63);
  const publicUrl = `https://${appName}.${workersSubdomain}.workers.dev`;

  const work = mkdtempSync(join(tmpdir(), "takosumi-cf-smoke-"));
  mkdirSync(join(work, "module"), { recursive: true });
  let tf = readFileSync(MODULE_TF, "utf8");
  const pin = process.env.CLOUDFLARE_PROVIDER_VERSION;
  if (pin) {
    tf = tf.replace(
      /(cloudflare\s*=\s*\{\s*source\s*=\s*"cloudflare\/cloudflare")/,
      `$1\n      version = "${pin}"`,
    );
  }
  writeFileSync(join(work, "module", "main.tf"), tf);
  writeFileSync(
    join(work, "main.tf"),
    `module "capsule" {\n` +
      `  source           = "./module"\n` +
      `  appName          = var.appName\n` +
      `  accountId        = var.accountId\n` +
      `  workersSubdomain = var.workersSubdomain\n` +
      `}\n` +
      `variable "appName" { type = string }\n` +
      `variable "accountId" { type = string }\n` +
      `variable "workersSubdomain" { type = string }\n` +
      `output "worker_name" { value = module.capsule.worker_name }\n` +
      `output "url" { value = module.capsule.url }\n`,
  );

  const env = {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    TF_IN_AUTOMATION: "1",
  };
  const vars = [
    "-var",
    `appName=${appName}`,
    "-var",
    `accountId=${accountId}`,
    "-var",
    `workersSubdomain=${workersSubdomain}`,
  ];

  console.log(
    `> Cloudflare smoke: Worker "${appName}" in account ${accountId}\n  workdir ${work}\n`,
  );
  const started = Date.now();
  let applied = false;
  try {
    await tofu(["init", "-no-color", "-input=false"], work, env);
    await tofu(
      ["plan", "-no-color", "-input=false", `-out=${PLAN_FILE}`, ...vars],
      work,
      env,
    );
    await tofu(["apply", "-no-color", "-input=false", PLAN_FILE], work, env);
    applied = true;

    console.log("\n> verifying the Worker exists via the Cloudflare API...");
    if (!(await workerScriptExists(accountId, token, appName))) {
      throw new Error(
        `apply succeeded but Cloudflare reports Worker "${appName}" does not exist`,
      );
    }
    console.log("  ok: worker script exists in real Cloudflare state");

    console.log(`\n> probing ${publicUrl}...`);
    await probeWorkerUrl(publicUrl);
    console.log("  ok: worker URL returned the sample page");
  } finally {
    if (applied && process.env.SMOKE_KEEP !== "1") {
      console.log("\n> destroying...");
      try {
        await tofu(
          ["destroy", "-no-color", "-input=false", "-auto-approve", ...vars],
          work,
          env,
        );
        const gone = !(await workerScriptExists(accountId, token, appName));
        console.log(gone ? "  ok: worker destroyed" : "  x worker still exists");
        if (!gone) process.exitCode = 1;
      } catch (e) {
        console.error(
          `  x destroy/verify failed; manual cleanup of "${appName}" may be needed:`,
          e,
        );
        process.exitCode = 1;
      }
    }
    if (process.env.SMOKE_KEEP !== "1") rmSync(work, { recursive: true, force: true });
    else console.log(`\n(kept workdir ${work}; SMOKE_KEEP=1)`);
  }

  if (process.exitCode && process.exitCode !== 0) {
    console.error(
      `\nx Cloudflare smoke FAILED in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    return;
  }
  console.log(
    `\nok Cloudflare smoke PASSED in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

await main();
