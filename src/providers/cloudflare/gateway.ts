import {
  createJsonGatewayHandler,
  requireGatewayMethod,
} from "../../gateway/mod.ts";
import type { provider } from "takosumi-contract";
import type { CloudflareProviderClient } from "./clients.ts";

export type CloudflareHttpGatewayServices =
  & Partial<CloudflareProviderClient>
  & Partial<provider.ProviderMaterializer>
  & Partial<CloudflareProviderProofService>;

type CloudflareProviderProofService = {
  verifyDesiredState(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<unknown>;
};

export function createCloudflareHttpGatewayHandler(
  services: CloudflareHttpGatewayServices,
): (request: Request) => Promise<Response> {
  return createJsonGatewayHandler(
    new Map([
      [
        "provider/materialize-desired-state",
        (input) =>
          callFirst(services, [
            "materializeDesiredState",
            "reconcileDesiredState",
            "materialize",
          ], input),
      ],
      [
        "provider/reconcile-desired-state",
        (input) =>
          callFirst(services, [
            "reconcileDesiredState",
            "materializeDesiredState",
            "materialize",
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
      [
        "provider/list-operations",
        () => callFirst(services, ["listOperations", "listRecordedOperations"]),
      ],
      [
        "provider/clear-operations",
        () =>
          callFirst(services, [
            "clearOperations",
            "clearRecordedOperations",
          ]),
      ],
      [
        "provider/detect-drift",
        (input) => call(services, "detectDrift", input),
      ],
    ]),
    { provider: "cloudflare" },
  );
}

function call(
  services: CloudflareHttpGatewayServices,
  method: keyof CloudflareHttpGatewayServices,
  input?: unknown,
): unknown {
  const fn = requireGatewayMethod(services, method) as (
    input?: unknown,
  ) => unknown;
  return fn.call(services, input);
}

function callFirst(
  services: CloudflareHttpGatewayServices,
  methods: readonly (keyof CloudflareHttpGatewayServices)[],
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
