/**
 * Shared test fixture for the Space-direct Installation model (core-spec §4 /
 * §5 / §11). Seeds the minimal ledger rows an installation-driven run needs:
 * Space -> StoredSource -> SourceSnapshot -> InstallConfig -> Installation.
 *
 * Tests that previously planned directly from a source module now create the
 * Installation first (the create-on-apply legacy path is removed) and call
 * `controller.createInstallationPlan(installationId)`.
 */
import type {
  Connection,
  InstallConfig,
  Installation,
} from "@takosumi/internal/deploy-control-api";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { Space } from "takosumi-contract/spaces";
import { CredentialBundle, PhaseMintBundle } from "../../../core/adapters/vault/mod.ts";
import type { OpenTofuDeploymentStore, StoredSource } from "../../../core/domains/deploy-control/store.ts";

export interface SeededModel {
  readonly space: Space;
  readonly source: StoredSource;
  readonly snapshot: SourceSnapshot;
  readonly installConfig: InstallConfig;
  readonly installation: Installation;
}

export interface SeedModelOptions {
  readonly spaceId?: string;
  readonly sourceId?: string;
  readonly snapshotId?: string;
  readonly installConfigId?: string;
  readonly installationId?: string;
  readonly environment?: string;
  readonly name?: string;
  readonly sourceUrl?: string;
  readonly ref?: string;
  /** Skip seeding the SourceSnapshot (to exercise source_sync_required). */
  readonly withoutSnapshot?: boolean;
  /** Extra InstallConfig fields (e.g. templateBinding for template runs). */
  readonly installConfig?: Partial<InstallConfig>;
}

export interface SeedProviderConnectionOptions {
  readonly requiredProviders?: readonly string[];
  readonly materialization?: "secret" | "gateway";
}

export const FIXTURE_ARCHIVE_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FIXTURE_CLOUDFLARE_PROVIDER =
  "registry.opentofu.org/cloudflare/cloudflare";
export const FIXTURE_AWS_PROVIDER = "registry.opentofu.org/hashicorp/aws";
export const FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE = {
  provider: FIXTURE_CLOUDFLARE_PROVIDER,
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
} as const;
export const FIXTURE_AWS_MIRROR_EVIDENCE = {
  provider: FIXTURE_AWS_PROVIDER,
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/hashicorp/aws",
} as const;

export function fakeProviderVault(
  options: {
    readonly token?: string;
    readonly connectionId?: string;
    readonly provider?: string;
  } = {},
) {
  const provider = options.provider ?? FIXTURE_CLOUDFLARE_PROVIDER;
  const connectionId = options.connectionId ?? "conn_fixture";
  const token = options.token ?? "fixture-provider-token";
  const sharedEvidence = {
    provider,
    providerEnvId: connectionId,
    connectionId,
    delivery: "provider_env" as const,
    rootOnly: false,
    temporary: true,
    ttlEnforced: true,
    phase: "plan" as const,
  };
  const rootEvidence = {
    provider,
    providerEnvId: connectionId,
    connectionId,
    delivery: "generated_root_variable" as const,
    rootOnly: true,
    temporary: true,
    ttlEnforced: true,
    phase: "plan" as const,
  };
  return {
    register: () => Promise.reject(new Error("not used")),
    test: () => Promise.resolve({ status: "verified" }),
    revoke: () => Promise.resolve(true),
    mint: () =>
      Promise.resolve(
        new CredentialBundle(
          { CLOUDFLARE_API_TOKEN: token },
          [],
          [sharedEvidence],
        ),
      ),
    mintForPhase: () =>
      Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: token } },
          [],
          [sharedEvidence],
        ),
      ),
    mintForInstallationProviderEnvBindings: () =>
      Promise.resolve(
        new CredentialBundle(
          { TF_VAR_cloudflare_main_api_token: token },
          [],
          [rootEvidence],
        ),
      ),
  };
}

