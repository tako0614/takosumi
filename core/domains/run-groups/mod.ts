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
import type { Capsule } from "takosumi-contract/capsules";
import type { AppAccessResolver } from "../../../contract/app-access.ts";
import type { AppOwnershipStore } from "../app-ownership/store.ts";
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
  /** Member capsule id -> pre-plan failure reason. Older graphs omit this. */
  readonly failures?: Readonly<Record<string, "dependency_retired">>;
}

export interface RunGroupsServiceDependencies {
  readonly store: OpenTofuControlStore;
  /** Drives `createCapsulePlan` per member + unified `getRun` at read time. */
  readonly controller: OpenTofuController;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  readonly actor?: string;
  /** Set only by the trusted service composition for system-owned group work. */
  readonly systemOwnedFlow?: boolean;
  readonly appAccess?: AppAccessResolver;
  /** Canonical owner and ownership epoch for system-owned stale-app plans. */
  readonly appOwnership?: Pick<AppOwnershipStore, "getOwnership">;
  /** Workspace-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
}

export interface CreateWorkspaceDriftCheckOptions {
  readonly limit?: number;
  readonly actorAccountId?: string;
  /** Internal scheduled page. Revalidate membership/status without widening it. */
  readonly capsuleIds?: readonly string[];
}

export class RunGroupsService {
  readonly #store: OpenTofuControlStore;
  readonly #controller: OpenTofuController;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;
  readonly #actor?: string;
  readonly #systemOwnedFlow: boolean;
  readonly #appAccess?: AppAccessResolver;
  readonly #appOwnership?: Pick<AppOwnershipStore, "getOwnership">;
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
    this.#systemOwnedFlow = dependencies.systemOwnedFlow === true;
    this.#appAccess = dependencies.appAccess;
    this.#appOwnership = dependencies.appOwnership;
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
  }

  /** Creates one independent plan for each source-stale Capsule. */
  async createWorkspaceUpdate(workspaceId: string, actorAccountId?: string): Promise<RunGroupWithRuns> {
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
    const failures: Record<string, "dependency_retired"> = {};
    const memberRuns: Run[] = [];
    const runGroupId = this.#newId("rg");
    const byId = new Map(capsules.map((capsule) => [capsule.id, capsule]));
    const actors = new Map<string, string | undefined>();
    for (const capsuleId of members) {
      actors.set(capsuleId, await this.#runActor(byId.get(capsuleId)!, actorAccountId));
    }
    for (const layer of layers) {
      for (const capsuleId of layer) {
        let response;
        try {
          const actor = actors.get(capsuleId);
          response = await this.#controller.createCapsulePlan(
            capsuleId,
            actor ? { actor } : {},
            // A Workspace update re-plans each app's tracked ref as configured;
            // a retry of one member repeats exactly that.
            { runGroupId, origin: { kind: "update" } },
          );
        } catch (error) {
          if (!isRetiredDependencyError(error)) throw error;
          failures[capsuleId] = "dependency_retired";
          continue;
        }
        runs[capsuleId] = response.planRun.id;
        memberRuns.push(await this.#controller.getRun(response.planRun.id));
      }
    }
    const graph: WorkspaceUpdateGraph = { order: layers, runs, failures };
    const runGroup: RunGroup = {
      id: runGroupId,
      workspaceId,
      type: "workspace_update",
      // The persisted status is the creation-time snapshot; reads recompute it
      // from member runs. A fresh group with queued/running members is `running`.
      status: computeGroupStatus(memberRuns, Object.keys(failures).length > 0),
      graphJson: JSON.stringify(graph),
      createdAt: this.#now(),
    };
    await this.#store.putRunGroup(runGroup);
    // Activity (§27 / §34): preserve the graph's membership, successful run ids,
    // and pre-plan failure reasons using identifier/reason metadata only.
    await this.#activity.record({
      workspaceId,
      ...(actorAccountId || this.#actor ? { actorId: actorAccountId ?? this.#actor } : {}),
      action: "run_group.created",
      targetType: "run_group",
      targetId: runGroup.id,
      metadata: {
        type: runGroup.type,
        memberCapsuleIds: [...members],
        runIds: Object.values(runs),
        failures,
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
    const failures: Record<string, "dependency_retired"> = {};
    const memberRuns: Run[] = [];
    const runGroupId = this.#newId("rg");
    const byId = new Map(capsules.map((capsule) => [capsule.id, capsule]));
    const actors = new Map<string, string | undefined>();
    for (const capsuleId of capsuleIds) {
      actors.set(capsuleId, await this.#runActor(byId.get(capsuleId)!, options.actorAccountId));
    }

    for (const layer of layers) {
      for (const capsuleId of layer) {
        let response;
        try {
          const actor = actors.get(capsuleId);
          response = await this.#controller.createCapsuleDriftCheck(
            capsuleId,
            actor ? { actor } : {},
            { runGroupId },
          );
        } catch (error) {
          if (!isRetiredDependencyError(error)) throw error;
          failures[capsuleId] = "dependency_retired";
          continue;
        }
        runs[capsuleId] = response.planRun.id;
        memberRuns.push(await this.#controller.getRun(response.planRun.id));
      }
    }

    const graph: WorkspaceUpdateGraph = { order: layers, runs, failures };
    const runGroup: RunGroup = {
      id: runGroupId,
      workspaceId,
      type: "workspace_drift_check",
      status: computeGroupStatus(memberRuns, Object.keys(failures).length > 0),
      graphJson: JSON.stringify(graph),
      createdAt: this.#now(),
    };
    await this.#store.putRunGroup(runGroup);
    await this.#activity.record({
      workspaceId,
      ...(options.actorAccountId || this.#actor ? { actorId: options.actorAccountId ?? this.#actor } : {}),
      action: "run_group.created",
      targetType: "run_group",
      targetId: runGroup.id,
      metadata: {
        type: runGroup.type,
        memberCapsuleIds: capsuleIds,
        runIds: Object.values(runs),
        failures,
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
        status: computeGroupStatus(memberRuns, hasRecordedFailures(graph)),
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
  async approveRunGroup(id: string, actorAccountId?: string): Promise<RunGroupWithRuns | undefined> {
    requireNonEmptyString(id, "runGroupId");
    const stored = await this.#store.getRunGroup(id);
    if (!stored) return undefined;
    const graph = parseWorkspaceUpdateGraph(stored.graphJson);
    const awaiting = (await this.#memberRuns(graph)).filter((run) => run.status === "waiting_approval");
    const approvals = [] as { readonly runId: string; readonly actor?: string }[];
    for (const run of awaiting) {
      const capsule = run.capsuleId ? await this.#store.getCapsule(run.capsuleId) : undefined;
      if (!capsule || capsule.workspaceId !== stored.workspaceId) {
        throw new OpenTofuControllerError("failed_precondition", "RunGroup member app is unavailable");
      }
      const actor = await this.#runActor(capsule, actorAccountId);
      approvals.push({ runId: run.id, actor });
    }
    for (const approval of approvals) {
      await this.#controller.approveRun(
        approval.runId,
        approval.actor ? { approvedBy: approval.actor } : {},
      );
    }
    return await this.getRunGroup(id);
  }

  async #runActor(capsule: Capsule, actorAccountId?: string): Promise<string | undefined> {
    const ownership = this.#appOwnership
      ? await this.#appOwnership.getOwnership(capsule.id)
      : undefined;
    const ownerAccountId = ownership?.ownerAccountId;
    const ownershipEpoch = ownership?.ownershipEpoch;
    if (actorAccountId) {
      if (actorAccountId.startsWith("system:")) {
        throw new OpenTofuControllerError("permission_denied", "System actor is not an account authority");
      }
      if (!ownerAccountId) return actorAccountId;
      const access = await this.#appAccess?.resolveAppAccess(actorAccountId, capsule.id);
      if (!access || access.ownerAccountId !== ownerAccountId ||
        (ownershipEpoch !== undefined && access.ownershipEpoch !== ownershipEpoch) ||
        (access.role !== "owner" && access.role !== "member")) {
        throw new OpenTofuControllerError("permission_denied", "RunGroup actor has no current app access");
      }
      return actorAccountId;
    }
    if (!this.#systemOwnedFlow) return this.#actor;
    // Legacy Capsules without a backfilled app owner keep the historical
    // system actor so stale auto-plans remain runnable after owner minting is
    // deliberately skipped. Backfilled apps use their actual owner actor.
    return ownerAccountId?.trim() || this.#actor;
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
 * if any cancelled and none failed, succeeded when all succeeded. Recorded
 * pre-plan member failures count as failed Runs; an otherwise empty member set
 * reads as `succeeded`. The precedence order below is the load-bearing part.
 */
export function computeGroupStatus(
  runs: readonly Run[],
  hasMemberFailure = false,
): RunGroupStatus {
  if (runs.length === 0) return hasMemberFailure ? "failed" : "succeeded";
  let anyFailed = hasMemberFailure;
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

function isRetiredDependencyError(error: unknown): error is OpenTofuControllerError {
  return error instanceof OpenTofuControllerError &&
    error.code === "dependency_retired";
}

function hasRecordedFailures(graph: WorkspaceUpdateGraph): boolean {
  return Object.keys(graph.failures ?? {}).length > 0;
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
  const failures: Record<string, "dependency_retired"> = {};
  if (record.failures && typeof record.failures === "object") {
    for (const [key, value] of Object.entries(record.failures)) {
      if (value === "dependency_retired") failures[key] = value;
    }
  }
  return { order, runs, failures };
}
