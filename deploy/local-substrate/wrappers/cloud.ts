/**
 * Boots the redesigned local-substrate `cloud` control plane: the single
 * composed app this distribution serves (account-plane + embedded service +
 * dashboard / OIDC / billing / install UI), mirroring production's one
 * `app.takosumi.com`.
 *
 * It reuses the published reference composer's `buildComposedServer`
 * (node-postgres profile: Postgres store + accounts handler + healthz
 * pre-handler + serve) and only supplies the substrate-specific overrides:
 *   - the CoreDNS gateway projection writer that hands routes to Caddy.
 *
 * OpenTofu execution is external: the configured RunnerProfile points at the
 * dedicated `opentofu-runner` service. This process holds no docker.sock and
 * never spawns OpenTofu subprocesses.
 *
 * Imports straddle three mounts:
 *   - /workspace        = takosumi (the composer; buildComposedServer)
 *   - /takosumi         = takosumi source (the dev-seam `@takosjp/takosumi`
 *                         target the node-postgres import map points at)
 * and run under the takosumi workspace config so the composer graph
 * resolves.
 */
import { buildComposedServer } from "/workspace/deploy/node-postgres/src/server.ts";
import { selectSecretBoundaryCrypto } from "/workspace/core/adapters/secret-store/memory.ts";
import {
  createFileOpenTofuStateArtifactStore,
  createFileSourceArchiveStore,
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
  LOCAL_OPENTOFU_RUNNER_PROFILE_ID,
} from "/workspace/deploy/node-postgres/src/local-opentofu-runner.ts";
import {
  createDefaultRunnerProfiles,
  resolveEnabledRunnerProfiles,
} from "/workspace/core/domains/deploy-control/runner_profiles.ts";
import { mkdir, writeFile } from "node:fs/promises";

interface GatewayProjectionRecord {
  readonly recordName?: unknown;
  readonly fqdn?: unknown;
  readonly listener?: unknown;
  readonly target?: unknown;
  readonly routes?: unknown;
}

const env = { ...process.env };

const routeProjectionFile =
  env.TAKOSUMI_LOCAL_SUBSTRATE_GATEWAY_ROUTES_FILE ??
  "/local-substrate-runtime/gateway-routes.json";
await writeGatewayProjection(routeProjectionFile, []);

const sourceArchiveStore = createFileSourceArchiveStore(
  env.TAKOSUMI_LOCAL_SOURCE_ARCHIVE_DIR ??
    "/local-substrate-runtime/source-archives",
);
const stateArtifactStore = createFileOpenTofuStateArtifactStore(
  env.TAKOSUMI_LOCAL_STATE_ARTIFACT_DIR ??
    "/local-substrate-runtime/state-artifacts",
  selectSecretBoundaryCrypto({ env }),
);
const externalRunnerUrl = nonEmptyString(
  env.TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL,
);
const runnerProfiles = externalRunnerUrl
  ? resolveEnabledRunnerProfiles(
      createDefaultRunnerProfiles(),
      env.TAKOSUMI_ENABLED_RUNNER_PROFILES,
    )
  : [createLocalOpenTofuRunnerProfile()];
const defaultRunnerProfileId =
  (externalRunnerUrl
    ? nonEmptyString(env.TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID)
    : undefined) ??
  runnerProfiles[0]?.id ??
  LOCAL_OPENTOFU_RUNNER_PROFILE_ID;
if (runnerProfiles.length === 0) {
  throw new Error("local-substrate cloud requires at least one runner profile");
}

// Local/self-hosted runs do not receive a platform Worker Version or a
// published runner image identity automatically. An operator may provide the
// exact immutable release digests explicitly; partial configuration is
// rejected, while an entirely absent authority keeps plan/read-only paths
// available and makes apply/destroy fail closed in Core.
const executionEvidenceAuthority = executionEvidenceAuthorityFromEnv(env);

// Blocks on serveOnAnyRuntime (port 8787 from config).
await buildComposedServer({
  opentofuRunner: externalRunnerUrl
    ? createHttpOpenTofuRunner({
        archiveStore: sourceArchiveStore,
        stateStore: stateArtifactStore,
        baseUrl: externalRunnerUrl,
      })
    : createLocalOpenTofuRunner({
        archiveStore: sourceArchiveStore,
        stateStore: stateArtifactStore,
      }),
  runnerProfiles,
  defaultRunnerProfileId,
  ...(executionEvidenceAuthority ? { executionEvidenceAuthority } : {}),
});

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function executionEvidenceAuthorityFromEnv(
  values: Readonly<Record<string, string | undefined>>,
): {
  readonly controllerArtifact: { readonly digest: `sha256:${string}`; readonly immutable: true };
  readonly runnerArtifact: { readonly digest: `sha256:${string}`; readonly immutable: true };
  readonly executorArtifact: { readonly digest: `sha256:${string}`; readonly immutable: true };
} | undefined {
  const names = [
    "TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST",
    "TAKOSUMI_RUNNER_ARTIFACT_DIGEST",
    "TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST",
  ] as const;
  const valuesByName = names.map((name) => nonEmptyString(values[name]));
  if (valuesByName.every((value) => value === undefined)) return undefined;
  const missing = names.filter((_, index) => valuesByName[index] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `local-substrate execution evidence authority is incomplete; missing ${missing.join(", ")}`,
    );
  }
  for (const [index, digest] of valuesByName.entries()) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest!)) {
      throw new Error(`${names[index]} must be a sha256 digest`);
    }
  }
  return {
    controllerArtifact: { digest: valuesByName[0]! as `sha256:${string}`, immutable: true },
    runnerArtifact: { digest: valuesByName[1]! as `sha256:${string}`, immutable: true },
    executorArtifact: { digest: valuesByName[2]! as `sha256:${string}`, immutable: true },
  };
}

async function writeGatewayProjection(
  file: string,
  records: readonly GatewayProjectionRecord[],
): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf("/"));
  if (dir.length > 0) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(
    file,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        records: records.map((record) => ({
          recordName: record.recordName,
          fqdn: record.fqdn,
          listener: record.listener,
          target: record.target,
          routes: record.routes,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}
