// Deploy domain service — canonical Deployment-centric API.

import { objectAddress } from "takosumi-contract";
import type {
  Deployment,
  DeploymentApproval,
  DeploymentBinding,
  DeploymentCondition,
  DeploymentDesired,
  DeploymentInput,
  DeploymentMode,
  DeploymentResolution,
  DeploymentResourceClaim,
  DeploymentRoute,
  DeploymentRuntimeNetworkPolicy,
  DeploymentStatus,
  GroupHead,
  IsoTimestamp,
  JsonObject,
  ProviderObservation,
} from "takosumi-contract";
import {
  activationCommittedCondition,
  applyFailedCondition,
  applyingPhaseCondition,
  applyRolledBackCondition,
  type DeploymentProviderAdapter,
  operationCondition,
  type OperationOutcome,
  operationRolledBackCondition,
  type PlannedOperation,
  planProviderOperations,
  rolledBackCondition,
  SYNTHETIC_PROVIDER_ADAPTER,
} from "./apply_orchestrator.ts";
import { resolveBindings, validateAccessPaths } from "./binding_resolver.ts";
import { compileManifestToAppSpec } from "./compiler.ts";
import { buildDescriptorClosure } from "./descriptor_closure.ts";
import {
  type GroupHeadHistoryEntry,
  type GroupHeadHistoryStore,
  InMemoryGroupHeadHistoryStore,
  resolveRollbackTarget,
} from "./group_head_history.ts";
import { buildResolvedGraph } from "./resolved_graph.ts";
import type {
  AppSpec,
  AppSpecResource,
  AppSpecRoute,
  DeployBlocker,
  PublicComponentBindingSpec,
  PublicDeployManifest,
} from "./types.ts";
import type { DeploymentPolicyDecision } from "takosumi-contract";

// ---------------------------------------------------------------------------
// Public service surface
// ---------------------------------------------------------------------------

/** Filter for `listDeployments`. All fields optional (AND-combined). */
export interface DeploymentFilter {
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly status?: DeploymentStatus | readonly DeploymentStatus[];
  readonly limit?: number;
}

/** Input to `resolveDeployment` — preview/resolve only, no provider effects.
 *
 *  H1 — `mode` controls store persistence. Default `"resolve"` writes the
 *  Deployment record so dashboards / list endpoints can inspect it. Setting
 *  `"preview"` skips the write so dry-runs do not pollute the audit / list
 *  surface. Independent of `mode` no provider operation ever fires; this
 *  toggle is purely a persistence boundary.
 */
export interface ResolveDeploymentInput {
  readonly spaceId: string;
  readonly manifest: PublicDeployManifest;
  readonly env?: string;
  readonly envName?: string;
  readonly input?: DeploymentInput;
  readonly id?: string;
  readonly createdAt?: IsoTimestamp;
  readonly blockers?: readonly DeployBlocker[];
  readonly mode?: DeploymentMode;
}

/**
 * H1 — Result of `resolveDeploymentWithMode`. `persisted=false` means the
 * Deployment was returned without being written to the store (preview mode).
 * `persisted=true` means the Deployment was written and `deployment` is the
 * canonical persisted record.
 */
export interface ResolveDeploymentResult {
  readonly deployment: Deployment;
  readonly persisted: boolean;
}

/**
 * Result of a preflight validator hook. When `ok` is false the apply path
 * aborts before touching the Deployment status (no `applying` transition is
 * recorded so downstream observers see the stale read-set / drift on the
 * resolved record).
 */
export interface ApplyPreflightFinding {
  readonly ok: boolean;
  readonly reason?: string;
  readonly message?: string;
  readonly impact?: "must-replan" | "must-revalidate" | "warning-only";
}

/** Hook called by `applyDeployment` for read-set / drift / source-snapshot
 *  re-validation immediately before the apply transition. Implementations are
 *  injected by the caller (e.g. apply_worker, rollout) and receive the
 *  resolved Deployment. Returning `ok=false` aborts apply with an error whose
 *  message contains the validator-supplied reason. */
export type ApplyPreflightValidator = (
  deployment: Deployment,
) => ApplyPreflightFinding | Promise<ApplyPreflightFinding>;

/** Input to `applyDeployment` — promotes a resolved Deployment to applied. */
export interface ApplyDeploymentInput {
  readonly deploymentId: string;
  readonly appliedAt?: IsoTimestamp;
  readonly approval?: DeploymentApproval;
  /**
   * Optimistic-lock expected current Deployment id. When set, the GroupHead
   * advance step rejects with a stale-precondition error if the current head
   * does not match. `null` means "no current Deployment expected" (first
   * apply for a group).
   */
  readonly expectedCurrentDeploymentId?: string | null;
  /**
   * Read-set re-validation hook. Phase 17D extension: invoked just before the
   * `resolved → applying` transition. Returning `ok=false` aborts apply
   * without mutating any committed state. Use for must-replan signals
   * surfaced by the live provider plugin contract.
   */
  readonly readSetValidator?: ApplyPreflightValidator;
  /**
   * Descriptor closure drift detection hook. Phase 17D extension: invoked
   * just before the apply transition. Compares the closure pinned at resolve
   * time with provider-observed descriptor digests. Returning `ok=false`
   * aborts apply.
   */
  readonly descriptorClosureValidator?: ApplyPreflightValidator;
  /**
   * Source-snapshot validation hook (Core spec § 13 step 4). Verifies the
   * artifact integrity / signature pinned by `Deployment.input.source_ref`
   * before activation.commit. Returning `ok=false` aborts apply.
   */
  readonly sourceSnapshotValidator?: ApplyPreflightValidator;
}

/** Input to `rollbackGroup` — picks a prior Deployment as the new head.
 *
 *  Phase 18.3 / M6 — multi-generation rollback. Callers may pin the rollback
 *  target either by Deployment id (`targetDeploymentId`) or by the number of
 *  rollovers to skip backward (`steps`, where `steps=1` matches the
 *  pre-M6 single-generation behaviour: roll back to the immediately
 *  previous head). Supplying both is allowed and treated as a defensive
 *  cross-check — they MUST resolve to the same retained history entry, and
 *  an error is raised otherwise. Supplying neither is rejected: the caller
 *  did not actually request a rollback.
 */
export interface RollbackGroupInput {
  readonly spaceId: string;
  readonly groupId: string;
  /** Explicit target Deployment id. The Deployment must appear in the
   *  retained group_head_history; otherwise the rollback is refused. */
  readonly targetDeploymentId?: string;
  /** Number of rollovers to walk backward, skipping the current head.
   *  `1` ≡ the immediately previous head; `2` ≡ two generations back; …
   *  Errors when the history does not retain that many generations. */
  readonly steps?: number;
  readonly advancedAt?: IsoTimestamp;
  readonly reason?: string;
  /**
   * Retained-closure drift detection hook (Phase 17D). The retained
   * descriptor graph digests of the rollback target are compared with the
   * provider-observed descriptors. Returning `ok=false` blocks the rollback.
   */
  readonly descriptorClosureValidator?: ApplyPreflightValidator;
  /**
   * Retained Core artifact availability hook (Phase 17D). Verifies the
   * provider can still source the runtime/resource artifacts referenced by
   * the rollback target. Returning `ok=false` blocks the rollback.
   */
  readonly artifactAvailabilityValidator?: ApplyPreflightValidator;
  /**
   * Retained artifact digest pinning hook (Phase 17D). Verifies the digest of
   * each retained artifact has not changed under the same identity since the
   * rollback target was applied. Returning `ok=false` blocks the rollback.
   */
  readonly artifactDigestValidator?: ApplyPreflightValidator;
}

/**
 * H2 — Bundle of preflight validators used during rollback. Required so the
 * store always supplies a baseline implementation; callers that wish to
 * override SHOULD spread the defaults (`{ ...store.getDefaultRollbackValidators(), ... }`).
 */
export interface RollbackValidators {
  readonly descriptorClosureValidator: ApplyPreflightValidator;
  readonly artifactAvailabilityValidator: ApplyPreflightValidator;
  readonly artifactDigestValidator: ApplyPreflightValidator;
}

/** Persistence port for Deployment, ProviderObservation, GroupHead. */
export interface DeploymentStore {
  getDeployment(id: string): Promise<Deployment | undefined>;
  putDeployment(deployment: Deployment): Promise<Deployment>;
  listDeployments(filter: DeploymentFilter): Promise<readonly Deployment[]>;
  getGroupHead(input: GroupHeadRef): Promise<GroupHead | undefined>;
  advanceGroupHead(input: AdvanceGroupHeadInput): Promise<GroupHead>;
  commitAppliedDeployment?(
    input: CommitAppliedDeploymentInput,
  ): Promise<CommitAppliedDeploymentResult>;
  recordObservation?(
    observation: ProviderObservation,
  ): Promise<ProviderObservation>;
  listObservations?(
    filter: ProviderObservationFilter,
  ): Promise<readonly ProviderObservation[]>;
  /**
   * H2 — Provide a default bundle of rollback preflight validators. Callers
   * that do not inject custom validators on `RollbackGroupInput` will get
   * these so retained-closure / artifact pinning is never silently skipped.
   * Default implementations MUST be safe (e.g. always return `{ ok: true }`
   * with a stamped reason `RollbackPreflightDefault`); store implementations
   * that have access to a live registry / provider snapshot SHOULD override
   * with stronger checks.
   */
  getDefaultRollbackValidators?(): RollbackValidators;
  /**
   * Phase 18.3 / M6 — Persistent multi-generation GroupHead history. When
   * present, `DeploymentService.rollbackGroup` consults the history to
   * resolve `--target=<deployment_id>` or `--steps=<n>` requests against
   * any retained generation, not just the single
   * `group_heads.previous_deployment_id` slot. Stores SHOULD wrap every
   * `advanceGroupHead` / `commitAppliedDeployment` mutation so the GroupHead
   * write and the history append happen in one transaction.
   *
   * Stores that omit this method can only validate an explicitly supplied
   * rollback target; multi-step rollback requires retained history.
   */
  getGroupHeadHistory?(): GroupHeadHistoryStore;
}

