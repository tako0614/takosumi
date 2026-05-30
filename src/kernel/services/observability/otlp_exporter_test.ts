import assert from "node:assert/strict";
import { InMemoryObservabilitySink } from "./sink.ts";
import {
  OtlpObservabilitySink,
  otlpOptionsFromEnv,
  wrapObservabilitySinkWithOtlpMetrics,
} from "./otlp_exporter.ts";
import type { MetricEvent, TraceSpanEvent } from "./types.ts";

const metric: MetricEvent = {
  id: "metric_1",
  name: "deploy.apply.duration",
  kind: "gauge",
  value: 1.25,
  unit: "s",
  tags: { provider: "filesystem" },
  spaceId: "space_a",
  observedAt: "2026-05-05T00:00:00.000Z",
};

const traceSpan: TraceSpanEvent = {
  id: "span_1",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: "1111111111111111",
  name: "GET /health",
  kind: "server",
  status: "ok",
  startTime: "2026-05-05T00:00:00.000Z",
  endTime: "2026-05-05T00:00:01.000Z",
  requestId: "req_1",
  correlationId: "corr_1",
  attributes: {
    "http.request.method": "GET",
    "http.response.status_code": 200,
  },
};

Deno.test("OtlpObservabilitySink records locally and exports OTLP JSON metrics", async () => {
  const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const requestInit = init as
      | (
        & { readonly body?: BodyInit; readonly headers?: HeadersInit }
        & RequestInit
      )
      | undefined;
    calls.push({
      url: String(input),
      init,
      body: JSON.parse(String(requestInit?.body)),
    });
    return Promise.resolve(new Response("", { status: 200 }));
  };
  const base = new InMemoryObservabilitySink();
  const sink = new OtlpObservabilitySink(base, {
    endpoint: "http://collector.local/v1/metrics",
    serviceName: "takosumi-test",
    headers: { authorization: "Bearer otlp" },
    fetch: fetchImpl,
  });

  await sink.recordMetric(metric);

  assert.equal((await sink.listMetrics()).length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://collector.local/v1/metrics");
  assert.equal(
    (calls[0]?.init?.headers as Record<string, string>)?.authorization,
    "Bearer otlp",
  );
  const body = calls[0]?.body as {
    resourceMetrics: Array<{
      resource: { attributes: Array<{ key: string; value: unknown }> };
      scopeMetrics: Array<{
        metrics: Array<{
          name: string;
          unit?: string;
          gauge?: {
            dataPoints: Array<{
              asDouble: number;
              timeUnixNano: string;
              attributes: Array<{ key: string; value: unknown }>;
            }>;
          };
        }>;
      }>;
    }>;
  };
  const exported = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0];
  assert.equal(exported?.name, "deploy.apply.duration");
  assert.equal(exported?.unit, "s");
  assert.equal(exported?.gauge?.dataPoints[0]?.asDouble, 1.25);
  assert.equal(
    exported?.gauge?.dataPoints[0]?.timeUnixNano,
    "1777939200000000000",
  );
});

