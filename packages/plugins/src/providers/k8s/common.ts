import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";

export type K8sExecutionStatus = "succeeded" | "failed" | "skipped";

export interface K8sExecutionRecord {
  readonly status: K8sExecutionStatus;
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly skipped?: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface K8sObjectAddressInput {
  readonly apiVersion: string;
  readonly kind: string;
  readonly namespace?: string;
  readonly name: string;
}

export function objectAddress(input: K8sObjectAddressInput): string {
  const ns = input.namespace ? `${input.namespace}/` : "";
  return `k8s://${input.apiVersion}/${input.kind}/${ns}${input.name}`;
}

export function namespaceFromDesiredState(
  desiredState: RuntimeDesiredState,
  prefix = "takos",
): string {
  const sanitized = `${prefix}-${desiredState.spaceId}-${desiredState.groupId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return sanitized.length > 0 ? sanitized : `${prefix}-default`;
}

export function workloadName(componentName: string): string {
  return componentName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    if (ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export interface K8sProviderOperationInput {
  readonly id: string;
  readonly kind: string;
  readonly desiredStateId: string;
  readonly targetId: string;
  readonly targetName?: string;
  readonly command: readonly string[];
  readonly details: Record<string, unknown>;
  readonly recordedAt: string;
  readonly execution: K8sExecutionRecord;
}

export function buildOperation(
  input: K8sProviderOperationInput,
): provider.ProviderOperation {
  return deepFreeze({
    id: input.id,
    kind: input.kind,
    provider: "k8s",
    desiredStateId: input.desiredStateId,
    targetId: input.targetId,
    targetName: input.targetName,
    command: [...input.command],
    details: { ...input.details },
    recordedAt: input.recordedAt,
    execution: input.execution,
  });
}

export function compactRecord(
  input: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
