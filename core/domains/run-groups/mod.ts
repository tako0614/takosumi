/** Workspace RunGroups for independent stale-source plans and drift checks. */

import type {
  Run,
  RunGroup,
  RunGroupStatus,
  RunGroupWithRuns,
} from "takosumi-contract/runs";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuController } from "../deploy-control/mod.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";

/**
 * Recorded layers and per-member plan Run ids. New groups use a single
 * unordered layer; older groups retain their persisted order on reads.
 */
export interface WorkspaceUpdateGraph {
  /** Recorded member layers. New groups use one independent layer. */
  readonly order: readonly (readonly string[])[];
  /** Member capsule id -> the plan Run id created for it. */
  readonly runs: Readonly<Record<string, string>>;
}

export interface RunGroupsServiceDependencies {
  readonly store: OpenTofuControlStore;
  /** Drives `createCapsulePlan` per member + unified `getRun` at read time. */
  readonly controller: OpenTofuController;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  readonly actor?: string;
  /** Workspace-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
}

export interface CreateWorkspaceDriftCheckOptions {
  readonly limit?: number;
  /** Internal scheduled page. Revalidate membership/status without widening it. */
  readonly capsuleIds?: readonly string[];
}

export class RunGroupsService {
  readonly #store: OpenTofuControlStore;
  readonly #controller: OpenTofuController;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;
  readonly #actor?: string;
  readonly #activity: ActivityRecorder;

