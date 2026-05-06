import type {
  ObservabilitySink,
  TraceSpanEvent,
  TraceSpanKind,
  TraceSpanStatus,
} from "takosumi-contract";

export const TRACEPARENT_HEADER = "traceparent" as const;
export const REQUEST_ID_HEADER = "x-request-id" as const;
export const CORRELATION_ID_HEADER = "x-correlation-id" as const;

export interface RuntimeAgentTraceContext {
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export type RuntimeAgentTraceSink = Pick<ObservabilitySink, "recordTrace">;

export interface RuntimeAgentTraceOptions {
  readonly trace?: Partial<RuntimeAgentTraceContext>;
  readonly traceSink?: RuntimeAgentTraceSink;
  readonly now?: () => string;
  readonly traceIdFactory?: () => string;
  readonly spanIdFactory?: () => string;
  readonly warn?: (message: string) => void;
}

export interface StartedRuntimeAgentTraceSpan {
  readonly trace: RuntimeAgentTraceContext;
  readonly spanId: string;
  readonly traceparent: string;
}

export interface RuntimeAgentTraceSpanInput<T> {
  readonly name: string;
  readonly kind?: TraceSpanKind;
  readonly trace?: Partial<RuntimeAgentTraceContext>;
  readonly attributes?: Record<string, string | number | boolean | undefined>;
  readonly resultAttributes?: (
    result: T,
  ) => Record<string, string | number | boolean | undefined>;
  readonly statusForResult?: (result: T) => TraceSpanStatus;
  readonly statusMessageForResult?: (result: T) => string | undefined;
}

export function createRuntimeAgentTraceContext(
  input: Partial<RuntimeAgentTraceContext> | undefined,
  options: Pick<RuntimeAgentTraceOptions, "traceIdFactory"> = {},
): RuntimeAgentTraceContext {
  return {
    traceId: input?.traceId ?? (options.traceIdFactory ?? randomTraceId)(),
    ...(input?.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    ...(input?.requestId ? { requestId: input.requestId } : {}),
    ...(input?.correlationId ? { correlationId: input.correlationId } : {}),
  };
}

export async function withRuntimeAgentTraceSpan<T>(
  options: RuntimeAgentTraceOptions,
  input: RuntimeAgentTraceSpanInput<T>,
  fn: (span: StartedRuntimeAgentTraceSpan) => Promise<T>,
): Promise<T> {
  const trace = createRuntimeAgentTraceContext(input.trace ?? options.trace, {
    traceIdFactory: options.traceIdFactory,
  });
  const spanId = (options.spanIdFactory ?? randomSpanId)();
  const startedAt = now(options);
  try {
    const result = await fn({
      trace,
      spanId,
      traceparent: renderTraceparent(trace.traceId, spanId),
    });
    await recordRuntimeAgentTraceSpan(options, {
      ...input,
      trace,
      spanId,
      status: input.statusForResult?.(result) ?? "ok",
      statusMessage: input.statusMessageForResult?.(result),
      startTime: startedAt,
      endTime: now(options),
      attributes: {
        ...input.attributes,
        ...input.resultAttributes?.(result),
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRuntimeAgentTraceSpan(options, {
      ...input,
      trace,
      spanId,
      status: "error",
      statusMessage: message,
      startTime: startedAt,
      endTime: now(options),
    });
    throw error;
  }
}

async function recordRuntimeAgentTraceSpan(
  options: RuntimeAgentTraceOptions,
  input: {
    readonly name: string;
    readonly kind?: TraceSpanKind;
    readonly trace: RuntimeAgentTraceContext;
    readonly spanId: string;
    readonly attributes?: Record<string, string | number | boolean | undefined>;
    readonly status: TraceSpanStatus;
    readonly statusMessage?: string;
    readonly startTime: string;
    readonly endTime: string;
  },
): Promise<void> {
  const sink = options.traceSink;
  if (!sink) return;
  const attributes = compactAttributes(input.attributes ?? {});
  const span: TraceSpanEvent = {
    id: `span_${input.spanId}`,
    traceId: input.trace.traceId,
    spanId: input.spanId,
    ...(input.trace.parentSpanId
      ? { parentSpanId: input.trace.parentSpanId }
      : {}),
    name: input.name,
    kind: input.kind ?? "internal",
    status: input.status,
    ...(input.statusMessage ? { statusMessage: input.statusMessage } : {}),
    startTime: input.startTime,
    endTime: input.endTime,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(input.trace.requestId ? { requestId: input.trace.requestId } : {}),
    ...(input.trace.correlationId
      ? { correlationId: input.trace.correlationId }
      : {}),
  };
  try {
    await sink.recordTrace(span);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.warn ?? console.warn)(
      `[takosumi-runtime-agent-trace] failed to record ${span.name}: ${message}`,
    );
  }
}

function renderTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
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

function now(options: RuntimeAgentTraceOptions): string {
  return (options.now ?? (() => new Date().toISOString()))();
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
