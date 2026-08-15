import { expect, test } from "bun:test";

import type { TakosumiOperations } from "../../../core/bootstrap.ts";
import { HOST_RUNTIME_MATERIALIZATION_CONTRACT } from "../../../contract/host-runtime-materialization.ts";
import type { Capsule } from "../../../contract/capsules.ts";
import type { InstallConfig } from "../../../contract/install-configs.ts";
import { platformCapsuleHostRuntimeMaterialization } from "../../../deploy/platform/worker.ts";

const capsule: Capsule = {
  id: "cap_runtime_reader",
  workspaceId: "ws_runtime_reader",
  projectId: "prj_runtime_reader",
  name: "runtime-reader",
  slug: "runtime-reader",
  sourceId: "src_runtime_reader",
  installConfigId: "ic_runtime_reader",
  installingPrincipalId: "tsub_runtime_reader",
  environment: "production",
  currentStateGeneration: 1,
  status: "active",
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

const config: InstallConfig = {
  id: capsule.installConfigId,
  workspaceId: capsule.workspaceId,
  name: "runtime-reader",
  variableMapping: {},
  outputAllowlist: {},
  policy: {},
  hostRuntimeMaterialization: {
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    requirements: [
      {
        kind: "generated_secret",
        binding: "APP_SECRET",
        secretRef: "secret:runtime-reader/app",
        bytes: 32,
        encoding: "base64url",
      },
    ],
  },
  createdAt: capsule.createdAt,
  updatedAt: capsule.updatedAt,
};

function operationsFor(
  currentCapsule: Capsule,
  currentConfig: InstallConfig,
): Pick<TakosumiOperations, "capsules"> {
  return {
    capsules: {
      getCapsule: async () => currentCapsule,
      getInstallConfig: async () => currentConfig,
    },
  } as unknown as Pick<TakosumiOperations, "capsules">;
}

const env = {} as never;

test("platform reads exact DB-owned generated-secret metadata", async () => {
  const request = await platformCapsuleHostRuntimeMaterialization(
    env,
    {
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
    },
    {
      operationsForEnv: async () => operationsFor(capsule, config),
    },
  );

  expect(request).toEqual({
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    installConfigId: config.id,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    installingPrincipalId: capsule.installingPrincipalId,
    requirements: config.hostRuntimeMaterialization?.requirements,
  });
  expect(JSON.stringify(request)).not.toContain("secret-bytes");
});

test("platform returns no declaration for a Workspace-mismatched Capsule", async () => {
  let configReads = 0;
  const mismatched = operationsFor(capsule, config);
  mismatched.capsules.getInstallConfig = async () => {
    configReads += 1;
    return config;
  };

  await expect(
    platformCapsuleHostRuntimeMaterialization(
      env,
      { workspaceId: "ws_other", capsuleId: capsule.id },
      { operationsForEnv: async () => mismatched },
    ),
  ).resolves.toBeUndefined();
  expect(configReads).toBe(0);
});

test("platform returns no declaration for destroyed Capsules or configs without one", async () => {
  const destroyed = { ...capsule, status: "destroyed" as const };
  await expect(
    platformCapsuleHostRuntimeMaterialization(
      env,
      { workspaceId: capsule.workspaceId, capsuleId: capsule.id },
      { operationsForEnv: async () => operationsFor(destroyed, config) },
    ),
  ).resolves.toBeUndefined();

  const withoutDeclaration = {
    ...config,
    hostRuntimeMaterialization: undefined,
  };
  await expect(
    platformCapsuleHostRuntimeMaterialization(
      env,
      { workspaceId: capsule.workspaceId, capsuleId: capsule.id },
      {
        operationsForEnv: async () =>
          operationsFor(capsule, withoutDeclaration),
      },
    ),
  ).resolves.toBeUndefined();
});
