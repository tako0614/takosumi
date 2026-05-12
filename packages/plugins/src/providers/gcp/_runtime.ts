/**
 * Production-grade runtime helpers for the GCP provider materializer suite.
 *
 * Centralises:
 * - GCP API error classification (NotFound / PermissionDenied / RateLimited /
 *   DeadlineExceeded / Conflict / Internal / Unknown) → kernel-facing
 *   `ProviderOperation.condition`-shaped record stored on `details.condition`.
 * - Retry-with-exponential-backoff for retriable transient failures.
 * - Timeout enforcement (default 30s) with `runtime-agent` handoff signalling
 *   for long-running operations (Phase 17B).
 * - Idempotency key derivation from descriptor + desiredState + targetId.
 * - Drift computation comparing observed vs desired state.
 *
 * These helpers stay transport agnostic: each provider's operator-injected
 * client (e.g. `GcpCloudRunDeployClient`) is wrapped by this layer when it
 * surfaces an `Error` shaped object. Operators can also override defaults via
 * the `runtime` option each provider exposes.
 */

import type { provider, ProviderErrorCategory } from "takosumi-contract";

/**
 * Classified GCP API condition. The discriminant maps onto well-known status
 * codes the GCP REST APIs surface in `error.status` / HTTP status. The kernel
 * records this on `Deployment.conditions[]` via the operation `details.condition`
 * field (see `ProviderOperation.details: Record<string, unknown>`).
 */
export type GcpProviderConditionStatus =
  | "ok"
  | "not-found"
  | "permission-denied"
  | "rate-limited"
  | "deadline-exceeded"
  | "conflict"
  | "failed-precondition"
  | "unavailable"
  | "internal"
  | "invalid-argument"
  | "unknown";

export interface GcpProviderCondition {
  readonly status: GcpProviderConditionStatus;
  readonly retriable: boolean;
  readonly message: string;
  /** GCP `error.status` string (e.g. `NOT_FOUND`, `PERMISSION_DENIED`). */
  readonly code?: string;
  /** HTTP status code if surfaced by the operator-injected client. */
  readonly httpStatus?: number;
}

/**
 * Heuristic classifier that interprets common error shapes:
 * - `Error` with `status` (string) and/or `code` (number/string) — common in
 *   `googleapis` / `gaxios` style clients.
 * - HTTP-style failures with `statusCode` / `httpStatus`.
 * - Plain message string fallback.
 */
