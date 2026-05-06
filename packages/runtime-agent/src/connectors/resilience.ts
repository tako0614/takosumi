import type {
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleCompensateRequest,
  LifecycleCompensateResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";
import type {
  Connector,
  ConnectorContext,
  ConnectorVerifyResult,
} from "./connector.ts";

export type ConnectorOperation =
  | "apply"
  | "destroy"
  | "compensate"
  | "describe"
  | "verify";

export interface ConnectorRetryContext {
  readonly shape: string;
  readonly provider: string;
  readonly operation: ConnectorOperation;
  readonly attempt: number;
}

export interface ConnectorCredentialRefreshContext
  extends ConnectorRetryContext {
  readonly error: unknown;
}

export interface ConnectorResilienceOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly retryStatuses?: readonly number[];
  readonly credentialRefreshStatuses?: readonly number[];
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly refreshCredentials?: (
    ctx: ConnectorCredentialRefreshContext,
  ) => Promise<void>;
  readonly shouldRetry?: (
    error: unknown,
    ctx: ConnectorRetryContext,
  ) => boolean;
  readonly shouldRefreshCredentials?: (
    error: unknown,
    ctx: ConnectorRetryContext,
  ) => boolean;
}

interface NormalizedConnectorResilience {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryStatuses: ReadonlySet<number>;
  readonly credentialRefreshStatuses: ReadonlySet<number>;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly refreshCredentials?: (
    ctx: ConnectorCredentialRefreshContext,
  ) => Promise<void>;
  readonly shouldRetry: (
    error: unknown,
    ctx: ConnectorRetryContext,
  ) => boolean;
  readonly shouldRefreshCredentials: (
    error: unknown,
    ctx: ConnectorRetryContext,
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

export function withConnectorResilience(
  connector: Connector,
  options: false | ConnectorResilienceOptions | undefined = {},
): Connector {
  if (options === false) return connector;
  const resilience = normalizeConnectorResilience(options);
  const wrapped: {
    provider: string;
    shape: string;
    acceptedArtifactKinds: readonly string[];
    apply: (
      req: LifecycleApplyRequest,
      ctx: ConnectorContext,
    ) => Promise<LifecycleApplyResponse>;
    destroy: (
      req: LifecycleDestroyRequest,
      ctx: ConnectorContext,
    ) => Promise<LifecycleDestroyResponse>;
    compensate?: (
      req: LifecycleCompensateRequest,
      ctx: ConnectorContext,
    ) => Promise<LifecycleCompensateResponse>;
    describe: (
      req: LifecycleDescribeRequest,
      ctx: ConnectorContext,
    ) => Promise<LifecycleDescribeResponse>;
    verify?: (ctx: ConnectorContext) => Promise<ConnectorVerifyResult>;
  } = {
    provider: connector.provider,
    shape: connector.shape,
    acceptedArtifactKinds: connector.acceptedArtifactKinds,
    apply: (req, ctx) =>
      runWithResilience(
        connector,
        resilience,
        "apply",
        () => connector.apply(req, ctx),
      ),
    destroy: (req, ctx) =>
      runWithResilience(
        connector,
        resilience,
        "destroy",
        () => connector.destroy(req, ctx),
      ),
    describe: (req, ctx) =>
      runWithResilience(
        connector,
        resilience,
        "describe",
        () => connector.describe(req, ctx),
      ),
  };
  if (connector.compensate) {
    wrapped.compensate = (req, ctx) =>
      runWithResilience(
        connector,
        resilience,
        "compensate",
        () =>
          connector.compensate?.(req, ctx) ??
            Promise.resolve({ ok: false, note: "compensate hook missing" }),
      );
  }
  if (connector.verify) {
    wrapped.verify = (ctx) =>
      runWithResilience(
        connector,
        resilience,
        "verify",
        () =>
          connector.verify?.(ctx) ??
            Promise.resolve({ ok: true, note: "no verify hook" }),
      );
  }
  return wrapped;
}

async function runWithResilience<T>(
  connector: Connector,
  resilience: NormalizedConnectorResilience,
  operation: ConnectorOperation,
  fn: () => Promise<T>,
): Promise<T> {
  let credentialsRefreshed = false;
  for (let attempt = 1; attempt <= resilience.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const ctx = {
        shape: connector.shape,
        provider: connector.provider,
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
    `connector resilience exhausted for ${connector.shape}/${connector.provider} ${operation}`,
  );
}

function normalizeConnectorResilience(
  options: ConnectorResilienceOptions,
): NormalizedConnectorResilience {
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
      ((error) => isRetryableConnectorError(error, retryStatuses)),
    shouldRefreshCredentials: options.shouldRefreshCredentials ??
      ((error) => isCredentialRefreshError(error, credentialRefreshStatuses)),
  };
}

function backoffDelay(
  attempt: number,
  resilience: NormalizedConnectorResilience,
): number {
  return Math.min(
    resilience.maxDelayMs,
    resilience.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableConnectorError(
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
