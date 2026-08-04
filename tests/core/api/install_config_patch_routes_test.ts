import { expect, test } from "bun:test";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { defaultCapsuleInstallConfig } from "../../../core/domains/capsules/default_install_config.ts";
import {
  INSTALL_CONFIG_PATCH_V1_KIND,
  type InstallConfig,
} from "takosumi-contract/install-configs";

const TOKEN = "install-config-operator-token";

function headers(token = TOKEN): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function expectRedactedInstallConfig(config: {
  readonly variableMapping: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<Record<string, unknown>>;
}): void {
  expect(config.variableMapping).toMatchObject({
    declared_value: "[REDACTED]",
    undeclared_token: "[REDACTED]",
    ordinary_value: {
      api_token: "[REDACTED]",
      safe: "ok",
    },
    array_value: [{ nested_token: "[REDACTED]", safe: "array-ok" }],
  });
  expect(config.variableMapping.ordinary_value).toEqual({
    api_token: "[REDACTED]",
    safe: "ok",
  });
  expect(config.policy).toMatchObject({
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    providerCredentials: {
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      requireTemporary: true,
      requireTtlEnforced: true,
    },
    scopeBoundary: { mode: "strict", rules: [] },
  });
  const serialized = JSON.stringify(config);
  expect(serialized).not.toContain("declared-secret");
  expect(serialized).not.toContain("undeclared-secret");
  expect(serialized).not.toContain("nested-secret");
  expect(serialized).not.toContain("array-secret");
  expect(serialized).not.toContain("provider-secret");
  expect(serialized).not.toContain("scope-secret");
  expect(serialized).not.toContain("clientSecret");
  expect(serialized).not.toContain("operatorNote");
}

function routeRedactionInstallConfig(base: InstallConfig): InstallConfig {
  return {
    ...base,
    id: "cfg-route-redaction",
    name: "route-redaction",
    variableMapping: {
      declared_value: "declared-secret",
      undeclared_token: "undeclared-secret",
      ordinary_value: {
        api_token: "nested-secret",
        safe: "ok",
      },
      array_value: [
        {
          nested_token: "array-secret",
          safe: "array-ok",
        },
      ],
    },
    policy: {
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      providerCredentials: {
        requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        requireTemporary: true,
        requireTtlEnforced: true,
        clientSecret: "provider-secret",
      },
      scopeBoundary: {
        mode: "strict",
        rules: [],
        operatorNote: "scope-secret",
      },
    } as unknown as InstallConfig["policy"],
    variablePresentation: [
      {
        name: "declared_value",
        secret: true,
        label: { en: "Declared value" },
      },
      {
        name: "undeclared_token",
        label: { en: "Undeclared token" },
      },
      {
        name: "ordinary_value",
        label: { en: "Ordinary value" },
      },
    ],
  };
}

test("InstallConfig list/get routes redact host config secret variables", async () => {
  const config = routeRedactionInstallConfig(defaultCapsuleInstallConfig());
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    operatorInstallConfigs: [config],
  });

  const listResponse = await app.request("/internal/v1/install-configs", {
    headers: headers(),
  });
  expect(listResponse.status).toBe(200);
  const listed = (await listResponse.json()).installConfigs as Array<{
    id: string;
    variableMapping: Readonly<Record<string, unknown>>;
    policy: Readonly<Record<string, unknown>>;
  }>;
  const listedConfig = listed.find((item) => item.id === config.id);
  expect(listedConfig).toBeDefined();
  expectRedactedInstallConfig(listedConfig!);

  const getResponse = await app.request(
    `/internal/v1/install-configs/${config.id}`,
    { headers: headers() },
  );
  expect(getResponse.status).toBe(200);
  const got = (await getResponse.json()).installConfig as {
    variableMapping: Readonly<Record<string, unknown>>;
    policy: Readonly<Record<string, unknown>>;
  };
  expectRedactedInstallConfig(got);

});

