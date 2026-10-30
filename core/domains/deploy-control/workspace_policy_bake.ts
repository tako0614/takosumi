/**
 * Operator tool that bakes each Workspace policy into the InstallConfig
 * policies of the apps in that Workspace (TASK-0118 Phase 9, P9.1-g / 9.0-e).
 *
 * A Workspace `policy` is still a runtime ceiling over every app in the
 * Workspace. Workspace is being removed, so the ceiling has to move into each
 * app's own InstallConfig first; the TASK-0118 data policy is "the strictest
 * composition". This tool does exactly that, per app:
 *
 * - The baked policy is {@link bakeWorkspacePolicy}: the InstallConfig policy
 *   with every ceiling key replaced by the strictest merge of both layers.
 * - InstallConfig rows attached to a Capsule are immutable, so the tool writes
 *   an insert-only successor row (the current row with the baked policy and a
 *   value-free `internal.workspacePolicyBake` receipt) and moves the Capsule to
 *   it with the store's exact `rebindCapsuleInstallConfig` CAS: the current
 *   row and its digest, status, state cursor and execution-authority epoch must
 *   still be what the dry-run saw, and an active Run makes it `busy`. The
 *   epoch advance supersedes a computed, not yet applied Plan, so the next
 *   Plan is made under the baked policy.
 * - The default is a read-only dry-run. `apply` requires the digest of a
 *   reviewed dry-run and refuses when the current inventory produces a
 *   different write set.
 * - Like every InstallConfig rebind, the epoch advance makes an app's Accounts
 *   OIDC activation stale: sign-in to an app with an OIDC client returns
 *   `install_grant_stale` until its owner applies a new Plan
 *   (`oidcReactivationRequired` in the dry-run). Plan the bake with the owners.
 * - Idempotent: a baked InstallConfig already contains the ceiling, so it is
 *   reported as `alreadyBaked` and never written again; the successor id is
 *   derived from the reviewed write, so a retry after a lost acknowledgement
 *   finds the same row.
 *
 * Runtime enforcement does not depend on this tool having run: the Workspace
 * ceiling is skipped only for an InstallConfig that already contains it
 * ({@link effectiveProviderPolicy}). `unbaked` reaching 0 is the gate for
 * removing the Workspace read (stage 9.5).
 *
 * The tool runs no DDL and never edits a Workspace row.
 */

import type { Capsule, CapsuleStatus } from "takosumi-contract/capsules";
import { capsuleScopeRef } from "takosumi-contract/capsules";
import { installExperienceOidcClient } from "takosumi-contract";
import type {
  InstallConfig,
  PolicyConfig,
} from "@takosumi/internal/deploy-control-api";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import {
  bakeWorkspacePolicy,
  canonicalPolicyJson,
  malformedWorkspacePolicyKeys,
  mergePolicyConfigs,
  SCOPE_BOUNDARY_RULE_LIMIT,
  WORKSPACE_POLICY_CEILING_KEYS,
  workspacePolicyBakedInto,
  workspacePolicyCeiling,
} from "./provider_policy.ts";
import {
  type OpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
} from "./store.ts";

export const WORKSPACE_POLICY_BAKE_CONTRACT = "takosumi.workspace-policy-bake/v1";

/** The store surface the tool reads and writes (memory, Postgres or D1). */
export type WorkspacePolicyBakeStore = Pick<
  OpenTofuControlStore,
  | "listWorkspaces"
  | "getWorkspace"
  | "listCapsules"
  | "getInstallConfig"
  | "getWorkspaceManagement"
  | "getCapsuleExecutionAuthorityEpoch"
  | "createInstallConfigIfAbsent"
  | "rebindCapsuleInstallConfig"
>;

/** One reviewed per-app write. Every field is covered by the plan digest. */
export interface WorkspacePolicyBakeWrite {
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly workspacePolicyDigest: string;
  readonly installConfigId: string;
  readonly installConfigDigest: string;
  readonly bakedPolicyDigest: string;
  readonly targetInstallConfigId: string;
  readonly status: CapsuleStatus;
  readonly currentStateGeneration: number;
  readonly currentStateVersionId: string | null;
  readonly executionAuthorityEpoch: number;
  readonly managementEpoch: number;
  /**
   * Ceiling keys whose effective value becomes stricter than the runtime
   * composition enforced before the bake (only `destructiveChanges` can,
   * when the InstallConfig layer had overridden a stricter Workspace value).
   */
  readonly tightenedKeys: readonly string[];
  /**
   * The app has an Accounts OIDC client. Its activation digest binds the
   * InstallConfig row and the execution-authority epoch, so sign-in to the
   * app returns `install_grant_stale` from the rebind until the owner applies
   * a new Plan, which registers the activation again.
   */
  readonly oidcReactivationRequired: boolean;
}

