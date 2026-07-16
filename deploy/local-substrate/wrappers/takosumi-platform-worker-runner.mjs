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
 * Miniflare cannot run Cloudflare Containers. The local-only RUNNER durable
 * object therefore preserves the production artifact relay while proxying the
 * container transport to the standalone `opentofu-runner` service.
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
const accountsD1MigrationsPath =
  process.env.WORKER_ACCOUNTS_D1_MIGRATIONS_PATH ??
  "/worker/takosumi-accounts-d1-migrations.json";
const outboundCaCertPath =
  process.env.WORKER_OUTBOUND_CA_CERT_PATH ??
  "/local-substrate-runtime/pebble-issuance-root.pem";
let outboundCaCert;
try {
  outboundCaCert = readFileSync(outboundCaCertPath, "utf8");
} catch (cause) {
  throw new Error(
    `[takosumi-platform-worker] outbound CA certificate is missing or unreadable: ${outboundCaCertPath}`,
    { cause },
  );
}
if (
  !outboundCaCert.includes("-----BEGIN CERTIFICATE-----") ||
  !outboundCaCert.includes("-----END CERTIFICATE-----")
) {
  throw new Error(
    `[takosumi-platform-worker] outbound CA certificate is not PEM encoded: ${outboundCaCertPath}`,
  );
}

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
  // Keep Miniflare's normal public/private egress reachability, but replace
  // its implicit network service so workerd trusts the local Pebble issuance
  // root in addition to browser CAs. TLS verification stays enabled.
  outboundService: {
    network: {
      allow: ["public", "private", "240.0.0.0/4"],
      tlsOptions: {
        trustBrowserCas: true,
        trustedCertificates: [outboundCaCert],
      },
    },
  },
  // Composed worker needs BOTH the accounts ledger and the control-plane ledger.
  d1Databases: {
    TAKOSUMI_ACCOUNTS_DB: "takosumi-accounts",
    TAKOSUMI_CONTROL_DB: "takosumi-deploy",
  },
  d1Persist: "/data/d1",
  r2Buckets: ["R2_ARTIFACTS", "R2_SOURCE", "R2_STATE", "R2_BACKUPS"],
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
    RUNNER: {
      className: "LocalSubstrateOpenTofuRunnerProxyObject",
      useSQLite: true,
    },
  },
  durableObjectsPersist: "/data/do",
  queueProducers: {
    RUN_QUEUE: { queueName: "takosumi-runs" },
  },
  bindings,
});

await applyLocalAccountsD1Migrations(mf, accountsD1MigrationsPath);

const url = await mf.ready;
console.log(`[takosumi-platform-worker] miniflare serving at ${url}`);

async function applyLocalAccountsD1Migrations(miniflare, artifactPath) {
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `[takosumi-platform-worker] accounts D1 migration artifact is missing or invalid: ${artifactPath}`,
      { cause },
    );
  }
  if (
    artifact?.kind !== "takosumi.accounts.local-d1-migrations@v1" ||
    !Array.isArray(artifact.migrations)
  ) {
    throw new Error(
      `[takosumi-platform-worker] accounts D1 migration artifact has an unsupported shape: ${artifactPath}`,
    );
  }

  const versions = new Set();
  for (const [index, migration] of artifact.migrations.entries()) {
    if (
      !Number.isInteger(migration?.version) ||
      migration.version !== index ||
      versions.has(migration.version) ||
      typeof migration.name !== "string" ||
      migration.name.length === 0 ||
      typeof migration.sql !== "string" ||
      migration.sql.length === 0
    ) {
      throw new Error(
        `[takosumi-platform-worker] accounts D1 migration artifact is not a contiguous ordered catalog: ${artifactPath}`,
      );
    }
    versions.add(migration.version);
  }

  const database = await miniflare.getD1Database("TAKOSUMI_ACCOUNTS_DB");
  await database.exec(
    "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
  );
  const existing = await database
    .prepare(
      "SELECT version, name FROM takosumi_accounts_schema_migrations ORDER BY version",
    )
    .all();
  const existingByVersion = new Map(
    (existing.results ?? []).map((row) => [Number(row.version), row.name]),
  );
  const applied = [];
  for (const migration of artifact.migrations) {
    const existingName = existingByVersion.get(migration.version);
    if (existingName !== undefined) {
      if (existingName !== migration.name) {
        throw new Error(
          `[takosumi-platform-worker] accounts D1 migration ${migration.version} name mismatch: ledger=${existingName}, catalog=${migration.name}`,
        );
      }
      continue;
    }
    await database.exec(migration.sql);
    await database
      .prepare(
        "INSERT INTO takosumi_accounts_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      )
      .bind(migration.version, migration.name, Date.now())
      .run();
    applied.push(migration.version);
  }
  console.log(
    `[takosumi-platform-worker] accounts D1 migrations applied=${applied.length} current=${artifact.migrations.at(-1)?.version ?? -1}`,
  );
}