/** Seeds Space + Source + Snapshot + InstallConfig + Installation. */
export async function seedInstallationModel(
  store: OpenTofuDeploymentStore,
  options: SeedModelOptions = {},
): Promise<SeededModel> {
  const now = "2026-06-06T00:00:00.000Z";
  const spaceId = options.spaceId ?? "space_test";
  const sourceId = options.sourceId ?? "src_fixture";
  const environment = options.environment ?? "production";
  const name = options.name ?? "app";
  const space: Space = {
    id: spaceId,
    handle: spaceId.replace(/_/g, "-"),
    displayName: "Test Space",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: now,
    updatedAt: now,
  };
  await store.putSpace(space);
  const source: StoredSource = {
    id: sourceId,
    spaceId,
    name: `${name}-source`,
    url: options.sourceUrl ?? "https://git.example.com/example/app.git",
    defaultRef: options.ref ?? "main",
    defaultPath: ".",
    status: "active",
    createdAt: now,
    updatedAt: now,
    hookSecretHash: "test-hook-hash",
    autoSync: false,
  };
  await store.putSource(source);
  const snapshot: SourceSnapshot = {
    id: options.snapshotId ?? "snap_fixture",
    origin: "git",
    spaceId,
    sourceId,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: "abcdef0123456789abcdef0123456789abcdef01",
    path: ".",
    archiveObjectKey: `spaces/${spaceId}/sources/${sourceId}/snapshots/snap_fixture/source.tar.zst`,
    archiveDigest: FIXTURE_ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: "run_fixture_sync",
    fetchedAt: now,
  };
  if (!options.withoutSnapshot) {
    await store.putSourceSnapshot(snapshot);
  }
  const installConfig: InstallConfig = {
    id: options.installConfigId ?? "cfg_fixture",
    name: `${name}-config`,
    installType: "opentofu_module",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: {
      launch_url: { from: "launch_url", type: "url" },
    },
    policy: {},
    createdAt: now,
    updatedAt: now,
    ...options.installConfig,
  };
  await store.putInstallConfig(installConfig);
  const installation: Installation = {
    id: options.installationId ?? "inst_fixture",
    spaceId,
    name,
    slug: name,
    sourceId,
    installType: installConfig.installType,
    installConfigId: installConfig.id,
    environment,
    currentStateGeneration: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await store.putInstallation(installation);
  return { space, source, snapshot, installConfig, installation };
}

export async function seedProviderConnections(
  store: OpenTofuDeploymentStore,
  installation: Installation,
  options: SeedProviderConnectionOptions = {},
): Promise<void> {
  const requiredProviders = options.requiredProviders ?? [
    FIXTURE_CLOUDFLARE_PROVIDER,
  ];
  if (requiredProviders.length === 0) return;
  const materialization = options.materialization ?? "secret";
  const connections = requiredProviders.map((provider) => {
    const shortName = providerShortName(provider);
    const connectionId = `conn_fixture_${sanitizeId(installation.spaceId)}_${shortName}`;
    const gatewayEnvId = `penv_fixture_gateway_${shortName}`;
    return {
      provider: shortName,
      alias: "main",
      envId: materialization === "secret" ? connectionId : gatewayEnvId,
    } as const;
  });
  for (const provider of requiredProviders) {
    const shortName = providerShortName(provider);
    const connectionId = `conn_fixture_${sanitizeId(installation.spaceId)}_${shortName}`;
    const now = "2026-06-06T00:00:00.000Z";
    if (materialization === "secret") {
      const connection: Connection = {
        id: connectionId,
        spaceId: installation.spaceId,
        scope: "space",
        provider: shortName,
        kind: providerConnectionKind(shortName),
        authMethod: "static_secret",
        status: "verified",
        envNames: providerEnvNames(provider),
        createdAt: now,
        updatedAt: now,
        verifiedAt: now,
      };
      await store.putConnection(connection);
    }
    await store.putProviderEnv({
      id:
        materialization === "secret"
          ? connectionId
          : `penv_fixture_gateway_${shortName}`,
      ...(materialization === "secret" ? { spaceId: installation.spaceId } : {}),
      providerSource: provider,
      displayName: shortName,
      materialization,
      status: "ready",
      requiredEnvNames: providerEnvNames(provider),
      ...(materialization === "secret"
        ? { secretRef: connectionId }
        : { gatewayProfileId: "cloudflare-default" }),
      createdAt: now,
      updatedAt: now,
    });
  }
  await store.putInstallationProviderEnvBindingSet({
    id: `ipcset_fixture_${sanitizeId(installation.id)}_${sanitizeId(
      installation.environment,
    )}`,
    spaceId: installation.spaceId,
    installationId: installation.id,
    environment: installation.environment,
    bindings: connections,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
}

function providerShortName(provider: string): string {
  if (provider.includes("cloudflare/cloudflare")) return "cloudflare";
  if (provider.includes("hashicorp/aws")) return "aws";
  if (provider.includes("hashicorp/google")) return "google";
  if (provider.includes("integrations/github")) return "github";
  if (provider.includes("hashicorp/kubernetes")) return "kubernetes";
  return provider.split("/").pop() ?? provider;
}

function providerEnvNames(provider: string): readonly string[] {
  if (provider.includes("cloudflare/cloudflare")) {
    return ["CLOUDFLARE_API_TOKEN"];
  }
  if (provider.includes("hashicorp/aws")) {
    return ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
  }
  if (provider.includes("hashicorp/google")) {
    return ["GOOGLE_CREDENTIALS"];
  }
  if (provider.includes("integrations/github")) return ["GITHUB_TOKEN"];
  if (provider.includes("hashicorp/kubernetes")) return ["KUBE_CONFIG_PATH"];
  return [`${providerShortName(provider).toUpperCase()}_TOKEN`];
}

function providerConnectionKind(
  shortName: string,
): Connection["kind"] {
  if (shortName === "cloudflare") return "cloudflare_api_token";
  if (shortName === "aws") return "aws_assume_role";
  if (shortName === "google" || shortName === "gcp") {
    return "gcp_service_account_impersonation";
  }
  return "generic_env_provider";
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}
