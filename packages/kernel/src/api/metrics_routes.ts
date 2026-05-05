import type { Hono as HonoApp } from "hono";
import type { ObservabilitySink } from "../services/observability/mod.ts";
import type { MetricEvent } from "../services/observability/types.ts";
import { apiError, registerApiErrorHandler } from "./errors.ts";

export const TAKOSUMI_METRICS_PATH = "/metrics" as const;
export const PROMETHEUS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8" as const;

export interface RegisterMetricsRoutesOptions {
  readonly observability: Pick<ObservabilitySink, "listMetrics">;
  readonly getScrapeToken?: () => string | undefined;
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
    if (!presented || !constantTimeEquals(presented, expected)) {
      return c.json(apiError("unauthenticated", "invalid scrape token"), 401);
    }
    const metrics = await options.observability.listMetrics();
    return new Response(renderPrometheusMetrics(metrics, options.now?.()), {
      status: 200,
      headers: { "content-type": PROMETHEUS_CONTENT_TYPE },
    });
  });
}

export function renderPrometheusMetrics(
  events: readonly MetricEvent[],
  _now: Date = new Date(),
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
  for (const [name, namedEvents] of [...byName.entries()].sort()) {
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
  return `${lines.join("\n")}\n`;
}

const HISTOGRAM_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
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
        `${name}_bucket${renderLabels({ ...labels, le: String(bucket) })} ${
          formatNumber(count)
        }`,
      );
    }
    lines.push(
      `${name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${
        formatNumber(samples.length)
      }`,
    );
    lines.push(`${name}_sum${renderLabels(labels)} ${formatNumber(sum)}`);
    lines.push(
      `${name}_count${renderLabels(labels)} ${formatNumber(samples.length)}`,
    );
  }
}

function aggregateSamples(
  events: readonly MetricEvent[],
  kind: MetricEvent["kind"],
): readonly { readonly labels: string; readonly value: number }[] {
  const byLabels = groupByLabels(events);
  return [...byLabels.entries()].map(([labelKey, samples]) => {
    const value = kind === "counter"
      ? samples.reduce((total, event) => total + event.value, 0)
      : samples.at(-1)?.value ?? 0;
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
  return `{${
    entries.map(([key, value]) =>
      `${sanitizeLabelName(key)}="${escapeLabelValue(value)}"`
    ).join(",")
  }}`;
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
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(
    /"/g,
    '\\"',
  );
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

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}
