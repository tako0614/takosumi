import type { AuditEvent } from "../../domains/audit/types.ts";
import type { ChainedAuditEvent } from "./audit_chain.ts";
import type { ObservabilitySink } from "./sink.ts";
import type { MetricEvent, MetricEventQuery } from "./types.ts";

export interface OtlpMetricsExporterOptions {
  readonly endpoint: string;
  readonly serviceName?: string;
  readonly scopeName?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly failClosed?: boolean;
  readonly fetch?: typeof fetch;
}

export interface OtlpMetricsEnv {
  readonly TAKOSUMI_OTLP_METRICS_ENDPOINT?: string;
  readonly TAKOSUMI_OTLP_HEADERS_JSON?: string;
  readonly TAKOSUMI_OTLP_SERVICE_NAME?: string;
  readonly TAKOSUMI_OTLP_FAIL_CLOSED?: string;
  readonly OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?: string;
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  readonly OTEL_EXPORTER_OTLP_HEADERS?: string;
  readonly OTEL_SERVICE_NAME?: string;
}

export class OtlpObservabilitySink implements ObservabilitySink {
  readonly #base: ObservabilitySink;
  readonly #exporter: OtlpMetricsExporter;
  readonly #failClosed: boolean;

  constructor(base: ObservabilitySink, options: OtlpMetricsExporterOptions) {
    this.#base = base;
    this.#exporter = new OtlpMetricsExporter(options);
    this.#failClosed = options.failClosed === true;
  }

  appendAudit(event: AuditEvent): Promise<ChainedAuditEvent> {
    return this.#base.appendAudit(event);
  }

  listAudit(): Promise<readonly ChainedAuditEvent[]> {
    return this.#base.listAudit();
  }

  verifyAuditChain(): Promise<boolean> {
    return this.#base.verifyAuditChain();
  }

  async recordMetric(event: MetricEvent): Promise<MetricEvent> {
    const recorded = await this.#base.recordMetric(event);
    try {
      await this.#exporter.exportMetric(recorded);
    } catch (error) {
      if (this.#failClosed) throw error;
    }
    return recorded;
  }

  listMetrics(query?: MetricEventQuery): Promise<readonly MetricEvent[]> {
    return this.#base.listMetrics(query);
  }
}

export class OtlpMetricsExporter {
  readonly #endpoint: string;
  readonly #serviceName: string;
  readonly #scopeName: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof fetch;

  constructor(options: OtlpMetricsExporterOptions) {
    this.#endpoint = options.endpoint;
    this.#serviceName = options.serviceName ?? "takosumi-kernel";
    this.#scopeName = options.scopeName ?? "takosumi.kernel";
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? fetch;
  }

  async exportMetric(event: MetricEvent): Promise<void> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.#headers,
      },
      body: JSON.stringify(this.#bodyFor(event)),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `OTLP metrics export failed: HTTP ${response.status} ${text}`.trim(),
      );
    }
  }

  #bodyFor(event: MetricEvent): OtlpMetricsBody {
    return {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              attribute("service.name", this.#serviceName),
              attribute("takosumi.component", "kernel"),
            ],
          },
          scopeMetrics: [
            {
              scope: { name: this.#scopeName },
              metrics: [metricForEvent(event)],
            },
          ],
        },
      ],
    };
  }
}

export function wrapObservabilitySinkWithOtlpMetrics(
  base: ObservabilitySink,
  env: OtlpMetricsEnv | undefined,
): ObservabilitySink {
  const options = otlpOptionsFromEnv(env);
  return options ? new OtlpObservabilitySink(base, options) : base;
}

export function otlpOptionsFromEnv(
  env: OtlpMetricsEnv | undefined,
): OtlpMetricsExporterOptions | undefined {
  const endpoint = firstNonEmpty(
    env?.TAKOSUMI_OTLP_METRICS_ENDPOINT,
    env?.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    endpointFromOtelBase(env?.OTEL_EXPORTER_OTLP_ENDPOINT),
  );
  if (!endpoint) return undefined;
  return {
    endpoint,
    serviceName: firstNonEmpty(
      env?.TAKOSUMI_OTLP_SERVICE_NAME,
      env?.OTEL_SERVICE_NAME,
    ) ?? "takosumi-kernel",
    headers: parseHeaders(env),
    failClosed: parseBoolean(env?.TAKOSUMI_OTLP_FAIL_CLOSED),
  };
}

interface OtlpMetricsBody {
  readonly resourceMetrics: readonly OtlpResourceMetrics[];
}

interface OtlpResourceMetrics {
  readonly resource: {
    readonly attributes: readonly OtlpAttribute[];
  };
  readonly scopeMetrics: readonly OtlpScopeMetrics[];
}

