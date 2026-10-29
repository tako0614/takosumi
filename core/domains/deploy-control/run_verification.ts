/** Read-only verification of source, state, and Capsule compatibility pins. */

import type {
  DispatchPriorState,
  DispatchSourceArchive,
  DispatchStateAdoption,
  DispatchStateScope,
  Capsule,
  PlanRun,
  PolicyConfig,
  StateVersion,
} from "@takosumi/internal/deploy-control-api";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import type { OpenTofuControlStore } from "./store.ts";
import { OpenTofuControllerError } from "./errors.ts";
import type { RunExecutionDispatch } from "./mod.ts";
import type { ArtifactReferenceAllocator } from "../../adapters/storage/artifact-references.ts";

/** Shared ledger and policy seams used for run verification. */
export interface RunVerificationServiceDependencies {
  readonly store: OpenTofuControlStore;
  readonly artifactReferenceAllocator?: ArtifactReferenceAllocator;
  readonly policyForPlanRun: (
    planRun: PlanRun,
  ) => Promise<PolicyConfig | undefined>;
  readonly assertCompatibilityReportRunnable: (
    report: CapsuleCompatibilityReport,
    policy?: PolicyConfig,
  ) => void;
}

/**
 * Read-only run-time verification + dispatch-payload builder. Behavior is
 * identical to the prior inline controller methods.
 */
