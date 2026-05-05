/**
 * Runtime-agent main loop: enroll → heartbeat → lease → execute → report.
 *
 * The loop is provider-agnostic. Provider plugins register {@link
 * RuntimeAgentExecutor}s keyed by `kind` (matching the kernel's
 * `RuntimeAgentWorkPayload.kind`). On lease, the loop dispatches to the
 * matching executor and reports the outcome.
 *
 * The loop is built to be embedded in a Deno process inside the operator's
 * tenant cloud. The kernel never imports it.
 */
import type {
  GatewayManifest,
  JsonObject,
  RuntimeAgentCapabilitiesPayload,
  RuntimeAgentLeaseResponse,
  RuntimeAgentRegistrationResponse,
  RuntimeAgentWorkLease,
  RuntimeAgentWorkPayload,
} from "takosumi-contract";
import type { RuntimeAgentHttpClient } from "./client.ts";

/**
 * Outcome of executing a leased work item. The loop translates this into the
 * matching kernel report (`completed` / `failed`).
 */
export type RuntimeAgentExecutionOutcome =
  | { readonly status: "completed"; readonly result?: JsonObject }
  | {
    readonly status: "failed";
    readonly reason: string;
    readonly retry?: boolean;
    readonly result?: JsonObject;
  };

export interface RuntimeAgentExecutionContext {
  readonly lease: RuntimeAgentWorkLease;
  /** Sends a `progress` report and (optionally) extends the lease. */
  reportProgress(input: {
    readonly progress?: JsonObject;
    readonly extendUntil?: string;
  }): Promise<void>;
  /** Aborted when the loop is shutting down. Executors should bail out. */
  readonly signal: AbortSignal;
}

export type RuntimeAgentExecutor = (
  context: RuntimeAgentExecutionContext,
) => Promise<RuntimeAgentExecutionOutcome>;

export interface RuntimeAgentLoopOptions {
  readonly client: RuntimeAgentHttpClient;
  readonly agentId: string;
  readonly provider: string;
  readonly capabilities: RuntimeAgentCapabilitiesPayload;
  readonly hostKeyDigest?: string;
  /** Map of `work.kind` → executor. Falls back to {@link defaultExecutor}. */
  readonly executors: Readonly<Record<string, RuntimeAgentExecutor>>;
  /** Called when no executor matches. Default rejects with `unsupported kind`. */
  readonly defaultExecutor?: RuntimeAgentExecutor;
  /** Polling interval when no work is available. Default 1000ms. */
  readonly idleBackoffMs?: number;
  /** Lease TTL the agent requests. Default 60 000ms. */
  readonly leaseTtlMs?: number;
  /** Heartbeat cadence. Default 15 000ms. */
  readonly heartbeatIntervalMs?: number;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Telemetry sink. */
  readonly telemetry?: RuntimeAgentLoopTelemetry;
}

export interface RuntimeAgentLoopTelemetry {
  readonly onEvent?: (event: RuntimeAgentLoopEvent) => void;
}

export type RuntimeAgentLoopEvent =
  | {
    readonly kind: "gateway-manifest-loaded";
    readonly manifest: GatewayManifest;
  }
  | {
    readonly kind: "enrolled";
    readonly response: RuntimeAgentRegistrationResponse;
  }
  | { readonly kind: "heartbeat" }
  | { readonly kind: "idle" }
  | { readonly kind: "leased"; readonly lease: RuntimeAgentWorkLease }
  | {
    readonly kind: "executed";
    readonly outcome: RuntimeAgentExecutionOutcome;
  }
  | { readonly kind: "error"; readonly error: unknown };

/**
 * Long-lived loop. Use {@link runOnce} for tests and {@link runForever} in
 * production.
 */
export class RuntimeAgentLoop {
  readonly #options:
    & Required<
      Omit<
        RuntimeAgentLoopOptions,
        "telemetry" | "hostKeyDigest" | "defaultExecutor"
      >
    >
    & {
      readonly hostKeyDigest?: string;
      readonly defaultExecutor: RuntimeAgentExecutor;
      readonly telemetry?: RuntimeAgentLoopTelemetry;
    };
  #lastHeartbeat = 0;