export type WorkspacePolicyBakeRefusalReason =
  /** A Workspace ceiling value is malformed (see `malformedKeys`). */
  | "workspace_policy_invalid"
  /** The InstallConfig policy cannot be composed with the ceiling. */
  | "install_policy_invalid"
  | "capsule_uninstalled"
  | "install_config_missing"
  | "scope_boundary_rule_limit"
  | "workspace_management_inactive"
  | "execution_authority_missing";

export interface WorkspacePolicyBakePlan {
  readonly contract: typeof WORKSPACE_POLICY_BAKE_CONTRACT;
  /** Workspaces whose policy acts as a runtime ceiling. */
  readonly workspaces: readonly {
    readonly workspaceId: string;
    readonly workspacePolicyDigest: string;
    /**
     * Workspace policy keys that were never a runtime ceiling and are not
     * baked (for example `lifecycleActions`). Reported for review only.
     */
    readonly ignoredKeys: readonly string[];
    /**
     * Ceiling keys whose stored value is malformed (for example a `null`
     * allowlist). The policy cannot be baked; every live app in the Workspace
     * is refused and stays enforced through the old composition.
     */
    readonly malformedKeys: readonly string[];
    readonly liveCapsules: number;
  }[];
  /** Live (not destroyed) apps in those Workspaces. */
  readonly liveCapsules: number;
  /** Apps whose InstallConfig already contains their Workspace ceiling. */
  readonly alreadyBaked: number;
  readonly writes: readonly WorkspacePolicyBakeWrite[];
  /** Apps that cannot be baked now; their runtime enforcement stays. */
  readonly refused: readonly {
    readonly capsuleId: string;
    readonly workspaceId: string;
    readonly reason: WorkspacePolicyBakeRefusalReason;
  }[];
  /** `writes + refused`: apps still enforced through the Workspace. The gate is 0. */
  readonly unbaked: number;
  /** Digest of `writes`; `apply` must name it. */
  readonly digest: string;
}

export type WorkspacePolicyBakeSkipReason =
  | "busy"
  | "conflict"
  | "not_found"
  | "management_inactive"
  | "error";

export interface WorkspacePolicyBakeSkip {
  readonly capsuleId: string;
  readonly reason: WorkspacePolicyBakeSkipReason;
  /** Error class name when `reason` is `error` (never the message). */
  readonly errorName?: string;
  /**
   * A successor InstallConfig this write inserted (or found from an earlier
   * attempt) that the app was not moved to. It is unattached and inert; a
   * re-run finds and reuses it while the reviewed write is unchanged.
   */
  readonly orphanInstallConfigId?: string;
}

export interface WorkspacePolicyBakeResult {
  readonly baked: readonly string[];
  /**
   * Reviewed writes that were not applied (CAS loss, an active Run, or a store
   * error for that app). Every write is attempted; run the dry-run again.
   */
  readonly skipped: readonly WorkspacePolicyBakeSkip[];
  /** Successor ids inserted but left unattached (also listed per skip). */
  readonly orphanInstallConfigIds: readonly string[];
  /**
   * `unbaked` of a fresh dry-run after the writes, or `null` when that
   * re-plan failed (the result is still returned).
   */
  readonly remaining: number | null;
}

