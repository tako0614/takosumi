/**
 * Production-grade wrapper around an injected S3-compatible client.
 *
 * Adds:
 *   - retry / timeout for transient errors (5xx, throttling)
 *   - typed error classes (NotFound / AccessDenied / Throttled / Timeout)
 *   - cursor-based listing with bounded `limit`
 *   - bucket bootstrap when the injected client supports `ensureBucket`
 *
 * Coexists with `SelfHostedObjectStorageAdapter` from `object_storage.ts` —
 * that class already implements `ObjectStoragePort`, this one adds the
 * deepening surface called by reconcilers / migration tooling that need
 * richer behaviour than the port exposes.
 */
import type {
  SelfHostedObject,
  SelfHostedObjectClient,
  SelfHostedObjectHead,
  SelfHostedObjectLocation,
  SelfHostedObjectPut,
} from "./object_storage.ts";
import type { SelfHostedS3CompatClient } from "./injected_clients.ts";
import { freezeClone } from "./common.ts";

export type SelfHostedObjectErrorCode =
  | "not-found"
  | "access-denied"
  | "throttled"
  | "timeout"
  | "conflict"
  | "invalid"
  | "unavailable"
  | "unknown";

export class SelfHostedObjectError extends Error {
  readonly code: SelfHostedObjectErrorCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SelfHostedObjectErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly retryable?: boolean;
      readonly statusCode?: number;
      readonly details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "SelfHostedObjectError";
    this.code = code;
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.statusCode = options.statusCode;
    this.details = options.details;
  }
}

export interface SelfHostedObjectReconcilerOptions {
  readonly client: SelfHostedObjectClient | SelfHostedS3CompatClient;
  readonly maxAttempts?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class SelfHostedObjectReconciler {
  readonly #client: SelfHostedObjectClient | SelfHostedS3CompatClient;
  readonly #maxAttempts: number;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timeoutMs: number;
  readonly #clock: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: SelfHostedObjectReconcilerOptions) {
    this.#client = options.client;
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#initialBackoffMs = options.initialBackoffMs ?? 100;
    this.#maxBackoffMs = options.maxBackoffMs ?? 5_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ??
      ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  async ensureBucket(input: {
    readonly bucket: string;
    readonly region?: string;
  }): Promise<void> {
    const client = this.#client as SelfHostedS3CompatClient;
    if (!client.ensureBucket) return; // operator-managed bucket
    await this.#withRetry(() => client.ensureBucket!(input));
  }

  async putObject(input: SelfHostedObjectPut): Promise<SelfHostedObjectHead> {
    return await this.#withRetry(() => this.#client.putObject(input));
  }

  async getObject(
    input: SelfHostedObjectLocation,
  ): Promise<SelfHostedObject | undefined> {
    return await this.#withRetry(() => this.#client.getObject(input));
  }

  async deleteObject(input: SelfHostedObjectLocation): Promise<boolean> {
    return await this.#withRetry(() => this.#client.deleteObject(input));
  }

  async listAll(input: {
    readonly bucket: string;
    readonly prefix?: string;
    readonly limit?: number;
    readonly maxPages?: number;
  }): Promise<readonly SelfHostedObjectHead[]> {
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    const maxPages = input.maxPages ?? 100;
    const out: SelfHostedObjectHead[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.#withRetry(() =>
        this.#client.listObjects({
          bucket: input.bucket,
          prefix: input.prefix,
          cursor,
          limit: input.limit,
        })
      );
      out.push(...result.objects);
      if (out.length >= limit) return freezeClone(out.slice(0, limit));
      if (!result.nextCursor) return freezeClone(out);
      cursor = result.nextCursor;
    }
    return freezeClone(out);
  }

  async #withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const startMs = this.#clock().getTime();
    let lastError: SelfHostedObjectError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      if (this.#clock().getTime() - startMs > this.#timeoutMs) {
        throw new SelfHostedObjectError(
          "timeout",
          `object reconciler timed out after ${this.#timeoutMs}ms`,
          { cause: lastError, retryable: true },
        );
      }
      try {
        return await fn();
      } catch (error) {
        lastError = classifyObjectError(error);
        if (!lastError.retryable || attempt === this.#maxAttempts) {
          throw lastError;
        }
        const delay = Math.min(
          this.#initialBackoffMs * 2 ** (attempt - 1),
          this.#maxBackoffMs,
        );
        await this.#sleep(delay);
      }
    }
    throw lastError ??
      new SelfHostedObjectError("unknown", "retry exhausted with no error");
  }
}

export function classifyObjectError(error: unknown): SelfHostedObjectError {
  if (error instanceof SelfHostedObjectError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number; statusCode?: number }).status ??
    (error as { statusCode?: number }).statusCode;
  if (status === 404 || /not.?found/i.test(message)) {
    return new SelfHostedObjectError("not-found", message, {
      cause: error,
      statusCode: status,
      retryable: false,
    });
  }
  if (status === 403 || /access.?denied|forbidden/i.test(message)) {
    return new SelfHostedObjectError("access-denied", message, {
      cause: error,
      statusCode: status,
      retryable: false,
    });
  }
  if (status === 409 || /conflict|already exists/i.test(message)) {
    return new SelfHostedObjectError("conflict", message, {
      cause: error,
      statusCode: status,
      retryable: false,
    });
  }
  if (status === 429 || /throttl|rate.?limit/i.test(message)) {
    return new SelfHostedObjectError("throttled", message, {
      cause: error,
      statusCode: status,
      retryable: true,
    });
  }
  if (/timeout/i.test(message) || status === 504) {
    return new SelfHostedObjectError("timeout", message, {
      cause: error,
      statusCode: status,
      retryable: true,
    });
  }
  if (status && status >= 500) {
    return new SelfHostedObjectError("unavailable", message, {
      cause: error,
      statusCode: status,
      retryable: true,
    });
  }
  if (status === 400 || /invalid|bad request/i.test(message)) {
    return new SelfHostedObjectError("invalid", message, {
      cause: error,
      statusCode: status,
      retryable: false,
    });
  }
  return new SelfHostedObjectError("unknown", message, {
    cause: error,
    statusCode: status,
    retryable: false,
  });
}

function defaultRetryable(code: SelfHostedObjectErrorCode): boolean {
  return code === "throttled" || code === "timeout" || code === "unavailable";
}
