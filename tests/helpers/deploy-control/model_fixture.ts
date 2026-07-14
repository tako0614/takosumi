/**
 * Shared test fixture for the Workspace / Project / Capsule model (core-spec
 * §4 / §5 / §11). Seeds the minimal ledger rows a Capsule Run needs:
 * Workspace -> Project -> Source -> SourceSnapshot -> InstallConfig -> Capsule.
 *
 * Tests that previously planned directly from a source module now create the
 * Capsule first and call `controller.createCapsulePlan(capsuleId)`.
 */
import type {
  Capsule,
  InstallConfig,
  ProviderConnection,
} from "@takosumi/internal/deploy-control-api";
import type { Project } from "takosumi-contract/projects";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { Workspace } from "takosumi-contract/workspaces";
import {
  CredentialBundle,
  PhaseMintBundle,
} from "../../../core/adapters/vault/mod.ts";
import type {
  OpenTofuControlStore,
  StoredSource,
} from "../../../core/domains/deploy-control/store.ts";

export interface SeededCapsuleModel {
  readonly workspace: Workspace;
  readonly project: Project;
  readonly source: StoredSource;
  readonly snapshot: SourceSnapshot;
  readonly installConfig: InstallConfig;
  readonly capsule: Capsule;
}

export interface SeedCapsuleModelOptions {
  readonly workspaceId?: string;
  readonly sourceId?: string;
  readonly snapshotId?: string;
  readonly installConfigId?: string;
  readonly capsuleId?: string;
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
  readonly materialization?: "secret" | "oauth";
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
    connectionId,
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
    mintForCapsuleProviderBindings: () =>
      Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: token } },
          [],
          [sharedEvidence],
        ),
      ),
  };
}

/** Seeds Workspace + Project + Source + Snapshot + InstallConfig + Capsule. */
export async function seedCapsuleModel(
  store: OpenTofuControlStore,
  options: SeedCapsuleModelOptions = {},
): Promise<SeededCapsuleModel> {
  const now = "2026-06-06T00:00:00.000Z";
  const workspaceId = options.workspaceId ?? "workspace_test";
  const sourceId = options.sourceId ?? "src_fixture";
  const environment = options.environment ?? "production";
  const name = options.name ?? "app";
  const workspace: Workspace = {
    id: workspaceId,
    handle: workspaceId.replace(/_/g, "-"),
    displayName: "Test Workspace",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: now,
    updatedAt: now,
  };
  await store.putWorkspace(workspace);
  const project: Project = {
    id: `prj_default_${workspaceId}`,
    workspaceId,
    name: "Default",
    slug: "default",
    createdAt: now,
    updatedAt: now,
  };
  await store.putProject(project);
  const source: StoredSource = {
    id: sourceId,
    workspaceId,
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
    workspaceId,
    sourceId,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: "abcdef0123456789abcdef0123456789abcdef01",
    path: ".",
    archiveRef: `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snap_fixture/source.tar.zst`,
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
  const capsule: Capsule = {
    id: options.capsuleId ?? "cap_fixture",
    workspaceId,
    projectId: project.id,
    name,
    slug: name,
    sourceId,
    installConfigId: installConfig.id,
    environment,
    currentStateGeneration: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await store.putCapsule(capsule);
  return { workspace, project, source, snapshot, installConfig, capsule };
}

export async function seedProviderConnections(
  store: OpenTofuControlStore,
  capsule: Capsule,
  options: SeedProviderConnectionOptions = {},
): Promise<void> {
  const requiredProviders = options.requiredProviders ?? [
    FIXTURE_CLOUDFLARE_PROVIDER,
  ];
  if (requiredProviders.length === 0) return;
  const materialization = options.materialization ?? "secret";
  const now = "2026-06-06T00:00:00.000Z";
  const bindings = requiredProviders.map((provider) => {
    const shortName = providerShortName(provider);
    return {
      provider,
      alias: "main",
      connectionId: `conn_fixture_${sanitizeId(capsule.workspaceId)}_${shortName}`,
    } as const;
  });
  for (const provider of requiredProviders) {
    const shortName = providerShortName(provider);
    const connectionId = `conn_fixture_${sanitizeId(capsule.workspaceId)}_${shortName}`;
    const connection: ProviderConnection = {
      id: connectionId,
      workspaceId: capsule.workspaceId,
      scope: "workspace",
      provider,
      providerSource: provider,
      credentialRecipe: {
        id: "generic-env",
        authMode: "env",
        secretPartition: "provider-credentials",
        declaredEnv: true,
      },
      secretPartition: "provider-credentials",
      kind: providerConnectionKind(shortName),
      status: "verified",
      materialization,
      envNames: providerEnvNames(provider),
      createdAt: now,
      updatedAt: now,
      verifiedAt: now,
    };
    await store.putConnection(connection);
  }
  await store.putProviderBindingSet({
    id: `ipcset_fixture_${sanitizeId(capsule.id)}_${sanitizeId(
      capsule.environment,
    )}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    bindings,
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
    return ["GOOGLE_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"];
  }
  if (provider.includes("integrations/github")) return ["GITHUB_TOKEN"];
  if (provider.includes("hashicorp/kubernetes")) return ["KUBE_CONFIG_PATH"];
  return [`${providerShortName(provider).toUpperCase()}_TOKEN`];
}

function providerConnectionKind(shortName: string): ProviderConnection["kind"] {
  if (shortName === "cloudflare") return "cloudflare_api_token";
  if (shortName === "aws") return "aws_assume_role";
  if (shortName === "google" || shortName === "gcp") {
    return "gcp_service_account_json";
  }
  return "generic_env_provider";
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}
