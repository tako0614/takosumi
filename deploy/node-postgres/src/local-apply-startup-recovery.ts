/** Two bounded startup passes; never a general Run queue or provider retry loop. */
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import type { buildComposedApp } from "./composed-app.ts";
import type { OpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import {
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  RUN_HEARTBEAT_STALE_MS,
  type OpenTofuRunner,
  type OpenTofuRunnerExecutorRegistry,
} from "../../../core/domains/deploy-control/mod.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { withCommittedLocalApplyRecovery } from "./local-apply-recovery-capability.ts";

type Operations = Pick<Awaited<ReturnType<typeof buildComposedApp>>["operations"], "controller" | "dispatchQueuedRun">;
type Store = Pick<OpenTofuControlStore, "getApplyRun" | "getPlanRun" | "getPlanRunInputs" | "getCapsule" | "getCapsuleStorageRoot" | "getWorkspace">;
const LIMIT = 25;
const PASS_BUDGET_MS = 5_000;

/** A full page is a bounded window, not a claim to have recovered all Runs. */
export async function recoverLocalAppliesAtStartup(input: {
  readonly operations: Operations;
  readonly store: Store;
  readonly runner?: OpenTofuRunner;
  readonly profiles: readonly RunnerProfile[];
  readonly executors?: OpenTofuRunnerExecutorRegistry;
  readonly startedAt: number;
}): Promise<void> {
  if (!input.runner && !input.executors?.size) return;
  const deadlineAt = Date.now() + PASS_BUDGET_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      recoverPass(input, deadlineAt),
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, PASS_BUDGET_MS); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function recoverPass(input: Parameters<typeof recoverLocalAppliesAtStartup>[0], deadlineAt: number): Promise<void> {
  const cutoff = Date.now() - RUN_HEARTBEAT_STALE_MS;
  const runs = await input.operations.controller.listRecoverableOpenTofuRuns({
    staleQueuedBeforeMs: 0, staleRunningBeforeMs: cutoff, limit: LIMIT, sweep: true,
  });
  for (const row of runs.slice(0, LIMIT)) {
    if (Date.now() >= deadlineAt) return;
    // Queue, terminal accounting tails, other actions, and work started/renewed
    // after this boot belong to their existing consumer, never this replay.
    if (row.type !== "apply" || row.status !== "running" || !row.capsuleId) continue;
    try {
      const workspace = await input.store.getWorkspace(row.workspaceId);
      if (!workspace || workspace.id !== row.workspaceId || workspace.archivedAt) continue;
      const run = await input.store.getApplyRun(row.id);
      if (!run || run.id !== row.id || run.status !== "running" || run.workspaceId !== row.workspaceId ||
        run.capsuleId !== row.capsuleId || run.operation === "destroy" ||
        !Number.isFinite(run.heartbeatAt) || run.heartbeatAt! >= cutoff || run.heartbeatAt! > input.startedAt) continue;
      const plan = await input.store.getPlanRun(run.planRunId);
      const ctx = plan?.capsuleContext;
      if (!plan || !ctx || plan.workspaceId !== run.workspaceId || plan.capsuleId !== run.capsuleId ||
        ctx.workspaceId !== run.workspaceId || ctx.capsuleId !== run.capsuleId ||
        plan.operation !== run.operation || plan.runnerProfileId !== run.runnerProfileId) continue;
      const prepared = await input.store.getPlanRunInputs(plan.id);
      // Lifecycle commands/private file refresh are separate side effects, not
      // covered by an OpenTofu state receipt. Leave these Runs untouched.
      if (!prepared || prepared.lifecycleActions?.length || prepared.privateRunFileSlots?.length) continue;
      // Core prefers its configured catalog over a persisted row. Resolve
      // from that SAME startup snapshot, or the ALS fence could protect a
      // different adapter from the one Core actually invokes.
      const profile = input.profiles.find((candidate) => candidate.id === run.runnerProfileId);
      if (!profile) continue;
      const runner = profile.executorId === DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID
        ? input.runner ?? input.executors?.get(profile.executorId)
        : input.executors?.get(profile.executorId);
      const capsule = await input.store.getCapsule(ctx.capsuleId);
      if (!capsule || capsule.workspaceId !== ctx.workspaceId || capsule.environment !== ctx.environment) continue;
      const generation = (plan.baseStateGeneration ?? 0) + 1;
      if (!Number.isSafeInteger(generation) || generation < 1) continue;
      const storageRoot = await input.store.getCapsuleStorageRoot(capsule.id);
      const stateScope = {
        workspaceId: ctx.workspaceId, subject: { kind: "capsule" as const, id: ctx.capsuleId },
        environment: ctx.environment, generation,
        stateRef: new ObjectKeyArtifactReferenceAllocator().allocate({
          kind: "state", workspaceId: ctx.workspaceId,
          subject: { kind: "capsule", id: ctx.capsuleId }, environment: ctx.environment, generation,
          ...(storageRoot === undefined ? {} : { storageRoot }),
        }),
      };
      if (Date.now() >= deadlineAt) return;
      await withCommittedLocalApplyRecovery(runner, { runId: run.id, stateScope }, async (committedApplyReceipt) => {
        if (Date.now() >= deadlineAt) return;
        await input.operations.dispatchQueuedRun({ action: "apply", runId: run.id, workspaceId: run.workspaceId }, { deadlineAt, committedApplyReceipt });
      });
    } catch {
      // Missing, corrupt or mismatched custody is not execution authority. Do
      // not terminalize, mint credentials, or dispatch in order to discover it.
    }
  }
}

export function startLocalApplyStartupRecovery(
  input: Parameters<typeof recoverLocalAppliesAtStartup>[0] & {
    readonly log: (level: "error", message: string, fields: Record<string, unknown>) => void;
  },
): { readonly stop: () => void } {
  if (!input.runner && !input.executors?.size) return { stop() {} };
  let stopped = false;
  let active: Promise<void> | undefined;
  const pass = () => {
    if (stopped || active) return;
    active = recoverLocalAppliesAtStartup(input).catch(() => {
      input.log("error", "local Apply startup recovery unavailable", { event: "local_apply_startup_recovery_unavailable" });
    }).finally(() => { active = undefined; });
  };
  pass();
  // A Run can still have a fresh pre-crash heartbeat when this API boots.
  // Once the existing Core takeover window passes, scan once more. Never poll.
  const timer = setTimeout(pass, RUN_HEARTBEAT_STALE_MS + 1_000);
  (timer as { unref?: () => void }).unref?.();
  return { stop() { stopped = true; clearTimeout(timer); } };
}
