import { expect, test } from "bun:test";
import {
  TAKOSERVER_HOSTED_INSTALL_CONFIGS,
  TAKOSERVER_TAKOFORM_CONNECTION_ID,
  TAKOSERVER_TAKOFORM_PROVIDER_SOURCE,
} from "../../../deploy/platform/takoserver_hosted_install_configs.ts";
import * as hostedWorker from "../../../deploy/platform/takoserver_hosted_worker.ts";
import { composeTakoserverHostedWorkerEnv } from "../../../deploy/platform/takoserver_hosted_worker.ts";
import { OPERATOR_CONTROL_MCP_INSTALL_CONFIG } from "../../../deploy/operator-control-mcp.ts";
import { CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY } from "../../../providers/cloudflare/credentials.ts";

test("Takosumi Hosted exposes only the direct Cloudflare Yurucommu profile", () => {
  expect(TAKOSERVER_HOSTED_INSTALL_CONFIGS).toHaveLength(1);
  expect(
    TAKOSERVER_HOSTED_INSTALL_CONFIGS.some(
      (config) => config.id === "cfg-hosted-yurucommu-takoform-v2",
    ),
  ).toBe(false);
  const [cloudflare] = TAKOSERVER_HOSTED_INSTALL_CONFIGS;
  expect(cloudflare?.store?.deploymentProfile).toEqual({
    key: "cloudflare-v1",
    label: { ja: "Cloudflare", en: "Cloudflare" },
    description: {
      ja: "Cloudflareで配置します。接続済みのCloudflareアカウントを使用します。",
      en: "Deploy with Cloudflare using a connected Cloudflare account.",
    },
    order: 20,
    recommended: false,
    management: {
      kind: "external_console",
      href: "https://dash.cloudflare.com",
      label: { ja: "Cloudflareダッシュボード", en: "Cloudflare dashboard" },
    },
  });
  expect(cloudflare?.sourceSelector).toEqual({
    url: "https://github.com/tako0614/yurucommu.git",
    path: ".",
  });
  expect(cloudflare?.modulePath).toBe(".");
  expect(cloudflare?.variableMapping).toEqual({
    enable_cloudflare_resources: true,
    enable_cloudflare_worker_script: true,
    enable_workers_dev_subdomain: true,
    app_url: "",
    cloudflare_account_id: null,
    cloudflare_workers_subdomain: null,
  });
  expect(cloudflare?.policy.allowedProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
    "registry.opentofu.org/hashicorp/http",
    "registry.opentofu.org/hashicorp/random",
  ]);
  expect(cloudflare?.policy.providerCredentials).toEqual({
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    requiredCredentialCapabilities: [
      CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
    ],
  });
  expect(cloudflare?.installExperience).toEqual({
    projections: [
      {
        kind: "oidc_client",
        variables: {},
        callbackPath: "/api/auth/callback/takos",
        scopes: ["openid", "profile", "email"],
      },
    ],
  });
  expect(cloudflare?.accountsOidcModuleVariableMaterialization).toEqual({
    contract: "takosumi.accounts-oidc-module-variables/v1",
    workerNameVariable: "worker_name",
    projectNameVariable: "project_name",
    additionalInputVariables: [
      "cloudflare_account_id",
      "cloudflare_workers_subdomain",
    ],
    forbiddenNonEmptyInputVariables: [
      "auth_password_hash",
      "notification_push_gateway_token",
    ],
    issuerUrlVariable: "takosumi_accounts_issuer_url",
    clientIdVariable: "takosumi_accounts_client_id",
    ownerSubjectVariable: "oidc_owner_sub",
    allowUnpinnedOwnerClaimVariable: "allow_unpinned_owner_claim",
  });
  expect(cloudflare?.runtimeBindingMaterialization).toBeUndefined();
  expect(cloudflare?.variablePresentation).toBeUndefined();
});

test("Takoserver Hosted wrapper preserves every Worker Durable Object export", () => {
  expect(typeof hostedWorker.CoordinationObject).toBe("function");
  expect(typeof hostedWorker.LocalSubstrateOpenTofuRunnerProxyObject).toBe(
    "function",
  );
  expect(typeof hostedWorker.OpenTofuRunOwnerObject).toBe("function");
  expect(typeof hostedWorker.OpenTofuRunnerObject).toBe("function");
});

test("Takoserver Hosted wrapper keeps Worker variables enumerable for runtime composition", () => {
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
  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toBe(
    TAKOSERVER_HOSTED_INSTALL_CONFIGS,
  );
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

test("Takoserver Hosted composes the optional operator MCP InstallConfig when its route is enabled", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: "1",
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
  } as never);

  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([
    ...TAKOSERVER_HOSTED_INSTALL_CONFIGS,
    {
      ...OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
      variableMapping: { takosumi_origin: "https://app.takosumi.test" },
    },
  ]);
});

test("Takoserver Hosted connection descriptor is accepted and publicly discoverable", async () => {
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
            connectionId: TAKOSERVER_TAKOFORM_CONNECTION_ID,
            recipeId: "takoserver-takoform-run-v1",
            providerSource: TAKOSERVER_TAKOFORM_PROVIDER_SOURCE,
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
