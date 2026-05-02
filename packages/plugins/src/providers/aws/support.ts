/**
 * AWS provider support utilities — error mapping, retry / backoff, timeout,
 * pagination, idempotency, drift detection and {@link provider.ProviderOperation}
 * emission helpers.
 *
 * The kernel never imports the AWS SDK directly: every entry point is an
 * operator-injected client. These helpers give every AWS sub-provider the
 * same production-grade semantics (typed condition reasons, capped retries,
 * deterministic operation IDs) without forcing each implementation to
 * re-derive the same pattern.
 */
import type { provider, ProviderErrorCategory } from "takosumi-contract";

/**
 * Runtime-agent handoff hook (Phase 17B). Long-running AWS operations
 * (RDS create / ECS service deploy / Aurora cluster ...) regularly exceed
 * the kernel-side 30s budget. Each provider sub-module accepts an optional
 * `runtimeAgentHandoff` to push the operation onto a remote runtime-agent
 * work queue when its inline retry/backoff budget is exhausted.
 */
export interface AwsRuntimeAgentHandoff {
  enqueue(input: AwsRuntimeAgentEnqueueInput): Promise<string>;
}

export interface AwsRuntimeAgentEnqueueInput {
  /** Component descriptor (e.g. `aws.rds.create`, `aws.ecs.service.deploy`). */
  readonly descriptor: string;
  readonly desiredStateId: string;
  readonly targetId?: string;
  readonly idempotencyKey?: string;
  readonly enqueuedAt?: string;
  readonly payload?: Record<string, unknown>;
}

export interface AwsRuntimeHooks {
  readonly retry?: Partial<AwsRetryConfig>;
  /** Beyond this elapsed-ms threshold, hand off to the remote runtime-agent. */
  readonly longRunningThresholdMs?: number;
  readonly runtimeAgentHandoff?: AwsRuntimeAgentHandoff;
}

export const DEFAULT_AWS_LONG_RUNNING_THRESHOLD_MS = 30_000;

/**
 * Decides whether to hand off a long-running AWS operation. Returns a stable
 * idempotency key the caller should pass to {@link AwsRuntimeAgentHandoff} so
 * repeated invocations against the same logical target collapse into one
 * queued work item.
 */
export function shouldAwsHandoff(
  elapsedMs: number,
  hooks?: AwsRuntimeHooks,
): boolean {
  if (!hooks?.runtimeAgentHandoff) return false;
  const threshold = hooks.longRunningThresholdMs ??
    DEFAULT_AWS_LONG_RUNNING_THRESHOLD_MS;
  return Number.isFinite(elapsedMs) && elapsedMs >= threshold;
}

export function deriveAwsHandoffKey(
  descriptor: string,
  desiredStateId: string,
  targetId?: string,
): string {
  return `aws-${descriptor}-${desiredStateId}-${targetId ?? "default"}`;
}

/**
 * AWS API error categories. Each AWS service returns a string `Code` (e.g.
 * `ResourceNotFoundException`, `ThrottlingException`); we normalise that into
 * a small, finite category so downstream code can branch deterministically
 * without a giant `switch`.
 */
export type AwsErrorCategory =
  | "not-found"
  | "already-exists"
  | "validation"
  | "throttling"
  | "access-denied"
  | "conflict"
  | "service-unavailable"
  | "internal"
  | "timeout"
  | "unknown";

/** Mapping of well-known AWS error codes to {@link AwsErrorCategory}. */
const AWS_ERROR_CODE_MAP: Readonly<Record<string, AwsErrorCategory>> = {
  ResourceNotFoundException: "not-found",
  NoSuchEntity: "not-found",
  NoSuchBucket: "not-found",
  NoSuchKey: "not-found",
  DBInstanceNotFound: "not-found",
  DBInstanceNotFoundFault: "not-found",
  QueueDoesNotExist: "not-found",
  "AWS.SimpleQueueService.NonExistentQueue": "not-found",
  NotFoundException: "not-found",
  ResourceAlreadyExistsException: "already-exists",
  AlreadyExistsException: "already-exists",
  BucketAlreadyExists: "already-exists",
  BucketAlreadyOwnedByYou: "already-exists",
  DBInstanceAlreadyExists: "already-exists",
  ResourceInUseException: "conflict",
  InvalidDBInstanceState: "conflict",
  ConflictException: "conflict",
  ValidationException: "validation",
  InvalidParameterValue: "validation",
  InvalidParameterCombination: "validation",
  InvalidRequest: "validation",
  MalformedPolicyDocument: "validation",
  ThrottlingException: "throttling",
  Throttling: "throttling",
  TooManyRequestsException: "throttling",
  RequestLimitExceeded: "throttling",
  RequestThrottledException: "throttling",
  ProvisionedThroughputExceededException: "throttling",
  AccessDeniedException: "access-denied",
  AccessDenied: "access-denied",
  UnauthorizedOperation: "access-denied",
  ServiceUnavailable: "service-unavailable",
  ServiceUnavailableException: "service-unavailable",
  InternalFailure: "internal",
  InternalServerError: "internal",
  InternalError: "internal",
  RequestTimeout: "timeout",
  RequestTimeoutException: "timeout",
};