/**
 * H2 — Default rollback validators used when neither the store nor the
 * caller supplies one. These are intentionally permissive (always-ok with a
 * stamped reason) so the rollback path never blocks on a missing validator,
 * but are still distinguishable from "validator did not run" via the reason
 * string. Stores with access to richer state SHOULD override.
 */
export const DEFAULT_ROLLBACK_VALIDATORS: RollbackValidators = {
  descriptorClosureValidator: () => ({
    ok: true,
    reason: "RollbackPreflightDefault",
    message: "default descriptor-closure validator: no live snapshot available",
  }),
  artifactAvailabilityValidator: () => ({
    ok: true,
    reason: "RollbackPreflightDefault",
    message:
      "default artifact-availability validator: no live registry probe configured",
  }),
  artifactDigestValidator: () => ({
    ok: true,
    reason: "RollbackPreflightDefault",
    message:
      "default artifact-digest validator: no live registry probe configured",
  }),
};

export interface AdvanceGroupHeadInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly currentDeploymentId: string;
  readonly advancedAt?: IsoTimestamp;
  readonly expectedCurrentDeploymentId?: string;
  readonly expectedGeneration?: number;
}

export interface GroupHeadRef {
  readonly spaceId: string;
  readonly groupId: string;
}

export interface CommitAppliedDeploymentInput extends AdvanceGroupHeadInput {
  readonly deployment: Deployment;
}

export interface CommitAppliedDeploymentResult {
  readonly deployment: Deployment;
  readonly head: GroupHead;
}

export interface ProviderObservationFilter {
  readonly deploymentId?: string;
  readonly providerId?: string;
  readonly limit?: number;
}

export interface DeploymentServiceOptions {
  readonly store: DeploymentStore;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  /**
   * Provider adapter used by `applyDeployment` to materialize the planned
   * provider operations. Optional — when omitted the synthetic adapter is
   * used so unit tests / in-memory bootstraps can transition resolved →
   * applied without a real cloud round-trip.
   */
  readonly providerAdapter?: DeploymentProviderAdapter;
}

/**
 * Deployment-centric service. Canonical entry point for deploy domain
 * operations.
 */
export class DeploymentService {
  readonly #store: DeploymentStore;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #providerAdapter: DeploymentProviderAdapter;

  constructor(options: DeploymentServiceOptions) {
    this.#store = options.store;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#clock = options.clock ?? (() => new Date());
    this.#providerAdapter = options.providerAdapter ??
      SYNTHETIC_PROVIDER_ADAPTER;
  }

  /**
   * Resolve a Deployment from a public manifest. Produces a Deployment in
   * status `resolved` (preview/preflight). Performs descriptor closure
   * resolution, graph projection, binding resolution, and policy gate
   * evaluation — none of which mutate provider state.
   */
  async resolveDeployment(
    input: ResolveDeploymentInput,
  ): Promise<Deployment> {
    const result = await this.resolveDeploymentWithMode(input);
    return result.deployment;
  }

  /**
   * H1 — Resolve a Deployment and return both the record and a `persisted`
   * flag indicating whether it was written to the store. When
   * `input.mode === "preview"` the store is NOT touched: the in-memory
   * Deployment record is built (descriptor closure, resolved graph, bindings,
   * policy decisions) and returned with `persisted=false` so dashboards /
   * dry-run UIs can inspect the resolution outcome without polluting the
   * persisted Deployment list.
   *
   * Default mode is `"resolve"` so callers persist Deployment records unless
   * they explicitly request preview.
   */
  async resolveDeploymentWithMode(
    input: ResolveDeploymentInput,
  ): Promise<ResolveDeploymentResult> {
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const id = input.id ?? this.#idFactory();
    const deploymentInput: DeploymentInput = input.input ?? {
      manifest_snapshot: stableHash(input.manifest),
      source_kind: "inline",
      env: input.env,
      group: input.manifest.name,
    };
    const artifacts = buildDeploymentArtifacts({
      manifest: input.manifest,
      createdAt,
      env: input.env,
      envName: input.envName,
      input: deploymentInput,
    });
    const denied = artifacts.policyDecisions.some(
      (decision) => decision.decision === "deny",
    );
    const baseConditions = blockersToConditions(
      input.blockers ?? [],
      createdAt,
    );
    const status: DeploymentStatus = denied ? "failed" : "resolved";
    const conditions = denied
      ? [
        ...baseConditions,
        accessPathDeniedCondition(
          createdAt,
          baseConditions.length + 1,
          artifacts.policyDecisions,
        ),
      ]
      : baseConditions;
    const deployment: Deployment = {
      id,
      group_id: artifacts.groupId,
      space_id: input.spaceId,
      input: deploymentInput,
      resolution: artifacts.resolution,
      desired: artifacts.desired,
      status,
      conditions,
      policy_decisions: artifacts.policyDecisions,
      approval: null,
      rollback_target: null,
      created_at: createdAt,
      applied_at: null,
      finalized_at: null,
    };
    // H1 — `mode === "preview"` skips the store write. The in-memory record
    // is still deep-frozen so callers cannot mutate it accidentally.
    if (input.mode === "preview") {
      return {
        deployment: deepFreeze(deployment),
        persisted: false,
      };
    }
    const stored = await this.#store.putDeployment(deepFreeze(deployment));
    return {
      deployment: stored,
      persisted: true,
    };
  }

  /**
   * Promote a resolved Deployment to `applied` by sequencing provider
   * operations against `Deployment.desired`, recording per-operation
   * conditions, and advancing the `GroupHead` once every required operation
   * has reported success.
   *
   * Phase 10D semantics (Core spec § 13):
   *   1. Status `resolved` → `applying` (transition emits a phase condition).
   *   2. Plan provider operations from `resolution.resolved_graph` projections
   *      via `planProviderOperations`. Each operation is dispatched to the
   *      configured `DeploymentProviderAdapter` in canonical kind order.
   *   3. Each operation outcome is folded into `Deployment.conditions[]` with
   *      `scope.kind="operation"`. On any failure the Deployment terminates in
   *      `failed`; `GroupHead` is NOT advanced and `Deployment.desired` stays
   *      immutable (provider failures never mutate desired — repair / rollback
   *      creates a new Deployment).
   *   4. On full success the GroupHead is advanced (the canonical activation
   *      commit per § 15) and `ActivationCommitted` is recorded on
   *      `Deployment.conditions[]`.
   *
   * Stale-precondition rejection: any non-`resolved` source Deployment is
   * rejected. Worker-level retry handles the truly idempotent case by
   * resolving a fresh Deployment for `failed` / `applied` lineage; the
   * canonical Deployment record is immutable once it leaves `resolved`.
   */
  async applyDeployment(input: ApplyDeploymentInput): Promise<Deployment> {
    const current = await this.#store.getDeployment(input.deploymentId);
    if (!current) {
      throw new Error(`unknown deployment: ${input.deploymentId}`);
    }
    if (current.status !== "resolved" && current.status !== "applying") {
      // Finalized applies are rejected so callers (apply_worker, smoke tests)
      // see a clear stale-precondition error instead of silently re-running
      // provider operations. A prior crash may leave the record in `applying`;
      // that state is resumed below with the same operation keys.
      throw new Error(
        `deployment ${current.id} is not in 'resolved' status (got '${current.status}')`,
      );
    }

    const appliedAt = input.appliedAt ?? this.#clock().toISOString();

    // H4 — Approval gate. When the resolution carried at least one
    // `require-approval` policy decision, apply MUST receive an `approval`
    // payload (either via `input.approval` or already attached to the
    // resolved Deployment by `approveDeployment`). Missing approval finalises
    // the Deployment as `failed` with an `ApprovalRequired` condition rather
    // than letting the apply silently advance to provider materialisation.
    const requireApproval = (current.policy_decisions ?? []).some(
      (decision) => decision.decision === "require-approval",
    );
    const effectiveApproval = input.approval ?? current.approval ?? null;
    if (effectiveApproval) {
      validateDeploymentApproval(current, effectiveApproval, appliedAt);
    }
    if (requireApproval && !effectiveApproval) {
      const failedConditions = appendCondition(
        current.conditions,
        approvalRequiredCondition({
          observedGeneration: current.conditions.length + 1,
          observedAt: appliedAt,
          decisions: current.policy_decisions ?? [],
        }),
      );
      const failed: Deployment = {
        ...current,
        status: "failed",
        conditions: failedConditions,
        finalized_at: appliedAt,
      };
      return await this.#store.putDeployment(deepFreeze(failed));
    }

    // Phase 17D — preflight validators. Each hook is invoked against the
    // immutable `resolved` Deployment before any state transition. A
    // validator returning `ok=false` aborts apply with no committed state
    // change so the caller observes the stale read-set / drift / source
    // snapshot signal directly on the resolved record.
    await runPreflightValidator(
      "ReadSetStale",
      input.readSetValidator,
      current,
    );
    await runPreflightValidator(
      "DescriptorClosureDrift",
      input.descriptorClosureValidator,
      current,
    );
    await runPreflightValidator(
      "SourceSnapshotInvalid",
      input.sourceSnapshotValidator,
      current,
    );

    // Step 1: transition resolved → applying so consumers observing the store
    // mid-apply see a progressing Deployment rather than a stuck `resolved`
    // record. The phase condition lives on conditions[] (scope=phase).
    const applyingDeployment = current.status === "applying"
      ? current
      : applyingTransition(current, appliedAt);
    if (current.status !== "applying") {
      await this.#store.putDeployment(deepFreeze(applyingDeployment));
    }

    // Step 2: plan provider operations from the resolved-graph projections.
    const operations = planProviderOperations(applyingDeployment);

    // Step 3: dispatch each operation through the provider adapter. Conditions
    // accumulate as we go so a partial failure leaves enough breadcrumbs on
    // the Deployment for downstream observability. C1 — successful operations
    // are recorded so a subsequent failure can revert them in reverse order.
    let conditions: readonly DeploymentCondition[] =
      applyingDeployment.conditions;
    let failure:
      | { operation: PlannedOperation; reason: string; message?: string }
      | undefined;
    const committed: PlannedOperation[] = [];
    for (const operation of operations) {
      let outcome: OperationOutcome;
      try {
        outcome = await this.#providerAdapter.materialize(
          applyingDeployment,
          operation,
        );
      } catch (error) {
        outcome = {
          success: false,
          reason: "ProviderMaterializationThrew",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      conditions = appendCondition(
        conditions,
        operationCondition({
          operation,
          outcome,
          observedGeneration: conditions.length + 1,
          observedAt: appliedAt,
        }),
      );
      if (!outcome.success) {
        failure = {
          operation,
          reason: outcome.reason,
          message: outcome.message,
        };
        break;
      }
      committed.push(operation);
    }

    // Step 4: terminate. On failure we mark the Deployment `failed` and skip
    // the GroupHead advance; on success we advance and record the
    // ActivationCommitted condition. Both branches finalize via a single
    // putDeployment write so the persisted state is internally consistent.
    if (failure) {
      // C1 — Multi-cloud partial-success cleanup. Revert each previously
      // committed operation in reverse order so a Cloudflare commit followed
      // by an AWS failure does not leave the CF side dangling. The terminal
      // condition records both the ApplyFailed reason and the rollback
      // outcome (RolledBack vs RolledBackPartial).
      const rollbackResult = await this.#rollbackCommittedOperations({
        deployment: applyingDeployment,
        committed,
        observedAt: appliedAt,
        startingGeneration: conditions.length + 1,
      });
      conditions = [...conditions, ...rollbackResult.conditions];
      const failedConditions = appendCondition(
        appendCondition(
          conditions,
          applyFailedCondition({
            operation: failure.operation,
            outcome: {
              success: false,
              reason: failure.reason,
              message: failure.message,
            },
            observedGeneration: conditions.length + 1,
            observedAt: appliedAt,
          }),
        ),
        applyRolledBackCondition({
          observedGeneration: conditions.length + 2,
          observedAt: appliedAt,
          partial: rollbackResult.partial,
          revertedCount: rollbackResult.revertedCount,
          failedRevertCount: rollbackResult.failedRevertCount,
        }),
      );
      const failed: Deployment = {
        ...applyingDeployment,
        status: "failed",
        conditions: failedConditions,
        finalized_at: appliedAt,
      };
      return await this.#store.putDeployment(deepFreeze(failed));
    }

