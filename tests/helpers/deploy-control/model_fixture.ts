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
import type { ProviderBindingSet } from "takosumi-contract/connections";
import type { Project } from "takosumi-contract/projects";
import type { CapsuleProviderRequirement } from "takosumi-contract/capsules";
import { normalizeProviderSourceAddress } from "takosumi-contract/provider-env-rules";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { Workspace } from "takosumi-contract/workspaces";
import {
  CredentialBundle,
  PhaseMintBundle,
} from "../../../core/adapters/vault/mod.ts";
import {
  providerBindingSetAuthorityDigest,
  type OpenTofuControlStore,
  type StoredSource,
} from "../../../core/domains/deploy-control/store.ts";
import {
  stableJsonDigest,
  stableStringify,
} from "../../../core/adapters/source/digest.ts";
import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
} from "../../../core/domains/deploy-control/mod.ts";
import {
  RUN_EXECUTION_EVIDENCE_CONTRACT,
  type RunExecutionCommit,
  type RunExecutionEvidence,
} from "takosumi-contract/runs";

/*
 * This module is test-only. ProviderBindingSet fixture changes deliberately go
 * through the same atomic initial-authority or exact rebind CAS as production;
 * tests that need a later binding set therefore also create an immutable
 * InstallConfig successor and advance the Capsule epoch.
 */
type CapsuleStore = Pick<
  OpenTofuControlStore,
  | "createInstallConfigIfAbsent"
  | "createCapsuleInitialAuthority"
  | "getCapsule"
  | "getCapsuleExecutionAuthorityEpoch"
  | "getInstallConfig"
  | "getProviderBindingSetByCapsule"
  | "rebindCapsuleInstallConfig"
>;

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
  /** Provider identities committed with the Capsule's initial authority. */
  readonly requiredProviders?: readonly string[];
}

export interface SeedProviderConnectionOptions {
  readonly requiredProviders?: readonly string[];
  readonly materialization?: "secret" | "oauth";
}

export function providerRequirementsForFixture(
  requiredProviders: readonly string[],
  options: { readonly credentialRequired?: boolean } = {},
): readonly CapsuleProviderRequirement[] {
  return requiredProviders.map((provider) => {
    const source = normalizeProviderSourceAddress(provider);
    return {
      source,
      moduleLocalName: providerShortName(source),
      allowed: true,
      ...(options.credentialRequired === false
        ? {}
        : { credentialRequired: true }),
    };
  });
}

export const FIXTURE_ARCHIVE_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FIXTURE_STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
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
  installedDigest: `sha256:${"e".repeat(64)}`,
} as const;
export const FIXTURE_AWS_MIRROR_EVIDENCE = {
  provider: FIXTURE_AWS_PROVIDER,
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/hashicorp/aws",
  installedDigest: `sha256:${"e".repeat(64)}`,
} as const;

const FIXTURE_PROVIDER_ARTIFACT_DIGEST =
  `sha256:${"e".repeat(64)}` as `sha256:${string}`;

function fixtureProviderArtifacts(
  providers: readonly string[],
): RunExecutionEvidence["authority"]["providerArtifacts"] {
  return providers
    .filter((provider) => !provider.includes("/builtin/"))
    .map((source) => ({
      source: normalizeProviderSourceAddress(source),
      digest: FIXTURE_PROVIDER_ARTIFACT_DIGEST,
      attested: true as const,
    }))
    .sort((left, right) =>
      left.source === right.source
        ? left.digest.localeCompare(right.digest)
        : left.source.localeCompare(right.source),
    );
}

/** Explicit immutable identities for test-only runner compositions. */
export const FIXTURE_EXECUTION_EVIDENCE_AUTHORITY = {
  controllerArtifact: { digest: `sha256:${"a".repeat(64)}`, immutable: true },
  runnerArtifact: { digest: `sha256:${"b".repeat(64)}`, immutable: true },
  executorArtifact: { digest: `sha256:${"c".repeat(64)}`, immutable: true },
} as const;

