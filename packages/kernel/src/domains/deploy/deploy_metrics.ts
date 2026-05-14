import type { JsonObject } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";
import { log } from "../../shared/log.ts";

export const TAKOSUMI_DEPLOY_OPERATION_COUNT =
  "takosumi_deploy_operation_count";
export const TAKOSUMI_APPLY_DURATION_SECONDS =
  "takosumi_apply_duration_seconds";
export const TAKOSUMI_ROLLBACK_DURATION_SECONDS =
  "takosumi_rollback_duration_seconds";

export type DeployMetricOperationKind =
  | "plan"
  | "apply"
  | "destroy"
  | "rollback";
export type DeployMetricStatus =
  | "succeeded"
  | "failed"
  | "failed-validation"
  | "partial";

export interface DeployMetricEvent {
  readonly id: string;
  readonly name: string;
  readonly kind: "counter" | "histogram";
  readonly value: number;
  readonly unit?: string;
  readonly tags?: Record<string, string>;
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly payload?: JsonObject;
  readonly observedAt: IsoTimestamp;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface DeployMetricSink {
  recordMetric(event: DeployMetricEvent): Promise<unknown>;
}

export interface DeployMetricTimer {
  readonly startedAtMs: number;
}

export interface DeployMetricRecorderOptions {
  readonly observability?: DeployMetricSink;
  readonly idFactory?: () => string;
  readonly now?: () => IsoTimestamp;
  readonly monotonicNow?: () => number;
  readonly warn?: (message: string) => void;
}

export interface DeployMetricRecordInput {
  readonly operationKind: DeployMetricOperationKind;
  readonly status: DeployMetricStatus;
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly deploymentName?: string;
  readonly startedAtMs?: number;
  readonly observedAt?: IsoTimestamp;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly payload?: JsonObject;
}

export function startDeployMetricTimer(
  monotonicNow: () => number = defaultMonotonicNow,
): DeployMetricTimer {
  return { startedAtMs: monotonicNow() };
}

export async function recordDeployOperationMetric(
  options: DeployMetricRecorderOptions,
  input: DeployMetricRecordInput,
): Promise<void> {
  const sink = options.observability;
  if (!sink) return;
  const observedAt = input.observedAt ?? options.now?.() ??
    new Date().toISOString();
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const tags = {
    operationKind: input.operationKind,
    status: input.status,
  };
  const payload = compactJsonObject({
    kind: "takosumi.deploy.metric@v1",
    operationKind: input.operationKind,
    status: input.status,
    deploymentName: input.deploymentName,
    ...input.payload,
  });

  await safeRecordMetric(options, {
    id: `metric:${idFactory()}`,
    name: TAKOSUMI_DEPLOY_OPERATION_COUNT,
    kind: "counter",
    value: 1,
    tags,
    spaceId: input.spaceId,
    groupId: input.groupId,
    payload,
    observedAt,
    requestId: input.requestId,
    correlationId: input.correlationId,
  });

  const durationMetricName = durationMetricNameFor(input.operationKind);
  if (!durationMetricName || input.startedAtMs === undefined) return;
  const durationSeconds = Math.max(
    0,
    ((options.monotonicNow ?? defaultMonotonicNow)() - input.startedAtMs) /
      1000,
  );
  await safeRecordMetric(options, {
    id: `metric:${idFactory()}`,
    name: durationMetricName,
    kind: "histogram",
    value: durationSeconds,
    unit: "seconds",
    tags,
    spaceId: input.spaceId,
    groupId: input.groupId,
    payload,
    observedAt,
    requestId: input.requestId,
    correlationId: input.correlationId,
  });
}

function durationMetricNameFor(
  operationKind: DeployMetricOperationKind,
): string | undefined {
  if (operationKind === "apply") return TAKOSUMI_APPLY_DURATION_SECONDS;
  if (operationKind === "rollback") return TAKOSUMI_ROLLBACK_DURATION_SECONDS;
  return undefined;
}

async function safeRecordMetric(
  options: DeployMetricRecorderOptions,
  event: DeployMetricEvent,
): Promise<void> {
  try {
    await options.observability?.recordMetric(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.warn) {
      options.warn(
        `[takosumi-metrics] failed to record ${event.name}: ${message}`,
      );
    } else {
      log.warn("kernel.deploy.metric_record_failed", {
        metric: event.name,
        message,
      });
    }
  }
}

function defaultMonotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function compactJsonObject(input: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value as JsonObject[string];
  }
  return output;
}