Deno.test("OtlpObservabilitySink records locally and exports OTLP JSON traces", async () => {
  const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const requestInit = init as
      | (
        & { readonly body?: BodyInit; readonly headers?: HeadersInit }
        & RequestInit
      )
      | undefined;
    calls.push({
      url: String(input),
      init,
      body: JSON.parse(String(requestInit?.body)),
    });
    return Promise.resolve(new Response("", { status: 200 }));
  };
  const base = new InMemoryObservabilitySink();
  const sink = new OtlpObservabilitySink(base, {
    tracesEndpoint: "http://collector.local/v1/traces",
    serviceName: "takosumi-test",
    fetch: fetchImpl,
  });

  await sink.recordTrace(traceSpan);

  assert.equal((await sink.listTraces()).length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://collector.local/v1/traces");
  const body = calls[0]?.body as {
    resourceSpans: Array<{
      scopeSpans: Array<{
        spans: Array<{
          traceId: string;
          spanId: string;
          parentSpanId?: string;
          name: string;
          kind: number;
          status: { code: number };
          startTimeUnixNano: string;
          endTimeUnixNano: string;
          attributes: Array<{ key: string; value: Record<string, unknown> }>;
        }>;
      }>;
    }>;
  };
  const exported = body.resourceSpans[0]?.scopeSpans[0]?.spans[0];
  assert.equal(exported?.traceId, traceSpan.traceId);
  assert.equal(exported?.spanId, traceSpan.spanId);
  assert.equal(exported?.parentSpanId, traceSpan.parentSpanId);
  assert.equal(exported?.name, "GET /health");
  assert.equal(exported?.kind, 2);
  assert.equal(exported?.status.code, 1);
  assert.equal(exported?.startTimeUnixNano, "1777939200000000000");
  assert.equal(exported?.endTimeUnixNano, "1777939201000000000");
  assert.ok(
    exported?.attributes.some((attribute) =>
      attribute.key === "takosumi.request_id" &&
      attribute.value.stringValue === "req_1"
    ),
  );
});

Deno.test("OtlpObservabilitySink fail-open keeps metrics when collector fails", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(new Response("down", { status: 503 }));
  const sink = new OtlpObservabilitySink(new InMemoryObservabilitySink(), {
    endpoint: "http://collector.local/v1/metrics",
    fetch: fetchImpl,
  });

  await sink.recordMetric(metric);

  assert.equal((await sink.listMetrics()).length, 1);
});

Deno.test("OtlpObservabilitySink can fail closed for strict telemetry profiles", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(new Response("down", { status: 503 }));
  const sink = new OtlpObservabilitySink(new InMemoryObservabilitySink(), {
    endpoint: "http://collector.local/v1/metrics",
    fetch: fetchImpl,
    failClosed: true,
  });

  await assert.rejects(
    () => sink.recordMetric(metric),
    /OTLP metrics export failed/,
  );
});

Deno.test("otlpOptionsFromEnv supports Takosumi and standard OTEL env vars", () => {
  assert.deepEqual(
    otlpOptionsFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.local:4318/",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20token,x-tenant=a",
      OTEL_SERVICE_NAME: "takosumi-prod",
    }),
    {
      endpoint: "http://collector.local:4318/v1/metrics",
      tracesEndpoint: "http://collector.local:4318/v1/traces",
      serviceName: "takosumi-prod",
      headers: { authorization: "Bearer token", "x-tenant": "a" },
      failClosed: false,
    },
  );
  assert.deepEqual(
    otlpOptionsFromEnv({
      TAKOSUMI_OTLP_METRICS_ENDPOINT: "http://collector.local/v1/metrics",
      TAKOSUMI_OTLP_TRACES_ENDPOINT: "http://collector.local/v1/traces",
      TAKOSUMI_OTLP_HEADERS_JSON: '{"x-api-key":"secret"}',
      TAKOSUMI_OTLP_SERVICE_NAME: "takosumi-api",
      TAKOSUMI_OTLP_FAIL_CLOSED: "true",
    }),
    {
      endpoint: "http://collector.local/v1/metrics",
      tracesEndpoint: "http://collector.local/v1/traces",
      serviceName: "takosumi-api",
      headers: { "x-api-key": "secret" },
      failClosed: true,
    },
  );
});

Deno.test("wrapObservabilitySinkWithOtlpMetrics is a no-op without endpoint", () => {
  const base = new InMemoryObservabilitySink();
  assert.equal(wrapObservabilitySinkWithOtlpMetrics(base, {}), base);
});

Deno.test("wrapObservabilitySinkWithOtlpMetrics accepts trace-only endpoint", () => {
  const base = new InMemoryObservabilitySink();
  const wrapped = wrapObservabilitySinkWithOtlpMetrics(base, {
    TAKOSUMI_OTLP_TRACES_ENDPOINT: "http://collector.local/v1/traces",
  });

  assert.ok(wrapped instanceof OtlpObservabilitySink);
});
