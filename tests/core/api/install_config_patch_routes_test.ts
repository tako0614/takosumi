import { expect, test } from "bun:test";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { stableJsonDigest } from "../../../core/adapters/source/digest.ts";
import { defaultCapsuleInstallConfig } from "../../../core/domains/capsules/default_install_config.ts";
import {
  INSTALL_CONFIG_PATCH_V1_KIND,
  type InstallConfig,
} from "takosumi-contract/install-configs";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";

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

test("InstallConfig API redacts all generic OpenTofu variable values", async () => {
  const config: InstallConfig = {
    ...defaultCapsuleInstallConfig(),
    id: "cfg-route-generic-redaction",
    workspaceId: "ws-route-generic-redaction",
    modulePath: "deploy/opentofu/cloudflare",
    name: "generic-redaction",
    variableMapping: {
      region: "secret-region-value",
      display_name: "secret-display-value",
    },
    variablePresentation: [
      { name: "region", label: { en: "Region" } },
      { name: "display_name", label: { en: "Display name" } },
    ],
    internal: {
      genericOpenTofuVariableContractDigest: `sha256:${"2".repeat(64)}`,
      genericOpenTofuSourceSnapshotId: "snapshot-generic-redaction",
    },
  };
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
  });
  const workspace = await operations.workspaces.createWorkspace({
    handle: "generic-redaction",
    displayName: "Generic redaction",
    type: "personal",
    ownerUserId: "user-generic-redaction",
  });
  await operations.capsules.putInstallConfig({
    ...config,
    workspaceId: workspace.id,
  });

  const response = await app.request(
    `/internal/v1/install-configs/${config.id}`,
    { headers: headers() },
  );
  expect(response.status).toBe(200);
  const projected = (await response.json()).installConfig as {
    readonly variableMapping: Readonly<Record<string, unknown>>;
  };
  expect(projected.variableMapping).toEqual({
    region: "[REDACTED]",
    display_name: "[REDACTED]",
  });
  expect(JSON.stringify(projected)).not.toContain("secret-region-value");
  expect(JSON.stringify(projected)).not.toContain("secret-display-value");
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
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatchObject({
    code: "failed_precondition",
    details: { reason: "install_config_in_use" },
  });
  expect(await operations.capsules.getInstallConfig(before.id)).toEqual(before);
});

