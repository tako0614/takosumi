import { expect, test } from "bun:test";
import type { JsonValue } from "../../../../contract/types.ts";
import {
  projectServicesFromOutputs,
  validateProjectedServiceExportsFromOutputSnapshot,
} from "takosumi-contract/output-projection";

function outputs(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return value;
}

test("projects service_exports and service_bindings outputs to transient services", () => {
  const { serviceExports, serviceBindings } = projectServicesFromOutputs(
    outputs({
      service_exports: [
        {
          name: "tools",
          capabilities: ["protocol.mcp.server"],
          endpoints: [{ name: "mcp", url: "https://tools.example.test/mcp" }],
          visibility: "space",
        },
      ],
      service_bindings: [
        {
          name: "agent_tools",
          target: { kind: "workload", name: "agent-runtime" },
          selector: { name: "tools", capabilities: ["protocol.mcp.server"] },
          grant_request: {
            scopes: ["mcp.invoke"],
            audience: ["agent-runtime"],
            env: ["MCP_BASE_URL", "MCP_TOKEN"],
          },
        },
      ],
    }),
  );

  expect(serviceExports).toHaveLength(1);
  expect(serviceExports[0]?.name).toBe("tools");
  expect(serviceExports[0]?.capabilities).toEqual(["protocol.mcp.server"]);
  expect(serviceExports[0]?.visibility).toBe("space");
  expect(serviceExports[0]?.endpoints?.[0]?.url).toBe(
    "https://tools.example.test/mcp",
  );

  expect(serviceBindings).toHaveLength(1);
  expect(serviceBindings[0]?.target).toEqual({
    kind: "workload",
    name: "agent-runtime",
  });
  expect(serviceBindings[0]?.selector).toEqual({
    capabilities: ["protocol.mcp.server"],
    name: "tools",
  });
  expect(serviceBindings[0]?.grantRequest.env).toEqual([
    "MCP_BASE_URL",
    "MCP_TOKEN",
  ]);
});

test("projects app_deployment publish/consume outputs and resolves self producer", () => {
  const { serviceExports, serviceBindings } = projectServicesFromOutputs(
    outputs({
      app_deployment: {
        name: "yurucommu",
        version: "2.0.0",
        compute: {
          web: {
            kind: "worker",
            consume: [
              {
                publication: "identity.oidc",
                inject: {
                  env: {
                    issuerUrl: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
                    clientId: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
                  },
                },
              },
              { publication: "launcher" },
            ],
          },
        },
        publish: [
          {
            name: "launcher",
            publisher: "web",
            type: "UiSurface",
            outputs: { url: { kind: "url", routeRef: "root" } },
            display: { title: "Yurucommu" },
          },
        ],
      },
    }),
    { producerCapsuleId: "inst_yuru" },
  );

  expect(serviceExports.map((entry) => entry.name)).toEqual(["launcher"]);
  expect(serviceExports[0]?.capabilities).toEqual(["interface.ui.surface"]);

  const oidc = serviceBindings.find(
    (binding) => binding.selector.name === "identity.oidc",
  );
  expect(oidc?.selector.capabilities).toEqual(["identity.oidc"]);
  expect(oidc?.target.name).toBe("web");
  expect(oidc?.grantRequest.env).toEqual([
    "TAKOSUMI_ACCOUNTS_ISSUER_URL",
    "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  ]);

  const launcher = serviceBindings.find(
    (binding) => binding.selector.name === "launcher",
  );
  // `producer: launcher` resolves to the producing Capsule when supplied.
  expect(launcher?.selector.producerCapsuleId).toBe("inst_yuru");
});

test("rejects a malformed service_exports output", () => {
  expect(() =>
    validateProjectedServiceExportsFromOutputSnapshot(
      outputs({ service_exports: "not-an-array" as unknown as JsonValue }),
    ),
  ).toThrow(/service_exports output must be an array/);

  expect(() =>
    validateProjectedServiceExportsFromOutputSnapshot(
      outputs({ service_exports: [{ capabilities: ["protocol.mcp.server"] }] }),
    ),
  ).toThrow(/name is required/);
});

test("rejects credentials hidden in projected metadata and endpoint URLs", () => {
  expect(() =>
    validateProjectedServiceExportsFromOutputSnapshot(
      outputs({
        service_exports: [{
          name: "storage",
          capabilities: ["storage.object"],
          metadata: { nested: { apiKey: "must-not-project" } },
        }],
      }),
    ),
  ).toThrow(/must not contain credential data/);

  expect(() =>
    validateProjectedServiceExportsFromOutputSnapshot(
      outputs({
        service_exports: [{
          name: "database",
          capabilities: ["storage.sql"],
          endpoints: [{
            url: "postgres://user:password@db.example.com/app",
          }],
        }],
      }),
    ),
  ).toThrow(/must not contain URL credentials/);

  expect(() =>
    validateProjectedServiceExportsFromOutputSnapshot(
      outputs({
        service_exports: [{
          name: "api",
          capabilities: ["protocol.http.api"],
          endpoints: [{
            url: "https://api.example.com/v1?access_token=secret",
          }],
        }],
      }),
    ),
  ).toThrow(/must not contain credential query parameters/);
});

test("rejects an extension capability unless explicitly enabled", () => {
  const value = outputs({
    service_exports: [
      { name: "custom", capabilities: ["vendor.custom.capability"] },
    ],
  });
  expect(() =>
    validateProjectedServiceExportsFromOutputSnapshot(value),
  ).toThrow(/standard projected capability/);
  expect(() =>
    validateProjectedServiceExportsFromOutputSnapshot(value, {
      allowExtensionCapabilities: true,
    }),
  ).not.toThrow();
});

test("returns empty projections when no service outputs are present", () => {
  const result = projectServicesFromOutputs(outputs({ launch_url: "https://x" }));
  expect(result.serviceExports).toEqual([]);
  expect(result.serviceBindings).toEqual([]);
});