/** Default retry config — 3 attempts, 1s/2s/4s exponential. */
export interface AwsRetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: boolean;
  readonly timeoutMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_AWS_RETRY: AwsRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  jitter: false,
  timeoutMs: 30_000,
};

/**
 * Categorises an unknown thrown value into an {@link AwsErrorCategory}.
 * Looks at `name`, `code`, `Code`, `__type` and well-known message prefixes
 * (so it works whether the operator wraps the AWS SDK or returns a fetch
 * error).
 */
export function classifyAwsError(error: unknown): AwsErrorCategory {
  if (error instanceof AwsTimeoutError) return "timeout";
  if (!error || typeof error !== "object") return "unknown";
  const record = error as Record<string, unknown>;
  const candidates = [
    record.code,
    record.Code,
    record.name,
    record.__type,
    record.errorCode,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const tail = candidate.includes("#")
      ? candidate.slice(candidate.lastIndexOf("#") + 1)
      : candidate;
    if (tail in AWS_ERROR_CODE_MAP) return AWS_ERROR_CODE_MAP[tail];
  }
  const status = record.statusCode ?? record.status;
  if (typeof status === "number") {
    if (status === 404) return "not-found";
    if (status === 403 || status === 401) return "access-denied";
    if (status === 409) return "conflict";
    if (status === 408) return "timeout";
    if (status === 429) return "throttling";
    if (status >= 500 && status < 600) return "service-unavailable";
    if (status >= 400 && status < 500) return "validation";
  }
  return "unknown";
}

/** Whether this category should trigger a retry within the budget. */
export function isRetryableCategory(category: AwsErrorCategory): boolean {
  return category === "throttling" ||
    category === "service-unavailable" ||
    category === "internal" ||
    category === "timeout";
}

/** Error thrown when an operation exceeds its `timeoutMs` budget. */
export class AwsTimeoutError extends Error {
  override readonly name = "AwsTimeoutError";
  constructor(operation: string, timeoutMs: number) {
    super(
      `aws operation "${operation}" exceeded ${timeoutMs}ms timeout`,
    );
  }
}

/**
 * Runs `fn` with a deadline. If it does not resolve / reject within
 * `timeoutMs`, throws {@link AwsTimeoutError}.
 */
export async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await fn();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AwsTimeoutError(operation, timeoutMs));
      }, timeoutMs);
      fn().then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs `fn` with retry + exponential backoff for retryable categories.
 * Throws the last error if non-retryable or budget exhausted.
 */
export async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  config: Partial<AwsRetryConfig> = {},
): Promise<T> {
  const merged: AwsRetryConfig = { ...DEFAULT_AWS_RETRY, ...config };
  const sleep = merged.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt += 1) {
    try {
      return await withTimeout(operation, merged.timeoutMs, fn);
    } catch (error) {
      lastError = error;
      const category = classifyAwsError(error);
      if (!isRetryableCategory(category) || attempt === merged.maxAttempts) {
        throw error;
      }
      const delay = computeBackoff(attempt, merged);
      await sleep(delay);
    }
  }
  throw lastError;
}

function computeBackoff(attempt: number, config: AwsRetryConfig): number {
  const exp = config.baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exp, config.maxDelayMs);
  return config.jitter
    ? Math.floor(capped * (0.5 + Math.random() * 0.5))
    : capped;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a {@link provider.ProviderOperation} record from a captured
 * call. Provides consistent timestamps, kind / command shape, and
 * structured `details` (including the captured failure category when
 * applicable).
 */