    // GroupHead CAS — Phase 17D. When the caller pins
    // `expectedCurrentDeploymentId`, the store rejects the commit if the
    // observed pointer differs. The reject path rolls back provider
    // operations and finalises this Deployment as `failed`; the head never
    // points at an `applying` Deployment.
    const advanceInput: AdvanceGroupHeadInput = {
      spaceId: applyingDeployment.space_id,
      groupId: applyingDeployment.group_id,
      currentDeploymentId: applyingDeployment.id,
      advancedAt: appliedAt,
      ...("expectedCurrentDeploymentId" in input
        ? {
          expectedCurrentDeploymentId: input.expectedCurrentDeploymentId ??
            undefined,
        }
        : {}),
    };
    const successConditions = appendCondition(
      conditions,
      activationCommittedCondition({
        observedGeneration: conditions.length + 1,
        observedAt: appliedAt,
      }),
    );
    const applied: Deployment = {
      ...applyingDeployment,
      status: "applied",
      approval: input.approval ?? applyingDeployment.approval ?? null,
      applied_at: appliedAt,
      finalized_at: appliedAt,
      conditions: successConditions,
    };
    try {
      if (this.#store.commitAppliedDeployment) {
        try {
          const result = await this.#store.commitAppliedDeployment({
            ...advanceInput,
            deployment: deepFreeze(applied),
          });
          return result.deployment;
        } catch (error) {
          if (!isMissingOptionalStoreMethod(error, "commitAppliedDeployment")) {
            throw error;
          }
        }
      }
      await this.#store.putDeployment(deepFreeze(applied));
      await this.#store.advanceGroupHead(advanceInput);
      return applied;
    } catch (error) {
      const rollbackResult = await this.#rollbackCommittedOperations({
        deployment: applyingDeployment,
        committed,
        observedAt: appliedAt,
        startingGeneration: conditions.length + 1,
      });
      const message = error instanceof Error ? error.message : String(error);
      const rolledBackConditions = [
        ...conditions,
        ...rollbackResult.conditions,
      ];
      const failedConditions = appendCondition(
        appendCondition(
          rolledBackConditions,
          applyFailedCondition({
            operation: {
              key: `${applyingDeployment.id}|activation.commit|stale-head`,
              kind: "activation.commit",
              objectAddress: applyingDeployment.desired.activation_envelope
                .primary_assignment.componentAddress,
              desiredDigest:
                applyingDeployment.desired.activation_envelope.envelopeDigest,
            },
            outcome: {
              success: false,
              reason: "GroupHeadStale",
              message,
            },
            observedGeneration: rolledBackConditions.length + 1,
            observedAt: appliedAt,
          }),
        ),
        applyRolledBackCondition({
          observedGeneration: rolledBackConditions.length + 2,
          observedAt: appliedAt,
          partial: rollbackResult.partial,
          revertedCount: rollbackResult.revertedCount,
          failedRevertCount: rollbackResult.failedRevertCount,
        }),
      );
      const failed: Deployment = {
        ...applyingDeployment,
        status: "failed",
        conditions: failedConditions,
        finalized_at: appliedAt,
      };
      await this.#store.putDeployment(deepFreeze(failed));
      throw error;
    }
  }

  /**
   * Rollback a group to a prior Deployment.
   *
   * Per Core spec § 15 a rollback is a strongly consistent pointer move on
   * `GroupHead` — NOT a new Deployment. The retained
   * `Deployment.input.manifest_snapshot`, `descriptor_closure` and
   * `desired` of the target Deployment become canonical again; no provider
   * operations are re-issued. The previously current Deployment receives a
   * `rolled-back` status transition so its lifecycle is auditable, and its
   * `RolledBack` condition records the reason.
   *
   * Phase 10D semantics:
   *   1. Validate target exists and belongs to the addressed group.
   *   2. Validate target is retained (status applied or rolled-back).
   *   3. Atomically swap GroupHead via `advanceGroupHead`. The store
   *      derives `previous_deployment_id` from the prior current pointer.
   *   4. Mark the previously current Deployment `rolled-back` and append a
   *      RolledBack condition. The target Deployment is left untouched
   *      (status remains `applied`) since it is now current again.
   *
   * Phase 18.3 / M6 — multi-generation rollback. When the store exposes a
   * `getGroupHeadHistory()`, the input may pin the target by `steps`
   * (number of rollovers to walk backward) or by `targetDeploymentId`
   * (resolved against the retained history). Supplying both is treated as
   * a defensive cross-check. Stores without a history surface only support
   * explicit `targetDeploymentId`.
   */
  async rollbackGroup(input: RollbackGroupInput): Promise<GroupHead> {
    // Phase 18.3 / M6 — resolve the rollback target. When a history store
    // is available the target may come from `--steps=N` or be validated
    // against the retained N-generation history; without one only
    // `targetDeploymentId` is valid.
    const history = this.#store.getGroupHeadHistory?.();
    const targetDeploymentId = await this.#resolveRollbackTargetId(
      input,
      history,
    );

    const target = await this.#store.getDeployment(targetDeploymentId);
    if (!target) {
      throw new Error(
        `unknown rollback target deployment: ${targetDeploymentId}`,
      );
    }
    if (target.group_id !== input.groupId) {
      throw new Error(
        `rollback target ${target.id} does not belong to group ${input.groupId}`,
      );
    }
    if (target.space_id !== input.spaceId) {
      throw new Error(
        `rollback target ${target.id} does not belong to space ${input.spaceId}`,
      );
    }
    if (target.status !== "applied" && target.status !== "rolled-back") {
      throw new Error(
        `rollback target ${target.id} is not retained (status='${target.status}')`,
      );
    }

    // Phase 17D — rollback preflight validators. Drift / availability /
    // digest pinning checks against the retained descriptor closure of the
    // target. A validator returning `ok=false` blocks the rollback with a
    // descriptive error so callers see the underlying reason.
    //
    // H2 — Validators are now MANDATORY. Callers may inject custom
    // implementations via `RollbackGroupInput`; otherwise the store's
    // `getDefaultRollbackValidators()` (or the always-ok module-level
    // `DEFAULT_ROLLBACK_VALIDATORS`) is used so the rollback path never
    // silently skips a validator slot.
    const defaults = this.#store.getDefaultRollbackValidators?.() ??
      DEFAULT_ROLLBACK_VALIDATORS;
    await runPreflightValidator(
      "RollbackDescriptorClosureDrift",
      input.descriptorClosureValidator ?? defaults.descriptorClosureValidator,
      target,
    );
    await runPreflightValidator(
      "RollbackArtifactUnavailable",
      input.artifactAvailabilityValidator ??
        defaults.artifactAvailabilityValidator,
      target,
    );
    await runPreflightValidator(
      "RollbackArtifactDigestChanged",
      input.artifactDigestValidator ?? defaults.artifactDigestValidator,
      target,
    );

    const advancedAt = input.advancedAt ?? this.#clock().toISOString();
    const headBefore = await this.#store.getGroupHead({
      spaceId: input.spaceId,
      groupId: input.groupId,
    });
    const priorCurrentId = headBefore?.current_deployment_id;

    // Atomically swap the GroupHead pointer. `advanceGroupHead` derives
    // `previous_deployment_id` from the prior current id so the swap holds
    // even if rollback is invoked twice in succession.
    const head = await this.#store.advanceGroupHead({
      spaceId: input.spaceId,
      groupId: input.groupId,
      currentDeploymentId: target.id,
      advancedAt,
    });

    // Mark the previously current Deployment rolled-back so the lifecycle is
    // auditable. We deliberately do NOT mutate the target Deployment — it is
    // canonical again with its original `applied` status (Core spec § 15
    // step 4: "no new Deployment is created").
    if (priorCurrentId && priorCurrentId !== target.id) {
      const priorCurrent = await this.#store.getDeployment(priorCurrentId);
      if (priorCurrent && priorCurrent.status === "applied") {
        const conditions = appendCondition(
          priorCurrent.conditions,
          rolledBackCondition({
            observedGeneration: priorCurrent.conditions.length + 1,
            observedAt: advancedAt,
            reason: input.reason,
          }),
        );
        const rolledBack: Deployment = {
          ...priorCurrent,
          status: "rolled-back",
          conditions,
          finalized_at: advancedAt,
        };
        await this.#store.putDeployment(deepFreeze(rolledBack));
      }
    }

    return head;
  }

  /**
   * Phase 18.3 / M6 — Internal helper that resolves the Deployment id a
   * `rollbackGroup` call should advance to. Honours both `targetDeploymentId`
   * and `steps`; consults the GroupHead history store when available so any
   * retained generation is reachable, not just the single
   * `previous_deployment_id` slot on `group_heads`.
   *
   * Behaviour matrix:
   *   - history present, `steps` set → walk N rollovers back, validate
   *   - history present, `targetDeploymentId` set → validate target was head
   *   - history present, both set → cross-check they agree
   *   - history absent, `targetDeploymentId` set → use explicit target
   *   - history absent, `steps` set → reject (no retained history)
   *   - neither set → reject (no rollback request)
   */
  async #resolveRollbackTargetId(
    input: RollbackGroupInput,
    history: GroupHeadHistoryStore | undefined,
  ): Promise<string> {
    const hasTarget = typeof input.targetDeploymentId === "string" &&
      input.targetDeploymentId.length > 0;
    const hasSteps = typeof input.steps === "number";

    if (!hasTarget && !hasSteps) {
      throw new Error(
        "rollbackGroup: at least one of targetDeploymentId or steps must be provided",
      );
    }

    // Stores without retained history can validate an explicit target, but
    // `--steps=` is refused because the store does not retain enough state to
    // honour it correctly.
    if (!history) {
      if (hasSteps) {
        throw new Error(
          "rollbackGroup: store does not retain GroupHead history — " +
            "`steps` rollback is unsupported. Use `targetDeploymentId` instead.",
        );
      }
      return input.targetDeploymentId as string;
    }

    // History-aware resolution. The current GroupHead `generation` is the
    // upper bound for every history query so racing writers cannot smuggle
    // a newer head into the rollback decision.
    const currentHead = await this.#store.getGroupHead({
      spaceId: input.spaceId,
      groupId: input.groupId,
    });
    if (!currentHead) {
      // No GroupHead means this group has never been applied through the
      // deployment service. `--steps` requires retained history and is
      // refused; `--target` falls through to the existing scope/status
      // validation downstream so the caller sees the canonical
      // "does not belong to group/space" / "is not retained" errors
      // instead of an opaque "no GroupHead" string.
      if (hasSteps) {
        throw new Error(
          `rollbackGroup: no current GroupHead for (${input.spaceId}, ${input.groupId}) — ` +
            "`steps` rollback requires at least one prior apply",
        );
      }
      return input.targetDeploymentId as string;
    }
    const resolution = await resolveRollbackTarget(history, {
      spaceId: input.spaceId,
      groupId: input.groupId,
      currentSequence: currentHead.generation,
      targetDeploymentId: input.targetDeploymentId,
      steps: input.steps,
    });
    const _resolvedEntry: GroupHeadHistoryEntry = resolution.entry;
    return resolution.entry.deploymentId;
  }

  /** Look up a Deployment by id. Returns `undefined` if not present. */
  async getDeployment(id: string): Promise<Deployment | undefined> {
    return await this.#store.getDeployment(id);
  }

  /** List Deployments matching the given filter. */
  async listDeployments(
    filter: DeploymentFilter = {},
  ): Promise<readonly Deployment[]> {
    return await this.#store.listDeployments(filter);
  }

  /** Attach an approval record to a resolved Deployment without applying it. */
  async approveDeployment(input: {
    readonly deploymentId: string;
    readonly approval: DeploymentApproval;
  }): Promise<Deployment> {
    const current = await this.#store.getDeployment(input.deploymentId);
    if (!current) {
      throw new Error(`unknown deployment: ${input.deploymentId}`);
    }
    if (current.status !== "resolved") {
      throw new Error(
        `deployment ${current.id} cannot be approved in '${current.status}' status`,
      );
    }
    validateDeploymentApproval(
      current,
      input.approval,
      this.#clock().toISOString(),
    );
    const approved: Deployment = {
      ...current,
      approval: input.approval,
    };
    return await this.#store.putDeployment(deepFreeze(approved));
  }

  async listObservations(
    filter: ProviderObservationFilter = {},
  ): Promise<readonly ProviderObservation[]> {
    return await this.#store.listObservations?.(filter) ?? [];
  }

  /**
   * C1 — Multi-cloud partial-success cleanup. Iterates the previously
   * committed operations in reverse order and asks the provider adapter to
   * revert each one. Adapters that omit `rollback` (logically irreversible)
   * cause the result to flip to `partial=true` so the caller emits a
   * `RolledBackPartial` terminal condition. The per-operation revert outcome
   * is recorded as an `OperationRolledBack` / `OperationRollbackFailed`
   * condition on the failed Deployment for downstream observability.
   */
  async #rollbackCommittedOperations(input: {
    readonly deployment: Deployment;
    readonly committed: readonly PlannedOperation[];
    readonly observedAt: IsoTimestamp;
    readonly startingGeneration: number;
  }): Promise<{
    readonly conditions: readonly DeploymentCondition[];
    readonly partial: boolean;
    readonly revertedCount: number;
    readonly failedRevertCount: number;
  }> {
    const conditions: DeploymentCondition[] = [];
    let generation = input.startingGeneration;
    let revertedCount = 0;
    let failedRevertCount = 0;
    // Reverse order so later commits unwind before earlier ones (Cloudflare
    // commit then AWS failure → revert AWS-shaped commits first if any, then
    // Cloudflare-shaped commits).
    for (let i = input.committed.length - 1; i >= 0; i--) {
      const operation = input.committed[i];
      let outcome: OperationOutcome;
      if (typeof this.#providerAdapter.rollback !== "function") {
        outcome = {
          success: false,
          reason: "RollbackUnsupported",
          message:
            "provider adapter does not implement rollback for this operation",
        };
        failedRevertCount += 1;
      } else {
        try {
          outcome = await this.#providerAdapter.rollback(
            input.deployment,
            operation,
          );
          if (outcome.success) revertedCount += 1;
          else failedRevertCount += 1;
        } catch (error) {
          outcome = {
            success: false,
            reason: "RollbackThrew",
            message: error instanceof Error ? error.message : String(error),
          };
          failedRevertCount += 1;
        }
      }
      conditions.push(operationRolledBackCondition({
        operation,
        outcome,
        observedGeneration: generation,
        observedAt: input.observedAt,
      }));
      generation += 1;
    }
    return {
      conditions,
      partial: failedRevertCount > 0,
      revertedCount,
      failedRevertCount,
    };
  }
}

