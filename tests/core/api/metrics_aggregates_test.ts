import { expect, test } from "bun:test";

import { renderPrometheusMetrics } from "../../../core/api/metrics_routes.ts";
import { InMemoryObservabilitySink } from "../../../core/domains/observability/mod.ts";
import type { MetricEvent } from "../../../core/domains/observability/types.ts";
import {
  boundedAggregateLabels,
  metricHistogramBuckets,
  RUN_DURATION_HISTOGRAM_BUCKETS,
} from "../../../core/domains/observability/metric_layout.ts";

function counterEvent(id: string, value: number): MetricEvent {
  return {
    id,
    name: "takosumi_deploy_operation_count",
    kind: "counter",
    value,
    tags: {
      environment: "test",
      runner_profile_id: "opentofu-default",
      operation_kind: "apply",
      status: "succeeded",
    },
    observedAt: "2026-08-23T00:00:00.000Z",
  };
}

test("counters render monotonic totals from aggregates across event pruning", async () => {
  const sink = new InMemoryObservabilitySink();
  await sink.recordMetric(counterEvent("m1", 1));
  await sink.recordMetric(counterEvent("m2", 1));
  await sink.recordMetric(counterEvent("m3", 1));

  // Event retention prunes raw events; the durable aggregates keep the total.
  // Simulate by rendering with an EMPTY event list plus the aggregates.
  const aggregates = await sink.listMetricAggregates();
  const exposition = renderPrometheusMetrics([], new Date(0), { aggregates });
  const counterLine = exposition
    .split("\n")
    .find((line) => line.startsWith("takosumi_deploy_operation_count{"));
  expect(counterLine).toBeDefined();
  expect(counterLine!.endsWith(" 3")).toBe(true);
});

test("apply-duration histograms use the run-length bucket layout", async () => {
  expect(metricHistogramBuckets("takosumi_apply_duration_seconds")).toEqual(
    RUN_DURATION_HISTOGRAM_BUCKETS,
  );
  const sink = new InMemoryObservabilitySink();
  await sink.recordMetric({
    id: "h1",
    name: "takosumi_apply_duration_seconds",
    kind: "histogram",
    // A realistic 3-minute apply: under the 30 s legacy layout this landed in
    // +Inf only and the p95 panel could never produce a number.
    value: 180,
    tags: { environment: "test", operation_kind: "apply" },
    observedAt: "2026-08-23T00:00:00.000Z",
  });
  const exposition = renderPrometheusMetrics([], new Date(0), {
    aggregates: await sink.listMetricAggregates(),
  });
  expect(exposition).toContain('le="300"} 1');
  expect(exposition).toContain('le="120"} 0');
  expect(exposition).toContain("takosumi_apply_duration_seconds_sum");
});

test("aggregate labels are bounded: tenant identifiers never become series", () => {
  const labels = boundedAggregateLabels({
    tags: {
      environment: "test",
      workspace_id: "ws_secret_tenant",
      capsule_id: "cap_secret",
      operation_kind: "apply",
      status: "failed",
      run_id: "run_x",
    },
  });
  expect(labels).toEqual({
    environment: "test",
    operation_kind: "apply",
    status: "failed",
  });
});

test("gauges still render from the latest events alongside aggregates", async () => {
  const sink = new InMemoryObservabilitySink();
  await sink.recordMetric({
    id: "g1",
    name: "takosumi_run_queue_depth",
    kind: "gauge",
    value: 4,
    tags: { environment: "test", operation_kind: "apply" },
    observedAt: "2026-08-23T00:00:00.000Z",
  });
  await sink.recordMetric({
    id: "g2",
    name: "takosumi_run_queue_depth",
    kind: "gauge",
    value: 2,
    tags: { environment: "test", operation_kind: "apply" },
    observedAt: "2026-08-23T00:01:00.000Z",
  });
  const exposition = renderPrometheusMetrics(
    await sink.listMetrics(),
    new Date(0),
    { aggregates: await sink.listMetricAggregates() },
  );
  const gaugeLine = exposition
    .split("\n")
    .find((line) => line.startsWith("takosumi_run_queue_depth{"));
  // Last write wins for a gauge — never a sum.
  expect(gaugeLine?.endsWith(" 2")).toBe(true);
});

test("every metric the alert rules reference is an emitted metric name", async () => {
  const yaml = await Bun.file(
    new URL(
      "../../../deploy/observability/prometheus/takosumi-alerts.yaml",
      import.meta.url,
    ),
  ).text();
  const referenced = new Set(
    [...yaml.matchAll(/takosumi_[a-z0-9_]+/g)].map((match) => match[0]),
  );
  // The emitters, by source: run_engine #recordDeployOperationMetric +
  // queue-latency, container_runner capacity counter, worker.ts sweep
  // counters + ledger-derived gauges, metrics_routes scrape info.
  const emitted = new Set([
    "takosumi_metrics_scrape_info",
    "takosumi_deploy_operation_count",
    "takosumi_apply_duration_seconds",
    "takosumi_run_queue_latency_seconds",
    "takosumi_runner_capacity_exhausted_total",
    "takosumi_run_repair_total",
    "takosumi_sweep_scanned_total",
    "takosumi_stale_auto_plan_total",
    "takosumi_work_items_processed_total",
    "takosumi_run_queue_depth",
    "takosumi_run_queue_oldest_age_seconds",
    "takosumi_runs_running",
    "takosumi_runs_heartbeat_stale",
    "takosumi_billing_capture_pending",
    "takosumi_work_items_backlog",
  ]);
  for (const name of referenced) {
    expect(emitted.has(name), `alert references unemitted metric ${name}`).toBe(
      true,
    );
  }
});