/** Read-only inventory. Never writes. */
export async function planWorkspacePolicyBake(
  store: WorkspacePolicyBakeStore,
): Promise<WorkspacePolicyBakePlan> {
  const workspaces = [...await store.listWorkspaces()]
    .sort((a, b) => a.id.localeCompare(b.id));
  const reportedWorkspaces: {
    workspaceId: string;
    workspacePolicyDigest: string;
    ignoredKeys: string[];
    malformedKeys: string[];
    liveCapsules: number;
  }[] = [];
  const writes: WorkspacePolicyBakeWrite[] = [];
  const refused: {
    capsuleId: string;
    workspaceId: string;
    reason: WorkspacePolicyBakeRefusalReason;
  }[] = [];
  let liveCapsules = 0;
  let alreadyBaked = 0;
  for (const workspace of workspaces) {
    const policy = workspace.policy as PolicyConfig | undefined;
    const ceiling = workspacePolicyCeiling(policy);
    if (!ceiling) continue;
    const workspacePolicyDigest = await stableJsonDigest(
      JSON.parse(canonicalPolicyJson(ceiling)),
    );
    const capsules = [...await store.listCapsules(workspace.id)]
      .filter((capsule) =>
        capsule.workspaceId === workspace.id && capsule.status !== "destroyed"
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    reportedWorkspaces.push({
      workspaceId: workspace.id,
      workspacePolicyDigest,
      ignoredKeys: Object.keys(policy ?? {})
        .filter((key) =>
          !(WORKSPACE_POLICY_CEILING_KEYS as readonly string[]).includes(key)
        )
        .sort(),
      malformedKeys: malformedWorkspacePolicyKeys(ceiling),
      liveCapsules: capsules.length,
    });
    liveCapsules += capsules.length;
    for (const capsule of capsules) {
      const outcome = await planCapsule(
        store,
        capsule,
        ceiling,
        workspacePolicyDigest,
      );
      if (outcome === "baked") alreadyBaked += 1;
      else if ("reason" in outcome) {
        refused.push({
          capsuleId: capsule.id,
          workspaceId: workspace.id,
          reason: outcome.reason,
        });
      } else writes.push(outcome);
    }
  }
  return {
    contract: WORKSPACE_POLICY_BAKE_CONTRACT,
    workspaces: reportedWorkspaces,
    liveCapsules,
    alreadyBaked,
    writes,
    refused,
    unbaked: writes.length + refused.length,
    digest: await stableJsonDigest({
      contract: WORKSPACE_POLICY_BAKE_CONTRACT,
      writes,
    }),
  };
}

/**
 * Applies a reviewed plan. The current inventory must produce the same write
 * set (`expectedDigest`), so exactly what was reviewed is written.
 */
export async function applyWorkspacePolicyBake(
  store: WorkspacePolicyBakeStore,
  expectedDigest: string,
  options: { readonly now?: () => Date } = {},
): Promise<WorkspacePolicyBakeResult> {
  const plan = await planWorkspacePolicyBake(store);
  if (plan.digest !== expectedDigest) {
    throw new Error(
      "Workspace policy bake plan changed since review; run the dry-run again",
    );
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const baked: string[] = [];
  const skipped: WorkspacePolicyBakeSkip[] = [];
  for (const write of plan.writes) {
    const progress: WriteProgress = {};
    let outcome: "baked" | Omit<WorkspacePolicyBakeSkip, "capsuleId" | "orphanInstallConfigId">;
    try {
      const status = await applyWrite(store, write, now, progress);
      outcome = status === "baked" ? status : { reason: status };
    } catch (error) {
      // One app's store failure must not hide the others or the summary.
      outcome = {
        reason: "error",
        errorName: error instanceof Error ? error.name : "unknown",
      };
    }
    if (outcome === "baked") {
      baked.push(write.capsuleId);
      continue;
    }
    skipped.push({
      capsuleId: write.capsuleId,
      ...outcome,
      ...(progress.successorId !== undefined
        ? { orphanInstallConfigId: progress.successorId }
        : {}),
    });
  }
  let remaining: number | null = null;
  try {
    remaining = (await planWorkspacePolicyBake(store)).unbaked;
  } catch {
    // Report what was applied even when the re-plan cannot read the store.
  }
  return {
    baked,
    skipped,
    orphanInstallConfigIds: skipped.flatMap((skip) =>
      skip.orphanInstallConfigId === undefined ? [] : [skip.orphanInstallConfigId]
    ),
    remaining,
  };
}

/** What a write did before it stopped, for the orphan report. */
interface WriteProgress {
  /** The successor row exists (inserted now or by an earlier attempt). */
  successorId?: string;
}

async function planCapsule(
  store: WorkspacePolicyBakeStore,
  capsule: Capsule,
  ceiling: PolicyConfig,
  workspacePolicyDigest: string,
): Promise<
  | "baked"
  | WorkspacePolicyBakeWrite
  | { readonly reason: WorkspacePolicyBakeRefusalReason }
> {
  const installConfig = await store.getInstallConfig(capsule.installConfigId);
  if (!installConfig) return { reason: "install_config_missing" };
  // A malformed ceiling is never read as "no limit": refuse, and the runtime
  // keeps the old composition for this app (fail closed).
  if (malformedWorkspacePolicyKeys(ceiling).length > 0) {
    return { reason: "workspace_policy_invalid" };
  }
  let bakedPolicy: PolicyConfig;
  try {
    if (workspacePolicyBakedInto(ceiling, installConfig.policy)) return "baked";
    bakedPolicy = bakeWorkspacePolicy(ceiling, installConfig.policy)!;
  } catch {
    return { reason: "install_policy_invalid" };
  }
  // The uninstall grace period keeps its teardown pinned to the current
  // execution authority; it stays enforced through the Workspace until the
  // finalizer destroys it or the uninstall is cancelled.
  if (capsule.status === "uninstalled") return { reason: "capsule_uninstalled" };
  if ((bakedPolicy.scopeBoundary?.rules.length ?? 0) > SCOPE_BOUNDARY_RULE_LIMIT) {
    return { reason: "scope_boundary_rule_limit" };
  }
  const management = await store.getWorkspaceManagement(capsule.workspaceId);
  if (
    management?.workspaceId !== capsule.workspaceId ||
    management.managementState !== "active"
  ) {
    return { reason: "workspace_management_inactive" };
  }
  const executionAuthorityEpoch = await store.getCapsuleExecutionAuthorityEpoch(
    capsule.id,
  );
  if (executionAuthorityEpoch === undefined) {
    return { reason: "execution_authority_missing" };
  }
  const installConfigDigest = await stableJsonDigest(installConfig);
  const bakedPolicyDigest = await stableJsonDigest(
    JSON.parse(canonicalPolicyJson(bakedPolicy)),
  );
  return {
    capsuleId: capsule.id,
    workspaceId: capsule.workspaceId,
    workspacePolicyDigest,
    installConfigId: installConfig.id,
    installConfigDigest,
    bakedPolicyDigest,
    targetInstallConfigId: await bakeTargetInstallConfigId({
      scopeRef: capsuleScopeRef(capsule),
      capsuleId: capsule.id,
      installConfigId: installConfig.id,
      installConfigDigest,
      bakedPolicyDigest,
    }),
    status: capsule.status,
    currentStateGeneration: capsule.currentStateGeneration,
    currentStateVersionId: capsule.currentStateVersionId ?? null,
    executionAuthorityEpoch,
    managementEpoch: management.managementEpoch,
    tightenedKeys: tightenedKeys(ceiling, installConfig.policy, bakedPolicy),
    oidcReactivationRequired:
      installExperienceOidcClient(installConfig.installExperience) !== undefined,
  };
}

async function applyWrite(
  store: WorkspacePolicyBakeStore,
  write: WorkspacePolicyBakeWrite,
  now: string,
  progress: WriteProgress,
): Promise<"baked" | Exclude<WorkspacePolicyBakeSkipReason, "error">> {
  const current = await store.getInstallConfig(write.installConfigId);
  if (!current || await stableJsonDigest(current) !== write.installConfigDigest) {
    return "conflict";
  }
  // Re-derive from the rows as they are now: a Workspace policy or row that
  // changed after the reviewed dry-run is a conflict, never a silent rewrite.
  const ceiling = workspacePolicyCeiling(
    (await store.getWorkspace(write.workspaceId))?.policy as
      | PolicyConfig
      | undefined,
  );
  const bakedPolicy = ceiling
    ? bakeWorkspacePolicy(ceiling, current.policy)
    : undefined;
  if (
    !ceiling || !bakedPolicy ||
    await stableJsonDigest(JSON.parse(canonicalPolicyJson(ceiling))) !==
      write.workspacePolicyDigest ||
    await stableJsonDigest(JSON.parse(canonicalPolicyJson(bakedPolicy))) !==
      write.bakedPolicyDigest
  ) {
    return "conflict";
  }
  const successor = bakeSuccessor(current, write, bakedPolicy, now);
  const authority = {
    workspaceId: write.workspaceId,
    managementState: "active" as const,
    managementEpoch: write.managementEpoch,
  };
  try {
    const created = await store.createInstallConfigIfAbsent(successor, authority);
    const target = await store.getInstallConfig(successor.id);
    if (!target || !sameSuccessor(target, successor)) {
      if (created) progress.successorId = successor.id;
      return "conflict";
    }
    progress.successorId = successor.id;
    const result = await store.rebindCapsuleInstallConfig({
      capsuleId: write.capsuleId,
      targetInstallConfigId: target.id,
      expectedWorkspaceManagementAuthority: authority,
      expected: {
        installConfigId: write.installConfigId,
        installConfigDigest: write.installConfigDigest,
        targetInstallConfigDigest: await stableJsonDigest(target),
        currentStateGeneration: write.currentStateGeneration,
        currentStateVersionId: write.currentStateVersionId ?? undefined,
        status: write.status,
        executionAuthorityEpoch: write.executionAuthorityEpoch,
      },
      updatedAt: now,
    });
    if (result.status === "updated" || result.status === "replayed") {
      delete progress.successorId;
      return "baked";
    }
    return result.status;
  } catch (error) {
    if (error instanceof WorkspaceManagementAdmissionConflictError) {
      return "management_inactive";
    }
    throw error;
  }
}

/**
 * The successor row: the current row with the baked policy and a value-free
 * receipt. A previous re-adoption or configuration receipt describes how the
 * current row was derived, not this one, so it is not carried forward (as the
 * configuration-plan successor does).
 */
function bakeSuccessor(
  current: InstallConfig,
  write: WorkspacePolicyBakeWrite,
  bakedPolicy: PolicyConfig,
  now: string,
): InstallConfig {
  const { reAdoption: _reAdoption, ...preservedInternal } = current.internal ??
    { reason: "per_install_overrides" as const };
  return {
    ...current,
    id: write.targetInstallConfigId,
    workspaceId: write.workspaceId,
    policy: bakedPolicy,
    internal: {
      ...preservedInternal,
      reason: "per_install_overrides",
      workspacePolicyBake: {
        workspaceId: write.workspaceId,
        workspacePolicyDigest: write.workspacePolicyDigest,
        previousInstallConfigId: write.installConfigId,
        previousInstallConfigDigest: write.installConfigDigest,
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** Equal apart from the write timestamps (a retry finds an earlier successor). */
function sameSuccessor(actual: InstallConfig, expected: InstallConfig): boolean {
  const comparable = (config: InstallConfig) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = config;
    return canonicalPolicyJson(rest as unknown as PolicyConfig);
  };
  return comparable(actual) === comparable(expected);
}

function tightenedKeys(
  ceiling: PolicyConfig,
  installPolicy: PolicyConfig | undefined,
  bakedPolicy: PolicyConfig,
): string[] {
  const before = mergePolicyConfigs(ceiling, installPolicy) ?? {};
  const after = mergePolicyConfigs(undefined, bakedPolicy) ?? {};
  return WORKSPACE_POLICY_CEILING_KEYS.filter((key) => {
    if (key === "scopeBoundary") return false; // duplicate rules only
    return canonicalPolicyJson({ [key]: before[key] } as PolicyConfig) !==
      canonicalPolicyJson({ [key]: after[key] } as PolicyConfig);
  });
}

/**
 * Deterministic id of the bake successor for one reviewed write. The scope
 * slot holds the Capsule's frozen `scopeRef` under the historical
 * `workspaceId` key, like the other successor ids.
 */
export async function bakeTargetInstallConfigId(input: {
  readonly scopeRef: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly installConfigDigest: string;
  readonly bakedPolicyDigest: string;
}): Promise<string> {
  const digest = await stableJsonDigest({
    kind: "workspace_policy_bake_v1",
    workspaceId: input.scopeRef,
    capsuleId: input.capsuleId,
    installConfigId: input.installConfigId,
    installConfigDigest: input.installConfigDigest,
    bakedPolicyDigest: input.bakedPolicyDigest,
  });
  return `icfg_${digest.replace(/^sha256:/u, "").slice(0, 16)}`;
}
