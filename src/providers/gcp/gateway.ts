import {
  createJsonGatewayHandler,
  requireGatewayMethod,
} from "../../gateway/mod.ts";
import type { provider } from "takosumi-contract";
import type {
  GcpKmsClient,
  GcpObjectStorageClient,
  GcpObservabilityClient,
  GcpProviderClient,
  GcpQueueClient,
  GcpRouterClient,
  GcpRuntimeAgentClient,
  GcpSecretsClient,
} from "./clients.ts";

type GcpProviderProofService = {
  materializeDesiredState(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<unknown>;
  verifyDesiredState(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<unknown>;
  teardownDesiredState(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<unknown>;
};

export type GcpHttpGatewayServices =
  & Partial<GcpObjectStorageClient>
  & Partial<GcpQueueClient>
  & Partial<GcpKmsClient>
  & Partial<GcpSecretsClient>
  & Partial<GcpProviderClient>
  & Partial<GcpRouterClient>
  & Partial<GcpObservabilityClient>
  & Partial<GcpRuntimeAgentClient>
  & Partial<GcpProviderProofService>;

export function createGcpHttpGatewayHandler(
  services: GcpHttpGatewayServices,
): (request: Request) => Promise<Response> {
  return createJsonGatewayHandler(
    new Map([
      [
        "object-storage/upload-object",
        (input) => call(services, "uploadObject", input),
      ],
      [
        "object-storage/download-object",
        (input) => call(services, "downloadObject", input),
      ],
      [
        "object-storage/stat-object",
        (input) => call(services, "statObject", input),
      ],
      [
        "object-storage/list-objects",
        (input) => call(services, "listObjects", input),
      ],
      [
        "object-storage/delete-object",
        (input) => call(services, "deleteObject", input),
      ],
      [
        "queue/publish-message",
        (input) => call(services, "publishMessage", input),
      ],
      ["queue/pull-message", (input) => call(services, "pullMessage", input)],
      [
        "queue/acknowledge-message",
        (input) => call(services, "acknowledgeMessage", input),
      ],
      [
        "queue/modify-ack-deadline",
        (input) => call(services, "modifyAckDeadline", input),
      ],
      [
        "queue/dead-letter-message",
        (input) => call(services, "deadLetterMessage", input),
      ],
      [
        "kms/get-primary-key-version",
        () => call(services, "getPrimaryKeyVersion"),
      ],
      [
        "kms/encrypt-envelope",
        (input) => call(services, "encryptEnvelope", input),
      ],
      [
        "kms/decrypt-envelope",
        (input) => call(services, "decryptEnvelope", input),
      ],
      [
        "kms/rotate-envelope",
        (input) => call(services, "rotateEnvelope", input),
      ],
      [
        "secrets/add-secret-version",
        (input) => call(services, "addSecretVersion", input),
      ],
      [
        "secrets/access-secret-version",
        (input) => call(services, "accessSecretVersion", input),
      ],
      [
        "secrets/latest-secret-version",
        (input) =>
          callNamed(services, "latestSecretVersion", input, "secretId"),
      ],
      [
        "secrets/list-secret-versions",
        () => call(services, "listSecretVersions"),
      ],
      [
        "secrets/destroy-secret-version",
        (input) => call(services, "destroySecretVersion", input),
      ],
      [
        "provider/materialize-desired-state",
        (input) =>
          callFirst(services, [
            "materializeDesiredState",
            "reconcileDesiredState",
          ], input),
      ],
      [
        "provider/reconcile-desired-state",
        (input) =>
          callFirst(services, [
            "reconcileDesiredState",
            "materializeDesiredState",
          ], input),
      ],
      [
        "provider/verify-desired-state",
        (input) => call(services, "verifyDesiredState", input),
      ],
      [
        "provider/teardown-desired-state",
        (input) => call(services, "teardownDesiredState", input),
      ],
      ["provider/list-operations", () => call(services, "listOperations")],
      ["provider/clear-operations", () => call(services, "clearOperations")],
      ["router/apply-routes", (input) => call(services, "applyRoutes", input)],
      [
        "observability/write-audit-log",
        (input) => call(services, "writeAuditLog", input),
      ],
      ["observability/list-audit-logs", () => call(services, "listAuditLogs")],
      [
        "observability/verify-audit-logs",
        () => call(services, "verifyAuditLogs"),
      ],
      [
        "observability/write-metric",
        (input) => call(services, "writeMetric", input),
      ],
      [
        "observability/list-metric-events",
        (input) => call(services, "listMetricEvents", input),
      ],
      [
        "runtime-agent/register-agent",
        (input) => call(services, "registerAgent", input),
      ],
      [
        "runtime-agent/heartbeat-agent",
        (input) => call(services, "heartbeatAgent", input),
      ],
      [
        "runtime-agent/get-agent",
        (input) => callNamed(services, "getAgent", input, "agentId"),
      ],
      ["runtime-agent/list-agents", () => call(services, "listAgents")],
      [
        "runtime-agent/request-drain",
        (input) => callPair(services, "requestDrain", input, "agentId", "at"),
      ],
      [
        "runtime-agent/revoke-agent",
        (input) => callPair(services, "revokeAgent", input, "agentId", "at"),
      ],
      [
        "runtime-agent/enqueue-work",
        (input) => call(services, "enqueueWork", input),
      ],
      [
        "runtime-agent/lease-work",
        (input) => call(services, "leaseWork", input),
      ],
      [
        "runtime-agent/complete-work",
        (input) => call(services, "completeWork", input),
      ],
      ["runtime-agent/fail-work", (input) => call(services, "failWork", input)],
      [
        "runtime-agent/get-work",
        (input) => callNamed(services, "getWork", input, "workId"),
      ],
      ["runtime-agent/list-work", () => call(services, "listWork")],
    ]),
    { provider: "gcp" },
  );
}

function call(
  services: GcpHttpGatewayServices,
  method: keyof GcpHttpGatewayServices,
  input?: unknown,
): unknown {
  const fn = requireGatewayMethod(services, method) as (
    input?: unknown,
  ) => unknown;
  return fn.call(services, input);
}

function callFirst(
  services: GcpHttpGatewayServices,
  methods: readonly (keyof GcpHttpGatewayServices)[],
  input?: unknown,
): unknown {
  for (const method of methods) {
    if (typeof services[method] === "function") {
      return call(services, method, input);
    }
  }
  throw new Error(
    `gateway method is not configured: ${methods.map(String).join(" or ")}`,
  );
}

function callNamed(
  services: GcpHttpGatewayServices,
  method: keyof GcpHttpGatewayServices,
  input: unknown,
  key: string,
): unknown {
  return call(services, method, record(input)[key]);
}

function callPair(
  services: GcpHttpGatewayServices,
  method: keyof GcpHttpGatewayServices,
  input: unknown,
  firstKey: string,
  secondKey: string,
): unknown {
  const data = record(input);
  const fn = requireGatewayMethod(services, method) as (
    first: unknown,
    second?: unknown,
  ) => unknown;
  return fn.call(services, data[firstKey], data[secondKey]);
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : {};
}
