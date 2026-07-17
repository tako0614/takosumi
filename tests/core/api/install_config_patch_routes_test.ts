import { expect, test } from "bun:test";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { INSTALL_CONFIG_PATCH_V1_KIND } from "takosumi-contract/install-configs";

const TOKEN = "install-config-operator-token";

function headers(token = TOKEN): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

test("operator API applies one exact versioned patch and preserves row-owned fields", async () => {
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
  const before = await operations.capsules.putInstallConfig({
    ...bootstrapped,
    policy: {
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    },
  });
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
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.installConfig).toMatchObject({
    id: before.id,
    name: before.name,
    createdAt: before.createdAt,
    variableMapping: { target: "cloudflare" },
    outputAllowlist: {
      launch_url: { from: "launch_url", type: "url", required: true },
    },
    policy: {
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      lifecycleActions: {
        allowedExecutors: ["operator"],
        allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
      },
    },
  });
  expect(Date.parse(body.installConfig.updatedAt)).toBeGreaterThanOrEqual(
    Date.parse(before.updatedAt),
  );

  const stored = await operations.capsules.getInstallConfig(before.id);
  expect(stored.modulePath).toBe(before.modulePath);
  expect(stored.store).toEqual(before.store);
  expect(stored.runnerId).toBe(before.runnerId);
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
