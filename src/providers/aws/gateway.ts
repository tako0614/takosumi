import {
  createJsonGatewayHandler,
  requireGatewayMethod,
} from "../../gateway/mod.ts";
import type { provider } from "takosumi-contract";
import type {
  AwsKmsClient,
  AwsObjectStorageClient,
  AwsObservabilityClient,
  AwsProviderClient,
  AwsQueueClient,
  AwsRouterClient,
  AwsRuntimeAgentClient,
  AwsSecretsClient,
} from "./clients.ts";

type AwsProviderProofService = {
  verifyDesiredState(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<unknown>;
  teardownDesiredState(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<unknown>;
};

export type AwsHttpGatewayServices =
  & Partial<AwsObjectStorageClient>
  & Partial<AwsQueueClient>
  & Partial<AwsKmsClient>
  & Partial<AwsSecretsClient>
  & Partial<AwsProviderClient>
  & Partial<AwsRouterClient>
  & Partial<AwsObservabilityClient>
  & Partial<AwsRuntimeAgentClient>
  & Partial<AwsProviderProofService>;

export function createAwsHttpGatewayHandler(
  services: AwsHttpGatewayServices,
): (request: Request) => Promise<Response> {
  return createJsonGatewayHandler(
    new Map([
      [
        "object-storage/put-object",
        (input) => call(services, "putObject", input),
      ],
      [
        "object-storage/get-object",
        (input) => call(services, "getObject", input),
      ],
      [
        "object-storage/head-object",
        (input) => call(services, "headObject", input),
      ],
      [
        "object-storage/list-objects",
        (input) => call(services, "listObjects", input),
      ],
      [
        "object-storage/delete-object",
        (input) => call(services, "deleteObject", input),
      ],
      ["queue/send-message", (input) => call(services, "sendMessage", input)],
      [
        "queue/receive-message",
        (input) => call(services, "receiveMessage", input),
      ],
      [
        "queue/delete-message",
        (input) => call(services, "deleteMessage", input),
      ],
      [
        "queue/release-message",
        (input) => call(services, "releaseMessage", input),
      ],
      [
        "queue/dead-letter-message",
        (input) => call(services, "deadLetterMessage", input),
      ],
      ["kms/describe-active-key", () => call(services, "describeActiveKey")],
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
        "secrets/put-secret-value",
        (input) => call(services, "putSecretValue", input),
      ],
      [
        "secrets/get-secret-value",
        (input) => call(services, "getSecretValue", input),
      ],
      [
        "secrets/get-latest-secret",
        (input) => callNamed(services, "getLatestSecret", input, "secretName"),
      ],
      [
        "secrets/list-secret-versions",
        () => call(services, "listSecretVersions"),
      ],
      [
        "secrets/delete-secret-version",
        (input) => call(services, "deleteSecretVersion", input),
      ],
      [
        "provider/materialize-desired-state",
        (input) => call(services, "materializeDesiredState", input),
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
        "observability/append-audit-event",
        (input) => call(services, "appendAuditEvent", input),
      ],
      [
        "observability/list-audit-events",
        () => call(services, "listAuditEvents"),
      ],
      [
        "observability/verify-audit-events",
        () => call(services, "verifyAuditEvents"),
      ],
      [
        "observability/put-metric",
        (input) => call(services, "putMetric", input),
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
    { provider: "aws" },
  );
}

function call(
  services: AwsHttpGatewayServices,
  method: keyof AwsHttpGatewayServices,
  input?: unknown,
): unknown {
  const fn = requireGatewayMethod(services, method) as (
    input?: unknown,
  ) => unknown;
  return fn.call(services, input);
}

function callNamed(
  services: AwsHttpGatewayServices,
  method: keyof AwsHttpGatewayServices,
  input: unknown,
  key: string,
): unknown {
  return call(services, method, record(input)[key]);
}

function callPair(
  services: AwsHttpGatewayServices,
  method: keyof AwsHttpGatewayServices,
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