// ---------------------------------------------------------------------------
// In-memory reference store (used by tests and local-development bootstrap).
// ---------------------------------------------------------------------------

/** Minimal in-memory `DeploymentStore` implementation. */
export class InMemoryDeploymentStore implements DeploymentStore {
  readonly #deployments = new Map<string, Deployment>();
  readonly #heads = new Map<string, GroupHead>();
  readonly #observations = new Map<string, ProviderObservation>();
  readonly #headLocks = new Map<string, Promise<void>>();
  // Phase 18.3 / M6 — multi-generation rollback history. Append-only;
  // mirrors every `advanceGroupHead` / `commitAppliedDeployment` mutation.
  readonly #history = new InMemoryGroupHeadHistoryStore();

  // deno-lint-ignore require-await
  async getDeployment(id: string): Promise<Deployment | undefined> {
    return this.#deployments.get(id);
  }

  // deno-lint-ignore require-await
  async putDeployment(deployment: Deployment): Promise<Deployment> {
    const frozen = deepFreeze(structuredClone(deployment));
    this.#deployments.set(frozen.id, frozen);
    return frozen;
  }

  // deno-lint-ignore require-await
  async listDeployments(
    filter: DeploymentFilter,
  ): Promise<readonly Deployment[]> {
    const statuses = normalizeStatusFilter(filter.status);
    const matches: Deployment[] = [];
    for (const deployment of this.#deployments.values()) {
      if (filter.spaceId && deployment.space_id !== filter.spaceId) continue;
      if (filter.groupId && deployment.group_id !== filter.groupId) continue;
      if (statuses && !statuses.has(deployment.status)) continue;
      matches.push(deployment);
    }
    matches.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return filter.limit === undefined
      ? matches
      : matches.slice(0, Math.max(0, filter.limit));
  }

