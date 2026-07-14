/**
 * Run-time verification + dispatch-payload builder facade (Core Specification
 * §6 / §15 / §17 / §18 / §20 / §26).
 *
 * A cohesive, READ-ONLY collaborator pulled out of
 * `OpenTofuController`: every method here is a function of the stored
 * ledger (PlanRun + SourceSnapshot + DependencySnapshot + StateVersion +
 * CompatibilityReport + Capsule/OutputShare rows) and never mutates run
 * state nor calls back into the plan/apply run-engine mutation core. It owns two
 * cohesive concerns the queue consumers + apply preconditions lean on:
 *
 *   - the {@link RunExecutionDispatch} payload build (`executionDispatch`
 *     + the source-archive / remote-state descriptor resolution it threads), and
 *   - the apply/plan-time re-verification of the pins the plan was reviewed
 *     against: state generation, source snapshot, Capsule compatibility, and the
 *     DependencySnapshot (per-entry tamper digest, remote state ref/digest,
 *     published_output OutputShare coverage).
 *
 * The controller holds one instance and delegates from `#executionDispatch`,
 * the apply preconditions, `runQueuedPlan`, and `createApplyRun` so the exact
 * signatures, error codes, and verification ordering are preserved.
 *
 * Two shared seams stay owned by the controller and are injected as ports: the
 * §26 policy lookup (`policyForPlanRun`, also injected into the
 * {@link RunCredentialBroker}) and the §26 Capsule-Gate runnability assertion
 * (`assertCompatibilityReportRunnable`, also used by the run-creation path), so
 * the SAME logic is shared between here and those seams. The
 * {@link DependencyResolutionService} (OutputShare coverage) and the at-rest
 * {@link DependencyValueSealer} (sealed dependency-value recovery) are injected
 * as the same instances the controller holds.
 *
 * Behavior is identical to the prior inline controller methods. No credential
 * material or secret output value enters these projections.
 */

import type {
  DispatchDepState,
  DispatchSourceArchive,
  DispatchStateAdoption,
  DispatchStateScope,
  Capsule,
  PlanRun,
  PolicyConfig,
  StateVersion,
} from "@takosumi/internal/deploy-control-api";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { DependencySnapshotEntry } from "takosumi-contract/dependencies";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import type { OpenTofuControlStore } from "./store.ts";
import { OpenTofuControllerError } from "./errors.ts";
import type { DependencyResolutionService } from "./dependency_resolution.ts";
import type { DependencyValueSealer, RunExecutionDispatch } from "./mod.ts";
import type { ArtifactReferenceAllocator } from "../../adapters/storage/artifact-references.ts";

/**
 * Ports the controller injects into {@link RunVerificationService}. `store` is
 * the shared ledger; `dependencies` is the shared
 * {@link DependencyResolutionService} (OutputShare coverage); `dependencyValueSealer`
 * is the optional at-rest sealer (absent ⇒ sealed entries fail closed) — the SAME
 * sealer instance the controller holds, so `open` (AES-GCM auth-tag +
 * content-digest fail-closed) recovers the same plaintext digested at plan time;
 * `policyForPlanRun` + `assertCompatibilityReportRunnable` are the shared §26
 * seams kept on the controller (also injected into the credential broker /
 * used by the run-creation path).
 */
