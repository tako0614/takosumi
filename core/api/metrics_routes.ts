import type { Hono as HonoApp } from "hono";
import type { ObservabilitySink } from "../domains/observability/mod.ts";
import type { MetricEvent } from "../domains/observability/types.ts";
import { apiError, registerApiErrorHandler } from "./errors.ts";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import type { ApiEndpoint } from "./route_families.ts";

export const TAKOSUMI_METRICS_PATH = "/metrics" as const;
export const PROMETHEUS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8" as const;

/**
 * Endpoint inventory for the `metrics` family, co-located with the mount call
 * below. Consumed by `route_families.ts` to derive `/capabilities` and
 * `/openapi.json`. The Prometheus exposition response is non-JSON, so the
 * OpenAPI operation is supplied verbatim via `customOperation`. Keep in
 * lockstep with {@link registerMetricsRoutes}.
 */
export const METRICS_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    method: "GET",
    path: TAKOSUMI_METRICS_PATH,
    summary:
      "Returns Prometheus exposition format metrics for service scrape pipelines.",
    auth: "metrics-scrape",
    operationId: "getMetrics",
    openapi: {
      okSchema: "EmptyResponse",
      customOperation: {
        tags: ["metrics"],
        security: [{ metricsBearer: [] }],
        responses: {
          "200": {
            description: "Prometheus exposition document.",
            content: {
              [PROMETHEUS_CONTENT_TYPE]: {
                schema: {
                  type: "string",
                  description:
                    "Prometheus text exposition format (one metric per line).",
                },
              },
            },
          },
          "401": {
            description: "JSON response",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "404": {
            description: "JSON response",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
        "x-takos-auth": "metrics-scrape",
        "x-takos-mounted-path": TAKOSUMI_METRICS_PATH,
      },
    },
  },
] as const;

export interface RegisterMetricsRoutesOptions {
  readonly observability: Pick<ObservabilitySink, "listMetrics">;
  readonly getScrapeToken?: () => string | undefined;
  readonly metricTags?: Record<string, string>;
  readonly now?: () => Date;
}

export function registerMetricsRoutes(
  app: HonoApp,
  options: RegisterMetricsRoutesOptions,
): void {
  registerApiErrorHandler(app);
  app.get(TAKOSUMI_METRICS_PATH, async (c) => {
    const expected = options.getScrapeToken?.();
    if (!expected) {
      return c.json(apiError("not_found", "metrics endpoint disabled"), 404);
    }
    const presented = readBearerToken(c.req.header("authorization"));
    if (!presented || !constantTimeEqualsString(presented, expected)) {
      return c.json(apiError("unauthenticated", "invalid scrape token"), 401);
    }
    const metrics = await options.observability.listMetrics();
    const now = options.now?.() ?? new Date();
    return new Response(
      renderPrometheusMetrics(metrics, now, {
        defaultTags: options.metricTags,
      }),
      {
        status: 200,
        headers: { "content-type": PROMETHEUS_CONTENT_TYPE },
      },
    );
  });
}

export interface RenderPrometheusMetricsOptions {
  readonly defaultTags?: Record<string, string>;
}

export function renderPrometheusMetrics(
  events: readonly MetricEvent[],
  _now: Date = new Date(),
  options: RenderPrometheusMetricsOptions = {},
): string {
  const byName = new Map<string, MetricEvent[]>();
  for (const event of events) {
    const name = sanitizeMetricName(event.name);
    byName.set(name, [...(byName.get(name) ?? []), event]);
  }
  const lines: string[] = [
    "# HELP takosumi_metrics_scrape_info Takosumi metrics scrape metadata.",
    "# TYPE takosumi_metrics_scrape_info gauge",
    "takosumi_metrics_scrape_info 1",
  ];
  const renderedNames = new Set<string>();
  for (const [name, namedEvents] of [...byName.entries()].sort()) {
    renderedNames.add(name);
    const kind = namedEvents[0]?.kind ?? "gauge";
    if (kind === "histogram") {
      renderHistogram(lines, name, namedEvents);
      continue;
    }
    const type = kind === "counter" ? "counter" : "gauge";
    lines.push(`# TYPE ${name} ${type}`);
    const aggregates = aggregateSamples(namedEvents, kind);
    for (const sample of aggregates) {
      lines.push(`${name}${sample.labels} ${formatNumber(sample.value)}`);
    }
  }
  const defaultSeries = options.defaultTags
    ? defaultDashboardMetricSeries(options.defaultTags)
    : [];
  for (const series of defaultSeries) {
    const name = sanitizeMetricName(series.name);
    if (renderedNames.has(name)) continue;
    renderDefaultSeries(lines, { ...series, name });
  }
  return `${lines.join("\n")}\n`;
}

const HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const;

function renderHistogram(
  lines: string[],
  name: string,
  events: readonly MetricEvent[],
): void {
  lines.push(`# TYPE ${name} histogram`);
  const byLabels = groupByLabels(events);
  for (const [labelKey, samples] of byLabels) {
    const labels = parseLabelKey(labelKey);
    const sum = samples.reduce((total, event) => total + event.value, 0);
    for (const bucket of HISTOGRAM_BUCKETS) {
      const count = samples.filter((event) => event.value <= bucket).length;
      lines.push(
        `${name}_bucket${renderLabels({ ...labels, le: String(bucket) })} ${formatNumber(
          count,
        )}`,
      );
    }
    lines.push(
      `${name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${formatNumber(
        samples.length,
      )}`,
    );
    lines.push(`${name}_sum${renderLabels(labels)} ${formatNumber(sum)}`);
    lines.push(
      `${name}_count${renderLabels(labels)} ${formatNumber(samples.length)}`,
    );
  }
}

interface DefaultMetricSeries {
  readonly name: string;
  readonly kind: MetricEvent["kind"];
  readonly tags: Record<string, string>;
}

function defaultDashboardMetricSeries(
  inputTags: Record<string, string>,
): readonly DefaultMetricSeries[] {
  const baseTags = {
    environment: normalizedDefaultTag(inputTags.environment) ?? "local",
    runtime_cell_id:
      normalizedDefaultTag(inputTags.runtime_cell_id) ?? "platform-default",
  };
  const deployTags = {
    ...baseTags,
    space_id: "none",
    capsule_id: "none",
    operationKind: "none",
    status: "idle",
  };
  const runnerTags = {
    ...baseTags,
    operationKind: "none",
    status: "idle",
  };
  return [
    {
      name: "takosumi_deploy_operation_count",
      kind: "counter",
      tags: deployTags,
    },
    {
      name: "takosumi_apply_duration_seconds",
      kind: "histogram",
      tags: deployTags,
    },
    {
      name: "takosumi_runner_queue_age_seconds",
      kind: "gauge",
      tags: {
        ...runnerTags,
        space_id: "none",
      },
    },
    {
      name: "takosumi_runner_active_runs",
      kind: "gauge",
      tags: runnerTags,
    },
    {
      name: "takosumi_runner_container_startup_seconds",
      kind: "histogram",
      tags: runnerTags,
    },
    {
      name: "takosumi_api_request_duration_seconds",
      kind: "histogram",
      tags: {
        ...baseTags,
        method: "GET",
        route: "/api/*",
        status: "200",
      },
    },
    {
      name: "takosumi_oidc_request_count",
      kind: "counter",
      tags: {
        ...baseTags,
        method: "GET",
        route: "/.well-known/openid-configuration",
        status: "200",
      },
    },
  ];
}

function renderDefaultSeries(
  lines: string[],
  series: DefaultMetricSeries,
): void {
  if (series.kind === "histogram") {
    lines.push(`# TYPE ${series.name} histogram`);
    for (const bucket of HISTOGRAM_BUCKETS) {
      lines.push(
        `${series.name}_bucket${renderLabels({
          ...series.tags,
          le: String(bucket),
        })} 0`,
      );
    }
    lines.push(
      `${series.name}_bucket${renderLabels({ ...series.tags, le: "+Inf" })} 0`,
    );
    lines.push(`${series.name}_sum${renderLabels(series.tags)} 0`);
    lines.push(`${series.name}_count${renderLabels(series.tags)} 0`);
    return;
  }
  const type = series.kind === "counter" ? "counter" : "gauge";
  lines.push(`# TYPE ${series.name} ${type}`);
  lines.push(`${series.name}${renderLabels(series.tags)} 0`);
}

function normalizedDefaultTag(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function aggregateSamples(
  events: readonly MetricEvent[],
  kind: MetricEvent["kind"],
): readonly { readonly labels: string; readonly value: number }[] {
  const byLabels = groupByLabels(events);
  return [...byLabels.entries()].map(([labelKey, samples]) => {
    const value =
      kind === "counter"
        ? samples.reduce((total, event) => total + event.value, 0)
        : (samples.at(-1)?.value ?? 0);
    return { labels: renderLabels(parseLabelKey(labelKey)), value };
  });
}

function groupByLabels(
  events: readonly MetricEvent[],
): Map<string, readonly MetricEvent[]> {
  const groups = new Map<string, MetricEvent[]>();
  for (const event of events) {
    const labels = labelsForEvent(event);
    const key = JSON.stringify(labels);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return groups;
}

function labelsForEvent(event: MetricEvent): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      ...(event.spaceId ? { spaceId: event.spaceId } : {}),
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.tags ?? {}),
    }).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseLabelKey(key: string): Record<string, string> {
  return JSON.parse(key) as Record<string, string>;
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries
    .map(
      ([key, value]) =>
        `${sanitizeLabelName(key)}="${escapeLabelValue(value)}"`,
    )
    .join(",")}}`;
}

function sanitizeMetricName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function sanitizeLabelName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "bearer") return undefined;
  return token;
}