  // deno-lint-ignore require-await
  async getGroupHead(input: GroupHeadRef): Promise<GroupHead | undefined>;
  async getGroupHead(groupId: string): Promise<GroupHead | undefined>;
  async getGroupHead(
    input: GroupHeadRef | string,
  ): Promise<GroupHead | undefined> {
    if (typeof input === "string") {
      return findUniqueGroupHeadByGroupId(this.#heads, input);
    }
    return this.#heads.get(groupHeadKey(input.spaceId, input.groupId));
  }

  async advanceGroupHead(
    input: AdvanceGroupHeadInput,
  ): Promise<GroupHead> {
    return await this.#withHeadLock(input.spaceId, input.groupId, async () => {
      const deployment = this.#deployments.get(input.currentDeploymentId);
      assertHeadDeploymentScope(input, deployment);
      const key = groupHeadKey(input.spaceId, input.groupId);
      const previous = this.#heads.get(key);
      assertHeadPrecondition(input, previous);
      const advancedAt = input.advancedAt ?? new Date().toISOString();
      const next: GroupHead = deepFreeze({
        space_id: input.spaceId,
        group_id: input.groupId,
        current_deployment_id: input.currentDeploymentId,
        previous_deployment_id: previous?.current_deployment_id ?? null,
        generation: (previous?.generation ?? 0) + 1,
        advanced_at: advancedAt,
      });
      this.#heads.set(key, next);
      // Phase 18.3 / M6 — Append the rollover to the history store under
      // the same head lock so racing writers cannot interleave their
      // history rows. The DB-backed adapter wraps both writes in a single
      // SQL transaction; the in-memory adapter relies on the sequential
      // execution within `#withHeadLock`.
      await this.#history.append({
        spaceId: input.spaceId,
        groupId: input.groupId,
        deploymentId: input.currentDeploymentId,
        previousDeploymentId: previous?.current_deployment_id ?? null,
        sequence: next.generation,
        advancedAt,
      });
      return next;
    });
  }

  async commitAppliedDeployment(
    input: CommitAppliedDeploymentInput,
  ): Promise<CommitAppliedDeploymentResult> {
    return await this.#withHeadLock(input.spaceId, input.groupId, async () => {
      assertHeadDeploymentScope(input, input.deployment);
      if (input.deployment.id !== input.currentDeploymentId) {
        throw new Error(
          `commit deployment id ${input.deployment.id} does not match head target ${input.currentDeploymentId}`,
        );
      }
      const key = groupHeadKey(input.spaceId, input.groupId);
      const previous = this.#heads.get(key);
      assertHeadPrecondition(input, previous);
      const advancedAt = input.advancedAt ?? new Date().toISOString();
      const deployment = deepFreeze(structuredClone(input.deployment));
      const head: GroupHead = deepFreeze({
        space_id: input.spaceId,
        group_id: input.groupId,
        current_deployment_id: input.currentDeploymentId,
        previous_deployment_id: previous?.current_deployment_id ?? null,
        generation: (previous?.generation ?? 0) + 1,
        advanced_at: advancedAt,
      });
      this.#deployments.set(deployment.id, deployment);
      this.#heads.set(key, head);
      // Phase 18.3 / M6 — Append the rollover to the history store under
      // the same head lock (see `advanceGroupHead` for transactional notes).
      await this.#history.append({
        spaceId: input.spaceId,
        groupId: input.groupId,
        deploymentId: input.currentDeploymentId,
        previousDeploymentId: previous?.current_deployment_id ?? null,
        sequence: head.generation,
        advancedAt,
      });
      return { deployment, head };
    });
  }

  // deno-lint-ignore require-await
  async recordObservation(
    observation: ProviderObservation,
  ): Promise<ProviderObservation> {
    const frozen = deepFreeze(structuredClone(observation));
    this.#observations.set(frozen.id, frozen);
    return frozen;
  }

  // deno-lint-ignore require-await
  async listObservations(
    filter: ProviderObservationFilter = {},
  ): Promise<readonly ProviderObservation[]> {
    const matches: ProviderObservation[] = [];
    for (const observation of this.#observations.values()) {
      if (
        filter.deploymentId &&
        observation.deployment_id !== filter.deploymentId
      ) continue;
      if (filter.providerId && observation.provider_id !== filter.providerId) {
        continue;
      }
      matches.push(observation);
    }
    matches.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    return filter.limit === undefined
      ? matches
      : matches.slice(0, Math.max(0, filter.limit));
  }

  /**
   * H2 — Default rollback validators. The in-memory store has no live
   * provider snapshot, so we delegate to the always-ok defaults. Real stores
   * (D1 / Postgres backed) SHOULD override with stronger checks that consult
   * the live `ProviderObservation` stream.
   */
  getDefaultRollbackValidators(): RollbackValidators {
    return DEFAULT_ROLLBACK_VALIDATORS;
  }

  /**
   * Phase 18.3 / M6 — expose the in-memory history store so
   * `DeploymentService.rollbackGroup` can resolve `--target=` / `--steps=`
   * against any retained generation. Stores backed by a real DB return a
   * `StorageBackedGroupHeadHistoryStore` that runs the queries inside the
   * same connection pool as `group_heads`.
   */
  getGroupHeadHistory(): GroupHeadHistoryStore {
    return this.#history;
  }

  async #withHeadLock<T>(
    spaceId: string,
    groupId: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const lockKey = groupHeadKey(spaceId, groupId);
    const previous = this.#headLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.#headLocks.set(lockKey, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#headLocks.get(lockKey) === tail) {
        this.#headLocks.delete(lockKey);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildDeploymentArtifacts(input: {
  readonly manifest: PublicDeployManifest;
  readonly createdAt: IsoTimestamp;
  readonly env?: string;
  readonly envName?: string;
  readonly input: DeploymentInput;
}): {
  readonly groupId: string;
  readonly resolution: DeploymentResolution;
  readonly desired: DeploymentDesired;
  readonly policyDecisions: readonly DeploymentPolicyDecision[];
} {
  const appSpec = compileManifestToAppSpec(input.manifest, {
    env: input.env,
    envName: input.envName,
    source: {
      kind: input.input.source_kind === "git" ? "git_ref" : "manifest",
      uri: input.input.source_ref,
    },
  });
  // Phase 10A — Authoring expansion already happened inside
  // `compileManifestToAppSpec`. The expansion descriptor digest plus every
  // referenced runtime/artifact/interface/resource/publication descriptor
  // (and their JSON-LD context dependencies) is pinned by the descriptor
  // closure builder. Apply consumes this closure verbatim and MUST NOT
  // re-fetch descriptor URLs at execution time (Core spec § 6).
  const descriptorClosure = buildDescriptorClosure({
    appSpec,
    resolvedAt: input.createdAt,
  });
  // Phase 10B — ResolvedGraph projections (six canonical families) are emitted
  // here so controllers consume the projection records instead of re-deriving
  // them from raw descriptors (Core spec § 8).
  const resolvedGraph = buildResolvedGraph({
    appSpec,
    descriptorClosure,
    manifestSnapshot: input.input.manifest_snapshot,
  });
  // Phase 10C / Wave 3 — Binding resolution + access-path policy validation.
  // The resolver expands every consume edge into a canonical
  // `DeploymentBinding` (with stage chain + network boundary). The validator
  // emits one policy decision per access path; external-boundary paths require
  // an explicit `runtime_network_policy` egress allow rule (Core spec § 12
  // invariant). Denied decisions force the Deployment to status `failed` in
  // the caller above.
  const bindings = resolveBindings({
    appSpec,
    resolvedGraph,
    descriptorClosure,
    resolvedAt: input.createdAt,
  });
  const resources = resourceClaimsFor(appSpec, bindings);
  const routes = routeRecordsFor(appSpec);
  const runtimeNetworkPolicy = runtimeNetworkPolicyFor(appSpec);
  const runtimeNetworkPolicyRecord: DeploymentRuntimeNetworkPolicy = {
    ...runtimeNetworkPolicy,
    policyDigest: stableHash(runtimeNetworkPolicy),
  };
  const policyDecisions = validateAccessPaths({
    bindings,
    runtimeNetworkPolicy: runtimeNetworkPolicyRecord,
    resolvedAt: input.createdAt,
  });
  const nativeBindingDecisions = validateNativeBindingApproval({
    appSpec,
    resolvedAt: input.createdAt,
  });
  const providerFeatureDecisions = validateRequiredProviderFeatures({
    appSpec,
    resolvedAt: input.createdAt,
  });
  const resourceSafetyDecisions = validateResourceSafetyPolicies({
    appSpec,
    resolvedAt: input.createdAt,
  });
  const canarySafetyDecisions = validateCanarySafetyPolicies({
    appSpec,
    resolvedAt: input.createdAt,
  });
  const desired: DeploymentDesired = {
    routes,
    bindings,
    resources,
    runtime_network_policy: runtimeNetworkPolicyRecord,
    activation_envelope: activationEnvelopeFor(appSpec, routes),
  };
  return {
    groupId: appSpec.groupId,
    resolution: {
      descriptor_closure: descriptorClosure,
      resolved_graph: resolvedGraph,
    },
    desired,
    policyDecisions: [
      ...policyDecisions,
      ...nativeBindingDecisions,
      ...providerFeatureDecisions,
      ...resourceSafetyDecisions,
      ...canarySafetyDecisions,
    ],
  };
}

function validateNativeBindingApproval(input: {
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
}): readonly DeploymentPolicyDecision[] {
  const decisions: DeploymentPolicyDecision[] = [];
  for (const component of input.appSpec.components) {
    for (const [bindingName, spec] of Object.entries(component.bindings)) {
      if (!requestsRawNativeBinding(spec)) continue;
      const sourceName = bindingSourceNameFor(spec);
      const subjectAddress = objectAddress(
        "app.binding",
        `${component.name}/${bindingName}`,
      );
      decisions.push({
        id:
          `policy-decision:native-raw-binding:${component.name}:${bindingName}`,
        gateGroup: "resolution",
        gate: "binding-resolution",
        decision: "require-approval",
        ruleRef: "native-raw-binding:manual-approval-required",
        subjectAddress,
        subjectDigest: stableHash({
          component: component.name,
          bindingName,
          sourceName,
          nativeBinding: "raw",
        }) as `sha256:${string}`,
        decidedAt: input.resolvedAt,
      });
    }
  }
  return decisions.sort((left, right) => left.id.localeCompare(right.id));
}

function requestsRawNativeBinding(spec: PublicComponentBindingSpec): boolean {
  const from = spec.from as { access?: unknown };
  const access = from.access;
  if (!isRecord(access)) return false;
  const nativeBinding = access.nativeBinding ?? access.native;
  return nativeBinding === "raw";
}

function bindingSourceNameFor(spec: PublicComponentBindingSpec): string {
  const from = spec.from;
  if ("resource" in from) return from.resource;
  if ("output" in from) return from.output;
  if ("secret" in from) return from.secret;
  return from.providerOutput;
}

