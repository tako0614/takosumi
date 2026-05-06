import assert from "node:assert/strict";
import { Hono } from "hono";
import { InMemoryObservabilitySink } from "../services/observability/mod.ts";
import {
  type ApiRequestLogLine,
  createConsoleApiRequestLogger,
  parseApiLogLevel,
  registerRequestCorrelation,
  TAKOSUMI_CORRELATION_ID_HEADER,
  TAKOSUMI_REQUEST_ID_HEADER,
  TRACEPARENT_HEADER,
} from "./request_correlation.ts";

Deno.test("request correlation propagates inbound ids to response headers and logs", async () => {
  const logs: ApiRequestLogLine[] = [];
  const app = new Hono();
  let monotonic = 10;
  registerRequestCorrelation(app, {
    logger: (line) => logs.push(line),
    now: () => new Date("2026-05-07T00:00:00.000Z"),
    monotonicNow: () => {
      monotonic += 2.5;
      return monotonic;
    },
    traceIdFactory: () => "4bf92f3577b34da6a3ce929d0e0e4736",
    spanIdFactory: () => "00f067aa0ba902b7",
  });
  app.get("/items/:id", (c) => c.text("ok"));

  const response = await app.request("/items/one", {
    headers: {
      [TAKOSUMI_REQUEST_ID_HEADER]: "req_inbound",
      [TAKOSUMI_CORRELATION_ID_HEADER]: "corr_inbound",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get(TAKOSUMI_REQUEST_ID_HEADER), "req_inbound");
  assert.equal(
    response.headers.get(TRACEPARENT_HEADER),
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  assert.equal(
    response.headers.get(TAKOSUMI_CORRELATION_ID_HEADER),
    "corr_inbound",
  );
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    ts: "2026-05-07T00:00:00.000Z",
    level: "info",
    subsystem: "kernel",
    msg: "http request completed",
    method: "GET",
    route: "/items/:id",
    status: 200,
    durationMs: 2.5,
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7",
    requestId: "req_inbound",
    correlationId: "corr_inbound",
  });
});

Deno.test("request correlation records HTTP server trace spans", async () => {
  const observability = new InMemoryObservabilitySink();
  const app = new Hono();
  registerRequestCorrelation(app, {
    traceSink: observability,
    spanIdFactory: () => "2222222222222222",
    now: (() => {
      const values = [
        new Date("2026-05-07T00:00:00.000Z"),
        new Date("2026-05-07T00:00:01.000Z"),
      ];
      return () => values.shift() ?? new Date("2026-05-07T00:00:01.000Z");
    })(),
  });
  app.get("/items/:id", (c) => c.text("ok"));

  const response = await app.request("/items/one", {
    headers: {
      [TAKOSUMI_REQUEST_ID_HEADER]: "req_trace",
      [TAKOSUMI_CORRELATION_ID_HEADER]: "corr_trace",
      [TRACEPARENT_HEADER]:
        "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
    },
  });

  assert.equal(response.status, 200);
  const traces = await observability.listTraces();
  assert.equal(traces.length, 1);
  assert.deepEqual(traces[0], {
    id: "span_2222222222222222",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "2222222222222222",
    parentSpanId: "1111111111111111",
    name: "GET /items/:id",
    kind: "server",
    status: "ok",
    startTime: "2026-05-07T00:00:00.000Z",
    endTime: "2026-05-07T00:00:01.000Z",
    attributes: {
      "http.request.method": "GET",
      "http.route": "/items/:id",
      "http.response.status_code": 200,
    },
    requestId: "req_trace",
    correlationId: "corr_trace",
  });
});

Deno.test("request correlation generates ids when headers are absent", async () => {
  const logs: ApiRequestLogLine[] = [];
  const app = new Hono();
  registerRequestCorrelation(app, {
    idFactory: () => "generated",
    logger: (line) => logs.push(line),
    now: () => new Date("2026-05-07T00:00:00.000Z"),
    monotonicNow: () => 1,
  });
  app.get("/health", (c) => c.json({ ok: true }));

  const response = await app.request("/health");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get(TAKOSUMI_REQUEST_ID_HEADER),
    "req_generated",
  );
  assert.equal(
    response.headers.get(TAKOSUMI_CORRELATION_ID_HEADER),
    "req_generated",
  );
  assert.equal(logs[0]?.requestId, "req_generated");
  assert.equal(logs[0]?.correlationId, "req_generated");
});

Deno.test("request correlation respects minimum log level", async () => {
  const logs: ApiRequestLogLine[] = [];
  const app = new Hono();
  registerRequestCorrelation(app, {
    logger: (line) => logs.push(line),
    minLevel: "warn",
    now: () => new Date("2026-05-07T00:00:00.000Z"),
    monotonicNow: () => 1,
  });
  app.get("/ok", (c) => c.text("ok"));
  app.get("/missing", (c) => c.text("missing", 404));

  await app.request("/ok");
  await app.request("/missing");

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, "warn");
  assert.equal(logs[0]?.status, 404);
});

Deno.test("console request logger emits JSON only above configured level", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  try {
    console.log = (line?: unknown) => lines.push(String(line));
    console.warn = (line?: unknown) => lines.push(String(line));
    const logger = createConsoleApiRequestLogger(parseApiLogLevel("warn"));
    logger({
      ts: "2026-05-07T00:00:00.000Z",
      level: "info",
      subsystem: "kernel",
      msg: "http request completed",
      method: "GET",
      route: "/ok",
      status: 200,
      durationMs: 1,
      requestId: "req_1",
      correlationId: "corr_1",
    });
    logger({
      ts: "2026-05-07T00:00:01.000Z",
      level: "warn",
      subsystem: "kernel",
      msg: "http request completed",
      method: "GET",
      route: "/missing",
      status: 404,
      durationMs: 1,
      requestId: "req_2",
      correlationId: "corr_2",
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.equal(lines.length, 1);
  assert(JSON.parse(lines[0] ?? "{}").requestId === "req_2");
});