test("operator API cannot mutate immutable host InstallConfigs", async () => {
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
  });
  const bootstrapped = await operations.capsules.getInstallConfig(
    "cfg-default-opentofu-capsule",
  );
  const before = bootstrapped;
  const response = await app.request(
    "/internal/v1/install-configs/cfg-default-opentofu-capsule",
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        kind: INSTALL_CONFIG_PATCH_V1_KIND,
        variableMapping: { target: "cloudflare" },
        outputAllowlist: {
          launch_url: { from: "launch_url", type: "url", required: true },
        },
        lifecycleActions: [
          {
            apiVersion: "takosumi.dev/v1alpha1",
            kind: "command",
            id: "activate",
            phase: "post_apply",
            executor: "operator",
            command: [
              "bun",
              "scripts/control/takosumi-release.mjs",
              "production",
            ],
            runnerCapability: "capsule.lifecycle.command.v1",
          },
        ],
        lifecycleActionPolicy: {
          allowedExecutors: ["operator"],
          allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
        },
      }),
    },
  );
  expect(response.status).toBe(403);
  expect((await response.json()).error.message).toContain("immutable");
  expect(await operations.capsules.getInstallConfig(before.id)).toEqual(before);
});

test("Workspace-scoped bearer cannot patch a shared InstallConfig", async () => {
  let workspaceId: string | undefined;
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    authorizeDeployControlBearer: ({ token }) => {
      if (token === "operator") {
        return {
          actor: "operator",
          workspaceIds: "*",
          operations: "*",
          runnerProfileIds: "*",
        };
      }
      if (token === "scoped" && workspaceId) {
        return {
          actor: "workspace-user",
          workspaceIds: [workspaceId],
          operations: "*",
          runnerProfileIds: "*",
        };
      }
      return undefined;
    },
  });
  const workspaceResponse = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers("operator"),
    body: JSON.stringify({
      handle: "install-config-scope",
      displayName: "Install config scope",
      type: "personal",
      ownerUserId: "user_install_config_scope",
    }),
  });
  expect(workspaceResponse.status).toBe(201);
  workspaceId = (await workspaceResponse.json()).workspace.id as string;

  const response = await app.request(
    "/internal/v1/install-configs/cfg-default-opentofu-capsule",
    {
      method: "PATCH",
      headers: headers("scoped"),
      body: JSON.stringify({
        kind: INSTALL_CONFIG_PATCH_V1_KIND,
        variableMapping: { target: "cloudflare" },
      }),
    },
  );
  expect(response.status).toBe(403);
  expect((await response.json()).error.message).toContain(
    "only an unrestricted operator",
  );

  await operations.capsules.putInstallConfig({
    id: "cfg-workspace-patch-test",
    workspaceId,
    name: "workspace-patch-test",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  const placeholderResponse = await app.request(
    "/internal/v1/install-configs/cfg-workspace-patch-test",
    {
      method: "PATCH",
      headers: headers("operator"),
      body: JSON.stringify({
        kind: INSTALL_CONFIG_PATCH_V1_KIND,
        interfaceBlueprints: [
          {
            key: "launcher",
            name: "app.launcher",
            spec: {
              type: "interface.ui.surface",
              version: "1",
              document: { launcher: true },
              access: { visibility: "workspace" },
            },
            bindings: [
              {
                key: "installer",
                subject: { source: "installing_principal" },
                permissions: ["ui.open"],
                delivery: { type: "none" },
              },
            ],
          },
        ],
      }),
    },
  );
  expect(placeholderResponse.status).toBe(400);
  expect((await placeholderResponse.json()).error.message).toContain(
    "only on a shared pre-install config",
  );
});

test("operator API rejects an unknown version before storage", async () => {
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
  });
  const before = await operations.capsules.getInstallConfig(
    "cfg-default-opentofu-capsule",
  );
  const response = await app.request(
    "/internal/v1/install-configs/cfg-default-opentofu-capsule",
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        kind: "takosumi.install-config-patch@v2",
        variableMapping: { target: "cloudflare" },
      }),
    },
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error.message).toContain(
    "kind must be takosumi.install-config-patch@v1",
  );
  expect(await operations.capsules.getInstallConfig(before.id)).toEqual(before);

  const invalidBlueprintResponse = await app.request(
    "/internal/v1/install-configs/cfg-default-opentofu-capsule",
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        kind: INSTALL_CONFIG_PATCH_V1_KIND,
        interfaceBlueprints: [
          {
            key: "invalid-blueprint",
            name: "app.invalid",
            spec: {
              type: "interface.ui.surface",
              version: "1",
              document: { launcher: true },
              access: { visibility: "workspace" },
              repositoryManifest: true,
            },
          },
        ],
      }),
    },
  );
  expect(invalidBlueprintResponse.status).toBe(400);
  expect((await invalidBlueprintResponse.json()).error.message).toContain(
    "unknown field repositoryManifest",
  );
  expect(await operations.capsules.getInstallConfig(before.id)).toEqual(before);
});
