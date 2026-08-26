import { expect, test } from "bun:test";
import { PlaceholderSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createRuntimeSecretFileMaterializer,
  RUNTIME_SECRET_FILE_BUNDLE_MARKER,
} from "../../../../core/domains/deploy-control/runtime_secret_file_materializer.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const profile = {
  contract: "takosumi.runtime-binding-profile/v1",
  runtimeSecretFile: {
    contract: "takosumi.runtime-secret-file/v1",
    envName: "TAKOS_RUNTIME_SECRETS_FILE",
    fileName: "takos-runtime-secrets.json",
    mode: 0o600,
    values: [
      {
        kind: "rsa-key-pair",
        privateName: "PLATFORM_PRIVATE_KEY",
        publicName: "PLATFORM_PUBLIC_KEY",
        modulusLength: 2048,
        hash: "SHA-256",
      },
      {
        kind: "random",
        name: "ENCRYPTION_KEY",
        bytes: 32,
        encoding: "base64",
      },
      {
        kind: "random",
        name: "TAKOS_AGENT_START_TOKEN",
        bytes: 32,
        encoding: "hex",
      },
      {
        kind: "random",
        name: "TAKOS_INTERNAL_API_SECRET",
        bytes: 32,
        encoding: "hex",
      },
    ],
  },
} as const;

