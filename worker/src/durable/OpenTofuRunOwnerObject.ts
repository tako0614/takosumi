import type { CloudflareWorkerEnv, OpenTofuRunAction } from "../bindings.ts";
import { cachedRunOwnerDeployControlService } from "../deploy_control_seam.ts";
import { InstallationLeaseBusyError } from "../../../core/domains/deploy-control/installation_lease.ts";
import type { RunStatus } from "takosumi-contract/runs";

const RUN_OWNER_RECORD_KEY = "run";
const RUN_OWNER_MAX_ATTEMPTS = 3;
const RUN_OWNER_RETRY_BASE_DELAY_MS = 10_000;
const RUN_OWNER_LEASE_BUSY_DELAY_MS = 10_000;
const RUN_OWNER_CONTROLLER_REQUEUE_DELAY_MS = 1_000;
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
  readonly spaceId: string;
  readonly cause?: "controller_retry";
  readonly queueAttempt?: number;
  readonly messageId?: string;
}

interface RunOwnerRecord {
  readonly kind: "takosumi.opentofu-run-owner@v1";
  readonly action: DispatchableRunAction;
  readonly requestedAction: OpenTofuRunAction;
  readonly runId: string;
  readonly spaceId: string;
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
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm?(scheduledTime: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

export interface OpenTofuRunOwnerObjectDeps {
  readonly now?: () => number;
  readonly dispatch?: (
    dispatch: {
      readonly action: DispatchableRunAction;
      readonly runId: string;
      readonly spaceId: string;
    },
    env: CloudflareWorkerEnv,
  ) => Promise<void>;
  readonly readRunStatus?: (
    dispatch: {
      readonly action: DispatchableRunAction;
      readonly runId: string;
      readonly spaceId: string;
    },
    env: CloudflareWorkerEnv,
  ) => Promise<RunStatus | undefined>;
  readonly markRetriesExhausted?: (
    dispatch: {
      readonly action: DispatchableRunAction;
      readonly runId: string;
      readonly spaceId: string;
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
      spaceId: input.spaceId,
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
        spaceId: record.spaceId,
      };
      await this.#dispatch(dispatch, this.env);
      const runStatus = await this.#readRunStatus(dispatch, this.env).catch(
        () => undefined,
      );
      if (isRunStillDispatchable(runStatus)) {
        const requeueAt = this.#now() + RUN_OWNER_CONTROLLER_REQUEUE_DELAY_MS;
        await this.#writeRecord({
          ...base,
          status: "scheduled",
          startedAt: record.startedAt ?? startedAt,
          updatedAt: new Date(this.#now()).toISOString(),
          nextAttemptAt: new Date(requeueAt).toISOString(),
          lastScheduleCause: "controller_retry",
          lastError: `run remained ${runStatus} after dispatch`,
        });
        await this.#scheduleAlarm(requeueAt);
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

  async #recordDispatchFailure(
    record: RunOwnerRecord,
    error: unknown,
    immediateControllerRetry: boolean,
  ): Promise<boolean> {
    if (error instanceof InstallationLeaseBusyError) {
      const nextAttemptAt = new Date(
        this.#now() + RUN_OWNER_LEASE_BUSY_DELAY_MS,
      ).toISOString();
      await this.#writeRecord({
        ...record,
        status: "scheduled",
        updatedAt: new Date(this.#now()).toISOString(),
        nextAttemptAt,
        lastError: "installation lease busy",
      });
      await this.#scheduleAlarm(Date.parse(nextAttemptAt));
      return false;
    }
    if (isControllerManagedRetryError(error)) {
      const existing = await this.#readRecord();
      const now = this.#now();
      const nextAttemptAt = new Date(
        now +
          (immediateControllerRetry
            ? 0
            : RUN_OWNER_CONTROLLER_REQUEUE_DELAY_MS),
      ).toISOString();
      const next: RunOwnerRecord = {
        ...(existing?.runId === record.runId ? existing : record),
        status: "scheduled",
        updatedAt: new Date(now).toISOString(),
        nextAttemptAt,
        lastScheduleCause: "controller_retry",
        lastError: "controller-managed retry",
      };
      await this.#writeRecord(next);
      await this.#scheduleAlarm(Date.parse(nextAttemptAt));
      return true;
    }
    const attempts = record.attempts + 1;
    if (attempts >= record.maxAttempts) {
      try {
        await this.#markRetriesExhausted(
          {
            action: record.action,
            runId: record.runId,
            spaceId: record.spaceId,
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
        lastError: "opentofu run dispatch failed",
      });
      await this.state.storage.deleteAlarm?.();
      return false;
    }
    const nextAttemptAt = new Date(
      this.#now() + RUN_OWNER_RETRY_BASE_DELAY_MS * attempts,
    ).toISOString();
    await this.#writeRecord({
      ...record,
      status: "scheduled",
      attempts,
      updatedAt: new Date(this.#now()).toISOString(),
      nextAttemptAt,
      lastError: "opentofu run dispatch failed",
    });
    await this.#scheduleAlarm(Date.parse(nextAttemptAt));
    return false;
  }

  async #readRecord(): Promise<RunOwnerRecord | undefined> {
    return await this.state.storage.get<RunOwnerRecord>(RUN_OWNER_RECORD_KEY);
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
    readonly spaceId: string;
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
    readonly spaceId: string;
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
    readonly spaceId: string;
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
  const spaceId = nonEmptyString(record.spaceId);
  if (!runId || !spaceId) {
    throw new Error("runId and spaceId are required");
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
    spaceId,
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
  const { nextAttemptAt, lastError, lastScheduleCause, ...cleaned } = record;
  void nextAttemptAt;
  void lastError;
  void lastScheduleCause;
  return cleaned as RunOwnerRecord;
}

function isControllerManagedRetryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /retryable_runner_infrastructure_error/i.test(error.message)
  );
}

function isRunStillDispatchable(status: RunStatus | undefined): boolean {
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
