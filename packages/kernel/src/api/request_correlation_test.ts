import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  type ApiRequestLogLine,
  createConsoleApiRequestLogger,
  parseApiLogLevel,
  registerRequestCorrelation,
  TAKOSUMI_CORRELATION_ID_HEADER,
  TAKOSUMI_REQUEST_ID_HEADER,
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
    requestId: "req_inbound",
    correlationId: "corr_inbound",
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