function validateRequiredProviderFeatures(input: {
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
}): readonly DeploymentPolicyDecision[] {
  const supported = providerFeatureSupport(input.appSpec);
  const decisions: DeploymentPolicyDecision[] = [];

  for (const component of input.appSpec.components) {
    const caps = new Set([
      ...(component.requirements?.runtimeCapabilities ?? []),
      ...(input.appSpec.effectiveRuntimeCapabilities?.[component.name] ?? []),
    ]);
    for (const capability of caps) {
      if (supported.runtimeCapabilities.has(capability)) continue;
      decisions.push(policyDecision({
        id: `policy-decision:provider-feature:${component.name}:${capability}`,
        gate: "provider-selection",
        decision: "deny",
        ruleRef: "provider-feature:runtime-capability-unsupported",
        subjectAddress: componentAddress(component.name),
        subject: { component: component.name, capability },
        decidedAt: input.resolvedAt,
      }));
    }
  }

  for (const resource of input.appSpec.resources) {
    if (supported.resourceContracts.has(resource.type)) continue;
    decisions.push(policyDecision({
      id: `policy-decision:provider-feature:resource:${resource.name}`,
      gate: "provider-selection",
      decision: "deny",
      ruleRef: "provider-feature:resource-contract-unsupported",
      subjectAddress: resourceAddress(resource.name),
      subject: { resource: resource.name, contract: resource.type },
      decidedAt: input.resolvedAt,
    }));
  }

  for (const route of input.appSpec.routes) {
    const contract = routeDescriptorId(route);
    if (supported.interfaceContracts.has(contract)) continue;
    decisions.push(policyDecision({
      id: `policy-decision:provider-feature:interface:${route.name}`,
      gate: "provider-selection",
      decision: "deny",
      ruleRef: "provider-feature:interface-contract-unsupported",
      subjectAddress: routeAddress(route.name),
      subject: { route: route.name, contract },
      decidedAt: input.resolvedAt,
    }));
  }

  const required = stringArrayFromUnknown(
    providerTargetOverride(input.appSpec).requiredFeatures,
  );
  for (const feature of required) {
    if (supported.genericFeatures.has(feature)) continue;
    decisions.push(policyDecision({
      id: `policy-decision:provider-feature:required:${feature}`,
      gate: "provider-selection",
      decision: "deny",
      ruleRef: "provider-feature:required-feature-unsupported",
      subjectAddress: objectAddress("provider-feature", feature),
      subject: { feature },
      decidedAt: input.resolvedAt,
    }));
  }

  return decisions.sort((left, right) => left.id.localeCompare(right.id));
}

function validateResourceSafetyPolicies(input: {
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
}): readonly DeploymentPolicyDecision[] {
  const decisions: DeploymentPolicyDecision[] = [];
  const resourcesByName = new Map(
    input.appSpec.resources.map((resource) => [resource.name, resource]),
  );

  for (const resource of input.appSpec.resources) {
    for (const previous of previousNames(resource.raw)) {
      const previousContract = previous.contract;
      const currentAtPreviousName = resourcesByName.get(previous.name);
      const crossContract = previousContract
        ? previousContract !== resource.type
        : currentAtPreviousName !== undefined &&
          currentAtPreviousName.name !== resource.name &&
          currentAtPreviousName.type !== resource.type;
      if (!crossContract) continue;
      decisions.push(policyDecision({
        id: `policy-decision:previous-names:${resource.name}:${previous.name}`,
        gate: "descriptor-resolution",
        decision: "deny",
        ruleRef: "previous-names:cross-contract-denied",
        subjectAddress: resourceAddress(resource.name),
        subject: {
          resource: resource.name,
          contract: resource.type,
          previousName: previous.name,
          previousContract: previousContract ?? currentAtPreviousName?.type,
        },
        decidedAt: input.resolvedAt,
      }));
    }

    for (const feature of nativeFeatureRequests(resource.raw)) {
      decisions.push(policyDecision({
        id: `policy-decision:native-feature:${resource.name}:${feature}`,
        gate: "provider-selection",
        decision: "require-approval",
        ruleRef: "native-feature-realization:manual-approval-required",
        subjectAddress: resourceAddress(resource.name),
        subject: { resource: resource.name, contract: resource.type, feature },
        decidedAt: input.resolvedAt,
      }));
    }

    if (requestsDbSemanticWrites(resource)) {
      decisions.push(policyDecision({
        id: `policy-decision:db-semantic-write:${resource.name}`,
        gate: "operation-planning",
        decision: "require-approval",
        ruleRef: "db-semantic-write:manual-approval-required",
        subjectAddress: resourceAddress(resource.name),
        subject: { resource: resource.name, contract: resource.type },
        decidedAt: input.resolvedAt,
      }));
    }
  }

  return decisions.sort((left, right) => left.id.localeCompare(right.id));
}

function validateCanarySafetyPolicies(input: {
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
}): readonly DeploymentPolicyDecision[] {
  const rollout = input.appSpec.overrides?.rollout;
  if (!isRecord(rollout)) return [];
  const decisions: DeploymentPolicyDecision[] = [];
  const kind = typeof rollout.kind === "string" ? rollout.kind : "canary";

  if (kind === "canary" && hasCandidateScopedEgress(input.appSpec)) {
    decisions.push(policyDecision({
      id: "policy-decision:canary:candidate-scoped-egress",
      gate: "access-path-selection",
      decision: "require-approval",
      ruleRef: "canary-egress:candidate-scoped-manual-approval-required",
      subjectAddress: objectAddress("rollout", input.appSpec.groupId),
      subject: { group: input.appSpec.groupId, kind },
      decidedAt: input.resolvedAt,
    }));
  }

  if (hasShadowRollout(rollout) && hasSideEffectSurface(input.appSpec)) {
    decisions.push(policyDecision({
      id: "policy-decision:canary:shadow-side-effects",
      gate: "operation-planning",
      decision: "require-approval",
      ruleRef: "shadow-side-effects:manual-approval-required",
      subjectAddress: objectAddress("rollout", input.appSpec.groupId),
      subject: { group: input.appSpec.groupId, kind },
      decidedAt: input.resolvedAt,
    }));
  }

  return decisions.sort((left, right) => left.id.localeCompare(right.id));
}

function routeRecordsFor(appSpec: AppSpec): readonly DeploymentRoute[] {
  return appSpec.routes.map((route) => ({
    id: route.name,
    exposureAddress: routeAddress(route.name),
    routeDescriptorId: routeDescriptorId(route),
    match: {
      host: route.host,
      path: route.path,
      protocol: route.protocol,
      port: route.port,
      source: route.source,
      methods: route.methods,
      target: route.to,
      targetPort: route.targetPort,
    },
    transport: {
      security: route.protocol.toLowerCase() === "http" ? "none" : "tls",
    },
  }));
}

function resourceClaimsFor(
  appSpec: AppSpec,
  bindings: readonly DeploymentBinding[],
): readonly DeploymentResourceClaim[] {
  return appSpec.resources.map((resource) => {
    const claimAddress = resourceAddress(resource.name);
    return {
      claimAddress,
      contract: resource.type,
      bindingNames: bindings
        .filter((binding) => binding.sourceAddress === claimAddress)
        .map((binding) => binding.bindingName),
    };
  });
}

function runtimeNetworkPolicyFor(
  appSpec: AppSpec,
): Omit<DeploymentRuntimeNetworkPolicy, "policyDigest"> {
  const configured = runtimeNetworkPolicyInput(appSpec);
  const defaultEgress = configured.defaultEgress;
  return {
    defaultEgress: defaultEgress === "allow" || defaultEgress === "deny" ||
        defaultEgress === "deny-by-default"
      ? defaultEgress
      : "deny-by-default",
    egressRules: Array.isArray(configured.egressRules)
      ? configured.egressRules
        .filter((rule): rule is Record<string, unknown> => isRecord(rule))
        .map((rule) => ({
          effect: rule.effect === "allow" ? "allow" : "deny",
          protocol: protocolFor(rule.protocol),
          to: Array.isArray(rule.to)
            ? rule.to.filter((item): item is Record<string, unknown> =>
              isRecord(item)
            )
            : undefined,
          ports: Array.isArray(rule.ports)
            ? rule.ports.filter((port): port is number =>
              Number.isInteger(port)
            )
            : undefined,
        }))
      : undefined,
    serviceIdentity: {
      group: appSpec.groupId,
      components: appSpec.components.map((component) => component.name).sort(),
    },
  };
}

function activationEnvelopeFor(
  appSpec: AppSpec,
  routes: readonly DeploymentRoute[],
): DeploymentDesired["activation_envelope"] {
  const assignments = appSpec.components.map((component) => ({
    componentAddress: componentAddress(component.name),
    weight: 1,
    labels: { component: component.name },
  }));
  const primary = assignments[0] ?? {
    componentAddress: objectAddress("group", appSpec.groupId),
    weight: 0,
    labels: { group: appSpec.groupId },
  };
  const rolloutOverride = rolloutStrategyOverride(appSpec);
  const envelope = {
    primary_assignment: primary,
    assignments,
    route_assignments: routeAssignmentsFor(appSpec, routes, rolloutOverride),
    rollout_strategy: rolloutOverride.strategy,
    non_routed_defaults: assignments[0]
      ? {
        events: {
          componentAddress: assignments[0].componentAddress,
          reason: rolloutOverride.kind === "canary"
            ? "http-only-canary"
            : "first-component",
        },
        outputs: {
          componentAddress: assignments[0].componentAddress,
          reason: rolloutOverride.kind === "canary"
            ? "http-only-canary"
            : "first-component",
        },
      }
      : undefined,
  };
  return {
    ...envelope,
    envelopeDigest: stableHash(envelope),
  };
}

/**
 * Phase 17D — read the canary rollout assignment model out of authoring
 * overrides (`overrides.rollout`). The rollout-canary service injects this
 * shape at every step; resolving the override here lets the resolved
 * Deployment carry route-level canary weight assignments rather than the
 * default `weightPermille: 1000` immediate strategy.
 */
