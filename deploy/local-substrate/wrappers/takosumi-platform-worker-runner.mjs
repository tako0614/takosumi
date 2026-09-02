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
 * promotion goes through the ecosystem `release-production-safely` controller
 * with an operator-private envelope and fixed adapter. THIS FILE MUST NEVER BE
 * COPIED to a production runner. The LOCAL_SUBSTRATE_TEST_BED=1 guard below
 * fails fast if someone tries.
 *
 * Miniflare cannot run Cloudflare Containers. The local-only RUNNER durable
 * object therefore preserves the production artifact relay while proxying the
 * container transport to the standalone `opentofu-runner` service.
 * ============================================================================
 */
import { Miniflare } from "miniflare";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

async function main() {
  if (process.env.LOCAL_SUBSTRATE_TEST_BED !== "1") {
  console.error(
    "[takosumi-platform-worker] refusing to start: this runner is local-substrate-only.\n" +
      "    It pass-throughs ALL TAKOSUMI_* env vars into worker bindings and injects\n" +
      "    local fixture bindings/secrets for Miniflare D1/R2/DO/queue,\n" +
      "    which is a credential leak path outside a controlled test bed.\n" +
      "    For production use the ecosystem release-production-safely controller.\n" +
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
  bindings,
});

await applyLocalAccountsD1Migrations(mf, accountsD1MigrationsPath);

const url = await mf.ready;
await warmDeployControlSeam(mf, bindings.TAKOSUMI_DEPLOY_CONTROL_TOKEN);
console.log(`[takosumi-platform-worker] miniflare serving at ${url}`);
}

/**
 * Bootstrap the deploy-control ledger schema before the port is announced.
 *
 * The seam initializes its control-D1 schema lazily on the first request that
 * reaches it, and that initialization blocks every other request the Worker is
 * serving — on a cold control D1 it replays the whole migration set one
 * statement at a time, which is storage-latency-bound and takes tens of
 * seconds on an ordinary CI disk. Paying it here keeps it inside the
 * bring-up readiness wait, where a slow start belongs, instead of inside a
 * bounded smoke check that can only report "it hung".
 *
 * The elapsed time is logged rather than swallowed: this cost is real, it is
 * also paid by a freshly provisioned Worker in production, and it should stay
 * visible.
 */
