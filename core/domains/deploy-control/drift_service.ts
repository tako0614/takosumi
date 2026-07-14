/**
 * Drift-check orchestration facade (spec §19 `drift_check` / §27 / §34
 * Activity; Phase 8). Both Capsule and first-class Resource subjects use the
 * same read-only Run primitive.
 *
 * A thin collaborator pulled out of `OpenTofuController`: it owns the
 * controller-bound drift orchestration that is NOT part of the shared plan/run
 * engine — the public `createCapsuleDriftCheck` entry (which flags an
 * `update`-kind plan run as a read-only drift check) and the
 * `recordDriftDetected` Activity emission that runs after a succeeded
 * `drift_check`. The controller holds one instance and re-exposes
 * `createCapsuleDriftCheck` on its public API, so the `/api`
 * drift-check route keeps calling the controller surface.
 *
 * The shared plan engine itself stays on the controller: drift-check creation is
 * just the Capsule plan path with `{ driftCheck: true }`, and the
 * run-completion path still detects `driftCheck === true && status === succeeded`
 * inline (the plan JSON projection is only in scope there) and delegates the
 * sanitized aggregate emission to {@link DriftService.recordDriftDetected}.
 *
 * The pure classification helpers (`classifyDriftResourceChanges` etc.) stay in
 * {@link ./drift.ts} and are reused here, not duplicated. Two seams stay owned by
 * the controller and are injected as ports rather than moved:
 *   - `createPlanRun` — the shared Capsule plan engine entry;
 *   - `recordActivity` — the shared Activity recorder wrapper (used by many
 *     non-drift controller methods too).
 * Behavior is identical to the prior inline controller methods.
 */

import type {
  PlanResourceChange,
  PlanRun,
  PlanRunResponse,
} from "@takosumi/internal/deploy-control-api";
import type { RecordActivityInput } from "../activity/mod.ts";
import { classifyDriftResourceChanges } from "./drift.ts";

/** Actor context carried through a drift-check run creation (mirrors the controller's). */
export interface DriftActorContext {
  readonly actor?: string;
}

/** RunGroup association threaded onto a drift-check plan run. */
export interface DriftCheckInternal {
  readonly runGroupId?: string;
}

/**
 * Ports the controller injects into {@link DriftService}. `createPlanRun` and
 * `recordActivity` stay owned by the controller and are passed in rather than
 * moved: the former is the shared Capsule plan engine entry, the
 * latter the shared Activity recorder wrapper used by many non-drift methods too.
 */
export interface DriftServiceDependencies {
  /**
   * Shared plan engine entry. A drift check is a normal `update`-kind plan run
   * flagged `driftCheck: true`; the destroy flag is always `false` for drift.
   */
  readonly createPlanRun: (
    capsuleId: string,
    destroy: boolean,
    context: DriftActorContext,
    internal: { readonly runGroupId?: string; readonly driftCheck?: true },
  ) => Promise<PlanRunResponse>;
  /** Shared Activity recorder wrapper (swallows recorder errors, logs a warning). */
  readonly recordActivity: (event: RecordActivityInput) => Promise<void>;
}

/**
 * Collaborator owning the controller-bound drift-check orchestration: the
 * public drift-check creation entry and the post-completion drift Activity
 * emission. Behavior is identical to the prior inline controller methods.
 */
export class DriftService {
  readonly #createPlanRun: DriftServiceDependencies["createPlanRun"];
  readonly #recordActivity: DriftServiceDependencies["recordActivity"];

  constructor(dependencies: DriftServiceDependencies) {
    this.#createPlanRun = dependencies.createPlanRun;
    this.#recordActivity = dependencies.recordActivity;
  }

  /**
   * Capsule-driven drift check (spec §19 `drift_check` run type; Phase 8
   * advanced). Creates a plan-kind internal run flagged {@link PlanRun.driftCheck}
   * that:
   *   - resolves the Capsule config -> Source -> latest snapshot
   *     exactly like a Capsule update plan, so the
   *     runner produces a real `tofu plan` against the live state;
   *   - NEVER parks `waiting_approval` (`#planAwaitsApproval` short-circuits a
   *     drift check) — it is a read-only signal, not an applyable plan;
   *   - can NEVER be applied (`createApplyRun` rejects a drift-check plan with
   *     `failed_precondition`);
   *   - on completion with a non-empty change summary emits an
   *     `capsule.drift_detected` Activity event with public-safe aggregate
   *     metadata only (no values, no Capsule status change; the spec has no
   *     `drifted` status).
   * The §19 Run projection maps it to `type: "drift_check"`.
   *
   * The public API exposes drift-check creation as a canonical read-only run
   * route; it records ledger/activity evidence without creating an applyable
   * plan artifact.
   */
  async createCapsuleDriftCheck(
    capsuleId: string,
    context: DriftActorContext = {},
    internal: DriftCheckInternal = {},
  ): Promise<PlanRunResponse> {
    return await this.#createPlanRun(capsuleId, false, context, {
      ...internal,
      driftCheck: true,
    });
  }

  /**
   * Emits the subject-specific `capsule.drift_detected` or
   * `resource.drift_detected` Activity when a succeeded drift_check observed a
   * non-empty change summary. Metadata carries the run id,
   * add/change/destroy counts, provider/type/action aggregates, and public-safe
   * remediation hints only (never resource names, values, or scope identifiers).
   * A run with an empty summary emits nothing.
   */
  async recordDriftDetected(
    planRun: PlanRun,
    changes: readonly PlanResourceChange[],
  ): Promise<void> {
    const summary = planRun.summary;
    const add = summary?.add ?? 0;
    const change = summary?.change ?? 0;
    const destroy = summary?.destroy ?? 0;
    if (add + change + destroy <= 0) return;
    const classification = classifyDriftResourceChanges(changes);
    const capsuleId = planRun.capsuleContext?.capsuleId ?? planRun.capsuleId;
    const resourceId = planRun.resourceContext?.resourceId;
    const targetId = resourceId ?? capsuleId ?? planRun.id;
    await this.#recordActivity({
      workspaceId: planRun.workspaceId,
      action: resourceId ? "resource.drift_detected" : "capsule.drift_detected",
      targetType: resourceId ? "resource" : "capsule",
      targetId,
      runId: planRun.id,
      metadata: {
        ...(capsuleId ? { capsuleId } : {}),
        ...(resourceId ? { resourceId } : {}),
        add,
        change,
        destroy,
        ...(Object.keys(classification.resourceTypes).length > 0
          ? { resourceTypes: classification.resourceTypes }
          : {}),
        ...(Object.keys(classification.providers).length > 0
          ? { providers: classification.providers }
          : {}),
        ...(Object.keys(classification.actions).length > 0
          ? { actions: classification.actions }
          : {}),
        ...(classification.remediationHints.length > 0
          ? { remediationHints: classification.remediationHints }
          : {}),
      },
    });
  }
}