function rolloutStrategyOverride(appSpec: AppSpec): {
  readonly kind: string;
  readonly strategy: { kind: string; steps?: readonly unknown[] };
  readonly routeWeights: ReadonlyMap<
    string,
    readonly { readonly target: string; readonly weightPermille: number }[]
  >;
} {
  const overrideValue = appSpec.overrides?.rollout;
  const empty = new Map<
    string,
    readonly { readonly target: string; readonly weightPermille: number }[]
  >();
  if (!isRecord(overrideValue)) {
    return {
      kind: "immediate",
      strategy: { kind: "immediate" },
      routeWeights: empty,
    };
  }
  const kind = typeof overrideValue.kind === "string"
    ? overrideValue.kind
    : "canary";
  const routesField = overrideValue.routes;
  const routeWeights = new Map<
    string,
    readonly { readonly target: string; readonly weightPermille: number }[]
  >();
  if (Array.isArray(routesField)) {
    for (const route of routesField) {
      if (!isRecord(route)) continue;
      const routeName = typeof route.routeName === "string"
        ? route.routeName
        : undefined;
      if (!routeName) continue;
      const rawAssignments = Array.isArray(route.assignments)
        ? route.assignments
        : [];
      const assignments: { target: string; weightPermille: number }[] = [];
      for (const candidate of rawAssignments) {
        if (!isRecord(candidate)) continue;
        const releaseId = candidate["appReleaseId"];
        const componentAddr = candidate["componentAddress"];
        const weight = candidate["weightPermille"];
        const target = typeof releaseId === "string"
          ? releaseId
          : typeof componentAddr === "string"
          ? componentAddr
          : "";
        if (target.length === 0) continue;
        assignments.push({
          target,
          weightPermille: typeof weight === "number" ? weight : 0,
        });
      }
      routeWeights.set(routeName, assignments);
    }
  }
  return {
    kind,
    strategy: {
      kind,
      steps: Array.isArray(overrideValue.steps)
        ? overrideValue.steps
        : undefined,
    },
    routeWeights,
  };
}

function routeAssignmentsFor(
  appSpec: AppSpec,
  routes: readonly DeploymentRoute[],
  override: ReturnType<typeof rolloutStrategyOverride>,
): readonly {
  routeId: string;
  protocol?: string;
  assignments: readonly {
    componentAddress: string;
    weightPermille: number;
  }[];
}[] {
  return routes.map((route) => {
    const targetName = stringField(route.match, "target") ??
      appSpec.components[0]?.name ?? appSpec.groupId;
    const overrideAssignments = override.routeWeights.get(route.id);
    if (overrideAssignments && overrideAssignments.length > 0) {
      // Map app-release labels onto the canonical primary component. The
      // canary releases share the component identity (Deployment.desired
      // carries the activation chain via per-step Deployments) so each
      // assignment maps the override target to the route's primary
      // componentAddress with the requested permille weight.
      return {
        routeId: route.id,
        protocol: stringField(route.match, "protocol"),
        assignments: overrideAssignments.map((assignment) => ({
          componentAddress: componentAddress(targetName),
          weightPermille: assignment.weightPermille,
          labels: { release: assignment.target },
        })),
      };
    }
    return {
      routeId: route.id,
      protocol: stringField(route.match, "protocol"),
      assignments: [{
        componentAddress: componentAddress(targetName),
        weightPermille: 1000,
      }],
    };
  });
}

function runtimeNetworkPolicyInput(appSpec: AppSpec): Record<string, unknown> {
  const overrides = appSpec.overrides;
  const value = overrides.runtimeNetworkPolicy;
  return isRecord(value) ? value : {};
}

function providerTargetOverride(appSpec: AppSpec): Record<string, unknown> {
  const value = appSpec.overrides?.providerTarget ??
    appSpec.overrides?.providerSupport;
  return isRecord(value) ? value : {};
}

function providerFeatureSupport(appSpec: AppSpec): {
  readonly runtimeCapabilities: ReadonlySet<string>;
  readonly resourceContracts: ReadonlySet<string>;
  readonly interfaceContracts: ReadonlySet<string>;
  readonly genericFeatures: ReadonlySet<string>;
} {
  const override = providerTargetOverride(appSpec);
  const supports = isRecord(override.supports) ? override.supports : override;
  const runtimeCapabilities = supportedSet(supports, "runtimeCapabilities", [
    "always-on-container",
    "request-driven-container",
    "request-driven-js-worker",
    "external-tenant-routing",
    "health-check-aware-routing",
  ]);
  const resourceContracts = supportedSet(supports, "resourceContracts", [
    "resource.sql.postgres@v1",
    "resource.sql.sqlite-serverless@v1",
    "resource.object-store.s3@v1",
    "resource.key-value@v1",
    "resource.queue.at-least-once@v1",
    "resource.secret@v1",
    "resource.vector-index@v1",
  ]);
  const interfaceContracts = supportedSet(supports, "interfaceContracts", [
    "interface.http@v1",
    "interface.tcp@v1",
    "interface.udp@v1",
    "interface.queue@v1",
    "interface.schedule@v1",
    "interface.event@v1",
  ]);
  const genericFeatures = new Set([
    ...runtimeCapabilities,
    ...resourceContracts,
    ...interfaceContracts,
    ...stringArrayFromUnknown(supports.features),
    ...stringArrayFromUnknown(supports.capabilityProfiles),
  ]);
  return {
    runtimeCapabilities,
    resourceContracts,
    interfaceContracts,
    genericFeatures,
  };
}

function supportedSet(
  source: Record<string, unknown>,
  field: string,
  defaults: readonly string[],
): ReadonlySet<string> {
  const explicit = stringArrayFromUnknown(source[field]);
  return new Set(explicit.length > 0 ? explicit : defaults);
}

function previousNames(
  resource: Record<string, unknown>,
): readonly { readonly name: string; readonly contract?: string }[] {
  const generate = isRecord(resource.generate) ? resource.generate : {};
  const value = resource.previousNames ?? resource.previous_names ??
    generate.previousNames ?? generate.previous_names;
  if (!Array.isArray(value)) return [];
  const entries: { name: string; contract?: string }[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      entries.push({ name: item });
    } else if (isRecord(item) && typeof item.name === "string") {
      const contract = typeof item.contract === "string"
        ? item.contract
        : typeof item.type === "string"
        ? item.type
        : undefined;
      entries.push({ name: item.name, contract });
    }
  }
  return entries;
}

function nativeFeatureRequests(
  resource: Record<string, unknown>,
): readonly string[] {
  const generate = isRecord(resource.generate) ? resource.generate : {};
  return [
    ...stringArrayFromUnknown(resource.features),
    ...stringArrayFromUnknown(resource.nativeFeatures),
    ...stringArrayFromUnknown(resource.providerNativeFeatures),
    ...stringArrayFromUnknown(resource.extensions),
    ...stringArrayFromUnknown(generate.features),
    ...stringArrayFromUnknown(generate.nativeFeatures),
    ...stringArrayFromUnknown(generate.providerNativeFeatures),
    ...stringArrayFromUnknown(generate.extensions),
  ].filter((feature) => isNativeFeature(feature));
}

function isNativeFeature(feature: string): boolean {
  const normalized = feature.toLowerCase();
  return normalized === "pgvector" || normalized.includes("native") ||
    normalized.startsWith("extension:");
}

function requestsDbSemanticWrites(resource: AppSpecResource): boolean {
  if (!resource.type.includes("sql")) return false;
  const raw = resource.raw;
  if (
    raw.semanticWrites === true || raw.dbSemanticWrites === true ||
    raw.semanticWrite === true
  ) {
    return true;
  }
  const generate = isRecord(raw.generate) ? raw.generate : {};
  if (
    generate.semanticWrites === true || generate.dbSemanticWrites === true ||
    generate.semanticWrite === true
  ) {
    return true;
  }
  const writeSemantics = raw.writeSemantics;
  const generateWriteSemantics = generate.writeSemantics;
  if (
    (typeof writeSemantics === "string" && writeSemantics.length > 0) ||
    (typeof generateWriteSemantics === "string" &&
      generateWriteSemantics.length > 0)
  ) {
    return true;
  }
  const migrations = raw.migrations ?? generate.migrations;
  return isRecord(migrations) && migrations.writes === true;
}

function hasCandidateScopedEgress(appSpec: AppSpec): boolean {
  const policy = runtimeNetworkPolicyInput(appSpec);
  const rules = Array.isArray(policy.egressRules) ? policy.egressRules : [];
  return rules.some((rule) =>
    isRecord(rule) &&
    (rule.candidateScoped === true || rule.candidateOnly === true ||
      typeof rule.candidateAppReleaseId === "string" ||
      rule.scope === "candidate")
  );
}

function hasShadowRollout(rollout: Record<string, unknown>): boolean {
  return rollout.kind === "shadow" || rollout.shadow === true ||
    rollout.shadowTraffic === true || isRecord(rollout.shadowTraffic);
}

function hasSideEffectSurface(appSpec: AppSpec): boolean {
  if (appSpec.outputs.length > 0) return true;
  if (
    appSpec.routes.some((route) =>
      ["queue", "schedule", "event"].includes(route.protocol.toLowerCase())
    )
  ) {
    return true;
  }
  if (
    appSpec.components.some((component) => isRecord(component.raw.triggers))
  ) {
    return true;
  }
  return appSpec.resources.some((resource) =>
    requestsDbSemanticWrites(resource)
  );
}

function policyDecision(input: {
  readonly id: string;
  readonly gate: DeploymentPolicyDecision["gate"];
  readonly decision: DeploymentPolicyDecision["decision"];
  readonly ruleRef: string;
  readonly subjectAddress: string;
  readonly subject: unknown;
  readonly decidedAt: IsoTimestamp;
}): DeploymentPolicyDecision {
  return {
    id: input.id,
    gateGroup: "resolution",
    gate: input.gate,
    decision: input.decision,
    ruleRef: input.ruleRef,
    subjectAddress: input.subjectAddress,
    subjectDigest: stableHash(input.subject) as `sha256:${string}`,
    decidedAt: input.decidedAt,
  };
}

