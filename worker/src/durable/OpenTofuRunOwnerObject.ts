import type { CloudflareWorkerEnv, OpenTofuRunAction } from "../bindings.ts";
import { cachedRunOwnerDeployControlService } from "../deploy_control_seam.ts";
import {
  isRunnerInfrastructureRequeueError,
  OpenTofuControllerError,
} from "../../../core/domains/deploy-control/errors.ts";
import { CapsuleLeaseBusyError } from "../../../core/domains/deploy-control/capsule_lease.ts";
import {
  PollSchedule,
  RetrySchedule,
} from "../../../core/shared/lifecycle/mod.ts";
import { log } from "../../../core/shared/log.ts";
import type { RunStatus } from "takosumi-contract/runs";

const RUN_OWNER_RECORD_KEY = "run";
const RUN_OWNER_MAX_ATTEMPTS = 3;
const RUN_OWNER_RETRY_BASE_DELAY_MS = 10_000;
const RUN_OWNER_RETRY_MAX_DELAY_MS = 60_000;
const RUN_OWNER_LEASE_BUSY_DELAY_MS = 10_000;
const RUN_OWNER_CONTROLLER_REQUEUE_DELAY_MS = 1_000;
const RUN_OWNER_CONTROLLER_POLL_MAX_DELAY_MS = 60_000;
/**
 * Total budget for waiting on the control ledger to settle after a dispatch.
 * Reaching it is not "the run failed" — it means this owner can no longer
 * observe the run, so it parks loudly and hands the run back to the scheduled
 * repair sweep instead of re-poking the controller forever.
 */
const RUN_OWNER_CONTROLLER_POLL_DEADLINE_MS = 15 * 60 * 1000;

/**
 * Waiting for the controller/ledger is a POLL, not a retry: a run that is still
 * `queued` because the runner pool is full, or a ledger read that timed out, is
 * a normal state and must not burn the dispatch retry budget. It must also not
 * re-arm at a flat 1s forever, which is what an unbounded requeue delay did:
 * every alarm re-dispatched, so a run whose row was missing pinned one Durable
 * Object at 1 Hz with no attempt counter, no ceiling, and no log line.
 */
/** Synthetic observed-status token for a runner-infrastructure requeue. */
const CONTROLLER_REQUEUE_STATUS = "runner_requeued";

const RUN_OWNER_CONTROLLER_POLL = new PollSchedule({
  minDelayMs: RUN_OWNER_CONTROLLER_REQUEUE_DELAY_MS,
  maxDelayMs: RUN_OWNER_CONTROLLER_POLL_MAX_DELAY_MS,
  deadlineMs: RUN_OWNER_CONTROLLER_POLL_DEADLINE_MS,
  jitter: "full",
});
// This is the recovery window for a RunOwner DO that resets after the
// controller already put the run ledger back to queued. Normal long dispatches
// stay serialized by the same DO event, so a shorter alarm mainly reduces the
// user-visible stall after runner infrastructure resets.
const RUN_OWNER_RUNNING_STALE_MS = 90 * 1000;

type DispatchableRunAction = "plan" | "apply" | "source_sync" | "restore";

interface RunOwnerStartRequest {
  readonly kind: "takosumi.opentofu-run-owner.start@v1";
  readonly action: OpenTofuRunAction;
  readonly runId: string;
  readonly workspaceId: string;
  readonly cause?: "controller_retry";
  readonly queueAttempt?: number;
  readonly messageId?: string;
}