test("internal InstallConfig PATCH rejects compiled and re-adopted rows for every principal", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const now = "2026-08-26T00:00:00.000Z";
  const workspaceId = "ws_install_config_immutable";
  await store.putWorkspace({
    id: workspaceId,
    handle: "install-config-immutable",
    displayName: "InstallConfig immutable",
    type: "personal",
    ownerUserId: "user_install_config_immutable",
    createdAt: now,
    updatedAt: now,
  });
  await store.putSource({
    id: "src_install_config_immutable",
    workspaceId,
    name: "immutable-repo",
    url: "https://example.com/acme/immutable.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active",
    createdAt: now,
    updatedAt: now,
    hookSecretHash: "sha256:hook",
    autoSync: false,
  });
  const compiled: InstallConfig = {
    id: "cfg-compiled-route",
    workspaceId,
    name: "compiled-route",
    variableMapping: { original: "compiled" },
    outputAllowlist: {},
    policy: {},
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snap_compiled_route",
      repositoryInstallUxDigest: `sha256:${"a".repeat(64)}`,
    },
    createdAt: now,
    updatedAt: now,
  };
  const reAdopted: InstallConfig = {
    id: "cfg-re-adopted-route",
    workspaceId,
    name: "re-adopted-route",
    variableMapping: { original: "re-adopted" },
    outputAllowlist: {},
    policy: {},
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snap_re_adopted_route",
      repositoryInstallUxDigest: `sha256:${"b".repeat(64)}`,
      reAdoption: {
        capsuleId: "cap_install_config_immutable",
        actorSubject: "user_install_config_immutable",
        reason: "adopt reviewed repository setup",
        idempotencyKeyHash: `sha256:${"c".repeat(64)}`,
        requestDigest: `sha256:${"d".repeat(64)}`,
        previousInstallConfigId: "cfg_previous_route",
        previousInstallConfigDigest: `sha256:${"e".repeat(64)}`,
        previousCapsuleStatus: "pending",
        previousStateGeneration: 0,
        previousExecutionAuthorityEpoch: 1,
        authorityGuard: `sha256:${"f".repeat(64)}`,
        derivedTargetDigest: `sha256:${"1".repeat(64)}`,
        baseInstallConfigId: "cfg_base_route",
        sourceSnapshotId: "snap_re_adopted_route",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
  await store.putInstallConfig(compiled);
  await store.putInstallConfig(reAdopted);

  let putCount = 0;
  const putInstallConfig = store.putInstallConfig.bind(store);
  store.putInstallConfig = async (config) => {
    putCount += 1;
    return await putInstallConfig(config);
  };
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    authorizeDeployControlBearer: ({ token }) => {
      if (token === "operator") {
        return {
          actor: "operator",
          workspaceIds: "*",
          operations: "*",
          runnerProfileIds: "*",
        };
      }
      if (token === "scoped") {
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
  const capsule = await operations.capsules.createCapsule({
    workspaceId,
    name: "immutable-capsule",
    environment: "production",
    sourceId: "src_install_config_immutable",
    installConfigId: compiled.id,
    installingPrincipalId: "user_install_config_immutable",
  });
  const beforeCapsule = await operations.capsules.getCapsule(capsule.id);
  const beforeEpoch = await operations.capsules.getCapsuleExecutionAuthorityEpoch(
    capsule.id,
  );
  const beforeRows = new Map(
    await Promise.all(
      [compiled.id, reAdopted.id].map(async (id) => {
        const row = await operations.capsules.getInstallConfig(id);
        return [id, { row, digest: await stableJsonDigest(row) }] as const;
      }),
    ),
  );
  putCount = 0;

  for (const token of ["operator", "scoped"]) {
    for (const id of [compiled.id, reAdopted.id]) {
      const response = await app.request(`/internal/v1/install-configs/${id}`, {
        method: "PATCH",
        headers: headers(token),
        body: JSON.stringify({
          kind: INSTALL_CONFIG_PATCH_V1_KIND,
          variableMapping: { changed: "must-not-persist" },
        }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatchObject({
        code: "failed_precondition",
        details: { reason: "install_config_in_use" },
      });
    }
  }

  expect(putCount).toBe(0);
  for (const id of [compiled.id, reAdopted.id]) {
    const before = beforeRows.get(id);
    const after = await operations.capsules.getInstallConfig(id);
    expect(after).toEqual(before?.row);
    expect(await stableJsonDigest(after)).toBe(before?.digest);
    expect(after.internal?.reAdoption?.derivedTargetDigest).toBe(
      before?.row.internal?.reAdoption?.derivedTargetDigest,
    );
  }
  expect(await operations.capsules.getCapsule(capsule.id)).toEqual(
    beforeCapsule,
  );
  expect(
    await operations.capsules.getCapsuleExecutionAuthorityEpoch(capsule.id),
  ).toBe(beforeEpoch);
});

test("internal InstallConfig PATCH rejects an immutable migration-restore receipt even when unattached", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const restored: InstallConfig = {
    id: "cfg-restored-unattached-route",
    name: "restored-unattached-route",
    modulePath: ".",
    variableMapping: { original: "restored" },
    outputAllowlist: {},
    policy: {},
    internal: {
      reason: "per_install_overrides",
      migrationRestore: {
        bundleDigest: `sha256:${"a".repeat(64)}`,
        migrationId: "migration-unattached-route",
        idempotencyKeyHash: `sha256:${"b".repeat(64)}`,
        requestDigest: `sha256:${"c".repeat(64)}`,
        sourceSnapshotId: "snap_restored_unattached_route",
        compatibilityCheckRunId: "compat_restored_unattached_route",
        compatibilityReportId: "report_restored_unattached_route",
        actorSubject: "operator",
      },
    },
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  await store.putInstallConfig(restored);
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    authorizeDeployControlBearer: ({ token }) =>
      token === "operator"
        ? {
            actor: "operator",
            workspaceIds: "*",
            operations: "*",
            runnerProfileIds: "*",
          }
        : undefined,
  });

  const response = await app.request(
    `/internal/v1/install-configs/${restored.id}`,
    {
      method: "PATCH",
      headers: headers("operator"),
      body: JSON.stringify({
        kind: INSTALL_CONFIG_PATCH_V1_KIND,
        variableMapping: { changed: "must-not-persist" },
      }),
    },
  );
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatchObject({
    code: "failed_precondition",
    details: { reason: "install_config_in_use" },
  });
  expect(await store.getInstallConfig(restored.id)).toEqual(restored);
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
  expect(placeholderResponse.status).toBe(409);
  expect((await placeholderResponse.json()).error.message).toContain(
    "Only an unattached Workspace-neutral InstallConfig template may be patched",
  );
});

test("operator PATCH updates only an unattached shared template and rejects active or destroyed references", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    authorizeDeployControlBearer: ({ token }) =>
      token === "operator"
        ? {
            actor: "operator",
            workspaceIds: "*",
            operations: "*",
            runnerProfileIds: "*",
          }
        : undefined,
  });
  const now = "2026-09-04T00:00:00.000Z";
  const shared: InstallConfig = {
    id: "cfg-shared-unattached",
    name: "shared-unattached",
    variableMapping: { region: "initial" },
    outputAllowlist: {},
    policy: {},
    createdAt: now,
    updatedAt: now,
  };
  await store.putInstallConfig(shared);
  const patched = await app.request(
    `/internal/v1/install-configs/${shared.id}`,
    {
      method: "PATCH",
      headers: headers("operator"),
      body: JSON.stringify({
        kind: INSTALL_CONFIG_PATCH_V1_KIND,
        variableMapping: { region: "updated" },
      }),
    },
  );
  expect(patched.status).toBe(200);
  expect((await operations.capsules.getInstallConfig(shared.id)).variableMapping)
    .toEqual({ region: "updated" });

  const workspaceId = "ws_template_reference";
  await store.putWorkspace({
    id: workspaceId,
    handle: "template-reference",
    displayName: "Template reference",
    type: "personal",
    ownerUserId: "acct_template_reference",
    createdAt: now,
    updatedAt: now,
  });
  await store.putSource({
    id: "src_template_reference",
    workspaceId,
    name: "template-reference",
    url: "https://example.com/acme/template-reference.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active",
    createdAt: now,
    updatedAt: now,
    hookSecretHash: `sha256:${"a".repeat(64)}`,
    autoSync: false,
  });
  const referenced: InstallConfig = {
    id: "cfg-shared-referenced",
    name: "shared-referenced",
    variableMapping: { region: "immutable" },
    outputAllowlist: {},
    policy: {},
    createdAt: now,
    updatedAt: now,
  };
  await store.putInstallConfig(referenced);
  const capsule = await operations.capsules.createCapsule({
    workspaceId,
    name: "template-reference",
    environment: "preview",
    sourceId: "src_template_reference",
    installConfigId: referenced.id,
    installingPrincipalId: "acct_template_reference",
  });
  const patchReferenced = () =>
    app.request(`/internal/v1/install-configs/${referenced.id}`, {
      method: "PATCH",
      headers: headers("operator"),
      body: JSON.stringify({
        kind: INSTALL_CONFIG_PATCH_V1_KIND,
        variableMapping: { region: "must-not-change" },
      }),
    });

  const active = await patchReferenced();
  expect(active.status).toBe(409);
  expect((await active.json()).error.details).toEqual({
    reason: "install_config_in_use",
  });
  expect(await store.getInstallConfig(referenced.id)).toEqual(referenced);

  await operations.capsules.abandonUnappliedCapsule(
    capsule.id,
    "exercise destroyed provenance reference",
  );
  expect((await store.getCapsule(capsule.id))?.status).toBe("destroyed");
  const destroyed = await patchReferenced();
  expect(destroyed.status).toBe(409);
  expect((await destroyed.json()).error.details).toEqual({
    reason: "install_config_in_use",
  });
  expect(await store.getInstallConfig(referenced.id)).toEqual(referenced);
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