async function warmDeployControlSeam(miniflare, deployControlToken) {
  const started = Date.now();
  try {
    const response = await miniflare.dispatchFetch(
      "http://localhost/internal/v1/runner-profiles",
      { headers: { authorization: `Bearer ${deployControlToken}` } },
    );
    await response.arrayBuffer();
    console.log(
      `[takosumi-platform-worker] deploy-control seam warm status=${response.status} elapsed=${Date.now() - started}ms`,
    );
  } catch (cause) {
    console.error(
      `[takosumi-platform-worker] deploy-control seam warm failed after ${Date.now() - started}ms:`,
      cause,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

export async function applyLocalAccountsD1Migrations(
  miniflare,
  artifactPath,
  options = {},
) {
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `[takosumi-platform-worker] accounts D1 migration artifact is missing or invalid: ${artifactPath}`,
      { cause },
    );
  }
  const runtimeModulePath =
    options.runtimeModulePath ?? artifactPath.replace(/\.json$/u, ".runtime.mjs");
  if (runtimeModulePath === artifactPath) {
    throw new Error(
      "[takosumi-platform-worker] accounts D1 migration policy mismatch",
    );
  }
  let migrationRuntime;
  try {
    migrationRuntime = await import(pathToFileURL(runtimeModulePath).href);
  } catch (cause) {
    throw new Error(
      "[takosumi-platform-worker] accounts D1 migration runtime is missing or invalid",
      { cause },
    );
  }
  if (
    typeof migrationRuntime.loadD1AccountsMigrationCatalog !== "function" ||
    typeof migrationRuntime.backfillD1AccountsActivationDigests !== "function" ||
    typeof migrationRuntime.applyD1AccountsMigrationBatch !== "function" ||
    typeof migrationRuntime.readD1AccountsMigrationState !== "function"
  ) {
    throw new Error(
      "[takosumi-platform-worker] accounts D1 migration runtime is missing or invalid",
    );
  }
  const catalog = await migrationRuntime.loadD1AccountsMigrationCatalog();
  assertLocalAccountsD1Artifact(artifact, catalog);

  const database = await miniflare.getD1Database("TAKOSUMI_ACCOUNTS_DB");
  let state = await migrationRuntime.readD1AccountsMigrationState(
    database,
    catalog,
  );
  assertExactLocalAccountsD1Prefix(state, catalog);
  let prefixLength = state.exactPrefixLength;
  const applied = [];
  const lostAcknowledgementReconciled = [];
  let activationDigestBackfill;
  for (const migration of catalog.migrations.slice(prefixLength)) {
    if (migration.version === 4) {
      activationDigestBackfill =
        await migrationRuntime.backfillD1AccountsActivationDigests(database);
    }
    try {
      await migrationRuntime.applyD1AccountsMigrationBatch(
        database,
        migration,
        Date.now(),
      );
    } catch (cause) {
      let reconciledState;
      try {
        reconciledState = await migrationRuntime.readD1AccountsMigrationState(
          database,
          catalog,
        );
      } catch {
        throw new Error(
          "[takosumi-platform-worker] accounts D1 migration state is indeterminate",
          { cause },
        );
      }
      if (
        reconciledState.issues.length === 0 &&
        reconciledState.exactPrefixLength === migration.version + 1
      ) {
        lostAcknowledgementReconciled.push(migration.version);
        state = reconciledState;
        prefixLength = migration.version + 1;
        continue;
      }
      if (
        reconciledState.issues.length === 0 &&
        reconciledState.exactPrefixLength === migration.version
      ) {
        throw new Error(
          "[takosumi-platform-worker] accounts D1 migration did not commit; restart required",
          { cause },
        );
      }
      throw new Error(
        "[takosumi-platform-worker] accounts D1 migration state is indeterminate",
        { cause },
      );
    }
    state = await migrationRuntime.readD1AccountsMigrationState(
      database,
      catalog,
    );
    if (
      state.issues.length !== 0 ||
      state.exactPrefixLength !== migration.version + 1
    ) {
      throw new Error(
        "[takosumi-platform-worker] accounts D1 migration acknowledgement has no exact receipt",
      );
    }
    prefixLength = migration.version + 1;
    applied.push(migration.version);
  }
  const current = catalog.migrations.at(prefixLength - 1)?.version ?? -1;
  console.log(
    `[takosumi-platform-worker] accounts D1 migrations applied=${applied.length} current=${current}`,
  );
  return {
    applied,
    lostAcknowledgementReconciled,
    current,
    ...(activationDigestBackfill ? { activationDigestBackfill } : {}),
  };
}

function assertLocalAccountsD1Artifact(artifact, catalog) {
  const expected = {
    kind: "takosumi.accounts.local-d1-migrations@v2",
    catalogDigest: catalog.digest,
    policyDigest: catalog.policyDigest,
    headVersion: catalog.headVersion,
    migrations: catalog.migrations,
    schemaClosures: catalog.schemaClosures,
    preLedgerPolicy: catalog.preLedgerPolicy,
  };
  const policyDigest = sha256(
    JSON.stringify({
      preLedgerPolicy: artifact?.preLedgerPolicy,
      schemaClosures: Array.isArray(artifact?.schemaClosures)
        ? artifact.schemaClosures.map(
            ({ headVersion, ledgerShape, digest }) => ({
              headVersion,
              ledgerShape,
              digest,
            }),
          )
        : null,
    }),
  );
  const schemaDigestsAreExact =
    Array.isArray(artifact?.schemaClosures) &&
    artifact.schemaClosures.every(
      (closure) =>
        closure &&
        sha256(JSON.stringify({ objects: closure.objects })) === closure.digest,
    );
  if (
    artifact?.policyDigest !== policyDigest ||
    !schemaDigestsAreExact ||
    JSON.stringify(artifact) !== JSON.stringify(expected)
  ) {
    throw new Error(
      "[takosumi-platform-worker] accounts D1 migration policy mismatch",
    );
  }
}

function assertExactLocalAccountsD1Prefix(state, catalog) {
  if (
    state.issues.length !== 0 ||
    !Number.isInteger(state.exactPrefixLength) ||
    state.exactPrefixLength < 0 ||
    state.exactPrefixLength > catalog.migrations.length
  ) {
    throw new Error(
      "[takosumi-platform-worker] accounts D1 state is not an exact catalog prefix",
    );
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
