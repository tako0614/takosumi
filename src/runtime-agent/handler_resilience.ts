import type {
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleCompensateRequest,
  LifecycleCompensateResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract/reference/runtime-agent-lifecycle";
import type {
  RuntimeHandler,
  RuntimeHandlerContext,
  RuntimeHandlerVerifyResult,
} from "./handlers.ts";

export type RuntimeHandlerOperation =
  | "apply"
  | "destroy"
  | "compensate"
  | "describe"
  | "verify";

export interface RuntimeHandlerRetryContext {
  readonly shape: string;
  readonly provider: string;
  readonly operation: RuntimeHandlerOperation;
  readonly attempt: number;
}

export interface RuntimeHandlerCredentialRefreshContext
  extends RuntimeHandlerRetryContext {
  readonly error: unknown;
}

export interface RuntimeHandlerResilienceOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly retryStatuses?: readonly number[];
  readonly credentialRefreshStatuses?: readonly number[];
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly refreshCredentials?: (
    ctx: RuntimeHandlerCredentialRefreshContext,
  ) => Promise<void>;
  readonly shouldRetry?: (
    error: unknown,
    ctx: RuntimeHandlerRetryContext,
  ) => boolean;
  readonly shouldRefreshCredentials?: (
    error: unknown,
    ctx: RuntimeHandlerRetryContext,
  ) => boolean;
}

interface NormalizedRuntimeHandlerResilience {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryStatuses: ReadonlySet<number>;
  readonly credentialRefreshStatuses: ReadonlySet<number>;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly refreshCredentials?: (
    ctx: RuntimeHandlerCredentialRefreshContext,
  ) => Promise<void>;
  readonly shouldRetry: (
    error: unknown,
    ctx: RuntimeHandlerRetryContext,
  ) => boolean;
  readonly shouldRefreshCredentials: (
    error: unknown,
    ctx: RuntimeHandlerRetryContext,
  ) => boolean;
}

const DEFAULT_RETRY_STATUSES = Object.freeze([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);
const DEFAULT_CREDENTIAL_REFRESH_STATUSES = Object.freeze([401]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
]);
const NETWORK_ERROR_NAMES = new Set(["NetworkError", "TimeoutError"]);

export function withRuntimeHandlerResilience(
  handler: RuntimeHandler,
  options: false | RuntimeHandlerResilienceOptions | undefined = {},
): RuntimeHandler {
  if (options === false) return handler;
  const resilience = normalizeRuntimeHandlerResilience(options);
  const wrapped: {
    provider: string;
    shape: string;
    acceptedArtifactKinds: readonly string[];
    apply: (
      req: LifecycleApplyRequest,
      ctx: RuntimeHandlerContext,
    ) => Promise<LifecycleApplyResponse>;
    destroy: (
      req: LifecycleDestroyRequest,
      ctx: RuntimeHandlerContext,
    ) => Promise<LifecycleDestroyResponse>;
    compensate?: (
      req: LifecycleCompensateRequest,
      ctx: RuntimeHandlerContext,
    ) => Promise<LifecycleCompensateResponse>;
    describe: (
      req: LifecycleDescribeRequest,
      ctx: RuntimeHandlerContext,
    ) => Promise<LifecycleDescribeResponse>;
    verify?: (ctx: RuntimeHandlerContext) => Promise<RuntimeHandlerVerifyResult>;
  } = {
    provider: handler.provider,
    shape: handler.shape,
    acceptedArtifactKinds: handler.acceptedArtifactKinds,
    apply: (req, ctx) =>
      runWithResilience(
        handler,
        resilience,
        "apply",
        () => handler.apply(req, ctx),
      ),
    destroy: (req, ctx) =>
      runWithResilience(
        handler,
        resilience,
        "destroy",
        () => handler.destroy(req, ctx),
      ),
    describe: (req, ctx) =>
      runWithResilience(
        handler,
        resilience,
        "describe",
        () => handler.describe(req, ctx),
      ),
  };
  if (handler.compensate) {
    wrapped.compensate = (req, ctx) =>
      runWithResilience(
        handler,
        resilience,
        "compensate",
        () =>
          handler.compensate?.(req, ctx) ??
            Promise.resolve({ ok: false, note: "compensate hook missing" }),
      );
  }
  if (handler.verify) {
    wrapped.verify = (ctx) =>
      runWithResilience(
        handler,
        resilience,
        "verify",
        () =>
          handler.verify?.(ctx) ??
            Promise.resolve({ ok: true, note: "no verify hook" }),
      );
  }
  return wrapped;
}