async function fixture() {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    installConfig: { runtimeBindingMaterialization: profile },
  });
  const materializer = createRuntimeSecretFileMaterializer({
    store,
    crypto: new PlaceholderSecretBoundaryCrypto(),
    clock: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const request = {
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    installConfigId: seeded.installConfig.id,
    phase: "post_apply" as const,
  };
  return { store, seeded, materializer, request };
}

test("runtime secret file is stable, sealed, opaque, and exact across retries and updates", async () => {
  const { store, seeded, materializer, request } = await fixture();

  const [first, concurrent] = await Promise.all([
    materializer.materialize(request),
    materializer.materialize(request),
  ]);
  await store.putInstallConfig({
    ...seeded.installConfig,
    updatedAt: "2026-08-25T12:05:00.000Z",
  });
  const updateRetry = await materializer.materialize(request);
  const afterRestart = await createRuntimeSecretFileMaterializer({
    store,
    crypto: new PlaceholderSecretBoundaryCrypto(),
  }).materialize(request);

  expect(JSON.stringify(first)).toBe(
    JSON.stringify(RUNTIME_SECRET_FILE_BUNDLE_MARKER),
  );
  const firstDispatch = first.toRunnerDispatch();
  expect(concurrent.toRunnerDispatch()).toEqual(firstDispatch);
  expect(updateRetry.toRunnerDispatch()).toEqual(firstDispatch);
  expect(afterRestart.toRunnerDispatch()).toEqual(firstDispatch);
  expect(firstDispatch.files).toHaveLength(1);
  expect(firstDispatch.files[0]).toMatchObject({
    path: "takos-runtime-secrets.json",
    mode: 0o600,
    envName: "TAKOS_RUNTIME_SECRETS_FILE",
    secretNames: [
      "ENCRYPTION_KEY",
      "PLATFORM_PRIVATE_KEY",
      "PLATFORM_PUBLIC_KEY",
      "TAKOS_AGENT_START_TOKEN",
      "TAKOS_INTERNAL_API_SECRET",
    ].sort(),
  });
  const values = JSON.parse(firstDispatch.files[0]!.content) as Record<
    string,
    string
  >;
  expect(Object.keys(values).sort()).toEqual(
    firstDispatch.files[0]!.secretNames,
  );
  expect(values.ENCRYPTION_KEY).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
  expect(values.TAKOS_AGENT_START_TOKEN).toMatch(/^[0-9a-f]{64}$/u);
  expect(values.TAKOS_INTERNAL_API_SECRET).toMatch(/^[0-9a-f]{64}$/u);
  expect(values.PLATFORM_PRIVATE_KEY).toStartWith(
    "-----BEGIN PRIVATE KEY-----",
  );
  expect(values.PLATFORM_PUBLIC_KEY).toStartWith(
    "-----BEGIN PUBLIC KEY-----",
  );

  const sealed = await store.getSecretBlob(
    `runtime_secret_file_${request.capsuleId}`,
  );
  expect(sealed).toBeDefined();
  expect(JSON.stringify(sealed)).not.toContain(values.ENCRYPTION_KEY);
  expect(JSON.stringify(sealed)).not.toContain(values.PLATFORM_PRIVATE_KEY);
  expect(JSON.stringify(sealed)).not.toContain("TAKOS_RUNTIME_SECRETS_FILE");
});

test("an immutable InstallConfig replacement with the same profile reopens the Capsule-stable bundle", async () => {
  const { store, seeded, materializer, request } = await fixture();
  const first = await materializer.materialize(request);
  const replacement = {
    ...seeded.installConfig,
    id: "cfg_runtime_replacement",
    createdAt: "2026-08-25T12:05:00.000Z",
    updatedAt: "2026-08-25T12:05:00.000Z",
  };
  await store.putInstallConfig(replacement);
  await store.putCapsule({
    ...seeded.capsule,
    installConfigId: replacement.id,
    updatedAt: "2026-08-25T12:05:00.000Z",
  });

  const afterRebind = await materializer.materialize({
    ...request,
    installConfigId: replacement.id,
  });
  expect(afterRebind.toRunnerDispatch()).toEqual(first.toRunnerDispatch());
  await expect(materializer.materialize(request)).rejects.toThrow("authority");
});

test("two Capsules receive independently sealed runtime secret bundles", async () => {
  const { store, seeded, materializer, request } = await fixture();
  const secondCapsule = {
    ...seeded.capsule,
    id: "cap_runtime_isolated",
    slug: "runtime-isolated",
    name: "Runtime isolated",
  };
  await store.putCapsule(secondCapsule);

  const [first, second] = await Promise.all([
    materializer.materialize(request),
    materializer.materialize({
      ...request,
      capsuleId: secondCapsule.id,
    }),
  ]);
  expect(second.toRunnerDispatch().files[0]?.content).not.toBe(
    first.toRunnerDispatch().files[0]?.content,
  );
  const firstBlob = await store.getSecretBlob(
    `runtime_secret_file_${request.capsuleId}`,
  );
  const secondBlob = await store.getSecretBlob(
    `runtime_secret_file_${secondCapsule.id}`,
  );
  expect(firstBlob?.connectionId).not.toBe(secondBlob?.connectionId);
  expect(firstBlob?.aad).not.toBe(secondBlob?.aad);
  expect(firstBlob?.ciphertext).not.toBe(secondBlob?.ciphertext);
});

test("runtime secret file refuses plan/destroy exposure and profile drift without rotation", async () => {
  const { store, seeded, materializer, request } = await fixture();
  await materializer.materialize(request);
  const sealedBeforeDrift = await store.getSecretBlob(
    `runtime_secret_file_${request.capsuleId}`,
  );

  await expect(
    materializer.materialize({ ...request, phase: "destroy" as never }),
  ).rejects.toThrow("post_apply");
  await store.putInstallConfig({
    ...seeded.installConfig,
    runtimeBindingMaterialization: {
      ...profile,
      runtimeSecretFile: {
        ...profile.runtimeSecretFile,
        fileName: "changed.json",
      },
    },
  });
  await expect(materializer.materialize(request)).rejects.toThrow(
    "profile",
  );
  await expect(
    materializer.materialize({
      ...request,
      installConfigId: "wrong",
    }),
  ).rejects.toThrow("authority");
  expect(
    await store.getSecretBlob(`runtime_secret_file_${request.capsuleId}`),
  ).toEqual(
    sealedBeforeDrift,
  );
});

test("runtime secret bundle retires only after the exact Capsule is destroyed", async () => {
  const { store, seeded, materializer, request } = await fixture();
  const bundle = await materializer.materialize(request);
  const profileDigest = bundle.toRunnerDispatch().profileDigest;

  await expect(
    materializer.retire({ ...request, profileDigest }),
  ).rejects.toThrow("destroyed");
  await store.putCapsule({ ...seeded.capsule, status: "destroyed" });
  await materializer.retire({ ...request, profileDigest });
  expect(
    await store.getSecretBlob(`runtime_secret_file_${request.capsuleId}`),
  ).toBeUndefined();
});
