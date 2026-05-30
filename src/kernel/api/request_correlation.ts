import type { Context, Hono as HonoApp } from "hono";
import type {
  ObservabilitySink,
  TraceSpanEvent,
} from "../services/observability/mod.ts";
import { log } from "../shared/log.ts";

export const TAKOSUMI_REQUEST_ID_HEADER = "x-request-id" as const;
export const TAKOSUMI_CORRELATION_ID_HEADER = "x-correlation-id" as const;
export const TRACEPARENT_HEADER = "traceparent" as const;

export type ApiLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface RequestCorrelation {
  readonly requestId: string;
  readonly correlationId: string;
}

export interface RequestTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
}

export interface ApiRequestLogLine extends RequestCorrelation {
  readonly ts: string;
  readonly level: ApiLogLevel;
  readonly subsystem: "kernel";
  readonly msg: "http request completed";
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly trace_id?: string;
  readonly span_id?: string;
}

export type ApiRequestLogSink = (line: ApiRequestLogLine) => void;

export interface RegisterRequestCorrelationOptions {
  readonly logger?: ApiRequestLogSink;
  readonly minLevel?: ApiLogLevel;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly idFactory?: () => string;
  readonly traceSink?: Pick<ObservabilitySink, "recordTrace">;
  readonly traceIdFactory?: () => string;
  readonly spanIdFactory?: () => string;
  readonly warn?: (message: string) => void;
}

const REQUEST_ID_CONTEXT_KEY = "takosumi.requestId";
const CORRELATION_ID_CONTEXT_KEY = "takosumi.correlationId";
const TRACE_ID_CONTEXT_KEY = "takosumi.traceId";
const SPAN_ID_CONTEXT_KEY = "takosumi.spanId";
const PARENT_SPAN_ID_CONTEXT_KEY = "takosumi.parentSpanId";
const MAX_HEADER_VALUE_LENGTH = 256;
const TRACEPARENT_PATTERN =
  /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i;

const LOG_LEVEL_WEIGHT: Record<ApiLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export function registerRequestCorrelation(
  app: HonoApp,
  options: RegisterRequestCorrelationOptions = {},
): void {
  app.use("*", async (c, next) => {
    const correlation = requestCorrelationFromHeaders(
      c.req.raw.headers,
      options.idFactory,
    );
    const trace = requestTraceFromHeaders(c.req.raw.headers, options);
    storeRequestCorrelation(c, correlation);
    storeRequestTrace(c, trace);
    setCorrelationHeaders(c, correlation);
    c.header(TRACEPARENT_HEADER, renderTraceparent(trace));
    const startedAtMs = (options.monotonicNow ?? defaultMonotonicNow)();
    const startedAt = (options.now ?? (() => new Date()))();
    try {
      await next();
    } finally {
      setCorrelationHeaders(c, correlation);
      c.header(TRACEPARENT_HEADER, renderTraceparent(trace));
      await recordRequestTrace(c, correlation, trace, startedAt, options);
      emitRequestLog(c, correlation, trace, startedAtMs, options);
    }
  });
}

export function readRequestCorrelation(
  c: Context,
  idFactory?: () => string,
): RequestCorrelation {
  const requestId = readContextString(c, REQUEST_ID_CONTEXT_KEY);
  const correlationId = readContextString(c, CORRELATION_ID_CONTEXT_KEY);
  if (requestId && correlationId) return { requestId, correlationId };
  return requestCorrelationFromHeaders(c.req.raw.headers, idFactory);
}

export function readRequestTrace(c: Context): RequestTraceContext {
  const traceId = readContextString(c, TRACE_ID_CONTEXT_KEY);
  const spanId = readContextString(c, SPAN_ID_CONTEXT_KEY);
  const parentSpanId = readContextString(c, PARENT_SPAN_ID_CONTEXT_KEY);
  if (traceId && spanId) {
    return {
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
    };
  }
  return requestTraceFromHeaders(c.req.raw.headers);
}

export function requestCorrelationFromHeaders(
  headers: Headers,
  idFactory: () => string = defaultIdFactory,
): RequestCorrelation {
  const requestId = normalizedHeaderValue(
    headers.get(TAKOSUMI_REQUEST_ID_HEADER),
  ) ?? `req_${idFactory()}`;
  const correlationId = normalizedHeaderValue(
    headers.get(TAKOSUMI_CORRELATION_ID_HEADER),
  ) ?? requestId;
  return { requestId, correlationId };
}

export function requestTraceFromHeaders(
  headers: Headers,
  options: Pick<
    RegisterRequestCorrelationOptions,
    "traceIdFactory" | "spanIdFactory"
  > = {},
): RequestTraceContext {
  const parsed = parseTraceparent(headers.get(TRACEPARENT_HEADER));
  const traceId = parsed?.traceId ??
    (options.traceIdFactory ?? randomTraceId)();
  const spanId = (options.spanIdFactory ?? randomSpanId)();
  return {
    traceId,
    spanId,
    ...(parsed?.spanId ? { parentSpanId: parsed.spanId } : {}),
  };
}

export function createConsoleApiRequestLogger(
  minLevel: ApiLogLevel = "info",
): ApiRequestLogSink {
  return (line) => {
    if (!shouldLog(line.level, minLevel)) return;
    const output = JSON.stringify(line);
    if (line.level === "error" || line.level === "fatal") {
      console.error(output);
    } else if (line.level === "warn") {
      console.warn(output);
    } else {
      console.log(output);
    }
  };
}

