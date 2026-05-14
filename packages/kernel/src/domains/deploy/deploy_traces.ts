import type {
  PlatformContext,
  PlatformOperationContext,
  PlatformTraceContext,
} from "takosumi-contract";
import type {
  TraceSpanEvent,
  TraceSpanKind,
  TraceSpanStatus,
} from "../../services/observability/types.ts";
import type { IsoTimestamp } from "../../shared/time.ts";
import { log } from "../../shared/log.ts";

export interface DeployTraceSink {
  recordTrace(event: TraceSpanEvent): Promise<unknown>;
}

export interface DeployTraceRecorderOptions {
  readonly observability?: Partial<DeployTraceSink>;
  readonly now?: () => IsoTimestamp;
  readonly warn?: (message: string) => void;
}

export interface DeployTraceSpanInput<T> {
  readonly name: string;
  readonly kind?: TraceSpanKind;
  readonly trace?: PlatformTraceContext;
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly operation?: PlatformOperationContext;
  readonly operationKind?: string;
  readonly walStage?: string;
  readonly idempotencyKey?: string;
  readonly attributes?: Record<string, string | number | boolean | undefined>;
  readonly resultAttributes?: (
    result: T,
  ) => Record<string, string | number | boolean | undefined>;
  readonly statusForResult?: (result: T) => TraceSpanStatus;
  readonly statusMessageForResult?: (result: T) => string | undefined;
}

export function createDeployTraceContext(
  input: Partial<PlatformTraceContext> = {},
): PlatformTraceContext {
  return {
    traceId: input.traceId ?? randomTraceId(),
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
}

export function withDeployTraceContext(
  context: PlatformContext,
): PlatformContext {
  return context.trace
    ? context
    : { ...context, trace: createDeployTraceContext() };
}

export async function withDeployTraceSpan<T>(
  options: DeployTraceRecorderOptions,
  input: DeployTraceSpanInput<T>,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = (options.now ?? (() => new Date().toISOString()))();
  try {
    const result = await fn();
    await recordDeployTraceSpan(options, {
      ...input,
      status: input.statusForResult?.(result) ?? "ok",
      statusMessage: input.statusMessageForResult?.(result),
      startTime: startedAt,
      endTime: (options.now ?? (() => new Date().toISOString()))(),
      attributes: {
        ...input.attributes,
        ...input.resultAttributes?.(result),
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordDeployTraceSpan(options, {
      ...input,
      status: "error",
      statusMessage: message,
      startTime: startedAt,
      endTime: (options.now ?? (() => new Date().toISOString()))(),
    });
    throw error;
  }
}

async function recordDeployTraceSpan(
  options: DeployTraceRecorderOptions,
  input: {
    readonly name: string;
    readonly kind?: TraceSpanKind;
    readonly trace?: PlatformTraceContext;
    readonly spaceId?: string;
    readonly groupId?: string;
    readonly operation?: PlatformOperationContext;
    readonly operationKind?: string;
    readonly walStage?: string;
    readonly idempotencyKey?: string;
    readonly attributes?: Record<string, string | number | boolean | undefined>;
    readonly status: TraceSpanStatus;
    readonly statusMessage?: string;
    readonly startTime: IsoTimestamp;
    readonly endTime: IsoTimestamp;
  },
): Promise<void> {
  const sink = options.observability;
  if (typeof sink?.recordTrace !== "function") return;
  const trace = createDeployTraceContext(input.trace);
  const operation = input.operation;
  const spanId = randomSpanId();
  const attributes = compactAttributes({
    "takosumi.operation_id": operation?.operationId,
    "takosumi.operation_kind": input.operationKind ?? operation?.phase,
    "takosumi.wal_stage": input.walStage ?? operation?.walStage,
    "takosumi.idempotency_key": input.idempotencyKey ??
      operation?.idempotencyKeyString,
    "takosumi.resource_name": operation?.resourceName,
    "takosumi.provider_id": operation?.providerId,
    ...input.attributes,
  });
  const span: TraceSpanEvent = {
    id: `span_${spanId}`,
    traceId: trace.traceId,
    spanId,
    ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
    name: input.name,
    kind: input.kind ?? "internal",
    status: input.status,
    ...(input.statusMessage ? { statusMessage: input.statusMessage } : {}),
    startTime: input.startTime,
    endTime: input.endTime,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(trace.requestId ? { requestId: trace.requestId } : {}),
    ...(trace.correlationId ? { correlationId: trace.correlationId } : {}),
  };
  try {
    await sink.recordTrace(span);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.warn) {
      options.warn(
        `[takosumi-trace] failed to record ${span.name}: ${message}`,
      );
    } else {
      log.warn("kernel.deploy.trace_record_failed", {
        span: span.name,
        message,
      });
    }
  }
}

function compactAttributes(
  input: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function randomTraceId(): string {
  return randomHex(16);
}

function randomSpanId(): string {
  return randomHex(8);
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