export interface RunVerificationServiceDependencies {
  readonly store: OpenTofuControlStore;
  readonly dependencies: DependencyResolutionService;
  readonly dependencyValueSealer?: DependencyValueSealer;
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
  readonly #dependencies: DependencyResolutionService;
  readonly #dependencyValueSealer?: DependencyValueSealer;
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
    this.#dependencies = dependencies.dependencies;
    this.#dependencyValueSealer = dependencies.dependencyValueSealer;
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
  ): Promise<RunExecutionDispatch> {
    if (planRun.resourceContext) {
      const subject = {
        kind: "resource" as const,
        id: planRun.resourceContext.resourceId,
      };
      return {
        stateScope: await this.#stateScope({
          workspaceId: planRun.resourceContext.workspaceId,
          subject,
          environment: planRun.resourceContext.environment,
          generation,
        }),
        ...(stateAdoption ? { stateAdoption } : {}),
      };
    }
    if (stateAdoption) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "state adoption is valid only for a first-class Resource run",
      );
    }
    const ctx = planRun.capsuleContext;
    if (!ctx || !planRun.sourceSnapshotId) return {};
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
    const stateScope = await this.#stateScope({
      workspaceId: ctx.workspaceId,
      subject: {
        kind: "capsule",
        id: ctx.capsuleId,
      },
      environment: ctx.environment,
      generation,
    });
    // remote_state dependencies (spec §15): for each remote_state edge, dispatch
    // the producer StateVersion pinned by the plan's DependencySnapshot so
    // apply/destroy use the same state bytes the plan reviewed.
    const depStates = await this.#resolveRemoteStateDispatch(planRun);
    const sourceArchive = await this.#dispatchSourceArchive(planRun, snapshot);
    return {
      stateScope,
      sourceArchive,
      ...(depStates.length > 0 ? { depStates } : {}),
    };
  }

  async #dispatchSourceArchive(
    planRun: PlanRun,
    snapshot: SourceSnapshot,
  ): Promise<DispatchSourceArchive> {
    if (!planRun.compatibilityReportId) {
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

  /**
   * Builds the {@link DispatchDepState} list for a PlanRun's `remote_state`
   * DependencySnapshot entries (spec §15/§17). New PlanRuns pin the exact
   * StateVersion ref/digest at plan time. Older snapshots without those
   * optional fields fall back to the StateVersion with the pinned generation.
   * `name` is the producer Capsule name — the `/work/deps/<name>.tfstate`
   * filename the consumer references via `terraform_remote_state`. Returns an
   * empty list when the plan pinned no remote_state edges.
   */
  async #resolveRemoteStateDispatch(
    planRun: PlanRun,
  ): Promise<readonly DispatchDepState[]> {
    if (!planRun.dependencySnapshotId) return [];
    const snapshot = await this.#store.getDependencySnapshot(
      planRun.dependencySnapshotId,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_snapshot_missing: plan run ${planRun.id} references ` +
          `DependencySnapshot ${planRun.dependencySnapshotId} which is no ` +
          `longer present`,
        { reason: "dependency_snapshot_missing" },
      );
    }
    const depStates: DispatchDepState[] = [];
    for (const entry of snapshot.dependencies) {
      const dependency = await this.#store.getDependency(entry.dependencyId);
      if (!dependency) continue;
      if (dependency.mode !== "remote_state") continue;
      const producer = await this.#store.getCapsule(entry.producerCapsuleId);
      if (!producer) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_state_unavailable: dependency ${dependency.id} producer ` +
            `Capsule ${entry.producerCapsuleId} not found`,
          { reason: "dependency_state_unavailable" },
        );
      }
      const pinned = await this.#pinnedRemoteStateVersionForEntry(
        planRun,
        entry,
        producer,
      );
      depStates.push({
        name: producer.name,
        capsuleId: producer.id,
        environment: producer.environment,
        generation: pinned.generation,
        stateRef: pinned.stateRef,
        digest: pinned.digest,
      });
    }
    return depStates;
  }

  async #pinnedRemoteStateVersionForEntry(
    planRun: PlanRun,
    entry: DependencySnapshotEntry,
    producer: Capsule,
  ): Promise<StateVersion> {
    const snapshots = await this.#store.listStateVersions(
      producer.id,
      producer.environment,
    );
    const pinned = snapshots.find(
      (snapshot) => snapshot.generation === entry.producerStateGeneration,
    );
    if (!pinned) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_state_unavailable: plan run ${planRun.id} dependency ` +
          `${entry.dependencyId} pinned producer StateVersion generation ` +
          `${entry.producerStateGeneration} is no longer present`,
        { reason: "dependency_state_unavailable" },
      );
    }
    if (entry.producerStateRef || entry.producerStateDigest) {
      if (
        (entry.producerStateVersionId &&
          pinned.id !== entry.producerStateVersionId) ||
        pinned.stateRef !== entry.producerStateRef ||
        pinned.digest !== entry.producerStateDigest
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_snapshot_tampered: plan run ${planRun.id} dependency ` +
            `${entry.dependencyId} pinned producer StateVersion no longer ` +
            `matches the ledger row`,
          { reason: "dependency_snapshot_tampered" },
        );
      }
    }
    return pinned;
  }

  async #stateScope(
    input: Omit<DispatchStateScope, "stateRef">,
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
    });
    if (!stateRef.trim()) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "artifact-reference allocator returned an empty stateRef",
      );
    }
    return { ...input, stateRef };
  }

  async #reverifyRemoteStateVersionPin(
    planRun: PlanRun,
    entry: DependencySnapshotEntry,
  ): Promise<void> {
    const dependency = await this.#store.getDependency(entry.dependencyId);
    if (dependency?.mode !== "remote_state") return;
    const producer = await this.#store.getCapsule(entry.producerCapsuleId);
    if (!producer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_state_unavailable: dependency ${entry.dependencyId} ` +
          `producer Capsule ${entry.producerCapsuleId} not found`,
        { reason: "dependency_state_unavailable" },
      );
    }
    await this.#pinnedRemoteStateVersionForEntry(planRun, entry, producer);
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
   * Only `ready` reports are runnable; `needs_patch` and `unsupported` stop
   * before credentials are issued.
   */
  async assertCapsuleCompatibilityAllowsRun(planRun: PlanRun): Promise<void> {
    if (!planRun.compatibilityReportId) return;
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

  /**
   * Verifies the plan's pinned DependencySnapshot at apply time (spec §17 /
   * invariant 9). No-ops when the plan pinned no snapshot.
   *
   *   - `strict` mode (production consumer): every entry's producer Capsule
   *     must STILL be at the `producerStateGeneration` pinned at plan time; a
   *     moved producer is a typed `failed_precondition`
   *     (`dependency_snapshot_stale`).
   *   - both modes: recompute the per-entry `valuesDigest` over the pinned values
   *     and fail on mismatch (`dependency_snapshot_tampered`) — the pinned values
   *     are exactly what was injected and digested at plan time.
   *
   * `pinned` mode (preview / dev) intentionally tolerates a producer that moved
   * after plan: it applies the values frozen at plan time regardless.
   *
   * INDEPENDENTLY of mode, a `published_output` edge re-verifies the backing
   * OutputShare is STILL active and covers every mapped name (spec §18): a grant
   * revoked between plan and apply fails the apply `output_share_revoked`, even
   * in `pinned` mode (a revoked grant must not be applied from frozen values).
   */
  async verifyDependencySnapshot(planRun: PlanRun): Promise<void> {
    if (!planRun.dependencySnapshotId) return;
    const snapshot = await this.#store.getDependencySnapshot(
      planRun.dependencySnapshotId,
    );
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_snapshot_missing: plan run ${planRun.id} references ` +
          `DependencySnapshot ${planRun.dependencySnapshotId} which is no ` +
          `longer present`,
        { reason: "dependency_snapshot_missing" },
      );
    }
    for (const entry of snapshot.dependencies) {
      // Tamper check (both modes): the pinned values must still hash to the
      // pinned digest. A re-put that mutated the frozen values — OR a tampered
      // sealed-values blob (the AES-GCM auth tag and the post-decrypt content
      // digest both fail closed) — trips this. The digest is over the FULL
      // plaintext value map, so sealed sensitive values are recovered first.
      const fullValues = await this.#recoverEntryValues(planRun, entry);
      const recomputed = await stableJsonDigest(fullValues);
      if (recomputed !== entry.valuesDigest) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_snapshot_tampered: plan run ${planRun.id} dependency ` +
            `${entry.dependencyId} pinned values no longer match the pinned digest`,
          { reason: "dependency_snapshot_tampered" },
        );
      }
      // published_output: re-verify the backing OutputShare at apply (spec §18).
      // A revoke after plan must fail the apply regardless of snapshot mode.
      await this.#reverifyPublishedOutputShare(planRun, entry.dependencyId);
      // remote_state: the pinned state ref/digest must still match the
      // immutable StateVersion ledger row, regardless of strict/pinned mode.
      await this.#reverifyRemoteStateVersionPin(planRun, entry);
      if (snapshot.mode !== "strict") continue;
      // Strict freshness: the producer must not have moved since plan.
      const producer = await this.#store.getCapsule(entry.producerCapsuleId);
      const current = producer?.currentStateGeneration ?? 0;
      if (current !== entry.producerStateGeneration) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_snapshot_stale: plan run ${planRun.id} dependency ` +
            `${entry.dependencyId} producer Capsule ` +
            `${entry.producerCapsuleId} advanced from state generation ` +
            `${entry.producerStateGeneration} to ${current} since plan`,
          { reason: "dependency_snapshot_stale" },
        );
      }
    }
  }

  /**
   * Recovers the FULL plaintext value map of a DependencySnapshot entry: the
   * cleartext non-sensitive `values` merged with the unsealed sensitive values
   * (spec §11 / §18). A sealed entry with no configured sealer fails closed
   * (`dependency_value_sealer_unavailable`); a tampered/wrong-key blob fails
   * closed at the AES-GCM auth tag (and the post-decrypt content digest) inside
   * {@link DependencyValueSealer.open}. Used by the apply-time tamper check so
   * the recomputed `valuesDigest` is over the same full plaintext that was
   * digested at plan time.
   */
  async #recoverEntryValues(
    planRun: PlanRun,
    entry: DependencySnapshotEntry,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!entry.sealedValues) return entry.values;
    if (!this.#dependencyValueSealer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_value_sealer_unavailable: plan run ${planRun.id} dependency ` +
          `${entry.dependencyId} pinned sealed values but no at-rest value ` +
          `sealer is configured to open them`,
        { reason: "dependency_value_sealer_unavailable" },
      );
    }
    const unsealed = await this.#dependencyValueSealer.open(entry.sealedValues);
    return { ...entry.values, ...unsealed };
  }

  /**
   * Re-verifies the OutputShare backing a `published_output` dependency is STILL
   * active and covers every mapped name at apply time (spec §18). No-ops for a
   * non-published_output edge or one whose Dependency row is gone (the snapshot
   * already pinned the values; a missing edge cannot be re-validated and the
   * tamper/staleness checks still apply). A grant revoked (or narrowed) between
   * plan and apply throws `output_share_revoked`.
   */
  async #reverifyPublishedOutputShare(
    planRun: PlanRun,
    dependencyId: string,
  ): Promise<void> {
    const dependency = await this.#store.getDependency(dependencyId);
    if (!dependency || dependency.mode !== "published_output") return;
    const producer = await this.#store.getCapsule(dependency.producerCapsuleId);
    const consumer = await this.#store.getCapsule(dependency.consumerCapsuleId);
    if (!producer || !consumer) return;
    const coverage = await this.#dependencies.resolveShareCoverage(
      producer,
      consumer,
    );
    for (const mapping of Object.values(dependency.outputs)) {
      if (!coverage.has(mapping.from)) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `output_share_revoked: plan run ${planRun.id} dependency ` +
            `${dependencyId} consumes shared output ${mapping.from} from ` +
            `producer Capsule ${producer.id} but no active OutputShare ` +
            `covers it`,
          { reason: "output_share_revoked" },
        );
      }
    }
  }
}