/** Build the exact evidence a successful fixture runner must return. */
export function fixtureExecutionEvidence(
  job: OpenTofuApplyJob | OpenTofuDestroyJob,
  action: "apply" | "destroy",
  options: {
    readonly providerArtifacts?: RunExecutionEvidence["authority"]["providerArtifacts"];
    readonly outcome?: RunExecutionEvidence["outcome"];
    readonly commit?: RunExecutionCommit;
  } = {},
): RunExecutionEvidence {
  if (!job.executionEvidenceCommit) {
    throw new Error("fixture runner job is missing execution evidence commit");
  }
  if (!job.planRun.planDigest) {
    throw new Error("fixture runner plan is missing plan digest");
  }
  return {
    format: RUN_EXECUTION_EVIDENCE_CONTRACT,
    runId: job.applyRun.id,
    planRunId: job.planRun.id,
    action,
    outcome: options.outcome ?? "committed",
    authority: {
      ...FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      runnerProfileId: job.runnerProfile.id,
      executorId: job.runnerProfile.executorId,
      providerArtifacts:
        options.providerArtifacts ??
        fixtureProviderArtifacts(job.planRun.requiredProviders),
    },
    plan: {
      digest: job.planRun.planDigest as `sha256:${string}`,
      artifactDigest: job.planArtifact.digest as `sha256:${string}`,
    },
    commit:
      options.commit ??
      (options.outcome === "provider_failed_state_persisted" &&
      "stateVersionId" in job.executionEvidenceCommit
        ? { stateVersionId: job.executionEvidenceCommit.stateVersionId }
        : job.executionEvidenceCommit),
    receipt: { operationId: job.applyRun.id, version: 1, fence: 1 },
    committedAt: "2026-06-06T00:00:00.000Z",
  };
}

