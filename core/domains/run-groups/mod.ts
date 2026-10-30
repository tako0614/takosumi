/**
 * Read-only access to RunGroups written before their retirement (TASK-0118
 * stage 9.1).
 *
 * The Workspace bulk operations that created RunGroups (`workspace_update`,
 * `workspace_drift_check`) and RunGroup approval are retired: the scheduled
 * sweep and the per-app routes plan, drift-check and approve each app on its
 * own. Production and staging hold no RunGroup rows; this service only keeps
 * an existing row readable. Stage 9.5 deletes it and 9.6 drops the table.
 */

import type {
  Run,
  RunGroupStatus,
  RunGroupWithRuns,
} from "takosumi-contract/runs";
import { requireNonEmptyString } from "../deploy-control/errors.ts";
import type { OpenTofuController } from "../deploy-control/mod.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";

/**
 * Recorded layers and per-member plan Run ids of a historical RunGroup.
 */
export interface WorkspaceUpdateGraph {
  /** Recorded member layers. */
  readonly order: readonly (readonly string[])[];
  /** Member capsule id -> the plan Run id created for it. */
  readonly runs: Readonly<Record<string, string>>;
  /** Member capsule id -> pre-plan failure reason. Older graphs omit this. */
  readonly failures?: Readonly<Record<string, "dependency_retired">>;
}

export interface RunGroupsServiceDependencies {
  readonly store: Pick<OpenTofuControlStore, "getRunGroup" | "getPlanRun">;
  /** Unified `getRun` for the member Runs at read time. */
  readonly controller: Pick<OpenTofuController, "getRun">;
}

export class RunGroupsService {
  readonly #store: RunGroupsServiceDependencies["store"];
  readonly #controller: RunGroupsServiceDependencies["controller"];

  constructor(dependencies: RunGroupsServiceDependencies) {
    this.#store = dependencies.store;
    this.#controller = dependencies.controller;
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