  constructor(options: RuntimeAgentLoopOptions) {
    this.#options = {
      client: options.client,
      agentId: options.agentId,
      provider: options.provider,
      capabilities: options.capabilities,
      hostKeyDigest: options.hostKeyDigest,
      executors: { ...options.executors },
      defaultExecutor: options.defaultExecutor ?? defaultUnsupportedExecutor,
      idleBackoffMs: options.idleBackoffMs ?? 1_000,
      leaseTtlMs: options.leaseTtlMs ?? 60_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      clock: options.clock ?? (() => new Date()),
      sleep: options.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      telemetry: options.telemetry,
    };
  }

  /**
   * Fetch and pin the gateway manifest. The loop calls this lazily before
   * the first enroll, but operators / tests may invoke it explicitly.
   *
   * Fail-closed: any verification failure surfaces to the caller (does not
   * proceed to enrollment).
   */
  async loadGatewayManifest(): Promise<GatewayManifest> {
    const manifest = await this.#options.client.loadGatewayManifest();
    this.#emit({ kind: "gateway-manifest-loaded", manifest });
    return manifest;
  }

  /** Send the initial enrollment. */
  async enroll(): Promise<RuntimeAgentRegistrationResponse> {
    if (!this.#options.client.pinnedManifest) {
      await this.loadGatewayManifest();
    }
    const response = await this.#options.client.enroll({
      agentId: this.#options.agentId,
      provider: this.#options.provider,
      capabilities: this.#options.capabilities,
      hostKeyDigest: this.#options.hostKeyDigest,
      enrolledAt: this.#options.clock().toISOString(),
    });
    this.#lastHeartbeat = this.#options.clock().getTime();
    this.#emit({ kind: "enrolled", response });
    return response;
  }

  /**
   * Run a single iteration: heartbeat (if due), pull a lease, dispatch to an
   * executor, report the outcome. Returns `true` if a lease was processed,
   * `false` otherwise (idle / heartbeat-only). For tests.
   */
  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<
    boolean
  > {
    if (signal.aborted) return false;
    await this.#maybeHeartbeat();
    const leaseResponse = await this.#options.client.leaseWork({
      agentId: this.#options.agentId,
      leaseTtlMs: this.#options.leaseTtlMs,
      now: this.#options.clock().toISOString(),
    });
    if (!leaseResponse.lease) {
      this.#emit({ kind: "idle" });
      return false;
    }
    await this.#executeLease(leaseResponse.lease, signal);
    return true;
  }

  /**
   * Loop until `signal` is aborted. When idle, sleeps `idleBackoffMs`.
   * Errors are emitted via telemetry but do not break the loop.
   */
  async runForever(signal: AbortSignal): Promise<void> {
    await this.enroll();
    while (!signal.aborted) {
      try {
        const processed = await this.runOnce(signal);
        if (!processed) await this.#options.sleep(this.#options.idleBackoffMs);
      } catch (error) {
        this.#emit({ kind: "error", error });
        await this.#options.sleep(this.#options.idleBackoffMs);
      }
    }
  }

  async #maybeHeartbeat(): Promise<void> {
    const now = this.#options.clock().getTime();
    if (
      this.#lastHeartbeat &&
      now - this.#lastHeartbeat < this.#options.heartbeatIntervalMs
    ) {
      return;
    }
    await this.#options.client.heartbeat({
      agentId: this.#options.agentId,
      heartbeatAt: new Date(now).toISOString(),
      ttlMs: this.#options.heartbeatIntervalMs * 3,
    });
    this.#lastHeartbeat = now;
    this.#emit({ kind: "heartbeat" });
  }

  async #executeLease(
    lease: RuntimeAgentWorkLease,
    signal: AbortSignal,
  ): Promise<void> {
    this.#emit({ kind: "leased", lease });
    const executor = this.#options.executors[lease.work.kind] ??
      this.#options.defaultExecutor;
    const reportProgress: RuntimeAgentExecutionContext["reportProgress"] =
      async (input) => {
        await this.#options.client.report({
          agentId: this.#options.agentId,
          leaseId: lease.id,
          status: "progress",
          progress: input.progress,
          extendUntil: input.extendUntil,
          reportedAt: this.#options.clock().toISOString(),
        });
      };
    let outcome: RuntimeAgentExecutionOutcome;
    try {
      outcome = await executor({ lease, reportProgress, signal });
    } catch (error) {
      outcome = {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        retry: false,
      };
    }
    this.#emit({ kind: "executed", outcome });
    if (outcome.status === "completed") {
      await this.#options.client.report({
        agentId: this.#options.agentId,
        leaseId: lease.id,
        status: "completed",
        completedAt: this.#options.clock().toISOString(),
        result: outcome.result,
      });
    } else {
      await this.#options.client.report({
        agentId: this.#options.agentId,
        leaseId: lease.id,
        status: "failed",
        reason: outcome.reason,
        retry: outcome.retry,
        failedAt: this.#options.clock().toISOString(),
        result: outcome.result,
      });
    }
  }

  #emit(event: RuntimeAgentLoopEvent): void {
    this.#options.telemetry?.onEvent?.(event);
  }
}

function defaultUnsupportedExecutor(
  context: RuntimeAgentExecutionContext,
): Promise<RuntimeAgentExecutionOutcome> {
  return Promise.resolve({
    status: "failed",
    reason: `no executor registered for kind ${context.lease.work.kind}`,
    retry: false,
  });
}

/**
 * Convenience helper: build an executor that delegates to a provider plugin
 * call (e.g. `aws.rds.create`) and returns the resulting JSON-safe payload.
 */
export function executorFromProviderCall<TResult extends JsonObject>(
  fn: (
    payload: RuntimeAgentWorkPayload,
    context: RuntimeAgentExecutionContext,
  ) => Promise<TResult>,
): RuntimeAgentExecutor {
  return async (context) => {
    try {
      const result = await fn(context.lease.work, context);
      return { status: "completed", result };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        retry: shouldRetryError(error),
      };
    }
  };
}

function shouldRetryError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  const status = typeof candidate.status === "string" ? candidate.status : "";
  if (status === "RESOURCE_EXHAUSTED" || status === "UNAVAILABLE") return true;
  const httpStatus = typeof candidate.httpStatus === "number"
    ? candidate.httpStatus
    : typeof candidate.statusCode === "number"
    ? candidate.statusCode
    : undefined;
  if (
    httpStatus !== undefined &&
    (httpStatus === 429 || httpStatus === 503 || httpStatus === 504)
  ) return true;
  return false;
}

export type { RuntimeAgentLeaseResponse, RuntimeAgentWorkLease };
