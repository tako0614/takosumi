import type { Context, Hono as HonoApp } from "hono";

export const TAKOSUMI_REQUEST_ID_HEADER = "x-request-id" as const;
export const TAKOSUMI_CORRELATION_ID_HEADER = "x-correlation-id" as const;

export type ApiLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface RequestCorrelation {
  readonly requestId: string;
  readonly correlationId: string;
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
}

export type ApiRequestLogSink = (line: ApiRequestLogLine) => void;

export interface RegisterRequestCorrelationOptions {
  readonly logger?: ApiRequestLogSink;
  readonly minLevel?: ApiLogLevel;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly idFactory?: () => string;
}

const REQUEST_ID_CONTEXT_KEY = "takosumi.requestId";
const CORRELATION_ID_CONTEXT_KEY = "takosumi.correlationId";
const MAX_HEADER_VALUE_LENGTH = 256;

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
    storeRequestCorrelation(c, correlation);
    setCorrelationHeaders(c, correlation);
    const startedAtMs = (options.monotonicNow ?? defaultMonotonicNow)();
    try {
      await next();
    } finally {
      setCorrelationHeaders(c, correlation);
      emitRequestLog(c, correlation, startedAtMs, options);
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

function storeRequestCorrelation(
  c: Context,
  correlation: RequestCorrelation,
): void {
  const context = c as unknown as {
    set(key: string, value: string): void;
  };
  context.set(REQUEST_ID_CONTEXT_KEY, correlation.requestId);
  context.set(CORRELATION_ID_CONTEXT_KEY, correlation.correlationId);
}

function readContextString(c: Context, key: string): string | undefined {
  const context = c as unknown as {
    get(key: string): unknown;
  };
  const value = context.get(key);
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
    ...correlation,
  };
  if (!shouldLog(line.level, options.minLevel ?? "info")) return;
  logger(line);
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

function defaultIdFactory(): string {
  return crypto.randomUUID();
}

function defaultMonotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
