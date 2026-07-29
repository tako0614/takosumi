import { expect, test } from "bun:test";

import { CloudflareD1ObservabilitySink } from "../../../worker/src/d1_observability.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

async function canonicalObservabilityDb(): Promise<SqliteFakeD1> {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  return db;
}

test("Cloudflare D1 observability requests execute no schema DDL", async () => {
  const db = await canonicalObservabilityDb();
  const queries: string[] = [];
  const observed: D1Database = {
    prepare(query) {
      const normalized = query.trim();
      queries.push(normalized);
      if (/^(?:create|alter|drop|pragma|reindex|vacuum)\b/iu.test(normalized)) {
        throw new Error(`request-time schema DDL: ${normalized}`);
      }
      return db.prepare(query);
    },
    batch: db.batch.bind(db),
  };
  const sink = new CloudflareD1ObservabilitySink({ db: observed });
  expect(queries).toEqual([]);

  const observedAt = new Date().toISOString();
  await sink.recordMetric({
    id: "metric_no_ddl",
    name: "no_ddl",
    kind: "counter",
    value: 1,
    observedAt,
  });
  await sink.recordTrace({
    id: "trace_no_ddl",
    traceId: "trace_no_ddl",
    spanId: "span_no_ddl",
    name: "no_ddl",
    kind: "internal",
    status: "ok",
    startTime: observedAt,
    endTime: observedAt,
  });
  await sink.appendAudit({
    id: "audit_no_ddl",
    eventClass: "compliance",
    type: "observability.recorded",
    severity: "info",
    payload: {},
    occurredAt: observedAt,
  });
  expect(await sink.listMetrics({ name: "no_ddl" })).toHaveLength(1);
  expect(await sink.listTraces({ name: "no_ddl" })).toHaveLength(1);
  expect(await sink.listAudit()).toHaveLength(1);
  expect(
    queries.every(
      (query) =>
        !/^(?:create|alter|drop|pragma|reindex|vacuum)\b/iu.test(query),
    ),
  ).toBe(true);
});

test("Cloudflare D1 observability fails closed before canonical boot", async () => {
  const db = new SqliteFakeD1();
  const sink = new CloudflareD1ObservabilitySink({ db });
  await expect(
    sink.recordMetric({
      id: "metric_unbooted",
      name: "unbooted",
      kind: "counter",
      value: 1,
      observedAt: new Date().toISOString(),
    }),
  ).rejects.toThrow();
  expect(
    await db
      .prepare(
        `select name from sqlite_master
         where type = 'table' and name like 'takosumi_observability_%'`,
      )
      .first(),
  ).toBeNull();
});

test("Cloudflare D1 observability sink persists metrics across instances", async () => {
  const db = await canonicalObservabilityDb();
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

test("Cloudflare D1 observability sink returns the newest bounded metric window", async () => {
  const db = await canonicalObservabilityDb();
  const sink = new CloudflareD1ObservabilitySink({ db });
  await sink.recordMetric({
    id: "metric_schema_seed",
    name: "seed",
    kind: "gauge",
    value: 0,
    observedAt: new Date().toISOString(),
  });
  await db.prepare("delete from takosumi_observability_metrics").run();
  await db
    .prepare(
      `with recursive samples(value) as (
         select 0
         union all
         select value + 1 from samples where value < 5000
       )
       insert into takosumi_observability_metrics
         (id, name, kind, value, observed_at)
       select printf('metric_%05d', value), 'bounded', 'gauge', value,
              printf('%05d', value)
         from samples`,
    )
    .run();

  const metrics = await sink.listMetrics({ name: "bounded" });
  expect(metrics).toHaveLength(5000);
  expect(metrics[0]?.id).toBe("metric_00001");
  expect(metrics.at(-1)?.id).toBe("metric_05000");
});

test("Cloudflare D1 observability sink retains only recent metric and trace samples", async () => {
  const db = await canonicalObservabilityDb();
  const initializer = new CloudflareD1ObservabilitySink({ db });
  await initializer.recordMetric({
    id: "metric_schema_seed",
    name: "seed",
    kind: "gauge",
    value: 0,
    observedAt: new Date().toISOString(),
  });
  await db
    .prepare(
      `insert into takosumi_observability_metrics
         (id, name, kind, value, observed_at)
       values ('metric_expired', 'expired', 'gauge', 1,
               '2020-01-01T00:00:00.000Z')`,
    )
    .run();
  await db
    .prepare(
      `insert into takosumi_observability_traces
         (id, trace_id, span_id, name, kind, status, start_time, end_time,
          event_json)
       values ('span_expired', 'trace_expired', 'span_expired', 'expired',
               'internal', 'ok', '2020-01-01T00:00:00.000Z',
               '2020-01-01T00:00:01.000Z', '{}')`,
    )
    .run();

  const sweeper = new CloudflareD1ObservabilitySink({ db });
  await sweeper.recordMetric({
    id: "metric_sweep",
    name: "sweep",
    kind: "gauge",
    value: 0,
    observedAt: new Date().toISOString(),
  });
  expect(await sweeper.listTraces({ name: "expired" })).toEqual([]);
  expect(await sweeper.listMetrics({ name: "expired" })).toEqual([]);
});

test("Cloudflare D1 observability sink persists and verifies the audit chain", async () => {
  const db = await canonicalObservabilityDb();
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
  const db = await canonicalObservabilityDb();
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
  const db = await canonicalObservabilityDb();
  const recorder = new CloudflareD1ObservabilitySink({ db });
  const firstStartedAt = new Date();
  const secondStartedAt = new Date(firstStartedAt.getTime() + 60_000);
  await recorder.recordTrace({
    id: "span_record_1",
    traceId: "trace_1",
    spanId: "span_1",
    name: "source.sync",
    kind: "internal",
    status: "ok",
    startTime: firstStartedAt.toISOString(),
    endTime: new Date(firstStartedAt.getTime() + 1_000).toISOString(),
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
    startTime: secondStartedAt.toISOString(),
    endTime: new Date(secondStartedAt.getTime() + 1_000).toISOString(),
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