export interface BuildOperationInput {
  readonly id: string;
  readonly kind: string;
  readonly desiredStateId: string;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly command: readonly string[];
  readonly details?: Record<string, unknown>;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: provider.ProviderOperationExecution["status"];
  readonly errorCategory?: AwsErrorCategory;
  readonly errorMessage?: string;
  readonly stdout?: string;
}

export function buildOperation(
  input: BuildOperationInput,
): provider.ProviderOperation {
  const details: Record<string, unknown> = compactRecord(input.details ?? {});
  if (input.errorCategory) details.errorCategory = input.errorCategory;
  if (input.errorMessage) details.reason = input.errorMessage;
  return {
    id: input.id,
    kind: input.kind,
    provider: "aws",
    desiredStateId: input.desiredStateId,
    targetId: input.targetId,
    targetName: input.targetName,
    command: input.command,
    details,
    recordedAt: input.completedAt,
    execution: {
      status: input.status,
      code: input.status === "succeeded"
        ? 0
        : (input.status === "skipped" ? 0 : 1),
      stdout: input.stdout,
      stderr: input.errorMessage,
      skipped: input.status === "skipped" ? true : undefined,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    },
  };
}

/**
 * Removes `undefined` entries from a plain record so the resulting object is
 * stable across snapshot tests.
 */
export function compactRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Produces a deterministic operation key from the (kind, target) tuple. The
 * key is suitable as an idempotency token when an operator client supports
 * it; same input → same key, retry safe.
 */
export function deriveOperationKey(
  kind: string,
  target: string,
  desiredStateId: string,
): string {
  return `${kind}:${target}:${desiredStateId}`;
}

/**
 * Drift detection helper. Compares a desired and observed snapshot field by
 * field, returning the list of paths that differ. The kernel persists the
 * resulting `diff` onto a `Deployment.condition.details.drift` record.
 *
 * Both inputs are JSON-shaped; arrays are compared element-wise (order
 * sensitive), records key-wise. Functions / classes are not supported.
 */
export interface DriftField {
  readonly path: string;
  readonly desired: unknown;
  readonly observed: unknown;
}

export function detectDrift(
  desired: unknown,
  observed: unknown,
  ignorePaths: readonly string[] = [],
): readonly DriftField[] {
  const drift: DriftField[] = [];
  const ignore = new Set(ignorePaths);
  walkDrift("", desired, observed, drift, ignore);
  return drift;
}

function walkDrift(
  path: string,
  desired: unknown,
  observed: unknown,
  out: DriftField[],
  ignore: ReadonlySet<string>,
): void {
  if (ignore.has(path)) return;
  if (desired === undefined) return;
  if (Object.is(desired, observed)) return;
  if (
    typeof desired !== "object" || desired === null ||
    typeof observed !== "object" || observed === null
  ) {
    if (desired !== observed) {
      out.push({ path: path || "$", desired, observed });
    }
    return;
  }
  if (Array.isArray(desired) || Array.isArray(observed)) {
    if (
      !Array.isArray(desired) || !Array.isArray(observed) ||
      desired.length !== observed.length
    ) {
      out.push({ path: path || "$", desired, observed });
      return;
    }
    for (let i = 0; i < desired.length; i += 1) {
      walkDrift(`${path}[${i}]`, desired[i], observed[i], out, ignore);
    }
    return;
  }
  const desiredObj = desired as Record<string, unknown>;
  const observedObj = observed as Record<string, unknown>;
  for (const key of Object.keys(desiredObj)) {
    const next = path ? `${path}.${key}` : key;
    walkDrift(next, desiredObj[key], observedObj[key], out, ignore);
  }
}

/**
 * Async iterator over a paginated AWS list operation. Each `fetchPage` call
 * is wrapped in {@link withRetry} so transient errors do not abort the scan.
 *
 * `fetchPage(token)` returns `{ items, nextToken }`. Iteration ends when
 * `nextToken` is `undefined`.
 */
export interface PaginatedPage<T> {
  readonly items: readonly T[];
  readonly nextToken?: string;
}

