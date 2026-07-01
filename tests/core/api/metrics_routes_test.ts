import { test } from "bun:test";
import assert from "node:assert/strict";
import { Hono, type Hono as HonoApp } from "hono";
import { InMemoryObservabilitySink } from "../../../core/domains/observability/mod.ts";
import {
  PROMETHEUS_CONTENT_TYPE,
  registerMetricsRoutes,
  renderPrometheusMetrics,
  TAKOSUMI_METRICS_PATH,
} from "../../../core/api/metrics_routes.ts";

test("metrics route requires bearer scrape token", async () => {
  const app = createApp("scrape-token");

  const missing = await app.request(TAKOSUMI_METRICS_PATH);
  assert.equal(missing.status, 401);

  const wrong = await app.request(TAKOSUMI_METRICS_PATH, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(wrong.status, 401);
});

test("metrics route returns Prometheus text exposition", async () => {
  const observability = new InMemoryObservabilitySink();
  await observability.recordMetric({
    id: "metric:1",
    name: "takosumi_revoke_debt_count",
    kind: "gauge",
    value: 2,
    tags: { status: "open" },
    spaceId: "space:one",
    observedAt: "2026-05-04T00:00:00.000Z",
  });
  const app = createApp("scrape-token", observability);

  const response = await app.request(TAKOSUMI_METRICS_PATH, {
    headers: { authorization: "Bearer scrape-token" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), PROMETHEUS_CONTENT_TYPE);
  const body = await response.text();
  assert.match(body, /# TYPE takosumi_revoke_debt_count gauge/);
  assert.match(
    body,
    /takosumi_revoke_debt_count\{spaceId="space:one",status="open"\} 2/,
  );
});

test("renderPrometheusMetrics aggregates counters and histograms", () => {
  const rendered = renderPrometheusMetrics([
    {
      id: "metric:counter:1",
      name: "takosumi_rate_limit_throttle_count",
      kind: "counter",
      value: 2,
      tags: { route: "/v1/installations" },
      observedAt: "2026-05-04T00:00:00.000Z",
    },
    {
      id: "metric:counter:2",
      name: "takosumi_rate_limit_throttle_count",
      kind: "counter",
      value: 3,
      tags: { route: "/v1/installations" },
      observedAt: "2026-05-04T00:00:01.000Z",
    },
    {
      id: "metric:histogram:1",
      name: "takosumi_apply_duration_seconds",
      kind: "histogram",
      value: 0.2,
      spaceId: "space:one",
      tags: { operationKind: "create" },
      observedAt: "2026-05-04T00:00:02.000Z",
    },
  ]);

  assert.match(
    rendered,
    /takosumi_rate_limit_throttle_count\{route="\/v1\/installations"\} 5/,
  );
  assert.match(
    rendered,
    /takosumi_apply_duration_seconds_bucket\{operationKind="create",spaceId="space:one",le="\+Inf"\} 1/,
  );
  assert.match(
    rendered,
    /takosumi_apply_duration_seconds_sum\{operationKind="create",spaceId="space:one"\} 0.2/,
  );
});

test("renderPrometheusMetrics exposes zero dashboard series for missing families", () => {
  const rendered = renderPrometheusMetrics(
    [],
    new Date("2026-05-04T00:00:00.000Z"),
    {
      defaultTags: {
        environment: "production",
        runtime_cell_id: "cell_a",
      },
    },
  );

  assert.match(
    rendered,
    /takosumi_runner_queue_age_seconds\{environment="production",runtime_cell_id="cell_a",operationKind="none",status="idle",space_id="none"\} 0/,
  );
  assert.match(
    rendered,
    /takosumi_api_request_duration_seconds_bucket\{environment="production",runtime_cell_id="cell_a",method="GET",route="\/api\/\*",status="200",le="\+Inf"\} 0/,
  );
  assert.match(
    rendered,
    /takosumi_oidc_request_count\{environment="production",runtime_cell_id="cell_a",method="GET",route="\/\.well-known\/openid-configuration",status="200"\} 0/,
  );
});

test("renderPrometheusMetrics keeps real families instead of adding defaults", () => {
  const rendered = renderPrometheusMetrics(
    [
      {
        id: "metric:queue:1",
        name: "takosumi_runner_queue_age_seconds",
        kind: "gauge",
        value: 12,
        tags: {
          environment: "production",
          operationKind: "apply",
          runtime_cell_id: "cell_a",
          space_id: "space_live",
          status: "dequeued",
        },
        observedAt: "2026-05-04T00:00:00.000Z",
      },
    ],
    new Date("2026-05-04T00:00:00.000Z"),
    {
      defaultTags: {
        environment: "production",
        runtime_cell_id: "cell_a",
      },
    },
  );

  assert.match(
    rendered,
    /takosumi_runner_queue_age_seconds\{environment="production",operationKind="apply",runtime_cell_id="cell_a",space_id="space_live",status="dequeued"\} 12/,
  );
  assert.doesNotMatch(
    rendered,
    /takosumi_runner_queue_age_seconds\{environment="production",operationKind="none"/,
  );
});

function createApp(
  token: string | undefined,
  observability = new InMemoryObservabilitySink(),
): HonoApp {
  const app: HonoApp = new Hono();
  registerMetricsRoutes(app, {
    observability,
    getScrapeToken: () => token,
  });
  return app;
}