  constructor(dependencies: RunGroupsServiceDependencies) {
    this.#store = dependencies.store;
    this.#controller = dependencies.controller;
    this.#newId =
      dependencies.newId ??
      ((prefix) =>
        `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#actor = dependencies.actor;
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
  }

  /** Creates one independent plan for each source-stale Capsule. */
  async createWorkspaceUpdate(workspaceId: string): Promise<RunGroupWithRuns> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const capsules = await this.#store.listCapsules(workspaceId);
    const members = new Set(
      capsules.filter((capsule) => capsule.status === "stale").map((capsule) => capsule.id),
    );
    if (members.size === 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "nothing_to_update: no stale capsules to re-plan",
      );
    }
    // Source-stale Capsules are independent. Preserve one stable layer for
    // the recorded group graph without reviving retired dependency ordering.
    const layers = [[...members]];
    const runs: Record<string, string> = {};
    const memberRuns: Run[] = [];
    const runGroupId = this.#newId("rg");
    for (const layer of layers) {
      for (const capsuleId of layer) {
        const response = await this.#controller.createCapsulePlan(
          capsuleId,
          this.#actor ? { actor: this.#actor } : {},
          // A Workspace update re-plans each app's tracked ref as configured;
          // a retry of one member repeats exactly that.
          { runGroupId, origin: { kind: "update" } },
        );
        runs[capsuleId] = response.planRun.id;
        memberRuns.push(await this.#controller.getRun(response.planRun.id));
      }
    }
    const graph: WorkspaceUpdateGraph = { order: layers, runs };
    const runGroup: RunGroup = {
      id: runGroupId,
      workspaceId,
      type: "workspace_update",
      // The persisted status is the creation-time snapshot; reads recompute it
      // from member runs. A fresh group with queued/running members is `running`.
      status: computeGroupStatus(memberRuns),
      graphJson: JSON.stringify(graph),
      createdAt: this.#now(),
    };
    await this.#store.putRunGroup(runGroup);
    // Activity (§27 / §34): a workspace_update RunGroup was created. Member ids +
    // run ids only.
    await this.#activity.record({
      workspaceId,
      ...(this.#actor ? { actorId: this.#actor } : {}),
      action: "run_group.created",
      targetType: "run_group",
      targetId: runGroup.id,
      metadata: {
        type: runGroup.type,
        memberCapsuleIds: [...members],
        runIds: Object.values(runs),
      },
    });
    return { runGroup, runs: memberRuns };
  }

  /**
   * Creates a `workspace_drift_check` RunGroup for one Workspace. Unlike
   * `workspace_update`, drift checks are read-only and independent, but recording
   * them as a RunGroup gives scheduled sweeps a single Workspace-scoped ledger row
   * and lets the dashboard read the member `drift_check` Runs through the same
   * §19 Run projection. Only `active` Capsules are checked; an empty active
   * set is a typed `failed_precondition` (`nothing_to_drift_check`).
   */
  async createWorkspaceDriftCheck(
    workspaceId: string,
    options: CreateWorkspaceDriftCheckOptions = {},
  ): Promise<RunGroupWithRuns> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const limit = normalizePositiveLimit(options.limit);
    const selectedIds = options.capsuleIds === undefined
      ? undefined
      : new Set(options.capsuleIds);
    const capsules = (await this.#store.listCapsules(workspaceId))
      .filter((capsule) => capsule.status === "active" &&
        (selectedIds === undefined || selectedIds.has(capsule.id)))
      .slice(0, limit);
    if (capsules.length === 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "nothing_to_drift_check: no active capsules to drift-check",
      );
    }

    const capsuleIds = capsules.map(
      (capsule) => capsule.id,
    );
    const layers = [capsuleIds];
    const runs: Record<string, string> = {};
    const memberRuns: Run[] = [];
    const runGroupId = this.#newId("rg");

    for (const layer of layers) {
      for (const capsuleId of layer) {
        const response = await this.#controller.createCapsuleDriftCheck(
          capsuleId,
          this.#actor ? { actor: this.#actor } : {},
          { runGroupId },
        );
        runs[capsuleId] = response.planRun.id;
        memberRuns.push(await this.#controller.getRun(response.planRun.id));
      }
    }

    const graph: WorkspaceUpdateGraph = { order: layers, runs };
    const runGroup: RunGroup = {
      id: runGroupId,
      workspaceId,
      type: "workspace_drift_check",
      status: computeGroupStatus(memberRuns),
      graphJson: JSON.stringify(graph),
      createdAt: this.#now(),
    };
    await this.#store.putRunGroup(runGroup);
    await this.#activity.record({
      workspaceId,
      ...(this.#actor ? { actorId: this.#actor } : {}),
      action: "run_group.created",
      targetType: "run_group",
      targetId: runGroup.id,
      metadata: {
        type: runGroup.type,
        memberCapsuleIds: capsuleIds,
        runIds: Object.values(runs),
      },
    });
    return { runGroup, runs: memberRuns };
  }

  /**
   * Reads a RunGroup with its member Runs and the COMPUTED status (spec §19).
   * The member run ids come from the recorded graphJson; each is read through
   * the controller's unified `getRun` so the status reflects the live member
   * states. The returned `runGroup.status` is recomputed (it does not trust the
   * persisted snapshot).
   */
  async getRunGroup(id: string): Promise<RunGroupWithRuns | undefined> {
    requireNonEmptyString(id, "runGroupId");
    const stored = await this.#store.getRunGroup(id);
    if (!stored) return undefined;
    const graph = parseWorkspaceUpdateGraph(stored.graphJson);
    const memberRuns = await this.#memberRuns(graph);
    return {
      runGroup: {
        ...stored,
        status: computeGroupStatus(memberRuns),
      },
      runs: memberRuns,
    };
  }

  /**
   * Approves every member Run currently `waiting_approval` (spec §19). Returns
   * the RunGroup with its refreshed member Runs + recomputed status. A member
   * not awaiting approval is skipped (the approve call would reject it), so this
   * is safe to call repeatedly.
   */
  async approveRunGroup(id: string): Promise<RunGroupWithRuns | undefined> {
    requireNonEmptyString(id, "runGroupId");
    const stored = await this.#store.getRunGroup(id);
    if (!stored) return undefined;
    const graph = parseWorkspaceUpdateGraph(stored.graphJson);
    for (const run of await this.#memberRuns(graph)) {
      if (run.status !== "waiting_approval") continue;
      await this.#controller.approveRun(
        run.id,
        this.#actor ? { approvedBy: this.#actor } : {},
      );
    }
    return await this.getRunGroup(id);
  }

  /** Reads the member Runs of a parsed graph through the controller's getRun. */
  async #memberRuns(graph: WorkspaceUpdateGraph): Promise<Run[]> {
    const runs: Run[] = [];
    // Preserve the order recorded at group creation for stable reads.
    for (const layer of graph.order) {
      for (const capsuleId of layer) {
        const runId = graph.runs[capsuleId];
        if (!runId) continue;
        try {
          runs.push(await this.#controller.getRun(runId));
          const plan = await this.#store.getPlanRun(runId);
          if (plan?.appliedApplyRunId) {
            runs.push(await this.#controller.getRun(plan.appliedApplyRunId));
          }
        } catch {
          // A member run the ledger no longer holds is skipped; the group status
          // is computed from the runs that remain.
        }
      }
    }
    return runs;
  }
}

function normalizePositiveLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit);
}

/**
 * Computes a RunGroup status from its member Runs (spec §19 / §24 decision):
 * queued/running if any member is non-terminal-and-not-waiting, waiting_approval
 * if any is waiting_approval (and none earlier), failed if any failed, cancelled
 * if any cancelled and none failed, succeeded when all succeeded. An empty
 * member set reads as `succeeded` (nothing left to run). The precedence order
 * below is the load-bearing part.
 */
export function computeGroupStatus(runs: readonly Run[]): RunGroupStatus {
  if (runs.length === 0) return "succeeded";
  let anyFailed = false;
  let anyCancelled = false;
  let anyWaiting = false;
  let anyActive = false;
  for (const run of runs) {
    switch (run.status) {
      case "failed":
        anyFailed = true;
        break;
      case "cancelled":
        anyCancelled = true;
        break;
      case "waiting_approval":
        anyWaiting = true;
        break;
      case "queued":
      case "running":
        anyActive = true;
        break;
      case "succeeded":
        break;
      // `expired` (never produced by the internal model) reads as non-terminal.
      default:
        anyActive = true;
        break;
    }
  }
  // Active members dominate: the group is still in flight.
  if (anyActive) return "running";
  if (anyWaiting) return "waiting_approval";
  if (anyFailed) return "failed";
  if (anyCancelled) return "cancelled";
  return "succeeded";
}

function parseWorkspaceUpdateGraph(graphJson: string): WorkspaceUpdateGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(graphJson);
  } catch {
    return { order: [], runs: {} };
  }
  if (!parsed || typeof parsed !== "object") return { order: [], runs: {} };
  const record = parsed as Record<string, unknown>;
  const order = Array.isArray(record.order)
    ? (record.order as unknown[])
        .filter(Array.isArray)
        .map((layer) =>
          (layer as unknown[]).filter(
            (id): id is string => typeof id === "string",
          ),
        )
    : [];
  const runs: Record<string, string> = {};
  if (record.runs && typeof record.runs === "object") {
    for (const [key, value] of Object.entries(record.runs)) {
      if (typeof value === "string") runs[key] = value;
    }
  }
  return { order, runs };
}
