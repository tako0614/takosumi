// Deploy domain service — canonical Deployment-centric API.

import type {
  Deployment,
  DeploymentApproval,
  DeploymentCondition,
  DeploymentInput,
  DeploymentMode,
  DeploymentStatus,
  GroupHead,
  IsoTimestamp,
  ProviderObservation,
} from "takosumi-contract";
import {
  activationCommittedCondition,
  applyFailedCondition,
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
import {
  type DeployMetricOperationKind,
  type DeployMetricSink,
  type DeployMetricStatus,
  recordDeployOperationMetric,
  startDeployMetricTimer,
} from "./deploy_metrics.ts";
import {
  accessPathDeniedCondition,
  appendCondition,
  applyingTransition,
  approvalRequiredCondition,
  blockersToConditions,
  isMissingOptionalStoreMethod,
  runPreflightValidator,
  validateDeploymentApproval,
} from "./internal/deployment_conditions.ts";
import { deepFreeze, stableHash } from "./internal/hash.ts";
import { buildDeploymentArtifacts } from "./internal/resolution_pipeline.ts";
import {
  type GroupHeadHistoryEntry,
  type GroupHeadHistoryStore,
  resolveRollbackTarget,
} from "./group_head_history.ts";
import type { DeployBlocker, PublicDeployManifest } from "./types.ts";

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
   * apply for a group). When omitted, apply snapshots the current GroupHead
   * before provider materialization and enforces that pointer + generation at
   * activation commit, so long-running materialization does not hold the
   * GroupHead lock but also cannot overwrite a newer commit.
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
  /** Optional metric sink for apply / rollback counters and latency histograms. */
  readonly observability?: DeployMetricSink;
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
  readonly #observability?: DeployMetricSink;

  constructor(options: DeploymentServiceOptions) {
    this.#store = options.store;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#clock = options.clock ?? (() => new Date());
    this.#providerAdapter = options.providerAdapter ??
      SYNTHETIC_PROVIDER_ADAPTER;
    this.#observability = options.observability;
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
    const timer = startDeployMetricTimer();
    try {
      const deployment = await this.#applyDeployment(input);
      await this.#recordDeployMetric({
        operationKind: "apply",
        status: deployment.status === "applied" ? "succeeded" : "failed",
        deployment,
        startedAtMs: timer.startedAtMs,
      });
      return deployment;
    } catch (error) {
      await this.#recordDeployMetric({
        operationKind: "apply",
        status: "failed",
        deploymentId: input.deploymentId,
        startedAtMs: timer.startedAtMs,
      });
      throw error;
    }
  }

  async #applyDeployment(input: ApplyDeploymentInput): Promise<Deployment> {
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

    const implicitHeadPrecondition = "expectedCurrentDeploymentId" in input
      ? undefined
      : await this.#store.getGroupHead({
        spaceId: current.space_id,
        groupId: current.group_id,
      });

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
        : {
          expectedCurrentDeploymentId: implicitHeadPrecondition
            ?.current_deployment_id,
          expectedGeneration: implicitHeadPrecondition?.generation ?? 0,
        }),
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
    const timer = startDeployMetricTimer();
    try {
      const head = await this.#rollbackGroup(input);
      await this.#recordDeployMetric({
        operationKind: "rollback",
        status: "succeeded",
        spaceId: input.spaceId,
        groupId: input.groupId,
        deploymentName: input.targetDeploymentId ?? String(input.steps ?? ""),
        startedAtMs: timer.startedAtMs,
      });
      return head;
    } catch (error) {
      await this.#recordDeployMetric({
        operationKind: "rollback",
        status: "failed",
        spaceId: input.spaceId,
        groupId: input.groupId,
        deploymentName: input.targetDeploymentId ?? String(input.steps ?? ""),
        startedAtMs: timer.startedAtMs,
      });
      throw error;
    }
  }

  async #rollbackGroup(input: RollbackGroupInput): Promise<GroupHead> {
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

  async #recordDeployMetric(input: {
    readonly operationKind: DeployMetricOperationKind;
    readonly status: DeployMetricStatus;
    readonly deployment?: Deployment;
    readonly deploymentId?: string;
    readonly spaceId?: string;
    readonly groupId?: string;
    readonly deploymentName?: string;
    readonly startedAtMs: number;
  }): Promise<void> {
    await recordDeployOperationMetric({
      observability: this.#observability,
      now: () => this.#clock().toISOString(),
    }, {
      operationKind: input.operationKind,
      status: input.status,
      spaceId: input.deployment?.space_id ?? input.spaceId,
      groupId: input.deployment?.group_id ?? input.groupId,
      deploymentName: input.deploymentName ?? input.deployment?.id ??
        input.deploymentId,
      startedAtMs: input.startedAtMs,
      payload: input.deployment || input.deploymentId
        ? {
          deploymentId: input.deployment?.id ?? input.deploymentId ??
            "unknown",
        }
        : undefined,
    });
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

// InMemoryDeploymentStore lives in ./internal/in_memory_store.ts.
// Re-export here so callers that import { InMemoryDeploymentStore } from
// "./deployment_service.ts" (and the store.ts re-export shim) keep working.
export { InMemoryDeploymentStore } from "./internal/in_memory_store.ts";

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