function stringArrayFromUnknown(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
      typeof item === "string" && item.length > 0
    )
    : [];
}

function routeDescriptorId(route: AppSpecRoute): string {
  const value = (route as AppSpecRoute & { interfaceContractRef?: string })
    .interfaceContractRef;
  return value ?? "interface.http@v1";
}

function componentAddress(name: string): string {
  return objectAddress("component", name);
}

function resourceAddress(name: string): string {
  return objectAddress("resource", name);
}

function routeAddress(name: string): string {
  return objectAddress("route", name);
}

function protocolFor(
  value: unknown,
): NonNullable<DeploymentRuntimeNetworkPolicy["egressRules"]>[number][
  "protocol"
] {
  return value === "http" || value === "https" || value === "tcp" ||
      value === "udp"
    ? value
    : undefined;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const item = value[field];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function blockersToConditions(
  blockers: readonly DeployBlocker[],
  observedAt: IsoTimestamp,
): readonly DeploymentCondition[] {
  return blockers.map((blocker, index) => ({
    type: blocker.code,
    status: "false" as const,
    reason: blocker.code,
    message: blocker.message,
    observed_generation: index + 1,
    last_transition_time: blocker.observedAt ?? observedAt,
    scope: { kind: "deployment" as const },
  }));
}

function accessPathDeniedCondition(
  observedAt: IsoTimestamp,
  generation: number,
  decisions: readonly DeploymentPolicyDecision[],
): DeploymentCondition {
  const denied = decisions.filter((decision) => decision.decision === "deny");
  const subjects = denied
    .map((decision) => decision.subjectAddress ?? decision.id)
    .join(", ");
  const externalOnly = denied.every((decision) =>
    decision.ruleRef === "runtime-network-policy:external-boundary-not-allowed"
  );
  return {
    type: "Resolution",
    status: "false",
    reason: externalOnly
      ? "AccessPathExternalBoundaryRequiresPolicy"
      : "PolicyDenied",
    message: subjects
      ? `Resolution denied by policy: ${subjects}`
      : "Resolution denied by policy.",
    observed_generation: generation,
    last_transition_time: observedAt,
    scope: { kind: "deployment" },
  };
}

/**
 * H4 — Build the terminal condition emitted when an apply is rejected because
 * at least one `policy_decisions[].decision === "require-approval"` was not
 * satisfied by an attached `DeploymentApproval`. The reason matches the
 * canonical `ApprovalRequired` reason from the Core condition reason catalog.
 */
function approvalRequiredCondition(input: {
  readonly observedGeneration: number;
  readonly observedAt: IsoTimestamp;
  readonly decisions: readonly DeploymentPolicyDecision[];
}): DeploymentCondition {
  const requiring = input.decisions.filter(
    (decision) => decision.decision === "require-approval",
  );
  const subjects = requiring
    .map((decision) => decision.subjectAddress ?? decision.id)
    .join(", ");
  return {
    type: "ApprovalRequired",
    status: "true",
    reason: "ApprovalRequired",
    message: subjects
      ? `apply blocked: policy decisions require approval (${subjects})`
      : "apply blocked: policy decisions require approval",
    observed_generation: input.observedGeneration,
    last_transition_time: input.observedAt,
    scope: { kind: "deployment" },
  };
}

function validateDeploymentApproval(
  deployment: Deployment,
  approval: DeploymentApproval,
  now: IsoTimestamp,
): void {
  if (!approval.approved_by.trim()) {
    throw new Error("deployment approval approved_by is required");
  }
  if (!Number.isFinite(Date.parse(approval.approved_at))) {
    throw new Error(
      "deployment approval approved_at must be a valid ISO timestamp",
    );
  }
  if (approval.expires_at) {
    const expiresAt = Date.parse(approval.expires_at);
    if (!Number.isFinite(expiresAt)) {
      throw new Error(
        "deployment approval expires_at must be a valid ISO timestamp",
      );
    }
    if (expiresAt <= Date.parse(now)) {
      throw new Error("deployment approval has expired");
    }
  }
  const decision = (deployment.policy_decisions ?? []).find((candidate) =>
    candidate.id === approval.policy_decision_id
  );
  if (!decision) {
    throw new Error(
      `deployment approval references unknown policy decision: ${approval.policy_decision_id}`,
    );
  }
  if (decision.decision !== "require-approval") {
    throw new Error(
      `deployment approval references non-approval policy decision: ${approval.policy_decision_id}`,
    );
  }
}

function isMissingOptionalStoreMethod(error: unknown, method: string): boolean {
  return error instanceof Error &&
    error.message === `storage store method not found: ${method}`;
}

/**
 * Run an apply / rollback preflight validator. Returns silently if the
 * validator is undefined or returns `ok=true`. Throws an Error keyed by the
 * supplied default reason when the validator reports a problem so the caller
 * sees a stale-precondition style failure message.
 */
async function runPreflightValidator(
  defaultReason: string,
  validator: ApplyPreflightValidator | undefined,
  deployment: Deployment,
): Promise<void> {
  if (!validator) return;
  const finding = await validator(deployment);
  if (finding.ok) return;
  const reason = finding.reason ?? defaultReason;
  const message = finding.message ?? reason;
  throw new Error(`${reason}: ${message}`);
}

function applyingTransition(
  current: Deployment,
  observedAt: IsoTimestamp,
): Deployment {
  return {
    ...current,
    status: "applying",
    conditions: appendCondition(
      current.conditions,
      applyingPhaseCondition({
        observedGeneration: current.conditions.length + 1,
        observedAt,
      }),
    ),
  };
}

function appendCondition(
  conditions: readonly DeploymentCondition[],
  condition: DeploymentCondition,
): readonly DeploymentCondition[] {
  return [...conditions, condition];
}

function normalizeStatusFilter(
  status: DeploymentFilter["status"],
): Set<DeploymentStatus> | undefined {
  if (!status) return undefined;
  return new Set(Array.isArray(status) ? status : [status]);
}

function assertHeadPrecondition(
  input: AdvanceGroupHeadInput,
  current: GroupHead | undefined,
): void {
  if ("expectedCurrentDeploymentId" in input) {
    const observed = current?.current_deployment_id;
    if (observed !== input.expectedCurrentDeploymentId) {
      throw new Error(
        `stale group head for ${input.groupId}: expected current ${
          input.expectedCurrentDeploymentId ?? "<none>"
        } but found ${observed ?? "<none>"}`,
      );
    }
  }
  if (input.expectedGeneration !== undefined) {
    const observed = current?.generation ?? 0;
    if (observed !== input.expectedGeneration) {
      throw new Error(
        `stale group head for ${input.groupId}: expected generation ${input.expectedGeneration} but found ${observed}`,
      );
    }
  }
}

function assertHeadDeploymentScope(
  input: AdvanceGroupHeadInput,
  deployment: Deployment | undefined,
): void {
  if (!deployment) {
    throw new Error(`unknown deployment: ${input.currentDeploymentId}`);
  }
  if (deployment.space_id !== input.spaceId) {
    throw new Error(
      `deployment ${deployment.id} belongs to space ${deployment.space_id}, not ${input.spaceId}`,
    );
  }
  if (deployment.group_id !== input.groupId) {
    throw new Error(
      `deployment ${deployment.id} belongs to group ${deployment.group_id}, not ${input.groupId}`,
    );
  }
}

function groupHeadKey(spaceId: string, groupId: string): string {
  return `${spaceId}\u0000${groupId}`;
}

function findUniqueGroupHeadByGroupId(
  heads: ReadonlyMap<string, GroupHead>,
  groupId: string,
): GroupHead | undefined {
  const matches = [...heads.values()].filter((head) =>
    head.group_id === groupId
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function stableHash(value: JsonObject | unknown): string {
  const input = stableStringify(value);
  const seeds = [
    0xcbf29ce484222325n,
    0x84222325cbf29ce4n,
    0x9e3779b97f4a7c15n,
    0x94d049bb133111ebn,
  ];
  return `sha256:${seeds.map((seed) => fnv1a64(input, seed)).join("")}`;
}

function fnv1a64(input: string, seed: bigint): string {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${stableStringify(object[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Free-function convenience wrappers (parallel to the class methods).
//
// These exist so callers that prefer a functional surface (or do not want to
// thread a service instance through layers) can call
// `resolveDeployment(store, input)` directly.
// ---------------------------------------------------------------------------

export function resolveDeployment(
  store: DeploymentStore,
  input: ResolveDeploymentInput,
  options: Omit<DeploymentServiceOptions, "store"> = {},
): Promise<Deployment> {
  return new DeploymentService({ ...options, store }).resolveDeployment(input);
}

export function applyDeployment(
  store: DeploymentStore,
  input: ApplyDeploymentInput,
  options: Omit<DeploymentServiceOptions, "store"> = {},
): Promise<Deployment> {
  return new DeploymentService({ ...options, store }).applyDeployment(input);
}

export function rollbackGroup(
  store: DeploymentStore,
  input: RollbackGroupInput,
  options: Omit<DeploymentServiceOptions, "store"> = {},
): Promise<GroupHead> {
  return new DeploymentService({ ...options, store }).rollbackGroup(input);
}

export function getDeployment(
  store: DeploymentStore,
  id: string,
): Promise<Deployment | undefined> {
  return store.getDeployment(id);
}

export function listDeployments(
  store: DeploymentStore,
  filter: DeploymentFilter = {},
): Promise<readonly Deployment[]> {
  return store.listDeployments(filter);
}

export function approveDeployment(
  store: DeploymentStore,
  input: {
    readonly deploymentId: string;
    readonly approval: DeploymentApproval;
  },
  options: Omit<DeploymentServiceOptions, "store"> = {},
): Promise<Deployment> {
  return new DeploymentService({ ...options, store }).approveDeployment(input);
}

export function listObservations(
  store: DeploymentStore,
  filter: ProviderObservationFilter = {},
): Promise<readonly ProviderObservation[]> {
  return store.listObservations?.(filter) ?? Promise.resolve([]);
}
