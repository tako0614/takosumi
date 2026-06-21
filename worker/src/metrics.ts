import type {
  MetricEvent,
  MetricKind,
  ObservabilitySink,
} from "../../core/domains/observability/mod.ts";
import { log } from "../../core/shared/log.ts";
import type { CloudflareWorkerEnv } from "./bindings.ts";

export type WorkerMetricSink = Pick<ObservabilitySink, "recordMetric">;

export interface RecordWorkerMetricInput {
  readonly observability?: WorkerMetricSink;
  readonly env: CloudflareWorkerEnv;
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly tags?: Record<string, string>;
  readonly observedAt?: Date;
}

export async function recordWorkerMetric(
  input: RecordWorkerMetricInput,
): Promise<void> {
  if (!input.observability) return;
  try {
    await input.observability.recordMetric({
      id: `metric_${crypto.randomUUID()}`,
      name: input.name,
      kind: input.kind,
      value: input.value,
      tags: {
        ...workerMetricTags(input.env),
        ...(input.tags ?? {}),
      },
      observedAt: (input.observedAt ?? new Date()).toISOString(),
    } satisfies MetricEvent);
  } catch (error) {
    log.warn("worker.metric_record_failed", {
      metric: input.name,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function workerMetricTags(
  env: CloudflareWorkerEnv,
): Record<string, string> {
  return {
    environment: stringEnv(env.TAKOSUMI_ENVIRONMENT) ?? "development",
    runtime_cell_id:
      stringEnv(env.TAKOSUMI_RUNTIME_CELL_ID) ??
      stringEnv(env.TAKOSUMI_RUNTIME_CELL) ??
      "platform-default",
  };
}

function stringEnv(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : undefined;
}
