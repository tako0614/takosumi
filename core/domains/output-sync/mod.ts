/** Takosumi-specific Workspace Output Sync extension. */

import type { PlanRun, ApplyRun } from "@takosumi/internal/deploy-control-api";
import type { JsonValue } from "takosumi-contract";
import {
  TAKOSUMI_OUTPUT_SYNC_CAPABILITY,
  type WorkspaceOutputSyncSnapshot,
  type WorkspaceOutputSyncState,
  type WorkspaceOutputSyncStatusResponse,
} from "takosumi-contract/output-sync";
import type { RunGroupWithRuns } from "takosumi-contract/runs";
import {
  defaultWorkspaceOutputSyncState,
  type OpenTofuDeploymentStore,
} from "../deploy-control/store.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import type { RunGroupsService } from "../run-groups/mod.ts";

const MAX_CONVERGENCE_PASSES = 5;

export class OutputSyncService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #runGroups: RunGroupsService;
  readonly #now: () => string;
  readonly #newId: (prefix: string) => string;

  constructor(input: {
    readonly store: OpenTofuDeploymentStore;
    readonly runGroups: RunGroupsService;
    readonly now?: () => string;
    readonly newId?: (prefix: string) => string;
  }) {
    this.#store = input.store;
    this.#runGroups = input.runGroups;
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#newId =
      input.newId ??
      ((prefix) =>
        `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
  }

  async getStatus(
    workspaceId: string,
  ): Promise<WorkspaceOutputSyncStatusResponse> {
    return {
      capability: TAKOSUMI_OUTPUT_SYNC_CAPABILITY,
      state: await this.#state(workspaceId),
    };
  }

  async setEnabled(
    workspaceId: string,
    enabled: boolean,
  ): Promise<WorkspaceOutputSyncStatusResponse> {
    const state = await this.#casUpdate(workspaceId, (current) => ({
      ...current,
      enabled,
      updatedAt: this.#now(),
    }));
    return { capability: TAKOSUMI_OUTPUT_SYNC_CAPABILITY, state };
  }

  async getSnapshot(workspaceId: string): Promise<WorkspaceOutputSyncSnapshot> {
    const state = await this.#state(workspaceId);
    const records =
      await this.#store.listCurrentOutputsByWorkspace(workspaceId);
    return {
      workspaceId,
      revision: state.outputRevision,
      outputs: records.map(({ capsule, output }) => ({
        capsuleId: capsule.id,
        capsuleStatus: capsule.status,
        outputId: output.id,
        stateGeneration: output.stateGeneration,
        outputDigest: output.outputDigest,
        publicOutputs: output.publicOutputs as Readonly<
          Record<string, JsonValue>
        >,
        workspaceOutputs: (output.workspaceOutputs ??
          output.spaceOutputs) as Readonly<Record<string, JsonValue>>,
        createdAt: output.createdAt,
      })),
    };
  }

  async reconcile(workspaceId: string): Promise<{
    readonly state: WorkspaceOutputSyncState;
    readonly reconciliation?: RunGroupWithRuns;
  }> {
    const initialStored =
      await this.#store.getWorkspaceOutputSyncState(workspaceId);
    let state =
      initialStored ??
      defaultWorkspaceOutputSyncState(workspaceId, this.#now());
    if (!state.enabled) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "output_sync_disabled: enable Workspace Output Sync before reconciling",
      );
    }

    if (state.activeRunGroupId) {
      const reconciliation = await this.#runGroups.advanceWorkspaceOutputSync(
        state.activeRunGroupId,
      );
      state = await this.#finishOrContinue(state.workspaceId, reconciliation);
      return {
        state,
        ...(reconciliation ? { reconciliation } : {}),
      };
    }

    if (state.outputRevision <= state.reconciledRevision) return { state };
    const runnable = (await this.#store.listInstallations(workspaceId)).some(
      (capsule) => capsule.status === "active" || capsule.status === "stale",
    );
    if (!runnable) {
      state = await this.#casUpdate(workspaceId, (current) => ({
        ...current,
        reconciledRevision: current.outputRevision,
        consecutivePasses: 0,
        updatedAt: this.#now(),
      }));
      return { state };
    }
    if (state.consecutivePasses >= MAX_CONVERGENCE_PASSES) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "output_sync_non_converging: five consecutive passes changed Workspace outputs",
      );
    }
    const runGroupId = this.#newId("rg");
    const claimed = {
      ...state,
      activeRunGroupId: runGroupId,
      consecutivePasses: state.consecutivePasses + 1,
      updatedAt: this.#now(),
    };
    if (
      !(await this.#store.compareAndSetWorkspaceOutputSyncState(
        initialStored,
        claimed,
      ))
    ) {
      return await this.reconcile(workspaceId);
    }
    state = claimed;
    let reconciliation: RunGroupWithRuns;
    try {
      reconciliation = await this.#runGroups.createWorkspaceOutputSync(
        workspaceId,
        state.outputRevision,
        state.consecutivePasses,
        runGroupId,
      );
    } catch (error) {
      await this.#casUpdate(workspaceId, (current) =>
        current.activeRunGroupId === runGroupId
          ? { ...current, activeRunGroupId: undefined, updatedAt: this.#now() }
          : current,
      );
      throw error;
    }
    reconciliation =
      (await this.#runGroups.advanceWorkspaceOutputSync(
        reconciliation.runGroup.id,
      )) ?? reconciliation;
    state = await this.#finishOrContinue(workspaceId, reconciliation);
    return { state, reconciliation };
  }

  async reconcilePending(limit = 25): Promise<number> {
    const pending =
      await this.#store.listPendingWorkspaceOutputSyncStates(limit);
    let processed = 0;
    for (const state of pending) {
      try {
        await this.reconcile(state.workspaceId);
        processed += 1;
      } catch {
        // One Workspace must not block recovery for the rest of the bounded scan.
      }
    }
    return processed;
  }

  async onRunTerminal(run: PlanRun | ApplyRun): Promise<void> {
    let runGroupId = "runGroupId" in run ? run.runGroupId : undefined;
    if (!runGroupId && "planRunId" in run) {
      runGroupId = (await this.#store.getPlanRun(run.planRunId))?.runGroupId;
    }
    if (!runGroupId) return;
    const group = await this.#store.getRunGroup(runGroupId);
    if (!group || group.type !== "workspace_output_sync") return;
    const workspaceId = group.workspaceId ?? group.spaceId;
    if (!workspaceId) return;
    await this.reconcile(workspaceId);
  }

  async #finishOrContinue(
    workspaceId: string,
    reconciliation: RunGroupWithRuns | undefined,
  ): Promise<WorkspaceOutputSyncState> {
    let state = await this.#state(workspaceId);
    if (!reconciliation) {
      const cleared = await this.#casUpdate(workspaceId, (current) => ({
        ...current,
        activeRunGroupId: undefined,
        updatedAt: this.#now(),
      }));
      return cleared.enabled &&
        cleared.outputRevision > cleared.reconciledRevision
        ? (await this.reconcile(workspaceId)).state
        : cleared;
    }
    const status = reconciliation.runGroup.status;
    if (
      status !== "succeeded" &&
      status !== "failed" &&
      status !== "cancelled"
    ) {
      return state;
    }
    const targetRevision = targetRevisionOf(reconciliation.runGroup.graphJson);
    const groupId = reconciliation.runGroup.id;
    const next = await this.#casUpdate(workspaceId, (current) =>
      current.activeRunGroupId !== groupId
        ? current
        : {
            ...current,
            reconciledRevision:
              status === "succeeded"
                ? Math.max(current.reconciledRevision, targetRevision)
                : current.reconciledRevision,
            activeRunGroupId: undefined,
            consecutivePasses:
              status === "succeeded" && current.outputRevision <= targetRevision
                ? 0
                : current.consecutivePasses,
            updatedAt: this.#now(),
          },
    );
    // A successful pass may itself have changed another Capsule's projected
    // outputs. Start the bounded follow-up immediately rather than waiting for
    // the cron recovery scan.
    if (
      status === "succeeded" &&
      next.enabled &&
      next.outputRevision > next.reconciledRevision &&
      next.consecutivePasses < MAX_CONVERGENCE_PASSES
    ) {
      return (await this.reconcile(next.workspaceId)).state;
    }
    return next;
  }

  async #state(workspaceId: string): Promise<WorkspaceOutputSyncState> {
    return (
      (await this.#store.getWorkspaceOutputSyncState(workspaceId)) ??
      defaultWorkspaceOutputSyncState(workspaceId, this.#now())
    );
  }

  async #casUpdate(
    workspaceId: string,
    update: (current: WorkspaceOutputSyncState) => WorkspaceOutputSyncState,
  ): Promise<WorkspaceOutputSyncState> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const stored = await this.#store.getWorkspaceOutputSyncState(workspaceId);
      const current =
        stored ?? defaultWorkspaceOutputSyncState(workspaceId, this.#now());
      const next = update(current);
      if (sameState(current, next)) return current;
      if (
        await this.#store.compareAndSetWorkspaceOutputSyncState(stored, next)
      ) {
        return next;
      }
    }
    throw new OpenTofuControllerError(
      "failed_precondition",
      "output_sync_conflict: Workspace Output Sync state changed concurrently",
    );
  }
}

function targetRevisionOf(graphJson: string): number {
  try {
    const value = JSON.parse(graphJson) as {
      readonly targetRevision?: unknown;
    };
    return typeof value.targetRevision === "number" ? value.targetRevision : 0;
  } catch {
    return 0;
  }
}

function sameState(
  left: WorkspaceOutputSyncState,
  right: WorkspaceOutputSyncState,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.outputRevision === right.outputRevision &&
    left.reconciledRevision === right.reconciledRevision &&
    left.activeRunGroupId === right.activeRunGroupId &&
    left.consecutivePasses === right.consecutivePasses &&
    left.updatedAt === right.updatedAt
  );
}
