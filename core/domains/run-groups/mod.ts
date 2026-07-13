/**
 * RunGroups domain service (Core Specification §19 / §24 — "RunGroup basic").
 *
 * A RunGroup orders multiple Runs across the Space's dependency DAG. The
 * implemented group types are:
 *   - `space_update`: after stale propagation marks downstream consumers
 *     `stale` (§24), re-plan every stale Installation plus its downstream in
 *     producer-before-consumer topological order.
 *   - `space_drift_check`: create one read-only `drift_check` Run per active
 *     Installation in a Space, grouped under one ledger row for scheduled and
 *     operator-initiated sweep observability.
 *
 * There is NO orchestration daemon. The per-installation write lease already
 * serializes applies, so this service only:
 *   - builds the member set + topological layers (graphJson),
 *   - creates ONE plan Run per member through the controller (carrying the
 *     RunGroup id), and
 *   - persists the run_groups row.
 *
 * Group status is COMPUTED at read time from the member runs (read through the
 * controller's unified `getRun`); no status is persisted on the row beyond its
 * creation snapshot. This is "RunGroup basic": the topological order is recorded
 * and members are created, but applying each member is driven by the existing
 * per-run apply flow (manual approve + createApplyRun), not by this service.
 */

import type {
  Run,
  RunGroup,
  RunGroupStatus,
  RunGroupWithRuns,
} from "takosumi-contract/runs";
import { GraphCycleError, topologicalLayers } from "takosumi-graph";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentController } from "../deploy-control/mod.ts";
import { applyExpectedGuardFromPlanRun } from "../deploy-control/mod.ts";
import type {
  OpenTofuDeploymentStore,
  StoredRunRecord,
} from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";

/**
 * The graphJson recorded on a `space_update` RunGroup row: the topological
 * layers (producer-before-consumer) over the member set and the per-member plan
 * Run id. Parsed at read time to drive the dashboard graph view.
 */
export interface SpaceUpdateGraph {
  /** Topological layers of member installation ids (layer 0 has no producers). */
  readonly order: readonly (readonly string[])[];
  /** Member installation id -> the plan Run id created for it. */
  readonly runs: Readonly<Record<string, string>>;
}

export interface WorkspaceOutputSyncGraph extends SpaceUpdateGraph {
  readonly mode: "workspace_output_sync";
  readonly targetRevision: number;
  readonly pass: number;
  readonly currentLayer: number;
}

