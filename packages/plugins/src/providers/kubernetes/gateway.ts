import {
  createJsonGatewayHandler,
  requireGatewayMethod,
} from "../../gateway/mod.ts";
import type { provider } from "takosumi-contract";
import type {
  KubernetesProviderClient,
  KubernetesRouterClient,
  KubernetesRuntimeAgentClient,
} from "./clients.ts";

type KubernetesProviderProofService = {
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

export type KubernetesHttpGatewayServices =
  & Partial<KubernetesProviderClient>
  & Partial<KubernetesRouterClient>
  & Partial<KubernetesRuntimeAgentClient>
  & Partial<KubernetesProviderProofService>;

export function createKubernetesHttpGatewayHandler(
  services: KubernetesHttpGatewayServices,
): (request: Request) => Promise<Response> {
  return createJsonGatewayHandler(
    new Map([
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
      [
        "runtime-agent/fail-work",
        (input) => call(services, "failWork", input),
      ],
      [
        "runtime-agent/get-work",
        (input) => callNamed(services, "getWork", input, "workId"),
      ],
      ["runtime-agent/list-work", () => call(services, "listWork")],
    ]),
    { provider: "kubernetes" },
  );
}

function call(
  services: KubernetesHttpGatewayServices,
  method: keyof KubernetesHttpGatewayServices,
  input?: unknown,
): unknown {
  const fn = requireGatewayMethod(services, method) as (
    input?: unknown,
  ) => unknown;
  return fn.call(services, input);
}

function callFirst(
  services: KubernetesHttpGatewayServices,
  methods: readonly (keyof KubernetesHttpGatewayServices)[],
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
  services: KubernetesHttpGatewayServices,
  method: keyof KubernetesHttpGatewayServices,
  input: unknown,
  key: string,
): unknown {
  return call(services, method, record(input)[key]);
}

function callPair(
  services: KubernetesHttpGatewayServices,
  method: keyof KubernetesHttpGatewayServices,
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