export class RunVerificationService {
  readonly #store: OpenTofuControlStore;
  readonly #artifactReferenceAllocator?: ArtifactReferenceAllocator;
  readonly #policyForPlanRun: (
    planRun: PlanRun,
  ) => Promise<PolicyConfig | undefined>;
  readonly #assertCompatibilityReportRunnable: (
    report: CapsuleCompatibilityReport,
    policy?: PolicyConfig,
  ) => void;

  constructor(dependencies: RunVerificationServiceDependencies) {
    this.#store = dependencies.store;
    this.#artifactReferenceAllocator = dependencies.artifactReferenceAllocator;
    this.#policyForPlanRun = dependencies.policyForPlanRun;
    this.#assertCompatibilityReportRunnable =
      dependencies.assertCompatibilityReportRunnable;
  }

  /**
   * Builds the M2 environment dispatch fields (`stateScope` + `sourceArchive`)
   * for a run that carries environment context. The `generation` is the state
   * generation this phase writes/restores at: a plan passes the CURRENT
   * generation (restore base); an apply / destroy_apply passes `base + 1` (the
   * persist generation the DO writes). Returns an empty object for a run WITHOUT
   * environment context so existing dispatch payloads are byte-for-byte
   * unchanged. Throws when the recorded SourceSnapshot is missing (a run cannot
   * dispatch against a snapshot the ledger no longer holds).
   */
  async executionDispatch(
    planRun: PlanRun,
    generation: number,
    stateAdoption?: DispatchStateAdoption,
    priorStateDescriptor?: DispatchPriorState,
  ): Promise<RunExecutionDispatch> {
    const priorState = await this.#canonicalPriorState(
      planRun,
      stateAdoption,
      priorStateDescriptor,
    );
    if (stateAdoption) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "state adoption is valid only for a Capsule run",
      );
    }
    const ctx = planRun.capsuleContext;
    if (
      planRun.dependencySnapshotId !== undefined ||
      (ctx && await this.#store.hasRetiredDependenciesForConsumer(ctx.capsuleId))
    ) {
      throw new OpenTofuControllerError(
        "dependency_retired",
        `dependency_retired: plan run ${planRun.id} has retired dependency inputs; create a new plan`,
        { reason: "dependency_retired" },
      );
    }
    if (!ctx) return {};
    const capsule = await this.#store.getCapsule(ctx.capsuleId);
    if (!capsule || capsule.workspaceId !== ctx.workspaceId || capsule.environment !== ctx.environment) {
      throw new OpenTofuControllerError("failed_precondition", "Capsule state allocation owner changed");
    }
    const stateScope = await this.#stateScope({
      workspaceId: ctx.workspaceId,
      subject: {
        kind: "capsule",
        id: ctx.capsuleId,
      },
      environment: ctx.environment,
      generation,
      ...(priorState ? { priorState } : {}),
    }, await this.#store.getCapsuleStorageRoot(capsule.id));
    if (!planRun.sourceSnapshotId) {
      return {
        stateScope,
      };
    }
    const snapshot = await this.#store.getSourceSnapshot(
      planRun.sourceSnapshotId,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_snapshot_missing: plan run ${planRun.id} references ` +
          `SourceSnapshot ${planRun.sourceSnapshotId} which is no longer present`,
        { reason: "source_snapshot_missing" },
      );
    }
    const sourceArchive = await this.#dispatchSourceArchive(planRun, snapshot);
    return {
      stateScope,
      sourceArchive,
    };
  }

  async #dispatchSourceArchive(
    planRun: PlanRun,
    snapshot: SourceSnapshot,
  ): Promise<DispatchSourceArchive> {
    // Compatibility reports are admission evidence for create/update only;
    // destroy dispatch is authorized by the applied StateVersion/PlanRun
    // provenance and must not read a legacy report row.
    if (planRun.operation === "destroy" || !planRun.compatibilityReportId) {
      return {
        ref: snapshot.archiveRef,
        digest: snapshot.archiveDigest,
      };
    }
    const report = await this.#store.getCapsuleCompatibilityReport(
      planRun.compatibilityReportId,
    );
    if (!report) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_missing: plan run ${planRun.id} references ` +
          `CompatibilityReport ${planRun.compatibilityReportId} which no longer exists`,
        { reason: "compatibility_report_missing" },
      );
    }
    this.#assertCompatibilityReportScopedToRun(report, planRun, snapshot);
    const policy = await this.#policyForPlanRun(planRun);
    this.#assertCompatibilityReportRunnable(report, policy);
    return {
      ref: snapshot.archiveRef,
      digest: snapshot.archiveDigest,
    };
  }

  async #stateScope(
    input: Omit<DispatchStateScope, "stateRef">,
    storageRoot?: string,
  ): Promise<DispatchStateScope> {
    const allocator = this.#artifactReferenceAllocator;
    if (!allocator || !input.subject) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "run dispatch requires an artifact-reference allocator",
      );
    }
    const stateRef = await allocator.allocate({
      kind: "state",
      workspaceId: input.workspaceId,
      subject: input.subject,
      environment: input.environment,
      generation: input.generation,
      ...(storageRoot === undefined ? {} : { storageRoot }),
    });
    if (!stateRef.trim()) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "artifact-reference allocator returned an empty stateRef",
      );
    }
    return { ...input, stateRef };
  }

  async #canonicalPriorState(
    planRun: PlanRun,
    stateAdoption: DispatchStateAdoption | undefined,
    priorState: DispatchPriorState | undefined,
  ): Promise<DispatchPriorState | undefined> {
    const generation = planRun.baseStateGeneration ?? 0;
    if (stateAdoption) {
      if (priorState) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "state adoption cannot replace a canonical prior state",
        );
      }
      return undefined;
    }
    if (generation === 0) {
      if (priorState) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "generation-zero dispatch cannot carry prior state",
        );
      }
      return undefined;
    }
    const ctx = planRun.capsuleContext;
    if (!ctx || !planRun.capsuleCurrentStateVersionId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `canonical_prior_state_unavailable: generation ${generation} has no pinned StateVersion`,
        { reason: "canonical_prior_state_unavailable" },
      );
    }
    const state = await this.#store.getStateVersion(
      planRun.capsuleCurrentStateVersionId,
    );
    if (
      !state ||
      state.workspaceId !== ctx.workspaceId ||
      state.capsuleId !== ctx.capsuleId ||
      state.environment !== ctx.environment ||
      state.generation !== generation ||
      !state.stateRef ||
      !state.digest ||
      !state.createdByRunId
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `canonical_prior_state_unavailable: StateVersion ${planRun.capsuleCurrentStateVersionId} does not match Capsule generation ${generation}`,
        { reason: "canonical_prior_state_unavailable" },
      );
    }
    const canonical = {
      generation: state.generation,
      stateRef: state.stateRef,
      digest: state.digest,
      createdByRunId: state.createdByRunId,
    };
    if (
      priorState &&
      (priorState.generation !== canonical.generation ||
        priorState.stateRef !== canonical.stateRef ||
        priorState.digest !== canonical.digest ||
        priorState.createdByRunId !== canonical.createdByRunId)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `canonical_prior_state_unavailable: supplied descriptor does not match StateVersion ${planRun.capsuleCurrentStateVersionId}`,
        { reason: "canonical_prior_state_unavailable" },
      );
    }
    return canonical;
  }

  /**
   * Env-driven state generation guard (M2). For a run carrying environment
   * context, rejects when the Environment's latest StateVersion generation no
   * longer equals the generation this plan was created against (a sibling apply
   * advanced the env state in between). Runs without env context are unaffected
   * (the Capsule-backed guard handles them).
   */
  async assertCapsuleStateGeneration(planRun: PlanRun): Promise<void> {
    const ctx = planRun.capsuleContext;
    if (!ctx) return;
    const base = planRun.baseStateGeneration ?? 0;
    const latest = await this.#store.getLatestStateVersion(
      ctx.capsuleId,
      ctx.environment,
    );
    const current = latest?.generation ?? 0;
    if (current !== base) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `state_generation_mismatch: plan run ${planRun.id} was created against ` +
          `Capsule ${ctx.capsuleId} (${ctx.environment}) state ` +
          `generation ${base} but it is now at generation ${current}`,
        { reason: "state_generation_mismatch" },
      );
    }
  }

  /**
   * Source snapshot revalidation (spec invariant 10; M2). For a plan pinned to a
   * SourceSnapshot, re-reads the persisted plan and confirms its sourceSnapshotId
   * is unchanged and still resolves to a stored snapshot — so an apply cannot run
   * against a snapshot the plan no longer references or the ledger has dropped.
   * No-ops for runs without a recorded snapshot.
   */
  async revalidateSourceSnapshot(planRun: PlanRun): Promise<void> {
    if (!planRun.sourceSnapshotId) return;
    const persisted = await this.#store.getPlanRun(planRun.id);
    const persistedSnapshotId = persisted?.sourceSnapshotId;
    if (persistedSnapshotId !== planRun.sourceSnapshotId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_snapshot_mismatch: plan run ${planRun.id} source snapshot ` +
          `changed since review (${planRun.sourceSnapshotId} -> ` +
          `${persistedSnapshotId ?? "<none>"})`,
        { reason: "source_snapshot_mismatch" },
      );
    }
    const snapshot = await this.#store.getSourceSnapshot(
      planRun.sourceSnapshotId,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_snapshot_missing: plan run ${planRun.id} references ` +
          `SourceSnapshot ${planRun.sourceSnapshotId} which is no longer present`,
        { reason: "source_snapshot_missing" },
      );
    }
  }

  /**
   * Capsule Gate precondition (core-spec §6 / §26): when a PlanRun was created
   * from a Capsule that has a reviewed CompatibilityReport, the queued
   * plan/apply consumer must re-read it before provider credential mint. Only
   * `ready` reports are runnable for create/update. Destroy returns before any
   * report read: analyzer or policy drift after apply must never make teardown
   * impossible.
   */
  async assertCapsuleCompatibilityAllowsRun(planRun: PlanRun): Promise<void> {
    // A CompatibilityReport is never a teardown lock. Return before touching
    // the report store so a legacy flat providers_json row cannot block destroy.
    if (planRun.operation === "destroy" || !planRun.compatibilityReportId) {
      return;
    }
    const report = await this.#store.getCapsuleCompatibilityReport(
      planRun.compatibilityReportId,
    );
    if (!report) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_missing: plan run ${planRun.id} references ` +
          `CompatibilityReport ${planRun.compatibilityReportId} which no longer exists`,
        { reason: "compatibility_report_missing" },
      );
    }
    if (planRun.sourceSnapshotId) {
      const snapshot = await this.#store.getSourceSnapshot(
        planRun.sourceSnapshotId,
      );
      if (!snapshot) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `source_snapshot_missing: plan run ${planRun.id} references ` +
            `SourceSnapshot ${planRun.sourceSnapshotId} which is no longer present`,
          { reason: "source_snapshot_missing" },
        );
      }
      this.#assertCompatibilityReportScopedToRun(report, planRun, snapshot);
    } else if (
      report.capsuleId &&
      report.capsuleId !== planRun.capsuleContext?.capsuleId
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_capsule_mismatch: plan run ${planRun.id} ` +
          `uses Capsule ${planRun.capsuleContext?.capsuleId ?? "<none>"} ` +
          `but report ${report.id} was created for ${report.capsuleId}`,
        { reason: "compatibility_report_capsule_mismatch" },
      );
    }
    const policy = await this.#policyForPlanRun(planRun);
    this.#assertCompatibilityReportRunnable(report, policy);
  }

  #assertCompatibilityReportScopedToRun(
    report: CapsuleCompatibilityReport,
    planRun: PlanRun,
    snapshot: SourceSnapshot,
  ): void {
    if (report.sourceSnapshotId !== snapshot.id) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_snapshot_mismatch: plan run ${planRun.id} ` +
          `uses SourceSnapshot ${snapshot.id} but report ${report.id} was created for ${report.sourceSnapshotId}`,
        { reason: "compatibility_report_snapshot_mismatch" },
      );
    }
    if (report.sourceId && report.sourceId !== snapshot.sourceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_source_mismatch: plan run ${planRun.id} ` +
          `uses Source ${snapshot.sourceId ?? "<none>"} but report ${report.id} ` +
          `was created for ${report.sourceId}`,
        { reason: "compatibility_report_source_mismatch" },
      );
    }
    if (
      report.capsuleId &&
      report.capsuleId !== planRun.capsuleContext?.capsuleId
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `compatibility_report_capsule_mismatch: plan run ${planRun.id} ` +
          `uses Capsule ${planRun.capsuleContext?.capsuleId ?? "<none>"} ` +
          `but report ${report.id} was created for ${report.capsuleId}`,
        { reason: "compatibility_report_capsule_mismatch" },
      );
    }
  }


}
