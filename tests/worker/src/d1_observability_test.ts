import { expect, test } from "bun:test";

import { CloudflareD1ObservabilitySink } from "../../../worker/src/d1_observability.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

test("Cloudflare D1 observability sink persists metrics across instances", async () => {
  const db = new SqliteFakeD1();
  const observedAt = new Date().toISOString();
  const recorder = new CloudflareD1ObservabilitySink({ db });
  await recorder.recordMetric({
    id: "metric_1",
    name: "takosumi_oidc_request_count",
    kind: "counter",
    value: 1,
    tags: {
      environment: "test",
      route: "/oauth/authorize",
      runner_profile_id: "runner_test",
      status: "200",
    },
    observedAt,
  });

  const scraper = new CloudflareD1ObservabilitySink({ db });
  const metrics = await scraper.listMetrics({
    name: "takosumi_oidc_request_count",
  });

  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({
    id: "metric_1",
    name: "takosumi_oidc_request_count",
    kind: "counter",
    value: 1,
    tags: {
      environment: "test",
      route: "/oauth/authorize",
      runner_profile_id: "runner_test",
      status: "200",
    },
    observedAt,
  });
});

test("Cloudflare D1 observability sink persists and verifies the audit chain", async () => {
  const db = new SqliteFakeD1();
  const firstSink = new CloudflareD1ObservabilitySink({ db });
  const occurredAt = new Date().toISOString();

  const first = await firstSink.appendAudit({
    id: "audit_1",
    eventClass: "security",
    type: "workspace.created",
    severity: "info",
    actor: { type: "user", id: "user_1", sessionId: "secret-session" },
    workspaceId: "ws_1",
    targetType: "workspace",
    targetId: "ws_1",
    payload: { token: "secret-token", result: "created" },
    occurredAt,
  });
  const secondSink = new CloudflareD1ObservabilitySink({ db });
  const second = await secondSink.appendAudit({
    id: "audit_2",
    eventClass: "compliance",
    type: "project.created",
    severity: "info",
    workspaceId: "ws_1",
    targetType: "project",
    targetId: "prj_1",
    payload: { result: "created" },
    occurredAt,
  });

  expect(second.sequence).toBe(2);
  expect(second.previousHash).toBe(first.hash);
  expect(await secondSink.verifyAuditChain()).toBe(true);
  const records = await secondSink.listAudit();
  expect(records).toHaveLength(2);
  expect(records[0]?.event.actor?.sessionId).toBe("[REDACTED]");
  expect(records[0]?.event.payload.token).toBe("[REDACTED]");
});

test("Cloudflare D1 observability sink serializes concurrent audit appends", async () => {
  const db = new SqliteFakeD1();
  const sinks = Array.from(
    { length: 6 },
    () => new CloudflareD1ObservabilitySink({ db }),
  );
  await Promise.all(
    sinks.map((sink, index) =>
      sink.appendAudit({
        id: `audit_concurrent_${index}`,
        eventClass: "compliance",
        type: "run.recorded",
        severity: "info",
        workspaceId: "ws_1",
        targetType: "run",
        targetId: `run_${index}`,
        payload: { index },
        occurredAt: "2026-07-13T00:00:00.000Z",
      }),
    ),
  );

  const reader = new CloudflareD1ObservabilitySink({ db });
  expect(await reader.verifyAuditChain()).toBe(true);
  expect((await reader.listAudit()).map((record) => record.sequence)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
});

test("Cloudflare D1 observability sink persists traces and applies queries", async () => {
  const db = new SqliteFakeD1();
  const recorder = new CloudflareD1ObservabilitySink({ db });
  await recorder.recordTrace({
    id: "span_record_1",
    traceId: "trace_1",
    spanId: "span_1",
    name: "source.sync",
    kind: "internal",
    status: "ok",
    startTime: "2026-07-13T00:00:00.000Z",
    endTime: "2026-07-13T00:00:01.000Z",
    workspaceId: "ws_1",
    attributes: { attempt: 1 },
  });
  await recorder.recordTrace({
    id: "span_record_2",
    traceId: "trace_2",
    spanId: "span_2",
    name: "run.apply",
    kind: "consumer",
    status: "error",
    startTime: "2026-07-13T00:01:00.000Z",
    endTime: "2026-07-13T00:01:01.000Z",
    workspaceId: "ws_2",
  });

  const reader = new CloudflareD1ObservabilitySink({ db });
  expect(
    await reader.listTraces({ traceId: "trace_1", workspaceId: "ws_1" }),
  ).toEqual([
    expect.objectContaining({
      id: "span_record_1",
      traceId: "trace_1",
      attributes: { attempt: 1 },
    }),
  ]);
  expect(await reader.listTraces({ status: "error" })).toHaveLength(1);
});
