import { expect, test } from "bun:test";

import { OPERATOR_CONTROL_MCP_INSTALL_CONFIG } from "../../../deploy/operator-control-mcp.ts";
import * as hostedWorker from "../../../deploy/platform/takoserver_hosted_worker.ts";
import { composeTakoserverHostedWorkerEnv } from "../../../deploy/platform/takoserver_hosted_worker.ts";

const HOSTED_PROVIDER_CONNECTION_ID = "conn_hostedProvider01";
const HOSTED_PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";

test("Takosumi Hosted composes no application InstallConfigs by default", () => {
  const composed = composeTakoserverHostedWorkerEnv({} as never);

  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([]);
});

test("Takoserver Hosted wrapper preserves every Worker Durable Object export", () => {
  expect(typeof hostedWorker.CoordinationObject).toBe("function");
  expect(typeof hostedWorker.LocalSubstrateOpenTofuRunnerProxyObject).toBe(
    "function",
  );
  expect(typeof hostedWorker.OpenTofuRunOwnerObject).toBe("function");
  expect(typeof hostedWorker.OpenTofuRunnerObject).toBe("function");
});

test("Takoserver Hosted wrapper keeps Worker variables enumerable", () => {
  const controlDb = Object.freeze({ binding: "control" });
  const env = {
    TAKOSUMI_CONTROL_DB: controlDb,
    TAKOSUMI_SECRET_BOUNDARY_KEY: "sealed-runtime-key",
    TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed",
  } as never;

  const composed = composeTakoserverHostedWorkerEnv(env);

  expect(composed).not.toBe(env);
  expect(Object.entries(composed)).toContainEqual([
    "TAKOSUMI_SECRET_BOUNDARY_KEY",
    "sealed-runtime-key",
  ]);
  expect(composed.TAKOSUMI_CONTROL_DB).toBe(controlDb);
  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([]);
  expect(composeTakoserverHostedWorkerEnv(env)).toBe(composed);
});

test("Takoserver Hosted proves only the exact Capsule-scoped OAuth resource", async () => {
  const calls: unknown[] = [];
  const composed = composeTakoserverHostedWorkerEnv({
    HOSTED: {
      async authorizeInterfaceOAuth2Resource(input: unknown) {
        calls.push(input);
        return true;
      },
    },
  } as never);

  await expect(
    composed.TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER?.({
      workspaceId: "workspace_1",
      interfaceId: "interface_1",
      ownerRef: { kind: "Capsule", id: "capsule_1" },
      resource: "https://storage.example.test/mcp",
    }),
  ).resolves.toBe(true);
  expect(calls).toEqual([
    {
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      resource: "https://storage.example.test/mcp",
    },
  ]);
  await expect(
    composed.TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER?.({
      workspaceId: "workspace_1",
      interfaceId: "interface_2",
      ownerRef: { kind: "Workspace", id: "workspace_1" },
      resource: "https://storage.example.test/mcp",
    }),
  ).resolves.toBe(false);
  expect(calls).toHaveLength(1);
});

test("Takoserver Hosted composes only the optional operator MCP declaration", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: "1",
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
  } as never);

  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([
    {
      ...OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
      variableMapping: { takosumi_origin: "https://app.takosumi.test" },
    },
  ]);
});

test("Takoserver Hosted connection descriptor remains publicly discoverable", async () => {
  const response = await hostedWorker.default.fetch(
    new Request("https://app-staging.takosumi.com/.well-known/takosumi"),
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          id: "takosumi-hosted-sponsorship",
          basePath: "/api/v1/account/subscription",
          handlerKey: "HOSTED",
          authDelivery: "context",
          ownsPathSubtree: true,
          workspaceContext: "query-required",
          requiredScopes: [],
          capabilities: ["takosumi.account.subscription.v1"],
          runCredential: {
            audience: "takosumi-hosted.takoform.v1",
            requiredScopes: ["takoform.run"],
          },
          providerCredentialBroker: {
            connectionId: HOSTED_PROVIDER_CONNECTION_ID,
            recipeId: "takoserver-takoform-run-v1",
            providerSource: HOSTED_PROVIDER_SOURCE,
            displayName: "Takoserver",
            exchangePath: "/provider-credentials/takoform",
            envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
          },
        },
      ]),
      HOSTED: {
        fetchAuthenticated: async () => new Response("ok"),
      },
    } as never,
  );

  expect(response.status).toBe(200);
  expect((await response.json()).endpoints.extensions).toEqual({
    "takosumi.account.subscription.v1":
      "https://app-staging.takosumi.com/api/v1/account/subscription",
  });
});