interface RunOwnerRecord {
  readonly kind: "takosumi.opentofu-run-owner@v1";
  readonly action: DispatchableRunAction;
  readonly requestedAction: OpenTofuRunAction;
  readonly runId: string;
  readonly workspaceId: string;
  readonly status: "scheduled" | "running" | "succeeded" | "failed";
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly nextAttemptAt?: string;
  readonly queueAttempt?: number;
  readonly messageId?: string;
  readonly lastScheduleCause?: "controller_retry";
  readonly lastError?: string;
  /**
   * Controller/ledger poll bookkeeping. Absent on records written before the
   * poll budget existed; treated as "no poll in flight", which restarts the
   * budget rather than inheriting an unbounded one.
   */
  readonly pollAttempts?: number;
  readonly pollingSince?: string;
  readonly lastPolledStatus?: string;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(scheduledTime: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

export interface OpenTofuRunOwnerObjectDeps {
  readonly now?: () => number;
  readonly dispatch?: (
    dispatch: {
      readonly action: DispatchableRunAction;
      readonly runId: string;
      readonly workspaceId: string;
    },
    env: CloudflareWorkerEnv,
  ) => Promise<void>;
  readonly readRunStatus?: (
    dispatch: {
      readonly action: DispatchableRunAction;
      readonly runId: string;
      readonly workspaceId: string;
    },
    env: CloudflareWorkerEnv,
  ) => Promise<RunStatus | undefined>;
  readonly markRetriesExhausted?: (
    dispatch: {
      readonly action: DispatchableRunAction;
      readonly runId: string;
      readonly workspaceId: string;
    },
    env: CloudflareWorkerEnv,
  ) => Promise<void>;
}

/**
 * Per-run execution owner for queued OpenTofu work.
 *
 * The queue consumer persists only the run identity here and then acks the
 * queue message. The owner alarm performs the long controller dispatch and owns
 * retry/final-failure bookkeeping, so queue delivery lifetime no longer bounds
 * a plan/apply/restore/source-sync run.
 */
export class OpenTofuRunOwnerObject {
  readonly #now: () => number;
  readonly #dispatch: NonNullable<OpenTofuRunOwnerObjectDeps["dispatch"]>;
  readonly #readRunStatus: NonNullable<
    OpenTofuRunOwnerObjectDeps["readRunStatus"]
  >;
  readonly #markRetriesExhausted: NonNullable<
    OpenTofuRunOwnerObjectDeps["markRetriesExhausted"]
  >;

  constructor(
    readonly state: DurableObjectState,
    readonly env: CloudflareWorkerEnv,
    deps: OpenTofuRunOwnerObjectDeps = {},
  ) {
    this.#now = deps.now ?? (() => Date.now());
    this.#dispatch = deps.dispatch ?? dispatchToController;
    this.#readRunStatus = deps.readRunStatus ?? readRunStatusFromController;
    this.#markRetriesExhausted =
      deps.markRetriesExhausted ?? markRunRetriesExhausted;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, role: "opentofu-run-owner" });
    }
    if (url.pathname === "/debug" && request.method === "GET") {
      return Response.json(await this.#debugState());
    }
    if (url.pathname === "/drain" && request.method === "POST") {
      await this.#dispatchDueRun({ drainControllerRetry: true });
      return Response.json(await this.#debugState());
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    try {
      if (trimPath(url.pathname) !== "start") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const input = parseStartRequest(await readJsonObject(request));
      const record = await this.#schedule(input);
      return Response.json(
        {
          accepted: true,
          runId: record.runId,
          status: record.status,
          attempts: record.attempts,
        },
        { status: 202 },
      );
    } catch {
      return Response.json(
        { error: "invalid run owner request" },
        { status: 400 },
      );
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.#dispatchDueRun({ drainControllerRetry: true });
    } catch {
      const retryAt = this.#now() + RUN_OWNER_RETRY_BASE_DELAY_MS;
      await this.#scheduleAlarm(retryAt);
    }
  }

  async #schedule(input: RunOwnerStartRequest): Promise<RunOwnerRecord> {
    const action = dispatchableAction(input.action);
    if (!action) {
      throw new Error("unsupported run action");
    }
    const existing = await this.#readRecord();
    if (existing) {
      if (input.cause === "controller_retry") {
        const now = this.#now();
        const { finishedAt, ...retryBase } = existing;
        void finishedAt;
        const retryRecord: RunOwnerRecord = {
          ...retryBase,
          status: "scheduled",
          updatedAt: new Date(now).toISOString(),
          nextAttemptAt: new Date(now).toISOString(),
          ...(input.queueAttempt !== undefined
            ? { queueAttempt: input.queueAttempt }
            : {}),
          ...(input.messageId ? { messageId: input.messageId } : {}),
          lastScheduleCause: "controller_retry",
          lastError: "controller-managed retry",
        };
        await this.#writeRecord(retryRecord);
        await this.#scheduleAlarm(now);
        return retryRecord;
      }
      if (existing.status === "succeeded" || existing.status === "failed") {
        const runStatus = await this.#readRunStatus(
          {
            action,
            runId: input.runId,
            workspaceId: input.workspaceId,
          },
          this.env,
        ).catch(() => undefined);
        if (isRunStillDispatchable(runStatus)) {
          const now = this.#now();
          const { finishedAt, ...retryBase } = existing;
          void finishedAt;
          const retryRecord: RunOwnerRecord = {
            ...retryBase,
            action,
            requestedAction: input.action,
            status: "scheduled",
            updatedAt: new Date(now).toISOString(),
            nextAttemptAt: new Date(now).toISOString(),
            ...(input.queueAttempt !== undefined
              ? { queueAttempt: input.queueAttempt }
              : {}),
            ...(input.messageId ? { messageId: input.messageId } : {}),
            lastError: `ledger remained ${runStatus} after terminal owner record`,
          };
          await this.#writeRecord(retryRecord);
          await this.#scheduleAlarm(now);
          return retryRecord;
        }
        return existing;
      }
      const alarmAt =
        existing.status === "running"
          ? parseIsoMs(existing.updatedAt, this.#now()) +
            RUN_OWNER_RUNNING_STALE_MS
          : existing.nextAttemptAt
            ? parseIsoMs(existing.nextAttemptAt, this.#now())
            : this.#now();
      await this.#scheduleAlarm(alarmAt);
      return existing;
    }
    const now = this.#now();
    const nowIso = new Date(now).toISOString();
    const record: RunOwnerRecord = {
      kind: "takosumi.opentofu-run-owner@v1",
      action,
      requestedAction: input.action,
      runId: input.runId,
      workspaceId: input.workspaceId,
      status: "scheduled",
      attempts: 0,
      maxAttempts: RUN_OWNER_MAX_ATTEMPTS,
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(input.queueAttempt !== undefined
        ? { queueAttempt: input.queueAttempt }
        : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
    };
    await this.state.storage.put(RUN_OWNER_RECORD_KEY, record);
    await this.#scheduleAlarm(now);
    return record;
  }

  async #dispatchDueRun(
    options: { readonly drainControllerRetry?: boolean } = {},
  ): Promise<void> {
    const record = await this.#readRecord();
    if (!record) return;
    if (record.status === "succeeded" || record.status === "failed") {
      await this.state.storage.deleteAlarm?.();
      return;
    }
    const now = this.#now();
    if (record.nextAttemptAt && parseIsoMs(record.nextAttemptAt, now) > now) {
      await this.#scheduleAlarm(parseIsoMs(record.nextAttemptAt, now));
      return;
    }
    if (record.status === "running") {
      const staleAt =
        parseIsoMs(record.updatedAt, now) + RUN_OWNER_RUNNING_STALE_MS;
      if (staleAt > now) {
        await this.#scheduleAlarm(staleAt);
        return;
      }
    }
    const startedAt = new Date(now).toISOString();
    const base = clearRetryState(record);
    await this.#writeRecord({
      ...base,
      status: "running",
      startedAt: record.startedAt ?? startedAt,
      updatedAt: startedAt,
    });
    await this.#scheduleAlarm(now + RUN_OWNER_RUNNING_STALE_MS);
    try {
      const dispatch = {
        action: record.action,
        runId: record.runId,
        workspaceId: record.workspaceId,
      };
      await this.#dispatch(dispatch, this.env);
      const runStatus = await this.#readRunStatus(dispatch, this.env).catch(
        () => "unknown" as const,
      );
      if (runStatus === "unknown") {
        await this.#pollController({
          record,
          base,
          startedAt,
          observedStatus: "unknown",
          reason: "run status unavailable after dispatch",
        });
        return;
      }
      if (isRunStillDispatchable(runStatus)) {
        await this.#pollController({
          record,
          base,
          startedAt,
          observedStatus: runStatus,
          reason: `run remained ${runStatus} after dispatch`,
        });
        return;
      }
      const finishedAt = new Date(this.#now()).toISOString();
      await this.#writeRecord({
        ...base,
        status: "succeeded",
        attempts: record.attempts + 1,
        startedAt: record.startedAt ?? startedAt,
        finishedAt,
        updatedAt: finishedAt,
      });
      await this.state.storage.deleteAlarm?.();
    } catch (error) {
      const retryReady = await this.#recordDispatchFailure(
        record,
        error,
        options.drainControllerRetry === true,
      );
      if (retryReady && options.drainControllerRetry === true) {
        await this.#dispatchDueRun({ drainControllerRetry: false });
      }
    }
  }

  /**
   * Re-arms the alarm for a run whose controller/ledger state has not settled
   * yet. Every path out of here either advances a persisted poll counter with a
   * capped, jittered delay, or ends the loop at the deadline with an error log —
   * there is no branch that re-arms without accounting.
   */
  async #pollController(input: {
    readonly record: RunOwnerRecord;
    readonly base: RunOwnerRecord;
    readonly startedAt: string;
    readonly observedStatus: string;
    readonly reason: string;
  }): Promise<void> {
    const now = this.#now();
    // A different observed status is progress, so the backoff (and the budget)
    // restart. Only a stuck observation is allowed to accumulate.
    const progressed = input.record.lastPolledStatus !== input.observedStatus;
    const polls = progressed ? 0 : (input.record.pollAttempts ?? 0);
    const pollingSince =
      progressed || !input.record.pollingSince
        ? new Date(now).toISOString()
        : input.record.pollingSince;
    const decision = RUN_OWNER_CONTROLLER_POLL.next({
      polls,
      elapsedMs: now - parseIsoMs(pollingSince, now),
      now,
      reason: input.reason,
    });
    const fields = {
      runId: input.record.runId,
      workspaceId: input.record.workspaceId,
      action: input.record.action,
      observedStatus: input.observedStatus,
    };
    if (decision.kind === "deadline-exceeded") {
      log.error("takosumi.run_owner.controller_poll_deadline_exceeded", {
        ...fields,
        poll: decision.poll,
        elapsedMs: decision.elapsedMs,
        deadlineMs: decision.deadlineMs,
        reason: decision.reason,
      });
      // Park instead of looping. The scheduled run-repair sweep is the backstop
      // for a run whose ledger row is still non-terminal, and a terminal owner
      // record makes that sweep able to re-arm this object.
      const finishedAt = new Date(now).toISOString();
      await this.#writeRecord({
        ...input.base,
        status: "failed",
        startedAt: input.record.startedAt ?? input.startedAt,
        finishedAt,
        updatedAt: finishedAt,
        lastError: `${decision.reason} (poll deadline exceeded after ${decision.elapsedMs}ms)`,
      });
      await this.state.storage.deleteAlarm?.();
      return;
    }
    log.warn("takosumi.run_owner.controller_poll_scheduled", {
      ...fields,
      poll: decision.poll,
      delayMs: decision.delayMs,
      reason: decision.reason,
    });
    await this.#writeRecord({
      ...input.base,
      status: "scheduled",
      startedAt: input.record.startedAt ?? input.startedAt,
      updatedAt: new Date(now).toISOString(),
      nextAttemptAt: new Date(decision.at).toISOString(),
      lastScheduleCause: "controller_retry",
      lastError: decision.reason,
      pollAttempts: decision.poll,
      pollingSince,
      lastPolledStatus: input.observedStatus,
    });
    await this.#scheduleAlarm(decision.at);
  }

  async #recordDispatchFailure(
    record: RunOwnerRecord,
    error: unknown,
    immediateControllerRetry: boolean,
  ): Promise<boolean> {
    if (error instanceof CapsuleLeaseBusyError) {
      const nextAttemptAt = new Date(
        this.#now() + RUN_OWNER_LEASE_BUSY_DELAY_MS,
      ).toISOString();
      await this.#writeRecord({
        ...record,
        status: "scheduled",
        updatedAt: new Date(this.#now()).toISOString(),
        nextAttemptAt,
        lastError: "Capsule lease busy",
      });
      await this.#scheduleAlarm(Date.parse(nextAttemptAt));
      return false;
    }
    if (isControllerManagedRetryError(error)) {
      const existing = await this.#readRecord();
      const now = this.#now();
      const current = existing?.runId === record.runId ? existing : record;
      // Runner-infrastructure requeue is a wait for capacity, not a dispatch
      // failure, so it is accounted on the poll budget instead of the attempt
      // budget. Without that budget this branch re-armed every second forever
      // whenever the runner pool stayed unavailable.
      const progressed = current.lastPolledStatus !== CONTROLLER_REQUEUE_STATUS;
      const polls = progressed ? 0 : (current.pollAttempts ?? 0);
      const pollingSince =
        progressed || !current.pollingSince
          ? new Date(now).toISOString()
          : current.pollingSince;
      const decision = RUN_OWNER_CONTROLLER_POLL.next({
        polls,
        elapsedMs: now - parseIsoMs(pollingSince, now),
        now,
        reason: "controller-managed retry",
      });
      if (decision.kind === "deadline-exceeded") {
        log.error("takosumi.run_owner.controller_poll_deadline_exceeded", {
          runId: record.runId,
          workspaceId: record.workspaceId,
          action: record.action,
          observedStatus: CONTROLLER_REQUEUE_STATUS,
          poll: decision.poll,
          elapsedMs: decision.elapsedMs,
          deadlineMs: decision.deadlineMs,
          reason: decision.reason,
        });
        const finishedAt = new Date(now).toISOString();
        await this.#writeRecord({
          ...current,
          status: "failed",
          finishedAt,
          updatedAt: finishedAt,
          lastError: `${decision.reason} (poll deadline exceeded after ${decision.elapsedMs}ms)`,
        });
        await this.state.storage.deleteAlarm?.();
        return false;
      }
      // The first drain within one alarm still runs inline; the persisted
      // re-arm is what the schedule bounds.
      const nextAttemptMs = immediateControllerRetry ? now : decision.at;
      const next: RunOwnerRecord = {
        ...current,
        status: "scheduled",
        updatedAt: new Date(now).toISOString(),
        nextAttemptAt: new Date(nextAttemptMs).toISOString(),
        lastScheduleCause: "controller_retry",
        lastError: "controller-managed retry",
        pollAttempts: decision.poll,
        pollingSince,
        lastPolledStatus: CONTROLLER_REQUEUE_STATUS,
      };
      await this.#writeRecord(next);
      await this.#scheduleAlarm(nextAttemptMs);
      return true;
    }
    const failure = runDispatchFailureMessage(error);
    const decision = retryScheduleFor(record).next({
      attempts: record.attempts,
      now: this.#now(),
      reason: failure,
    });
    const attempts = decision.attempt;
    if (decision.kind === "exhausted") {
      log.error("takosumi.run_owner.dispatch_retries_exhausted", {
        runId: record.runId,
        workspaceId: record.workspaceId,
        action: record.action,
        attempt: decision.attempt,
        maxAttempts: decision.maxAttempts,
        reason: decision.reason,
      });
      try {
        await this.#markRetriesExhausted(
          {
            action: record.action,
            runId: record.runId,
            workspaceId: record.workspaceId,
          },
          this.env,
        );
      } catch {
        // Best-effort ledger backstop. The owner record still becomes failed
        // so the DO never loops forever on a broken failure-record path.
      }
      const finishedAt = new Date(this.#now()).toISOString();
      await this.#writeRecord({
        ...record,
        status: "failed",
        attempts,
        finishedAt,
        updatedAt: finishedAt,
        lastError: failure,
      });
      await this.state.storage.deleteAlarm?.();
      return false;
    }
    log.warn("takosumi.run_owner.dispatch_retry_scheduled", {
      runId: record.runId,
      workspaceId: record.workspaceId,
      action: record.action,
      attempt: decision.attempt,
      delayMs: decision.delayMs,
      reason: decision.reason,
    });
    await this.#writeRecord({
      ...record,
      status: "scheduled",
      attempts,
      updatedAt: new Date(this.#now()).toISOString(),
      nextAttemptAt: new Date(decision.at).toISOString(),
      lastError: failure,
    });
    await this.#scheduleAlarm(decision.at);
    return false;
  }

  async #readRecord(): Promise<RunOwnerRecord | undefined> {
    return await this.state.storage.get<RunOwnerRecord>(RUN_OWNER_RECORD_KEY);
  }

  async #debugState(): Promise<{
    readonly record?: RunOwnerRecord;
    readonly alarmAt?: number;
    readonly alarmAtIso?: string;
  }> {
    const record = await this.#readRecord();
    const alarmAt = await this.state.storage.getAlarm?.().catch(() => null);
    return {
      ...(record ? { record } : {}),
      ...(typeof alarmAt === "number"
        ? { alarmAt, alarmAtIso: new Date(alarmAt).toISOString() }
        : {}),
    };
  }

  async #writeRecord(record: RunOwnerRecord): Promise<void> {
    const normalized = Object.fromEntries(
      Object.entries(record).filter(([, value]) => value !== undefined),
    ) as RunOwnerRecord;
    await this.state.storage.put(RUN_OWNER_RECORD_KEY, normalized);
  }

  async #scheduleAlarm(scheduledTime: number): Promise<void> {
    await this.state.storage.setAlarm?.(scheduledTime);
  }
}