export interface RunGroupsServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  /** Drives `createInstallationPlan` per member + unified `getRun` at read time. */
  readonly controller: OpenTofuDeploymentController;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  readonly actor?: string;
  /** Space-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
}

export interface CreateSpaceDriftCheckOptions {
  readonly limit?: number;
}

export class RunGroupsService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #controller: OpenTofuDeploymentController;
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

  /**
   * Creates a `space_update` RunGroup for a Space (spec §19 / §24). The member
   * set is every `stale` Installation in the Space plus the transitive
   * downstream of any member (so a chained re-plan is captured even when the far
   * consumer has not been flagged yet). Members are ordered into topological
   * layers (producers before consumers) over the Space's dependency edges, and
   * ONE plan Run is created per member through the controller — each carrying
   * the RunGroup id so the §19 Run projects `runGroupId`. The run_groups row
   * records the order + the per-member run id. An empty member set is a typed
   * `failed_precondition` (`nothing_to_update`).
   */
  async createWorkspaceUpdate(spaceId: string): Promise<RunGroupWithRuns> {
    requireNonEmptyString(spaceId, "spaceId");
    const installations = await this.#store.listInstallations(spaceId);
    const edges = (await this.#store.listDependenciesBySpace(spaceId)).map(
      (edge) => ({
        from: edge.producerInstallationId,
        to: edge.consumerInstallationId,
      }),
    );
    // The member set: every stale Installation, plus the transitive downstream
    // of each stale member (a stale producer's consumers must re-plan too even
    // if they have not yet been flagged). Computed by closing the stale set over
    // the dependency edges.
    const installationById = new Map(
      installations.map((installation) => [installation.id, installation]),
    );
    const stale = new Set(
      installations
        .filter((installation) => installation.status === "stale")
        .map((installation) => installation.id),
    );
    const members = closeDownstream(stale, edges);
    if (members.size === 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "nothing_to_update: no stale capsules to re-plan",
      );
    }
    // Topological layers over the member set, restricted to edges whose BOTH
    // endpoints are members so the ordering is well-defined within the group.
    const memberEdges = edges.filter(
      (edge) => members.has(edge.from) && members.has(edge.to),
    );
    const layers = topologicalLayersOrPrecondition(
      [...members],
      memberEdges,
      spaceId,
    );
    // Create one plan Run per member, layer by layer (producers first). The
    // member must still exist; a member missing from the ledger is a precondition
    // error (the snapshot raced a delete).
    const runs: Record<string, string> = {};
    const memberRuns: Run[] = [];
    const runGroupId = this.#newId("rg");
    for (const layer of layers) {
      for (const installationId of layer) {
        if (!installationById.has(installationId)) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            "nothing_to_update: capsule is not available to this workspace",
          );
        }
        const response = await this.#controller.createInstallationPlan(
          installationId,
          this.#actor ? { actor: this.#actor } : {},
          { runGroupId },
        );
        runs[installationId] = response.planRun.id;
        memberRuns.push(await this.#controller.getRun(response.planRun.id));
      }
    }
    const graph: SpaceUpdateGraph = { order: layers, runs };
    const runGroup: RunGroup = {
      id: runGroupId,
      spaceId,
      type: "space_update",
      // The persisted status is the creation-time snapshot; reads recompute it
      // from member runs. A fresh group with queued/running members is `running`.
      status: computeGroupStatus(memberRuns),
      graphJson: JSON.stringify(graph),
      createdAt: this.#now(),
    };
    await this.#store.putRunGroup(runGroup);
    // Activity (§27 / §34): a space_update RunGroup was created. Member ids +
    // run ids only.
    await this.#activity.record({
      workspaceId: spaceId,
      spaceId,
      ...(this.#actor ? { actorId: this.#actor } : {}),
      action: "run_group.created",
      targetType: "run_group",
      targetId: runGroup.id,
      metadata: {
        type: runGroup.type,
        memberInstallationIds: [...members],
        runIds: Object.values(runs),
      },
    });
    return { runGroup, runs: memberRuns };
  }

  /**
   * Starts a Takosumi Output Sync pass. Unlike the older space_update helper,
   * only the first topological layer is planned now; later layers are created
   * after the prior layer has either no changes or a successful apply.
   */
  async createWorkspaceOutputSync(
    workspaceId: string,
    targetRevision: number,
    pass = 1,
    requestedRunGroupId?: string,
  ): Promise<RunGroupWithRuns> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const capsules = (await this.#store.listInstallations(workspaceId)).filter(
      (capsule) => capsule.status === "active" || capsule.status === "stale",
    );
    if (capsules.length === 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "nothing_to_reconcile: no runnable capsules in this workspace",
      );
    }
    const memberIds = capsules.map((capsule) => capsule.id);
    const memberSet = new Set(memberIds);
    const edges = (await this.#store.listDependenciesBySpace(workspaceId))
      .map((edge) => ({
        from: edge.producerInstallationId,
        to: edge.consumerInstallationId,
      }))
      .filter((edge) => memberSet.has(edge.from) && memberSet.has(edge.to));
    const order = topologicalLayersOrPrecondition(
      memberIds,
      edges,
      workspaceId,
    );
    const runGroupId = requestedRunGroupId ?? this.#newId("rg");
    let graph: WorkspaceOutputSyncGraph = {
      mode: "workspace_output_sync",
      targetRevision,
      pass,
      currentLayer: 0,
      order,
      runs: {},
    };
    let group: RunGroup = {
      id: runGroupId,
      workspaceId,
      spaceId: workspaceId,
      type: "workspace_output_sync",
      status: "queued",
      graphJson: JSON.stringify(graph),
      createdAt: this.#now(),
    };
    // Persist the checkpoint before dispatching any member. A lost worker can
    // recover this row and create the still-missing layer runs idempotently.
    await this.#store.putRunGroup(group);
    graph = await this.#startOutputSyncLayer(group, graph);
    group = {
      ...group,
      status: "running",
      graphJson: JSON.stringify(graph),
    };
    await this.#store.putRunGroup(group);
    await this.#activity.record({
      workspaceId,
      spaceId: workspaceId,
      ...(this.#actor ? { actorId: this.#actor } : {}),
      action: "output_sync.started",
      targetType: "run_group",
      targetId: group.id,
      metadata: { targetRevision, pass, capsuleCount: memberIds.length },
    });
    return (await this.getRunGroup(group.id)) ?? { runGroup: group, runs: [] };
  }

  /** Advances one staged Output Sync group, and is safe to call repeatedly. */
  async advanceWorkspaceOutputSync(
    id: string,
  ): Promise<RunGroupWithRuns | undefined> {
    const stored = await this.#store.getRunGroup(id);
    if (!stored || stored.type !== "workspace_output_sync") return undefined;
    if (stored.status === "failed" || stored.status === "cancelled") {
      return await this.getRunGroup(id);
    }
    let graph = parseWorkspaceOutputSyncGraph(stored.graphJson);
    const layer = graph.order[graph.currentLayer] ?? [];
    if (layer.length === 0) {
      const completed = {
        ...stored,
        status: "succeeded" as const,
        finishedAt: this.#now(),
      };
      await this.#store.putRunGroup(completed);
      return await this.getRunGroup(id);
    }

    const workspaceRuns = await this.#store.listRunsBySpace(
      stored.workspaceId ?? stored.spaceId ?? "",
      { limit: 500 },
    );
    if (layer.some((capsuleId) => !graph.runs[capsuleId])) {
      graph = await this.#startOutputSyncLayer(stored, graph, workspaceRuns);
      await this.#store.putRunGroup({
        ...stored,
        status: "running",
        graphJson: JSON.stringify(graph),
      });
    }
    for (const capsuleId of layer) {
      const planId = graph.runs[capsuleId];
      if (!planId) return await this.getRunGroup(id);
      const plan = await this.#store.getPlanRun(planId);
      if (!plan) return await this.getRunGroup(id);
      if (plan.status === "failed" || plan.status === "cancelled") {
        const failed = {
          ...stored,
          status:
            plan.status === "failed"
              ? ("failed" as const)
              : ("cancelled" as const),
          finishedAt: this.#now(),
        };
        await this.#store.putRunGroup(failed);
        return await this.getRunGroup(id);
      }
      if (
        plan.status === "queued" ||
        plan.status === "running" ||
        plan.status === "waiting_approval"
      ) {
        return await this.getRunGroup(id);
      }
      if (
        plan.planResourceChanges !== undefined &&
        plan.planResourceChanges.length === 0
      )
        continue;
      const apply = workspaceRuns.find(
        (run) => "planRunId" in run && run.planRunId === plan.id,
      );
      if (!apply || apply.status === "queued" || apply.status === "running") {
        return await this.getRunGroup(id);
      }
      if (apply.status !== "succeeded") {
        const failed = {
          ...stored,
          status:
            apply.status === "cancelled"
              ? ("cancelled" as const)
              : ("failed" as const),
          finishedAt: this.#now(),
        };
        await this.#store.putRunGroup(failed);
        return await this.getRunGroup(id);
      }
    }

    const nextLayer = graph.currentLayer + 1;
    if (nextLayer >= graph.order.length) {
      const completed = {
        ...stored,
        status: "succeeded" as const,
        finishedAt: this.#now(),
      };
      await this.#store.putRunGroup(completed);
      return await this.getRunGroup(id);
    }
    graph = { ...graph, currentLayer: nextLayer };
    graph = await this.#startOutputSyncLayer(stored, graph);
    await this.#store.putRunGroup({
      ...stored,
      status: "running",
      graphJson: JSON.stringify(graph),
    });
    // Inline/local runners may have completed the newly-created layer before
    // createInstallationPlan returned. Re-enter once so that terminal layer is
    // not stranded waiting for the scheduled recovery scan.
    return await this.advanceWorkspaceOutputSync(id);
  }

  async #startOutputSyncLayer(
    group: RunGroup,
    graph: WorkspaceOutputSyncGraph,
    knownWorkspaceRuns?: readonly StoredRunRecord[],
  ): Promise<WorkspaceOutputSyncGraph> {
    const runs = { ...graph.runs };
    const workspaceId = group.workspaceId ?? group.spaceId ?? "";
    const existingRuns =
      knownWorkspaceRuns ??
      (await this.#store.listRunsBySpace(workspaceId, { limit: 500 }));
    for (const capsuleId of graph.order[graph.currentLayer] ?? []) {
      if (runs[capsuleId]) continue;
      const existing = existingRuns.find(
        (run) =>
          "runGroupId" in run &&
          run.runGroupId === group.id &&
          "requiredProviders" in run &&
          (run.capsuleId ?? run.installationId) === capsuleId &&
          run.operation !== "destroy",
      );
      if (existing) {
        runs[capsuleId] = existing.id;
        continue;
      }
      const response = await this.#controller.createInstallationPlan(
        capsuleId,
        { actor: this.#actor ?? "system:output-sync" },
        { runGroupId: group.id, autoApplyRequested: true },
      );
      runs[capsuleId] = response.planRun.id;
    }
    return { ...graph, runs };
  }

  /**
   * Creates a `space_drift_check` RunGroup for one Space. Unlike
   * `space_update`, drift checks are read-only and independent, but recording
   * them as a RunGroup gives scheduled sweeps a single Space-scoped ledger row
   * and lets the dashboard read the member `drift_check` Runs through the same
   * §19 Run projection. Only `active` Installations are checked; an empty active
   * set is a typed `failed_precondition` (`nothing_to_drift_check`).
   */
  async createWorkspaceDriftCheck(
    spaceId: string,
    options: CreateSpaceDriftCheckOptions = {},
  ): Promise<RunGroupWithRuns> {
    requireNonEmptyString(spaceId, "spaceId");
    const limit = normalizePositiveLimit(options.limit);
    const installations = (await this.#store.listInstallations(spaceId))
      .filter((installation) => installation.status === "active")
      .slice(0, limit);
    if (installations.length === 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "nothing_to_drift_check: no active capsules to drift-check",
      );
    }

    const installationIds = installations.map(
      (installation) => installation.id,
    );
    const dependencyEdges = (await this.#store.listDependenciesBySpace(spaceId))
      .map((edge) => ({
        from: edge.producerInstallationId,
        to: edge.consumerInstallationId,
      }))
      .filter(
        (edge) =>
          installationIds.includes(edge.from) &&
          installationIds.includes(edge.to),
      );
    const layers = topologicalLayersOrPrecondition(
      installationIds,
      dependencyEdges,
      spaceId,
    );
    const runs: Record<string, string> = {};
    const memberRuns: Run[] = [];
    const runGroupId = this.#newId("rg");

    for (const layer of layers) {
      for (const installationId of layer) {
        const response = await this.#controller.createInstallationDriftCheck(
          installationId,
          this.#actor ? { actor: this.#actor } : {},
          { runGroupId },
        );
        runs[installationId] = response.planRun.id;
        memberRuns.push(await this.#controller.getRun(response.planRun.id));
      }
    }

    const graph: SpaceUpdateGraph = { order: layers, runs };
    const runGroup: RunGroup = {
      id: runGroupId,
      spaceId,
      type: "space_drift_check",
      status: computeGroupStatus(memberRuns),
      graphJson: JSON.stringify(graph),
      createdAt: this.#now(),
    };
    await this.#store.putRunGroup(runGroup);
    await this.#activity.record({
      workspaceId: spaceId,
      spaceId,
      ...(this.#actor ? { actorId: this.#actor } : {}),
      action: "run_group.created",
      targetType: "run_group",
      targetId: runGroup.id,
      metadata: {
        type: runGroup.type,
        memberInstallationIds: installationIds,
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
  /** @deprecated transient alias for {@link createWorkspaceUpdate}. */
  async createSpaceUpdate(spaceId: string): Promise<RunGroupWithRuns> {
    return await this.createWorkspaceUpdate(spaceId);
  }

  /** @deprecated transient alias for {@link createWorkspaceDriftCheck}. */
  async createSpaceDriftCheck(
    spaceId: string,
    options: CreateSpaceDriftCheckOptions = {},
  ): Promise<RunGroupWithRuns> {
    return await this.createWorkspaceDriftCheck(spaceId, options);
  }

  async getRunGroup(id: string): Promise<RunGroupWithRuns | undefined> {
    requireNonEmptyString(id, "runGroupId");
    const stored = await this.#store.getRunGroup(id);
    if (!stored) return undefined;
    const graph = parseSpaceUpdateGraph(stored.graphJson);
    const memberRuns = await this.#memberRuns(graph);
    return {
      runGroup: {
        ...stored,
        status:
          stored.type === "workspace_output_sync"
            ? stored.status
            : computeGroupStatus(memberRuns),
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
    const graph = parseSpaceUpdateGraph(stored.graphJson);
    for (const run of await this.#memberRuns(graph)) {
      if (run.status !== "waiting_approval") continue;
      await this.#controller.approveRun(
        run.id,
        this.#actor ? { approvedBy: this.#actor } : {},
      );
      if (stored.type === "workspace_output_sync") {
        const plan = await this.#store.getPlanRun(run.id);
        if (plan && (plan.planResourceChanges?.length ?? 0) > 0) {
          await this.#controller.createApplyRun(
            {
              planRunId: plan.id,
              expected: applyExpectedGuardFromPlanRun(plan),
              confirmDestructive: true,
            },
            { actor: this.#actor ?? "system:output-sync" },
          );
        }
      }
    }
    if (stored.type === "workspace_output_sync") {
      await this.advanceWorkspaceOutputSync(id);
    }
    return await this.getRunGroup(id);
  }

  /** Reads the member Runs of a parsed graph through the controller's getRun. */
  async #memberRuns(graph: SpaceUpdateGraph): Promise<Run[]> {
    const runs: Run[] = [];
    // Iterate in the recorded topological order so the member list is stable.
    for (const layer of graph.order) {
      for (const installationId of layer) {
        const runId = graph.runs[installationId];
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
 * Builds the topological layers for a RunGroup member set, translating a
 * {@link GraphCycleError} (the member edges contain a cycle — the Space's
 * dependency DAG is wedged) into a typed `failed_precondition` instead of
 * letting it escape as an uncaught 500. The cycle is normally prevented at
 * Dependency creation, so a cycle here means a pre-existing wedge that the
 * operator must repair (delete one of the offending edges) before a RunGroup
 * can order the affected Installations.
 */
function topologicalLayersOrPrecondition(
  nodes: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
  spaceId: string,
): string[][] {
  try {
    return topologicalLayers(nodes, edges);
  } catch (error) {
    if (error instanceof GraphCycleError) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "dependency_cycle: workspace dependency graph contains a cycle; resolve the cycle before running a RunGroup",
      );
    }
    throw error;
  }
}

/**
 * Closes a seed set over the producer -> consumer edges: the seed installations
 * plus every transitive downstream consumer. The seed is always included even
 * when it has no downstream edge.
 */
function closeDownstream(
  seed: ReadonlySet<string>,
  edges: readonly { readonly from: string; readonly to: string }[],
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const closure = new Set<string>(seed);
  const stack = [...seed];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    for (const consumer of adjacency.get(node) ?? []) {
      if (!closure.has(consumer)) {
        closure.add(consumer);
        stack.push(consumer);
      }
    }
  }
  return closure;
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

function parseSpaceUpdateGraph(graphJson: string): SpaceUpdateGraph {
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

function parseWorkspaceOutputSyncGraph(
  graphJson: string,
): WorkspaceOutputSyncGraph {
  const base = parseSpaceUpdateGraph(graphJson);
  let record: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(graphJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    // The base parser already normalizes malformed JSON to an empty graph.
  }
  return {
    ...base,
    mode: "workspace_output_sync",
    targetRevision:
      typeof record.targetRevision === "number" ? record.targetRevision : 0,
    pass: typeof record.pass === "number" ? record.pass : 1,
    currentLayer:
      typeof record.currentLayer === "number" ? record.currentLayer : 0,
  };
}
