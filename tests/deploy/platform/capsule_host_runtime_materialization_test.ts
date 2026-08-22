import { expect, test } from "bun:test";

import type { TakosumiOperations } from "../../../core/bootstrap.ts";
import { HOST_RUNTIME_MATERIALIZATION_CONTRACT } from "../../../contract/host-runtime-materialization.ts";
import type { Capsule } from "../../../contract/capsules.ts";
import type { InstallConfig } from "../../../contract/install-configs.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import {
  ensurePlatformCapsulePublicOidcIdentity,
  materializePlatformCapsuleRuntimeBindings,
  platformCapsuleHostRuntimeMaterialization,
  rollbackPlatformCapsulePublicOidcIdentity,
  rollbackPlatformCapsuleRuntimeBindings,
} from "../../../deploy/platform/worker.ts";

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

test("platform derives one stable secret only after re-reading the exact Capsule declaration", async () => {
  const request = await platformCapsuleHostRuntimeMaterialization(
    env,
    { workspaceId: capsule.workspaceId, capsuleId: capsule.id },
    { operationsForEnv: async () => operationsFor(capsule, config) },
  );
  expect(request).toBeDefined();
  const materializerEnv = {
    TAKOSUMI_HOST_RUNTIME_SECRET_DERIVATION_KEY:
      "runtime-secret-derivation-key-32-bytes-minimum",
  } as never;
  const input = {
    request: request!,
    resourceName: "runtime-reader",
    scriptName: "runtime-reader-abcd",
    publicOrigin: "https://runtime-reader.example.test",
    bindings: ["APP_SECRET"],
  };
  const dependencies = { resolveRequest: async () => request };

  const first = await materializePlatformCapsuleRuntimeBindings(
    materializerEnv,
    input,
    dependencies,
  );
  const replay = await materializePlatformCapsuleRuntimeBindings(
    materializerEnv,
    input,
    dependencies,
  );

  expect(replay).toEqual(first);
  expect(Object.keys(first.values)).toEqual(["APP_SECRET"]);
  expect(first.values.APP_SECRET).toHaveLength(43);
  expect(first.rollbackReceipt).toBeUndefined();
  expect(JSON.stringify(input)).not.toContain(first.values.APP_SECRET!);
});

test("platform materializes the exact public OIDC fields and rejects stale declarations", async () => {
  const request = {
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    installConfigId: config.id,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    installingPrincipalId: capsule.installingPrincipalId!,
    requirements: [
      {
        kind: "public_oidc" as const,
        id: "accounts",
        callbackPath: "/api/auth/callback/takos",
        scopes: ["openid", "profile"],
        bindings: {
          issuerUrl: {
            binding: "OIDC_ISSUER",
            capabilityRef: "capability:accounts/issuer" as const,
          },
          clientId: {
            binding: "OIDC_CLIENT_ID",
            capabilityRef: "capability:accounts/client" as const,
          },
          ownerSubject: {
            binding: "OIDC_OWNER",
            capabilityRef: "capability:accounts/owner" as const,
          },
          redirectUri: {
            binding: "OIDC_REDIRECT",
            capabilityRef: "capability:accounts/redirect" as const,
          },
        },
      },
    ],
  };
  let oidcInputs = 0;
  const values = await materializePlatformCapsuleRuntimeBindings(
    {} as never,
    {
      request,
      resourceName: "runtime-reader",
      scriptName: "runtime-reader-abcd",
      publicOrigin: "https://runtime-reader.example.test",
      bindings: [
        "OIDC_REDIRECT",
        "OIDC_OWNER",
        "OIDC_CLIENT_ID",
        "OIDC_ISSUER",
      ],
    },
    {
      resolveRequest: async () => request,
      ensurePublicOidc: async (input) => {
        oidcInputs += 1;
        expect(input).toEqual({
          capsuleId: capsule.id,
          workspaceId: capsule.workspaceId,
          installingPrincipalId: capsule.installingPrincipalId,
          appOrigin: "https://runtime-reader.example.test",
          callbackPath: "/api/auth/callback/takos",
          scopes: ["openid", "profile"],
        });
        return {
          capsuleId: capsule.id,
          clientId: "toc_runtime_reader",
          expectedUpdatedAt: 1,
          identity: {
            issuerUrl: "https://accounts.example.test",
            clientId: "toc_runtime_reader",
            ownerSubject: "tsub_pairwise_owner",
            redirectUri:
              "https://runtime-reader.example.test/api/auth/callback/takos",
          },
          changed: false,
        };
      },
    },
  );
  expect(oidcInputs).toBe(1);
  expect(values).toEqual({
    values: {
      OIDC_ISSUER: "https://accounts.example.test",
      OIDC_CLIENT_ID: "toc_runtime_reader",
      OIDC_OWNER: "tsub_pairwise_owner",
      OIDC_REDIRECT:
        "https://runtime-reader.example.test/api/auth/callback/takos",
    },
  });

  await expect(
    materializePlatformCapsuleRuntimeBindings(
      {} as never,
      {
        request,
        resourceName: "runtime-reader",
        scriptName: "runtime-reader-abcd",
        publicOrigin: "https://runtime-reader.example.test",
        bindings: ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_OWNER", "OIDC_REDIRECT"],
      },
      {
        resolveRequest: async () => ({ ...request, installConfigId: "ic_replaced" }),
      },
    ),
  ).rejects.toThrow("does not match the canonical Capsule");
});