async function dispatchToController(
  dispatch: {
    readonly action: DispatchableRunAction;
    readonly runId: string;
    readonly workspaceId: string;
  },
  env: CloudflareWorkerEnv,
): Promise<void> {
  const service = await cachedRunOwnerDeployControlService(env);
  await service.operations.dispatchQueuedRun(dispatch);
}

async function readRunStatusFromController(
  dispatch: {
    readonly action: DispatchableRunAction;
    readonly runId: string;
    readonly workspaceId: string;
  },
  env: CloudflareWorkerEnv,
): Promise<RunStatus | undefined> {
  const service = await cachedRunOwnerDeployControlService(env);
  return (await service.operations.getRun(dispatch.runId)).status;
}

async function markRunRetriesExhausted(
  dispatch: {
    readonly action: DispatchableRunAction;
    readonly runId: string;
    readonly workspaceId: string;
  },
  env: CloudflareWorkerEnv,
): Promise<void> {
  try {
    const service = await cachedRunOwnerDeployControlService(env);
    await service.operations.controller.markRunFailed(
      dispatch.action,
      dispatch.runId,
      "retries-exhausted",
    );
  } catch {
    // Best-effort terminal backstop; the owner record still moves to failed so
    // the Durable Object does not loop forever.
  }
}

function parseStartRequest(
  record: Record<string, unknown>,
): RunOwnerStartRequest {
  if (record.kind !== "takosumi.opentofu-run-owner.start@v1") {
    throw new Error("invalid run owner kind");
  }
  const action = parseAction(record.action);
  const runId = nonEmptyString(record.runId);
  const workspaceId = nonEmptyString(record.workspaceId);
  if (!runId || !workspaceId) {
    throw new Error("runId and workspaceId are required");
  }
  const queueAttempt =
    typeof record.queueAttempt === "number" &&
    Number.isFinite(record.queueAttempt)
      ? Math.max(1, Math.floor(record.queueAttempt))
      : undefined;
  const messageId = nonEmptyString(record.messageId);
  const cause =
    record.cause === "controller_retry" ? "controller_retry" : undefined;
  return {
    kind: "takosumi.opentofu-run-owner.start@v1",
    action,
    runId,
    workspaceId,
    ...(cause ? { cause } : {}),
    ...(queueAttempt !== undefined ? { queueAttempt } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function parseAction(action: unknown): OpenTofuRunAction {
  if (
    action === "plan" ||
    action === "apply" ||
    action === "destroy" ||
    action === "source_sync" ||
    action === "compatibility_check" ||
    action === "backup" ||
    action === "restore"
  ) {
    return action;
  }
  throw new Error("invalid run action");
}

function dispatchableAction(
  action: OpenTofuRunAction,
): DispatchableRunAction | undefined {
  if (action === "destroy") return "apply";
  if (
    action === "plan" ||
    action === "apply" ||
    action === "source_sync" ||
    action === "restore"
  ) {
    return action;
  }
  return undefined;
}

function clearRetryState(record: RunOwnerRecord): RunOwnerRecord {
  const {
    nextAttemptAt,
    lastError,
    lastScheduleCause,
    pollAttempts,
    pollingSince,
    lastPolledStatus,
    ...cleaned
  } = record;
  void nextAttemptAt;
  void lastError;
  void lastScheduleCause;
  void pollAttempts;
  void pollingSince;
  void lastPolledStatus;
  return cleaned as RunOwnerRecord;
}

/**
 * The persisted `maxAttempts` stays the authority so an in-flight record keeps
 * the budget it was created with; only the delay shape comes from the module
 * constants.
 */
function retryScheduleFor(record: RunOwnerRecord): RetrySchedule {
  return new RetrySchedule({
    minDelayMs: RUN_OWNER_RETRY_BASE_DELAY_MS,
    maxDelayMs: RUN_OWNER_RETRY_MAX_DELAY_MS,
    maxAttempts: Math.max(1, Math.floor(record.maxAttempts)),
    jitter: "equal",
  });
}

function isControllerManagedRetryError(error: unknown): boolean {
  return isRunnerInfrastructureRequeueError(error);
}

function runDispatchFailureMessage(error: unknown): string {
  const prefix = "opentofu run dispatch failed";
  if (error instanceof OpenTofuControllerError) {
    return `${prefix}: ${error.code}: ${redactErrorMessage(error.message)}`;
  }
  if (error instanceof Error) {
    return `${prefix}: ${error.name}: ${redactErrorMessage(error.message)}`;
  }
  return `${prefix}: ${typeof error}`;
}

function redactErrorMessage(message: string): string {
  return message
    .replace(/(?:secret|token|key|password)[^\\s"'`]+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function isRunStillDispatchable(
  status: RunStatus | undefined,
): status is "queued" | "running" {
  return status === "queued" || status === "running";
}

function parseIsoMs(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("request body must be a JSON object");
}

function trimPath(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/g, "");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