interface OtlpScopeMetrics {
  readonly scope: { readonly name: string };
  readonly metrics: readonly OtlpMetric[];
}

interface OtlpMetric {
  readonly name: string;
  readonly unit?: string;
  readonly gauge?: { readonly dataPoints: readonly OtlpNumberDataPoint[] };
  readonly sum?: {
    readonly aggregationTemporality: number;
    readonly isMonotonic: boolean;
    readonly dataPoints: readonly OtlpNumberDataPoint[];
  };
  readonly histogram?: {
    readonly aggregationTemporality: number;
    readonly dataPoints: readonly OtlpHistogramDataPoint[];
  };
}

interface OtlpNumberDataPoint {
  readonly attributes: readonly OtlpAttribute[];
  readonly timeUnixNano?: string;
  readonly asDouble: number;
}

interface OtlpHistogramDataPoint {
  readonly attributes: readonly OtlpAttribute[];
  readonly timeUnixNano?: string;
  readonly count: string;
  readonly sum: number;
  readonly bucketCounts: readonly string[];
  readonly explicitBounds: readonly number[];
}

interface OtlpAttribute {
  readonly key: string;
  readonly value: {
    readonly stringValue?: string;
    readonly doubleValue?: number;
    readonly intValue?: string;
    readonly boolValue?: boolean;
  };
}

function metricForEvent(event: MetricEvent): OtlpMetric {
  const base = {
    name: event.name,
    ...(event.unit ? { unit: event.unit } : {}),
  };
  switch (event.kind) {
    case "counter":
      return {
        ...base,
        sum: {
          aggregationTemporality: 1,
          isMonotonic: true,
          dataPoints: [numberPointFor(event)],
        },
      };
    case "histogram":
      return {
        ...base,
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [histogramPointFor(event)],
        },
      };
    case "gauge":
    default:
      return {
        ...base,
        gauge: { dataPoints: [numberPointFor(event)] },
      };
  }
}

function numberPointFor(event: MetricEvent): OtlpNumberDataPoint {
  return {
    attributes: attributesForMetric(event),
    ...(timeUnixNano(event.observedAt)
      ? {
        timeUnixNano: timeUnixNano(event.observedAt),
      }
      : {}),
    asDouble: event.value,
  };
}

function histogramPointFor(event: MetricEvent): OtlpHistogramDataPoint {
  return {
    attributes: attributesForMetric(event),
    ...(timeUnixNano(event.observedAt)
      ? {
        timeUnixNano: timeUnixNano(event.observedAt),
      }
      : {}),
    count: "1",
    sum: event.value,
    bucketCounts: ["1"],
    explicitBounds: [],
  };
}

function attributesForMetric(event: MetricEvent): readonly OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [attribute("takosumi.metric.id", event.id)];
  if (event.spaceId) attrs.push(attribute("takosumi.space_id", event.spaceId));
  if (event.groupId) attrs.push(attribute("takosumi.group_id", event.groupId));
  if (event.requestId) {
    attrs.push(attribute("takosumi.request_id", event.requestId));
  }
  if (event.correlationId) {
    attrs.push(attribute("takosumi.correlation_id", event.correlationId));
  }
  for (const [key, value] of Object.entries(event.tags ?? {}).sort()) {
    attrs.push(attribute(`tag.${key}`, value));
  }
  return attrs;
}

function attribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function timeUnixNano(value: string): string | undefined {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return undefined;
  return String(BigInt(millis) * 1_000_000n);
}

function parseHeaders(
  env: OtlpMetricsEnv | undefined,
): Readonly<Record<string, string>> {
  const json = env?.TAKOSUMI_OTLP_HEADERS_JSON;
  if (json && json.trim() !== "") {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed)
            .filter((entry): entry is [string, string] =>
              typeof entry[1] === "string"
            ),
        );
      }
    } catch {
      return {};
    }
  }
  return parseOtelHeaderList(env?.OTEL_EXPORTER_OTLP_HEADERS);
}

function parseOtelHeaderList(
  value: string | undefined,
): Readonly<Record<string, string>> {
  if (!value || value.trim() === "") return {};
  const headers: Record<string, string> = {};
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = decodeURIComponent(part.slice(0, index).trim());
    const headerValue = decodeURIComponent(part.slice(index + 1).trim());
    if (key) headers[key] = headerValue;
  }
  return headers;
}

function endpointFromOtelBase(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.endsWith("/v1/metrics")) return trimmed;
  return `${trimmed.replace(/\/+$/, "")}/v1/metrics`;
}

function firstNonEmpty(
  ...values: readonly (string | undefined)[]
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" ||
    normalized === "yes" || normalized === "on";
}