async function runWithResilience<T>(
  handler: RuntimeHandler,
  resilience: NormalizedRuntimeHandlerResilience,
  operation: RuntimeHandlerOperation,
  fn: () => Promise<T>,
): Promise<T> {
  let credentialsRefreshed = false;
  for (let attempt = 1; attempt <= resilience.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const ctx = {
        shape: handler.shape,
        provider: handler.provider,
        operation,
        attempt,
      };
      if (attempt >= resilience.attempts) throw error;
      if (
        !credentialsRefreshed &&
        resilience.refreshCredentials &&
        resilience.shouldRefreshCredentials(error, ctx)
      ) {
        credentialsRefreshed = true;
        await resilience.refreshCredentials({ ...ctx, error });
        continue;
      }
      if (!resilience.shouldRetry(error, ctx)) throw error;
      await resilience.sleep(backoffDelay(attempt, resilience));
    }
  }
  throw new Error(
    `handler resilience exhausted for ${handler.shape}/${handler.provider} ${operation}`,
  );
}

function normalizeRuntimeHandlerResilience(
  options: RuntimeHandlerResilienceOptions,
): NormalizedRuntimeHandlerResilience {
  const retryStatuses = new Set(
    options.retryStatuses ?? DEFAULT_RETRY_STATUSES,
  );
  const credentialRefreshStatuses = new Set(
    options.credentialRefreshStatuses ?? DEFAULT_CREDENTIAL_REFRESH_STATUSES,
  );
  return {
    attempts: Math.max(1, Math.floor(options.attempts ?? 3)),
    baseDelayMs: Math.max(0, options.baseDelayMs ?? 250),
    maxDelayMs: Math.max(0, options.maxDelayMs ?? 2_000),
    retryStatuses,
    credentialRefreshStatuses,
    sleep: options.sleep ?? defaultSleep,
    refreshCredentials: options.refreshCredentials,
    shouldRetry: options.shouldRetry ??
      ((error) => isRetryableRuntimeHandlerError(error, retryStatuses)),
    shouldRefreshCredentials: options.shouldRefreshCredentials ??
      ((error) => isCredentialRefreshError(error, credentialRefreshStatuses)),
  };
}

function backoffDelay(
  attempt: number,
  resilience: NormalizedRuntimeHandlerResilience,
): number {
  return Math.min(
    resilience.maxDelayMs,
    resilience.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableRuntimeHandlerError(
  error: unknown,
  retryStatuses: ReadonlySet<number>,
): boolean {
  const record = errorRecord(error);
  if (record?.retryable === false) return false;
  if (record?.retryable === true) return true;
  const status = extractStatus(error);
  if (status !== undefined && retryStatuses.has(status)) return true;
  const code = stringProperty(record, "code");
  if (code && NETWORK_ERROR_CODES.has(code)) return true;
  const name = error instanceof Error
    ? error.name
    : stringProperty(record, "name");
  if (name && NETWORK_ERROR_NAMES.has(name)) return true;
  return error instanceof TypeError && status === undefined;
}

function isCredentialRefreshError(
  error: unknown,
  credentialRefreshStatuses: ReadonlySet<number>,
): boolean {
  const status = extractStatus(error);
  if (status !== undefined && credentialRefreshStatuses.has(status)) {
    return true;
  }
  const message = errorMessage(error);
  return /\b(expired|invalid|stale)\b.*\b(token|credential|credentials)\b/i
    .test(message) ||
    /\b(token|credential|credentials)\b.*\b(expired|invalid|stale)\b/i
      .test(message) ||
    /\bExpiredToken\b/.test(message);
}

function extractStatus(error: unknown): number | undefined {
  const record = errorRecord(error);
  const direct = numberProperty(record, "status") ??
    numberProperty(record, "statusCode");
  if (direct !== undefined) return direct;
  const match = /\bHTTP\s+(\d{3})\b/i.exec(errorMessage(error)) ??
    /\bstatus(?:\s+code)?\s*[:=]?\s*(\d{3})\b/i.exec(errorMessage(error));
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const record = errorRecord(error);
  return stringProperty(record, "message") ?? "";
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
}

function numberProperty(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function stringProperty(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