export function classifyGcpError(error: unknown): GcpProviderCondition {
  if (!error) {
    return {
      status: "unknown",
      retriable: false,
      message: "unknown error",
    };
  }
  if (typeof error === "string") {
    return mapByMessage(error);
  }
  if (error instanceof Error) {
    const candidate = error as Error & {
      status?: string | number;
      code?: string | number;
      statusCode?: number;
      httpStatus?: number;
      response?: { status?: number };
    };
    const httpStatus = candidate.httpStatus ?? candidate.statusCode ??
      candidate.response?.status ??
      (typeof candidate.code === "number" ? candidate.code : undefined);
    const codeText = typeof candidate.status === "string"
      ? candidate.status
      : typeof candidate.code === "string"
      ? candidate.code
      : undefined;
    const mapped = mapByCode(codeText, httpStatus) ??
      mapByMessage(error.message);
    return {
      ...mapped,
      ...(codeText ? { code: codeText } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
  }
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const status = typeof obj.status === "string" ? obj.status : undefined;
    const httpStatus = typeof obj.statusCode === "number"
      ? obj.statusCode
      : typeof obj.httpStatus === "number"
      ? obj.httpStatus
      : undefined;
    const message = typeof obj.message === "string"
      ? obj.message
      : JSON.stringify(obj);
    const mapped = mapByCode(status, httpStatus) ?? mapByMessage(message);
    return {
      ...mapped,
      ...(status ? { code: status } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
  }
  return { status: "unknown", retriable: false, message: String(error) };
}

function mapByCode(
  code: string | undefined,
  httpStatus: number | undefined,
): GcpProviderCondition | undefined {
  switch (code) {
    case "NOT_FOUND":
      return mk("not-found", false, "GCP resource not found");
    case "PERMISSION_DENIED":
      return mk("permission-denied", false, "GCP permission denied");
    case "RESOURCE_EXHAUSTED":
      return mk("rate-limited", true, "GCP quota / rate limit exhausted");
    case "DEADLINE_EXCEEDED":
      return mk("deadline-exceeded", true, "GCP deadline exceeded");
    case "ALREADY_EXISTS":
      return mk("conflict", false, "GCP resource already exists");
    case "FAILED_PRECONDITION":
      return mk("failed-precondition", false, "GCP failed precondition");
    case "UNAVAILABLE":
      return mk("unavailable", true, "GCP backend unavailable");
    case "INTERNAL":
      return mk("internal", true, "GCP internal error");
    case "INVALID_ARGUMENT":
      return mk("invalid-argument", false, "GCP invalid argument");
  }
  if (httpStatus !== undefined) {
    if (httpStatus === 404) return mk("not-found", false, "HTTP 404");
    if (httpStatus === 403) return mk("permission-denied", false, "HTTP 403");
    if (httpStatus === 401) return mk("permission-denied", false, "HTTP 401");
    if (httpStatus === 409) return mk("conflict", false, "HTTP 409");
    if (httpStatus === 429) return mk("rate-limited", true, "HTTP 429");
    if (httpStatus === 408) return mk("deadline-exceeded", true, "HTTP 408");
    if (httpStatus === 503) return mk("unavailable", true, "HTTP 503");
    if (httpStatus === 504) return mk("deadline-exceeded", true, "HTTP 504");
    if (httpStatus >= 500) return mk("internal", true, `HTTP ${httpStatus}`);
    if (httpStatus >= 400) {
      return mk("invalid-argument", false, `HTTP ${httpStatus}`);
    }
  }
  return undefined;
}

function mapByMessage(message: string): GcpProviderCondition {
  const lc = message.toLowerCase();
  if (lc.includes("not found") || lc.includes("notfound")) {
    return mk("not-found", false, message);
  }
  if (
    lc.includes("permission denied") || lc.includes("forbidden") ||
    lc.includes("unauthorized")
  ) return mk("permission-denied", false, message);
  if (
    lc.includes("rate limit") || lc.includes("quota") ||
    lc.includes("too many requests")
  ) return mk("rate-limited", true, message);
  if (lc.includes("deadline") || lc.includes("timeout")) {
    return mk("deadline-exceeded", true, message);
  }
  if (lc.includes("already exists") || lc.includes("conflict")) {
    return mk("conflict", false, message);
  }
  if (lc.includes("unavailable")) return mk("unavailable", true, message);
  if (lc.includes("internal")) return mk("internal", true, message);
  if (lc.includes("invalid")) return mk("invalid-argument", false, message);
  return mk("unknown", false, message);
}

function mk(
  status: GcpProviderConditionStatus,
  retriable: boolean,
  message: string,
): GcpProviderCondition {
  return { status, retriable, message };
}

/** Successful condition surfaced when the operation completes without error. */
export const GCP_OK_CONDITION: GcpProviderCondition = {
  status: "ok",
  retriable: false,
  message: "ok",
};

/**
 * Phase 18.2 / H6 — Map a GCP-native {@link GcpProviderConditionStatus} onto
 * the provider-agnostic {@link ProviderErrorCategory}.
 */
export function gcpStatusToProviderCategory(
  status: GcpProviderConditionStatus,
): ProviderErrorCategory {
  switch (status) {
    case "ok":
      // `ok` is not an error category; callers should not invoke this for ok.
      return "unknown";
    case "not-found":
      return "not-found";
    case "permission-denied":
      return "permission-denied";
    case "rate-limited":
      return "rate-limited";
    case "deadline-exceeded":
    case "unavailable":
    case "internal":
      return "transient";
    case "conflict":
      return "conflict";
    case "failed-precondition":
      return "permanent";
    case "invalid-argument":
      return "invalid";
    case "unknown":
      return "unknown";
  }
}

/**
 * Phase 18.2 / H6 — Convenience wrapper that classifies a GCP error and
 * normalises it onto the provider-agnostic enum in one call.
 */
export function classifyGcpErrorAsProviderCategory(
  error: unknown,
): ProviderErrorCategory {
  return gcpStatusToProviderCategory(classifyGcpError(error).status);
}

/**
 * Retry / timeout policy applied around the operator-injected client call.
 * `defaultGcpRuntimePolicy` matches Phase 17 acceptance criteria (30s timeout,
 * 3 retries with exponential backoff, jittered).
 */
export interface GcpRuntimePolicy {
  /** Maximum total wall-clock budget per `materialize()` call. */
  readonly timeoutMs: number;
  /** Maximum retry attempts after the initial call (so 3 = 4 total calls). */
  readonly maxRetries: number;
  /** Initial backoff in ms; doubled each retry up to `maxBackoffMs`. */
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Optional jitter cap (default 100ms). */
  readonly jitterMs?: number;
  /** Long-running threshold in ms beyond which we hand off to runtime-agent. */
  readonly longRunningThresholdMs?: number;
}

export const defaultGcpRuntimePolicy: GcpRuntimePolicy = Object.freeze({
  timeoutMs: 30_000,
  maxRetries: 3,
  initialBackoffMs: 500,
  maxBackoffMs: 8_000,
  jitterMs: 100,
  longRunningThresholdMs: 25_000,
});

/** Hook surface so providers can reuse common runtime semantics. */
export interface GcpRuntimeHooks {
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly policy?: GcpRuntimePolicy;
  /** Optional runtime-agent handoff for long-running operations. */
  readonly runtimeAgentHandoff?: GcpRuntimeAgentHandoff;
}

export interface GcpRuntimeAgentHandoff {
  /**
   * Called when a materialize() call exceeds `longRunningThresholdMs`. The
   * implementation should hand the operation off to a runtime-agent so the
   * kernel can poll `observe()` later. Returns the agent work id.
   */
  enqueue(input: GcpRuntimeAgentEnqueueInput): Promise<string>;
}

export interface GcpRuntimeAgentEnqueueInput {
  readonly descriptor: string;
  readonly desiredStateId: string;
  readonly targetId?: string;
  readonly idempotencyKey: string;
  readonly enqueuedAt: string;
}

/**
 * Internal context passed to per-provider materialize implementations. Wraps
 * the policy / hooks so each provider only needs to call `withRetry()`.
 */
export interface GcpRuntimeContext {
  readonly policy: GcpRuntimePolicy;
  readonly clock: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly handoff?: GcpRuntimeAgentHandoff;
}

export function resolveRuntimeContext(
  hooks: GcpRuntimeHooks | undefined,
): GcpRuntimeContext {
  const policy = hooks?.policy ?? defaultGcpRuntimePolicy;
  const clock = hooks?.clock ?? (() => new Date());
  const sleep = hooks?.sleep ??
    ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = hooks?.random ?? Math.random;
  return {
    policy,
    clock,
    sleep,
    random,
    handoff: hooks?.runtimeAgentHandoff,
  };
}

export interface RetryAttempt {
  readonly attempt: number;
  readonly delayMs: number;
  readonly condition: GcpProviderCondition;
}

export interface RetryOutcome<T> {
  readonly result?: T;
  readonly error?: unknown;
  readonly condition: GcpProviderCondition;
  readonly attempts: readonly RetryAttempt[];
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly handedOff: boolean;
  readonly handoffWorkId?: string;
}

/**
 * Wrap an operator-injected client call with retry, timeout, and long-running
 * handoff semantics. Returns a structured outcome so the materializer can
 * record `condition` on the `ProviderOperation` regardless of success.
 */
export async function withRetry<T>(
  ctx: GcpRuntimeContext,
  operation: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<RetryOutcome<T>> {
  const startedAt = ctx.clock().getTime();
  const attempts: RetryAttempt[] = [];
  let lastCondition: GcpProviderCondition = GCP_OK_CONDITION;
  let lastError: unknown;
  const maxRetries = options.maxRetries ?? ctx.policy.maxRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const elapsed = ctx.clock().getTime() - startedAt;
    if (elapsed >= ctx.policy.timeoutMs) {
      const condition: GcpProviderCondition = {
        status: "deadline-exceeded",
        retriable: true,
        message:
          `timed out after ${elapsed}ms (budget ${ctx.policy.timeoutMs}ms)`,
      };
      const handoff = await maybeHandoff(ctx, options, "timeout");
      return {
        condition,
        attempts,
        durationMs: elapsed,
        timedOut: true,
        handedOff: handoff !== undefined,
        handoffWorkId: handoff,
        error: lastError,
      };
    }
    try {
      const result = await runWithTimeout(
        operation,
        ctx.policy.timeoutMs - elapsed,
        ctx,
      );
      return {
        result,
        condition: GCP_OK_CONDITION,
        attempts,
        durationMs: ctx.clock().getTime() - startedAt,
        timedOut: false,
        handedOff: false,
      };
    } catch (error) {
      lastError = error;
      lastCondition = classifyGcpError(error);
      if (!lastCondition.retriable || attempt === maxRetries) {
        const totalMs = ctx.clock().getTime() - startedAt;
        const handoff = lastCondition.status === "deadline-exceeded"
          ? await maybeHandoff(ctx, options, "deadline")
          : undefined;
        attempts.push({
          attempt,
          delayMs: 0,
          condition: lastCondition,
        });
        return {
          condition: lastCondition,
          attempts,
          durationMs: totalMs,
          timedOut: lastCondition.status === "deadline-exceeded",
          handedOff: handoff !== undefined,
          handoffWorkId: handoff,
          error,
        };
      }
      const delayMs = nextBackoff(ctx, attempt);
      attempts.push({ attempt, delayMs, condition: lastCondition });
      await ctx.sleep(delayMs);
    }
  }
  return {
    condition: lastCondition,
    attempts,
    durationMs: ctx.clock().getTime() - startedAt,
    timedOut: false,
    handedOff: false,
    error: lastError,
  };
}

interface WithRetryOptions {
  readonly maxRetries?: number;
  readonly handoffInput?: GcpRuntimeAgentEnqueueInput;
}

async function runWithTimeout<T>(
  op: () => Promise<T>,
  budgetMs: number,
  ctx: GcpRuntimeContext,
): Promise<T> {
  if (budgetMs <= 0) {
    throw Object.assign(new Error("deadline exceeded before call"), {
      status: "DEADLINE_EXCEEDED",
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`call timed out after ${budgetMs}ms`), {
          status: "DEADLINE_EXCEEDED",
        }),
      );
    }, budgetMs);
  });
  try {
    return await Promise.race([op(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // ctx unused here; reserved for future structured cancellation.
    void ctx;
  }
}

function nextBackoff(ctx: GcpRuntimeContext, attempt: number): number {
  const base = Math.min(
    ctx.policy.initialBackoffMs * Math.pow(2, attempt),
    ctx.policy.maxBackoffMs,
  );
  const jitter = Math.floor(ctx.random() * (ctx.policy.jitterMs ?? 0));
  return base + jitter;
}

async function maybeHandoff(
  ctx: GcpRuntimeContext,
  options: WithRetryOptions,
  reason: "timeout" | "deadline",
): Promise<string | undefined> {
  if (!ctx.handoff || !options.handoffInput) return undefined;
  void reason;
  try {
    return await ctx.handoff.enqueue(options.handoffInput);
  } catch {
    return undefined;
  }
}

/**
 * Compute a deterministic idempotency key from descriptor / target identifiers
 * so duplicated `materialize()` invocations against the same logical target are
 * recognisable on the server side. The key is short (<64 chars) and made of
 * URL-safe characters.
 */
export function computeIdempotencyKey(input: {
  descriptor: string;
  desiredStateId: string;
  targetId?: string;
}): string {
  const raw = `${input.descriptor}::${input.desiredStateId}::${
    input.targetId ?? ""
  }`;
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  const encoded = btoa(raw)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
    .slice(0, 40);
  return `gcp-${hex}-${encoded}`;
}

/** Drift status describing observed vs desired. */
export type GcpDriftStatus = "in-sync" | "drift" | "missing" | "unknown";

export interface GcpDriftEntry {
  readonly path: string;
  readonly desired: unknown;
  readonly observed: unknown;
}

export interface GcpDriftReport {
  readonly status: GcpDriftStatus;
  readonly entries: readonly GcpDriftEntry[];
  readonly observedAt: string;
}

/**
 * Compute a shallow drift report between desired and observed records.
 * - missing: observed is undefined / not an object
 * - drift: any differing key
 * - in-sync: every desired key matches observed
 *
 * `observed` is accepted as `unknown` so callers can pass plan-result
 * payloads (typed as `unknown` from the provider contract) without
 * `as unknown as Record` double-casts. Non-object values are treated
 * as `missing`.
 */
export function computeDrift(
  desired: Readonly<Record<string, unknown>>,
  observed: unknown,
  observedAt: string,
): GcpDriftReport {
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
    return { status: "missing", entries: [], observedAt };
  }
  const observedRecord = observed as Readonly<Record<string, unknown>>;
  const entries: GcpDriftEntry[] = [];
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    const observedValue = observedRecord[key];
    if (!deepEqual(value, observedValue)) {
      entries.push({ path: key, desired: value, observed: observedValue });
    }
  }
  return {
    status: entries.length === 0 ? "in-sync" : "drift",
    entries,
    observedAt,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const av = a as Record<string, unknown>;
  const bv = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
  for (const key of keys) {
    if (!deepEqual(av[key], bv[key])) return false;
  }
  return true;
}

/**
 * Build the kernel-facing operation `details` payload from a retry outcome.
 * Stored on `ProviderOperation.details.condition` etc.
 */
export function buildRuntimeDetails(
  outcome: RetryOutcome<unknown>,
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    condition: outcome.condition,
    retryAttempts: outcome.attempts.length,
    durationMs: outcome.durationMs,
    idempotencyKey,
    timedOut: outcome.timedOut,
    handedOff: outcome.handedOff,
    ...(outcome.handoffWorkId ? { handoffWorkId: outcome.handoffWorkId } : {}),
  };
}

/**
 * Map a provider condition to the kernel-facing
 * `ProviderOperationExecution` shape. `failed` if the condition is anything
 * other than `ok`; `succeeded` otherwise. The kernel then collapses this onto
 * `Deployment.conditions[]`.
 */
export function executionFromCondition(
  condition: GcpProviderCondition,
  startedAt: string,
  completedAt: string,
  stdout?: string,
  stderr?: string,
): provider.ProviderOperation["execution"] {
  const failed = condition.status !== "ok";
  return {
    status: failed ? "failed" : "succeeded",
    code: failed ? 1 : 0,
    ...(stdout ? { stdout } : {}),
    ...(stderr || failed ? { stderr: stderr ?? condition.message } : {}),
    startedAt,
    completedAt,
  };
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export function compactRecord(
  input: Record<string, string | number | boolean | undefined | null>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}
