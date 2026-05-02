export type ProviderProofProvider =
  | "aws"
  | "gcp"
  | "k8s"
  | "kubernetes"
  | "cloudflare"
  | "selfhosted"
  | "azure";

export interface ProviderProofDesiredState {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly appName: string;
  readonly workloads: readonly unknown[];
  readonly resources: readonly unknown[];
  readonly routes: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface ProviderProofFixture {
  readonly version: "takos.provider-proof/v1";
  readonly provider: ProviderProofProvider;
  readonly runId: string;
  readonly desiredState: ProviderProofDesiredState;
  readonly expectedDescriptors: readonly string[];
  readonly verify: ProviderProofVerifyConfig;
  readonly cleanup?: ProviderProofCleanupConfig;
  readonly timeouts?: ProviderProofTimeouts;
  readonly metadata?: Record<string, unknown>;
}

export type ProviderProofExecutionMode = "live" | "fixture";

export interface ProviderProofVerifyConfig {
  readonly endpointUrl?: string;
  readonly healthPath?: string;
  readonly expectedStatus?: number;
  readonly timeoutMs?: number;
  readonly gateway?: boolean;
}

export interface ProviderProofCleanupConfig {
  readonly enabled?: boolean;
  readonly strategy?: "gateway" | "operator";
  readonly requireSmokeLabels?: boolean;
  readonly retainOnFailure?: boolean;
}

export interface ProviderProofTimeouts {
  readonly materializeMs?: number;
  readonly verifyMs?: number;
  readonly cleanupMs?: number;
}

export interface ProviderProofStepReport {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly message: string;
  readonly observed?: unknown;
}

export interface ProviderProofReport {
  readonly status: "passed" | "failed";
  readonly executionMode: ProviderProofExecutionMode;
  readonly live: boolean;
  readonly provider: ProviderProofProvider;
  readonly runId: string;
  readonly desiredStateId: string;
  readonly materialization?: unknown;
  readonly verification?: {
    readonly checks: readonly ProviderProofStepReport[];
  };
  readonly cleanup?: {
    readonly attempted: boolean;
    readonly retained: boolean;
    readonly checks: readonly ProviderProofStepReport[];
  };
  readonly operations: readonly unknown[];
}

export function assertProviderProofFixture(
  value: unknown,
): asserts value is ProviderProofFixture {
  if (!isRecord(value)) {
    throw new Error("provider proof fixture must be a JSON object");
  }
  if (value.version !== "takos.provider-proof/v1") {
    throw new Error(
      'provider proof fixture version must be "takos.provider-proof/v1"',
    );
  }
  if (!isProvider(value.provider)) {
    throw new Error(
      "provider proof fixture provider must be one of: aws, gcp, k8s, kubernetes, cloudflare, selfhosted",
    );
  }
  if (!nonEmptyString(value.runId)) {
    throw new Error("provider proof fixture runId must be a non-empty string");
  }
  if (!isDesiredStateLike(value.desiredState)) {
    throw new Error(
      "provider proof fixture desiredState is not RuntimeDesiredState-like",
    );
  }
  if (
    !Array.isArray(value.expectedDescriptors) ||
    value.expectedDescriptors.length === 0 ||
    !value.expectedDescriptors.every(nonEmptyString)
  ) {
    throw new Error(
      "provider proof fixture expectedDescriptors must be a non-empty string array",
    );
  }
  if (!hasProofSurface(value.desiredState)) {
    throw new Error(
      "provider proof fixture desiredState must include at least one workload, resource, or route",
    );
  }
  if (!isRecord(value.verify)) {
    throw new Error("provider proof fixture verify must be an object");
  }
  if (
    value.verify.endpointUrl !== undefined &&
    !nonEmptyString(value.verify.endpointUrl)
  ) {
    throw new Error("provider proof fixture verify.endpointUrl is invalid");
  }
  if (
    value.verify.healthPath !== undefined &&
    (!nonEmptyString(value.verify.healthPath) ||
      !value.verify.healthPath.startsWith("/"))
  ) {
    throw new Error("provider proof fixture verify.healthPath is invalid");
  }
  if (
    value.verify.expectedStatus !== undefined &&
    !isHttpStatus(value.verify.expectedStatus)
  ) {
    throw new Error(
      "provider proof fixture verify.expectedStatus must be an HTTP status",
    );
  }
}

export function isProvider(value: unknown): value is ProviderProofProvider {
  return value === "aws" || value === "gcp" || value === "k8s" ||
    value === "kubernetes" || value === "cloudflare" ||
    value === "selfhosted" || value === "azure";
}

export function operationDescriptor(operation: unknown): string | undefined {
  if (!isRecord(operation)) return undefined;
  const details = isRecord(operation.details) ? operation.details : {};
  const descriptor = details.descriptor;
  return typeof descriptor === "string" ? descriptor : undefined;
}

export function operationExecutionStatus(operation: unknown): string {
  if (!isRecord(operation)) return "unknown";
  const execution = isRecord(operation.execution) ? operation.execution : {};
  return typeof execution.status === "string" ? execution.status : "unknown";
}

function hasProofSurface(desiredState: ProviderProofDesiredState): boolean {
  return desiredState.workloads.length > 0 ||
    desiredState.resources.length > 0 ||
    desiredState.routes.length > 0;
}

function isDesiredStateLike(
  value: unknown,
): value is ProviderProofDesiredState {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.spaceId === "string" &&
    typeof value.groupId === "string" &&
    typeof value.activationId === "string" &&
    typeof value.appName === "string" &&
    Array.isArray(value.workloads) &&
    Array.isArray(value.resources) &&
    Array.isArray(value.routes);
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= 100 && value <= 599;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