export async function* paginate<T>(
  operation: string,
  fetchPage: (token: string | undefined) => Promise<PaginatedPage<T>>,
  config: Partial<AwsRetryConfig> = {},
): AsyncGenerator<T, void, unknown> {
  let token: string | undefined;
  do {
    const page = await withRetry(
      `${operation}.page`,
      () => fetchPage(token),
      config,
    );
    for (const item of page.items) yield item;
    token = page.nextToken;
  } while (token !== undefined);
}

/**
 * Collects all pages from {@link paginate} into a single array. Use only when
 * the result set is bounded — for unbounded scans iterate directly.
 */
export async function collectPaginated<T>(
  operation: string,
  fetchPage: (token: string | undefined) => Promise<PaginatedPage<T>>,
  config: Partial<AwsRetryConfig> = {},
): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const item of paginate(operation, fetchPage, config)) {
    out.push(item);
  }
  return out;
}

/**
 * Runs an operator-side AWS call with full production semantics:
 * retry + timeout + structured operation emission. Returns the result on
 * success and a typed failure record on error so callers can convert it into
 * a `ProviderOperation` with the correct condition reason.
 */
export interface AwsCallContext {
  readonly kind: string;
  readonly target: string;
  readonly desiredStateId: string;
  readonly command: readonly string[];
  readonly details?: Record<string, unknown>;
  readonly retry?: Partial<AwsRetryConfig>;
}

export type AwsCallOutcome<T> =
  | {
    readonly status: "succeeded";
    readonly result: T;
    readonly operation: provider.ProviderOperation;
  }
  | {
    readonly status: "failed";
    readonly error: unknown;
    readonly category: AwsErrorCategory;
    readonly operation: provider.ProviderOperation;
  };

export interface AwsCallEnv {
  readonly clock: () => Date;
  readonly idGenerator: () => string;
}

/**
 * Runs `fn`, captures success / failure into a `ProviderOperation`, and
 * returns the outcome. Never throws — instead emits a `failed` operation
 * with the classified category. The caller decides whether to surface the
 * failure as a thrown error or simply append it to the operation list.
 */
export async function runAwsCall<T>(
  ctx: AwsCallContext,
  env: AwsCallEnv,
  fn: () => Promise<T>,
): Promise<AwsCallOutcome<T>> {
  const startedAt = env.clock().toISOString();
  try {
    const result = await withRetry(ctx.kind, fn, ctx.retry);
    const completedAt = env.clock().toISOString();
    const operation = buildOperation({
      id: `provider_op_${env.idGenerator()}`,
      kind: ctx.kind,
      desiredStateId: ctx.desiredStateId,
      targetName: ctx.target,
      command: ctx.command,
      details: ctx.details,
      startedAt,
      completedAt,
      status: "succeeded",
    });
    return { status: "succeeded", result, operation };
  } catch (error) {
    const completedAt = env.clock().toISOString();
    const category = classifyAwsError(error);
    const operation = buildOperation({
      id: `provider_op_${env.idGenerator()}`,
      kind: ctx.kind,
      desiredStateId: ctx.desiredStateId,
      targetName: ctx.target,
      command: ctx.command,
      details: ctx.details,
      startedAt,
      completedAt,
      status: "failed",
      errorCategory: category,
      errorMessage: extractMessage(error),
    });
    return { status: "failed", error, category, operation };
  }
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Phase 18.2 / H6 — Map an AWS-native {@link AwsErrorCategory} onto the
 * provider-agnostic {@link ProviderErrorCategory} so kernel-side retry policy
 * can branch uniformly across all four clouds.
 */
export function awsErrorCategoryToProviderCategory(
  category: AwsErrorCategory,
): ProviderErrorCategory {
  switch (category) {
    case "throttling":
      return "rate-limited";
    case "service-unavailable":
    case "internal":
    case "timeout":
      return "transient";
    case "access-denied":
      return "permission-denied";
    case "not-found":
      return "not-found";
    case "conflict":
    case "already-exists":
      return "conflict";
    case "validation":
      return "invalid";
    case "unknown":
      return "unknown";
  }
}

/**
 * Phase 18.2 / H6 — Convenience wrapper that classifies and normalises an
 * AWS error in one call.
 */
export function classifyAwsErrorAsProviderCategory(
  error: unknown,
): ProviderErrorCategory {
  return awsErrorCategoryToProviderCategory(classifyAwsError(error));
}