test("failed Worker Version upload can return the signed OIDC mutation for exact rollback", async () => {
  const request = {
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    installConfigId: config.id,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    installingPrincipalId: capsule.installingPrincipalId!,
    requirements: [
      {
        kind: "public_oidc" as const,
        id: "accounts",
        callbackPath: "/api/auth/callback/takos",
        scopes: ["openid", "profile"],
        bindings: {
          issuerUrl: {
            binding: "OIDC_ISSUER",
            capabilityRef: "capability:accounts/issuer" as const,
          },
          clientId: {
            binding: "OIDC_CLIENT_ID",
            capabilityRef: "capability:accounts/client" as const,
          },
          ownerSubject: {
            binding: "OIDC_OWNER",
            capabilityRef: "capability:accounts/owner" as const,
          },
          redirectUri: {
            binding: "OIDC_REDIRECT",
            capabilityRef: "capability:accounts/redirect" as const,
          },
        },
      },
    ],
  };
  const store = new InMemoryAccountsStore();
  const materializerEnv = {
    TAKOSUMI_HOST_RUNTIME_SECRET_DERIVATION_KEY:
      "runtime-secret-derivation-key-32-bytes-minimum",
    TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.example.test",
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET:
      "runtime-pairwise-subject-secret-32-bytes-minimum",
  } as never;
  const operationsForEnv = async () => operationsFor(capsule, config);
  const dependencies = {
    resolveRequest: async () => request,
    ensurePublicOidc: async (input: Parameters<typeof ensurePlatformCapsulePublicOidcIdentity>[0]) =>
      await ensurePlatformCapsulePublicOidcIdentity(input, materializerEnv, {
        operationsForEnv,
        storeForEnv: async () => store,
        now: () => 1_700_000_000_000,
      }),
  };
  const materialized = await materializePlatformCapsuleRuntimeBindings(
    materializerEnv,
    {
      request,
      resourceName: "runtime-reader",
      scriptName: "runtime-reader-abcd",
      publicOrigin: "https://runtime-reader.example.test",
      bindings: ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_OWNER", "OIDC_REDIRECT"],
    },
    dependencies,
  );

  expect(materialized.rollbackReceipt).toBeString();
  expect(await store.findOidcClientForCapsule(capsule.id)).toBeDefined();
  await rollbackPlatformCapsuleRuntimeBindings(
    materializerEnv,
    { request, rollbackReceipt: materialized.rollbackReceipt! },
    {
      resolveRequest: async () => request,
      rollbackPublicOidc: async (mutation, runtimeEnv) =>
        await rollbackPlatformCapsulePublicOidcIdentity(
          mutation,
          runtimeEnv,
          { storeForEnv: async () => store },
        ),
    },
  );
  expect(await store.findOidcClientForCapsule(capsule.id)).toBeUndefined();

  const tampered = `${materialized.rollbackReceipt!.slice(0, -1)}x`;
  await expect(
    rollbackPlatformCapsuleRuntimeBindings(
      materializerEnv,
      { request, rollbackReceipt: tampered },
      { resolveRequest: async () => request },
    ),
  ).rejects.toThrow("rollback receipt is invalid");
});