export function parseApiLogLevel(value: string | undefined): ApiLogLevel {
  switch (value?.toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "fatal":
      return value.toLowerCase() as ApiLogLevel;
    default:
      return "info";
  }
}

type ContextStringKey =
  | typeof REQUEST_ID_CONTEXT_KEY
  | typeof CORRELATION_ID_CONTEXT_KEY
  | typeof TRACE_ID_CONTEXT_KEY
  | typeof SPAN_ID_CONTEXT_KEY
  | typeof PARENT_SPAN_ID_CONTEXT_KEY;

/**
 * Hono's bare `Context` type rejects arbitrary string keys for `set`/`get`
 * because the `ContextVariableMap` augmentation would otherwise leak across
 * packages on JSR (slow-types lint forbids ambient module declarations).
 * Routing the takosumi-internal keys through a narrowly-typed view keeps the
 * unsafety confined to this single helper.
 */
interface CorrelationContextVars {
  set(key: ContextStringKey, value: string): void;
  get(key: ContextStringKey): unknown;
}

function correlationVars(c: Context): CorrelationContextVars {
  return c as CorrelationContextVars;
}

function storeRequestCorrelation(
  c: Context,
  correlation: RequestCorrelation,
): void {
  const vars = correlationVars(c);
  vars.set(REQUEST_ID_CONTEXT_KEY, correlation.requestId);
  vars.set(CORRELATION_ID_CONTEXT_KEY, correlation.correlationId);
}

function storeRequestTrace(c: Context, trace: RequestTraceContext): void {
  const vars = correlationVars(c);
  vars.set(TRACE_ID_CONTEXT_KEY, trace.traceId);
  vars.set(SPAN_ID_CONTEXT_KEY, trace.spanId);
  if (trace.parentSpanId) {
    vars.set(PARENT_SPAN_ID_CONTEXT_KEY, trace.parentSpanId);
  }
}

function readContextString(
  c: Context,
  key: ContextStringKey,
): string | undefined {
  const value = correlationVars(c).get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function setCorrelationHeaders(
  c: Context,
  correlation: RequestCorrelation,
): void {
  c.header(TAKOSUMI_REQUEST_ID_HEADER, correlation.requestId);
  c.header(TAKOSUMI_CORRELATION_ID_HEADER, correlation.correlationId);
}

function emitRequestLog(
  c: Context,
  correlation: RequestCorrelation,
  trace: RequestTraceContext,
  startedAtMs: number,
  options: RegisterRequestCorrelationOptions,
): void {
  const logger = options.logger;
  if (!logger) return;
  const status = c.res.status || 404;
  const line: ApiRequestLogLine = {
    ts: (options.now ?? (() => new Date()))().toISOString(),
    level: logLevelForStatus(status),
    subsystem: "kernel",
    msg: "http request completed",
    method: c.req.method,
    route: routeForLog(c),
    status,
    durationMs: Math.max(
      0,
      Math.round(
        ((options.monotonicNow ?? defaultMonotonicNow)() - startedAtMs) * 1000,
      ) / 1000,
    ),
    trace_id: trace.traceId,
    span_id: trace.spanId,
    ...correlation,
  };
  if (!shouldLog(line.level, options.minLevel ?? "info")) return;
  logger(line);
}

async function recordRequestTrace(
  c: Context,
  correlation: RequestCorrelation,
  trace: RequestTraceContext,
  startedAt: Date,
  options: RegisterRequestCorrelationOptions,
): Promise<void> {
  const sink = options.traceSink;
  if (!sink) return;
  const status = c.res.status || 404;
  const route = routeForLog(c);
  const span: TraceSpanEvent = {
    id: `span_${trace.spanId}`,
    traceId: trace.traceId,
    spanId: trace.spanId,
    ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
    name: `${c.req.method} ${route}`,
    kind: "server",
    status: status >= 500 ? "error" : "ok",
    startTime: startedAt.toISOString(),
    endTime: (options.now ?? (() => new Date()))().toISOString(),
    attributes: {
      "http.request.method": c.req.method,
      "http.route": route,
      "http.response.status_code": status,
    },
    requestId: correlation.requestId,
    correlationId: correlation.correlationId,
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
      log.warn("kernel.api.trace_record_failed", { span: span.name, message });
    }
  }
}

function routeForLog(c: Context): string {
  try {
    const route = c.req.routePath;
    if (route && route !== "*" && route !== "/*") return route;
  } catch {
    // Fall back to the concrete path when Hono cannot expose the route template.
  }
  return c.req.path;
}

function logLevelForStatus(status: number): ApiLogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

function shouldLog(level: ApiLogLevel, minLevel: ApiLogLevel): boolean {
  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[minLevel];
}

function normalizedHeaderValue(value: string | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_HEADER_VALUE_LENGTH);
}

function parseTraceparent(
  value: string | null,
): { readonly traceId: string; readonly spanId: string } | undefined {
  const match = value?.trim().match(TRACEPARENT_PATTERN);
  if (!match) return undefined;
  const traceId = match[1]?.toLowerCase();
  const spanId = match[2]?.toLowerCase();
  if (!traceId || !spanId) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

function renderTraceparent(trace: RequestTraceContext): string {
  return `00-${trace.traceId}-${trace.spanId}-01`;
}

function defaultIdFactory(): string {
  return crypto.randomUUID();
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

function defaultMonotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