/** A successful runner mutation always returns evidence of its durable state. */
export function fixtureStateCommit(): { readonly stateDigest: string };
export function fixtureStateCommit<T extends object>(
  result: T,
): T & { readonly stateDigest: string };
export function fixtureStateCommit<T extends object>(result?: T) {
  return {
    ...(result ?? {}),
    stateDigest: FIXTURE_STATE_DIGEST,
  };
}

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
    mintForCapsuleProviderBindings: (
      _workspaceId: string,
      entries: readonly { provider: string; connectionId: string }[],
    ) =>
      Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: token } },
          [],
          entries.map((entry) => ({
            provider: entry.provider,
            connectionId: entry.connectionId,
            temporary: true,
            ttlEnforced: true,
          })),
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
  const capsuleId = options.capsuleId ?? "cap_fixture";
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
    workspaceId,
    name: `${name}-config`,
    variableMapping: {},
    outputAllowlist: {
      launch_url: { from: "launch_url", type: "url" },
    },
    policy: {},
    createdAt: now,
    updatedAt: now,
    ...options.installConfig,
    workspaceId,
  };
  const capsule: Capsule = {
    id: capsuleId,
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
  const providerBindingSet: ProviderBindingSet = {
    id: `ipcset_fixture_${sanitizeId(capsule.id)}_${sanitizeId(environment)}`,
    workspaceId,
    capsuleId: capsule.id,
    environment,
    bindings: providerBindingsForFixture(
      capsule,
      options.requiredProviders ?? [],
    ),
    createdAt: now,
    updatedAt: now,
  };
  const initial = await store.createCapsuleInitialAuthority({
    installConfig,
    capsule,
    providerBindingSet,
  });
  if (initial.status === "conflict") {
    throw new Error(`fixture initial authority conflicted for ${capsule.id}`);
  }
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
  const bindings = providerBindingsForFixture(capsule, requiredProviders);
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
  await transitionProviderBindingSetForFixture(store, {
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

function providerBindingsForFixture(
  capsule: Pick<Capsule, "workspaceId">,
  requiredProviders: readonly string[],
): ProviderBindingSet["bindings"] {
  return requiredProviders.map((provider) => {
    const shortName = providerShortName(provider);
    return {
      provider,
      moduleLocalName: shortName,
      rootAlias: "main",
      connectionId: `conn_fixture_${sanitizeId(capsule.workspaceId)}_${shortName}`,
    } as const;
  });
}

/**
 * Test-only binding transition through the real immutable-successor CAS. This
 * intentionally cannot alter a binding set behind an existing Plan's back.
 */
export async function transitionProviderBindingSetForFixture(
  store: CapsuleStore,
  target: ProviderBindingSet,
): Promise<Capsule> {
  const capsule = await store.getCapsule(target.capsuleId);
  if (
    !capsule ||
    capsule.workspaceId !== target.workspaceId ||
    capsule.environment !== target.environment
  ) {
    throw new Error("fixture ProviderBindingSet does not target one exact Capsule");
  }
  const currentBindingSet = await store.getProviderBindingSetByCapsule(
    capsule.id,
    capsule.environment,
  );
  if (stableStringify(currentBindingSet) === stableStringify(target)) {
    return capsule;
  }
  const currentConfig = await store.getInstallConfig(capsule.installConfigId);
  const executionAuthorityEpoch =
    await store.getCapsuleExecutionAuthorityEpoch(capsule.id);
  if (!currentConfig || executionAuthorityEpoch === undefined) {
    throw new Error("fixture Capsule deployment authority is incomplete");
  }
  const successorDigest = await stableJsonDigest({
    previousInstallConfigId: currentConfig.id,
    providerBindingSet: target,
  });
  const successor: InstallConfig = {
    ...currentConfig,
    id: `icfg_fixture_${successorDigest.replace(/^sha256:/u, "").slice(0, 24)}`,
    workspaceId: capsule.workspaceId,
    createdAt: target.updatedAt,
    updatedAt: target.updatedAt,
  };
  const created = await store.createInstallConfigIfAbsent(successor);
  if (!created) {
    const existing = await store.getInstallConfig(successor.id);
    if (stableStringify(existing) !== stableStringify(successor)) {
      throw new Error("fixture InstallConfig successor identity conflicted");
    }
  }
  const result = await store.rebindCapsuleInstallConfig({
    capsuleId: capsule.id,
    targetInstallConfigId: successor.id,
    providerBindingSetReplacement: {
      expectedCurrentAuthorityDigest: await providerBindingSetAuthorityDigest(
        currentBindingSet,
      ),
      target,
      targetDigest: await stableJsonDigest(target),
    },
    expected: {
      installConfigId: currentConfig.id,
      installConfigDigest: await stableJsonDigest(currentConfig),
      targetInstallConfigDigest: await stableJsonDigest(successor),
      currentStateGeneration: capsule.currentStateGeneration,
      currentStateVersionId: capsule.currentStateVersionId,
      status: capsule.status,
      executionAuthorityEpoch,
    },
    updatedAt: target.updatedAt,
  });
  if (result.status !== "updated" && result.status !== "replayed") {
    throw new Error(`fixture ProviderBindingSet rebind failed: ${result.status}`);
  }
  return result.capsule;
}

/**
 * Test-only InstallConfig transition through the immutable-successor CAS. It is
 * intentionally distinct from template fixture creation: once a Capsule owns
 * a config, even test setup must advance that Capsule's authority epoch.
 */
export async function transitionInstallConfigForFixture(
  store: CapsuleStore,
  capsuleId: string,
  patch: Partial<InstallConfig>,
  updatedAt = "2026-06-06T00:00:00.000Z",
): Promise<{ readonly capsule: Capsule; readonly installConfig: InstallConfig }> {
  if (patch.id !== undefined || patch.workspaceId !== undefined) {
    throw new Error("fixture InstallConfig patch cannot replace authority identity");
  }
  const capsule = await store.getCapsule(capsuleId);
  if (!capsule) throw new Error(`fixture Capsule ${capsuleId} does not exist`);
  const currentConfig = await store.getInstallConfig(capsule.installConfigId);
  const executionAuthorityEpoch =
    await store.getCapsuleExecutionAuthorityEpoch(capsule.id);
  if (!currentConfig || executionAuthorityEpoch === undefined) {
    throw new Error("fixture Capsule deployment authority is incomplete");
  }
  const successorDigest = await stableJsonDigest({
    previousInstallConfigId: currentConfig.id,
    patch,
  });
  const successor: InstallConfig = {
    ...currentConfig,
    ...patch,
    id: `icfg_fixture_${successorDigest.replace(/^sha256:/u, "").slice(0, 24)}`,
    workspaceId: capsule.workspaceId,
    createdAt: updatedAt,
    updatedAt,
  };
  const created = await store.createInstallConfigIfAbsent(successor);
  if (!created) {
    const existing = await store.getInstallConfig(successor.id);
    if (stableStringify(existing) !== stableStringify(successor)) {
      throw new Error("fixture InstallConfig successor identity conflicted");
    }
  }
  const result = await store.rebindCapsuleInstallConfig({
    capsuleId: capsule.id,
    targetInstallConfigId: successor.id,
    expected: {
      installConfigId: currentConfig.id,
      installConfigDigest: await stableJsonDigest(currentConfig),
      targetInstallConfigDigest: await stableJsonDigest(successor),
      currentStateGeneration: capsule.currentStateGeneration,
      currentStateVersionId: capsule.currentStateVersionId,
      status: capsule.status,
      executionAuthorityEpoch,
    },
    updatedAt,
  });
  if (result.status !== "updated" && result.status !== "replayed") {
    throw new Error(`fixture InstallConfig rebind failed: ${result.status}`);
  }
  return { capsule: result.capsule, installConfig: successor };
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
