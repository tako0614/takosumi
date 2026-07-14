/**
 * ============================================================================
 * LOCAL-SUBSTRATE TEST RUNNER ONLY.
 *
 * Boots THE single composed Takosumi platform worker — the bundle produced by
 * `bun build` from takosumi/deploy/platform/worker.ts, the same entry the
 * operator deploys at app.takosumi.com — inside Miniflare with local D1, R2,
 * Durable Object, and queue bindings. This replaces the old two-bundle scaffold
 * (a control-plane bundle + a mislabeled "accounts" bundle, both built from
 * worker/src/index.ts) so the dev substrate exercises the SAME composed entry
 * as production: accounts plane (bare-origin OIDC issuer + dashboard SPA
 * fallback) + in-process deploy-control plane.
 *
 * This runner pass-throughs every TAKOSUMI_* env var of the host process into
 * the Miniflare worker bindings. That convenience is acceptable inside the
 * local-substrate docker network — where the host process IS the test harness —
 * but in production it would be a credential-exfiltration vector. Production
 * deploys go through `wrangler deploy --config deploy/platform/wrangler.toml`
 * with an explicit env block + `wrangler secret put`. THIS FILE MUST NEVER BE
 * COPIED to a production runner. The LOCAL_SUBSTRATE_TEST_BED=1 guard below
 * fails fast if someone tries.
 *
 * The container-backed OpenTofu RUNNER durable object is intentionally NOT bound
 * here: Miniflare cannot run Cloudflare Containers, and the substrate dispatches
 * OpenTofu execution to the standalone `opentofu-runner` service instead.
 * ============================================================================
 */
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";

if (process.env.LOCAL_SUBSTRATE_TEST_BED !== "1") {
  console.error(
    "[takosumi-platform-worker] refusing to start: this runner is local-substrate-only.\n" +
      "    It pass-throughs ALL TAKOSUMI_* env vars into worker bindings and injects\n" +
      "    local fixture bindings/secrets for Miniflare D1/R2/DO/queue,\n" +
      "    which is a credential leak path outside a controlled test bed.\n" +
      "    For production use `wrangler deploy --config deploy/platform/wrangler.toml`.\n" +
      "    For local-substrate use, set LOCAL_SUBSTRATE_TEST_BED=1.",
  );
  process.exit(1);
}

const scriptPath =
  process.env.WORKER_SCRIPT ?? "/worker/takosumi-platform-worker.mjs";
const port = Number(process.env.WORKER_PORT ?? 8788);
const scriptContents = readFileSync(scriptPath, "utf8");

// Pass through every TAKOSUMI_* env var (which includes the TAKOSUMI_ACCOUNTS_*
// subset) as a worker binding so we don't have to enumerate each new config knob
// (platform-readiness refs, deploy control token, upstream OAuth, passkey RP,
// hardening evidence, etc) in this runner.
const bindings = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => typeof value === "string" && key.startsWith("TAKOSUMI_"),
  ),
);
bindings.LOCAL_SUBSTRATE_TEST_BED = "1";

// Sensible defaults if the operator forgot to set the basics.
bindings.TAKOSUMI_RUNTIME_MODE ??= "cloudflare-worker";
bindings.TAKOSUMI_ENVIRONMENT ??= "development";
bindings.TAKOSUMI_DEPLOY_CONTROL_TOKEN ??=
  "local-substrate-deploy-control-token";
bindings.TAKOSUMI_INTERNAL_API_SECRET ??= "local-dev-secret";
bindings.TAKOSUMI_SECRET_STORE_PASSPHRASE ??=
  "local-substrate-secret-store-passphrase-v1";
bindings.TAKOSUMI_ACCOUNTS_ISSUER ??= "https://app.takosumi.test";
bindings.TAKOSUMI_ACCOUNTS_SUBJECT ??= "tsub_takosumi_accounts_local";
bindings.TAKOSUMI_ACCOUNTS_CLIENT_ID ??= "takosumi-local";
bindings.TAKOSUMI_ACCOUNTS_REDIRECT_URIS ??=
  "https://app.takosumi.test/sign-in/callback";

const mf = new Miniflare({
  modules: [
    {
      type: "ESModule",
      path: basename(scriptPath),
      contents: scriptContents,
    },
  ],
  host: "0.0.0.0",
  port,
  compatibilityDate: process.env.WORKER_COMPATIBILITY_DATE ?? "2026-04-15",
  compatibilityFlags: ["nodejs_compat"],
  // Composed worker needs BOTH the accounts ledger and the control-plane ledger.
  d1Databases: {
    TAKOSUMI_ACCOUNTS_DB: "takosumi-accounts",
    TAKOSUMI_CONTROL_DB: "takosumi-deploy",
  },
  d1Persist: "/data/d1",
  r2Buckets: [
    "R2_ARTIFACTS",
    "R2_SOURCE",
    "R2_STATE",
    "R2_BACKUPS",
  ],
  r2Persist: "/data/r2",
  durableObjects: {
    COORDINATION: {
      className: "CoordinationObject",
      useSQLite: true,
    },
    RUN_OWNER: {
      className: "OpenTofuRunOwnerObject",
      useSQLite: true,
    },
  },
  durableObjectsPersist: "/data/do",
  queueProducers: {
    RUN_QUEUE: { queueName: "takosumi-runs" },
  },
  bindings,
});

const url = await mf.ready;
console.log(`[takosumi-platform-worker] miniflare serving at ${url}`);
