import { expect, test } from "bun:test";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import type { TakosumiOperations } from "../../../core/bootstrap.ts";
import {
  ensurePlatformCapsulePublicOidcIdentity,
  revokePlatformCapsulePublicOidcIdentity,
  rollbackPlatformCapsulePublicOidcIdentity,
} from "../../../deploy/platform/worker.ts";
import type { Capsule } from "../../../contract/capsules.ts";

const capsule: Capsule = {
  id: "cap_public_oidc",
  workspaceId: "ws_public_oidc",
  projectId: "prj_public_oidc",
  name: "social",
  slug: "social",
  sourceId: "src_public_oidc",
  installConfigId: "ic_public_oidc",
  installingPrincipalId: "tsub_installer",
  environment: "production",
  currentStateGeneration: 1,
  status: "active",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

const env = {
  TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.example.test/",
  TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET:
    "0123456789abcdef0123456789abcdef",
};

test("Capsule public OIDC authority registers one exact public client and returns no secret", async () => {
  const store = new InMemoryAccountsStore();
  let now = 100;
  const dependencies = {
    operationsForEnv: async () =>
      ({
        capsules: {
          getCapsule: async () => capsule,
        },
      }) as unknown as Pick<TakosumiOperations, "capsules">,
    storeForEnv: async () => store,
    deriveSubject: async () => "tsub_pairwise_owner" as const,
    now: () => now,
  };
  const request = {
    capsuleId: capsule.id,
    workspaceId: capsule.workspaceId,
    installingPrincipalId: capsule.installingPrincipalId!,
    appOrigin: "https://social.example.test",
    callbackPath: "/api/auth/callback/takos",
    scopes: ["email", "openid", "profile"],
  };

  const first = await ensurePlatformCapsulePublicOidcIdentity(
    request,
    env,
    dependencies,
  );
  now += 1;
  const replay = await ensurePlatformCapsulePublicOidcIdentity(
    request,
    env,
    dependencies,
  );

  expect(first.changed).toBe(true);
  expect(replay.changed).toBe(false);
  expect(replay.identity).toEqual(first.identity);
  expect(first.identity).toEqual({
    issuerUrl: "https://accounts.example.test",
    clientId: first.clientId,
    ownerSubject: "tsub_pairwise_owner",
    redirectUri: "https://social.example.test/api/auth/callback/takos",
  });
  expect(JSON.stringify(first)).not.toContain(
    env.TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET,
  );
  expect(await store.findOidcClientForCapsule(capsule.id)).toMatchObject({
    clientId: first.clientId,
    capsuleId: capsule.id,
    tokenEndpointAuthMethod: "none",
    clientSecretHash: undefined,
  });

  await rollbackPlatformCapsulePublicOidcIdentity(first, env, dependencies);
  expect(await store.findOidcClientForCapsule(capsule.id)).toBeUndefined();
});

test("Capsule public OIDC destroy is fenced to the expected client", async () => {
  const store = new InMemoryAccountsStore();
  const dependencies = {
    operationsForEnv: async () =>
      ({
        capsules: {
          getCapsule: async () => capsule,
        },
      }) as unknown as Pick<TakosumiOperations, "capsules">,
    storeForEnv: async () => store,
    deriveSubject: async () => "tsub_pairwise_owner" as const,
    now: () => 100,
  };
  const mutation = await ensurePlatformCapsulePublicOidcIdentity(
    {
      capsuleId: capsule.id,
      workspaceId: capsule.workspaceId,
      installingPrincipalId: capsule.installingPrincipalId!,
      appOrigin: "https://social.example.test",
      callbackPath: "/callback",
      scopes: ["openid"],
    },
    env,
    dependencies,
  );

  await expect(
    revokePlatformCapsulePublicOidcIdentity(
      { capsuleId: capsule.id, expectedClientId: "toc_stale" },
      env,
      dependencies,
    ),
  ).rejects.toThrow("refusing stale destroy");
  expect(await store.findOidcClientForCapsule(capsule.id)).toBeDefined();

  await revokePlatformCapsulePublicOidcIdentity(
    { capsuleId: capsule.id, expectedClientId: mutation.clientId },
    env,
    dependencies,
  );
  expect(await store.findOidcClientForCapsule(capsule.id)).toBeUndefined();
});
