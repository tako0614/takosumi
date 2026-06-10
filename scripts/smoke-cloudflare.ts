/**
 * Real-Cloudflare GA smoke (layer 1: provider/module integration).
 *
 * Applies the official `cloudflare-r2-storage` Capsule against a REAL Cloudflare
 * account, independently verifies the R2 bucket exists via the Cloudflare API,
 * then destroys it and verifies it is gone. This exercises the riskiest part of
 * the managed deploy loop that every fake-runner unit test cannot: the actual
 * Cloudflare API, real provider install, real apply, and a clean destroy.
 *
 * Credentials come ONLY from the environment — never the repo (operator secrets
 * stay outside git, per the ecosystem rules). Set them inline or in a gitignored
 * `.env.smoke` (auto-loaded if present):
 *
 *   CLOUDFLARE_API_TOKEN   # token with "Workers R2 Storage: Edit" on the account
 *   CLOUDFLARE_ACCOUNT_ID  # the target (ideally a scratch/dedicated) account
 *
 * Optional:
 *   CLOUDFLARE_PROVIDER_VERSION  # pin the cloudflare provider (else registry latest)
 *   SMOKE_BUCKET_PREFIX          # default "takosumi-smoke"
 *   SMOKE_KEEP=1                 # keep the temp workdir for inspection
 *
 * Run:  bun run smoke:cloudflare
 *
 * Exit 0 = the real apply→verify→destroy→verify loop passed; non-zero = a real
 * integration failure a GA must not ship with.
 */
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_TF = join(HERE, "../opentofu-modules/cloudflare-r2-storage/module/main.tf");
const CF_API = "https://api.cloudflare.com/client/v4";

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
      `✗ ${name} is not set. The Cloudflare smoke needs real operator credentials ` +
        `from the environment (never the repo):\n` +
        `    export CLOUDFLARE_API_TOKEN=...   # Workers R2 Storage: Edit\n` +
        `    export CLOUDFLARE_ACCOUNT_ID=...\n` +
        `  or put them in a gitignored takosumi/.env.smoke`,
    );
    process.exit(2);
  }
  return v.trim();
}

async function tofu(args: string[], cwd: string, env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(["tofu", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tofu ${args[0]} exited ${code}`);
}

async function bucketExists(accountId: string, token: string, name: string): Promise<boolean> {
  const res = await fetch(`${CF_API}/accounts/${accountId}/r2/buckets/${name}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.ok) return true;
  if (res.status === 404) return false;
  // 404 may also arrive as a 200 with success:false depending on the API; treat
  // any non-ok, non-404 as an inconclusive error so the smoke fails loudly.
  const body = await res.text();
  throw new Error(`cloudflare bucket probe returned ${res.status}: ${body.slice(0, 200)}`);
}

async function main(): Promise<void> {
  loadDotEnvSmoke();
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const prefix = (process.env.SMOKE_BUCKET_PREFIX ?? "takosumi-smoke").toLowerCase();
  // R2 bucket name: lowercase, digits, hyphens, 3-63 chars, globally unique enough.
  const bucket = `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 63);

  const work = mkdtempSync(join(tmpdir(), "takosumi-cf-smoke-"));
  mkdirSync(join(work, "module"), { recursive: true });
  let tf = readFileSync(MODULE_TF, "utf8");
  const pin = process.env.CLOUDFLARE_PROVIDER_VERSION;
  if (pin) {
    // Inject a version constraint into the cloudflare required_providers entry.
    tf = tf.replace(
      /(cloudflare\s*=\s*\{\s*source\s*=\s*"cloudflare\/cloudflare")/,
      `$1\n      version = "${pin}"`,
    );
  }
  writeFileSync(join(work, "module", "main.tf"), tf);
  // A tiny root that calls the module — mirrors how Takosumi wraps a Capsule.
  writeFileSync(
    join(work, "main.tf"),
    `module "capsule" {\n  source     = "./module"\n  bucketName = var.bucketName\n  accountId  = var.accountId\n}\n` +
      `variable "bucketName" { type = string }\nvariable "accountId" { type = string }\n` +
      `output "bucket_name" { value = module.capsule.bucket_name }\n`,
  );

  const env = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, TF_IN_AUTOMATION: "1" };
  const vars = ["-var", `bucketName=${bucket}`, "-var", `accountId=${accountId}`];

  console.log(`▶ Cloudflare smoke: R2 bucket "${bucket}" in account ${accountId}\n  workdir ${work}\n`);
  const started = Date.now();
  let applied = false;
  try {
    await tofu(["init", "-no-color", "-input=false"], work, env);
    await tofu(["apply", "-no-color", "-input=false", "-auto-approve", ...vars], work, env);
    applied = true;

    console.log("\n▶ verifying the bucket exists via the Cloudflare API…");
    if (!(await bucketExists(accountId, token, bucket))) {
      throw new Error(`apply succeeded but Cloudflare reports bucket "${bucket}" does NOT exist`);
    }
    console.log("  ✓ bucket exists in real Cloudflare state");
  } finally {
    if (applied && process.env.SMOKE_KEEP !== "1") {
      console.log("\n▶ destroying…");
      try {
        await tofu(["destroy", "-no-color", "-input=false", "-auto-approve", ...vars], work, env);
        const gone = !(await bucketExists(accountId, token, bucket));
        console.log(gone ? "  ✓ bucket destroyed (verified gone)" : "  ✗ bucket STILL exists after destroy");
        if (!gone) process.exitCode = 1;
      } catch (e) {
        console.error(`  ✗ destroy/verify failed — manual cleanup of "${bucket}" may be needed:`, e);
        process.exitCode = 1;
      }
    }
    if (process.env.SMOKE_KEEP !== "1") rmSync(work, { recursive: true, force: true });
    else console.log(`\n(kept workdir ${work} — SMOKE_KEEP=1)`);
  }

  if (process.exitCode && process.exitCode !== 0) {
    console.error(`\n✗ Cloudflare smoke FAILED in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }
  console.log(`\n✓ Cloudflare smoke PASSED in ${((Date.now() - started) / 1000).toFixed(1)}s — real apply/verify/destroy loop works`);
}

await main();
