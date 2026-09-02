// takos-secret-scan: synthetic — this in-memory test seals randomly generated
// bytes and asserts only their shape and containment.
import { expect, test } from "bun:test";
import { PlaceholderSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createRuntimeInputMaterializer,
  runtimeInputNonce,
  runtimeInputProviderInstance,
  RUNTIME_INPUT_BUNDLE_MARKER,
} from "../../../../core/domains/deploy-control/runtime_input_materializer.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const profile = {
  contract: "takosumi.runtime-binding-profile/v1",
  generatedSecrets: [
    { binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" },
    { binding: "SIGNING_KEY", bytes: 32, encoding: "hex" },
  ],
} as const;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const DEFAULT_INSTANCE = runtimeInputProviderInstance({
  moduleLocalName: "takoform",
});

async function fixture(
  overrides: { readonly runtimeBindingMaterialization?: unknown } = {},
) {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    installConfig: {
      runtimeBindingMaterialization: (overrides.runtimeBindingMaterialization ??
        profile) as never,
    },
  });
  const materializer = createRuntimeInputMaterializer({
    store,
    crypto: new PlaceholderSecretBoundaryCrypto(),
    clock: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  const authority = {
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    installConfigId: seeded.installConfig.id,
  };
  return {
    store,
    seeded,
    materializer,
    authority,
    request: { ...authority, providerInstance: DEFAULT_INSTANCE },
  };
}

test("the nonce is deterministic and changes only with the material generation", async () => {
  const { store, seeded, materializer, request } = await fixture();

  const nonce = await materializer.nonce(request);
  expect(nonce).toMatch(NONCE_PATTERN);
  expect(Buffer.from(nonce, "base64url")).toHaveLength(32);
  expect(await materializer.nonce(request)).toBe(nonce);

  // A different provider instance is a different apply-idempotency identity.
  expect(
    await materializer.nonce({
      ...request,
      providerInstance: runtimeInputProviderInstance({
        moduleLocalName: "takoform",
        rootAlias: "edge",
      }),
    }),
  ).not.toBe(nonce);

  // An unrelated InstallConfig edit must NOT rotate it: a rotated nonce forces
  // provider-side replacement of everything keyed to it.
  await store.putInstallConfig({
    ...seeded.installConfig,
    updatedAt: "2026-09-01T12:05:00.000Z",
  });
  expect(await materializer.nonce(request)).toBe(nonce);

  // Only the material generation moves it: the profile digest and the material
  // key version are both preimage parts.
  const parts = {
    workspaceId: request.workspaceId,
    capsuleId: request.capsuleId,
    installConfigId: request.installConfigId,
    profileDigest: "sha256:profile",
    materialKeyVersion: 1,
    providerInstance: DEFAULT_INSTANCE,
  };
  expect(await runtimeInputNonce(parts)).toBe(await runtimeInputNonce(parts));
  expect(await runtimeInputNonce({ ...parts, materialKeyVersion: 2 })).not.toBe(
    await runtimeInputNonce(parts),
  );
  expect(
    await runtimeInputNonce({ ...parts, profileDigest: "sha256:other" }),
  ).not.toBe(await runtimeInputNonce(parts));
  expect(await runtimeInputNonce({ ...parts, capsuleId: "cap_other" })).not.toBe(
    await runtimeInputNonce(parts),
  );
});

test("a drifted runtime binding profile fails closed instead of silently rotating", async () => {
  const { store, seeded, materializer, request } = await fixture();
  await materializer.materialize({ ...request, phase: "apply" });
  const sealedBeforeDrift = await store.getSecretBlob(
    `runtime_input_${request.capsuleId}`,
  );

  // Adding a binding would leave the new name with no sealed value, so the
  // owner/profile fence refuses rather than delivering a partial map.
  await store.putInstallConfig({
    ...seeded.installConfig,
    runtimeBindingMaterialization: {
      contract: "takosumi.runtime-binding-profile/v1",
      generatedSecrets: [
        { binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" },
        { binding: "SIGNING_KEY", bytes: 32, encoding: "hex" },
        { binding: "SESSION_KEY", bytes: 32, encoding: "hex" },
      ],
    },
  });
  await expect(materializer.nonce(request)).rejects.toThrow("fence");
  await expect(
    materializer.materialize({ ...request, phase: "apply" }),
  ).rejects.toThrow("fence");
  await expect(
    materializer.nonce({ ...request, installConfigId: "wrong" }),
  ).rejects.toThrow("authority");
  expect(
    await store.getSecretBlob(`runtime_input_${request.capsuleId}`),
  ).toEqual(sealedBeforeDrift);
});

test("materialized values are Capsule-stable, exact, and opaque to serialization", async () => {
  const { store, materializer, request } = await fixture();
  const nonce = await materializer.nonce(request);

  const first = await materializer.materialize({ ...request, phase: "apply" });
  const second = await materializer.materialize({ ...request, phase: "apply" });

  expect(JSON.stringify(first)).toBe(
    JSON.stringify(RUNTIME_INPUT_BUNDLE_MARKER),
  );
  expect(String(first)).toBe(RUNTIME_INPUT_BUNDLE_MARKER);
  const dispatch = first.toRunnerDispatch();
  expect(second.toRunnerDispatch()).toEqual(dispatch);
  expect(dispatch.nonce).toBe(nonce);
  expect(dispatch.names).toEqual(["ENCRYPTION_KEY", "SIGNING_KEY"]);
  expect(Object.keys(dispatch.values).sort()).toEqual([...dispatch.names]);
  for (const value of Object.values(dispatch.values)) {
    expect(value).toMatch(/^[0-9a-f]{64}$/u);
  }

  const sealed = await store.getSecretBlob(
    `runtime_input_${request.capsuleId}`,
  );
  expect(sealed).toBeDefined();
  for (const value of Object.values(dispatch.values)) {
    expect(JSON.stringify(sealed)).not.toContain(value);
  }

  await expect(
    materializer.materialize({ ...request, phase: "plan" as never }),
  ).rejects.toThrow("apply");
});

test("two Capsules receive independently sealed runtime inputs", async () => {
  const { store, seeded, materializer, request } = await fixture();
  const second = {
    ...seeded.capsule,
    id: "cap_runtime_input_isolated",
    name: "runtime-input-isolated",
    slug: "runtime-input-isolated",
  };
  await store.putCapsule(second);

  const [left, right] = await Promise.all([
    materializer.materialize({ ...request, phase: "apply" }),
    materializer.materialize({
      ...request,
      capsuleId: second.id,
      phase: "apply",
    }),
  ]);
  expect(right.toRunnerDispatch().values).not.toEqual(
    left.toRunnerDispatch().values,
  );
  expect(right.toRunnerDispatch().nonce).not.toBe(
    left.toRunnerDispatch().nonce,
  );
});

test("an unusable runtime binding profile is refused before any material exists", async () => {
  const rejected = [
    { contract: "takosumi.runtime-binding-profile/v1", generatedSecrets: [] },
    {
      contract: "takosumi.runtime-binding-profile/v1",
      generatedSecrets: [
        { binding: `A${"B".repeat(64)}`, bytes: 32, encoding: "hex" },
      ],
    },
    {
      contract: "takosumi.runtime-binding-profile/v1",
      generatedSecrets: Array.from({ length: 65 }, (_unused, index) => ({
        binding: `BINDING_${index}`,
        bytes: 32,
        encoding: "hex",
      })),
    },
    {
      contract: "takosumi.runtime-binding-profile/v1",
      generatedSecrets: [
        { binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" },
        { binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" },
      ],
    },
    { contract: "takosumi.runtime-binding-profile/v1" },
  ];
  for (const runtimeBindingMaterialization of rejected) {
    const { store, materializer, request } = await fixture({
      runtimeBindingMaterialization,
    });
    await expect(materializer.nonce(request)).rejects.toThrow(
      /runtime input profile|runtime input generated secret|runtime input binding/u,
    );
    expect(
      await store.getSecretBlob(`runtime_input_${request.capsuleId}`),
    ).toBeUndefined();
  }
});

test("runtime input material retires only after the exact Capsule is destroyed", async () => {
  const { store, seeded, materializer, authority, request } = await fixture();
  const bundle = await materializer.materialize({ ...request, phase: "apply" });
  const profileDigest = bundle.profileDigest;

  await expect(
    materializer.retire({ ...authority, profileDigest }),
  ).rejects.toThrow("destroyed");
  await store.putCapsule({ ...seeded.capsule, status: "destroyed" });
  await expect(
    materializer.retire({ ...authority, profileDigest: "sha256:stale" }),
  ).rejects.toThrow("stale");
  expect(
    await store.getSecretBlob(`runtime_input_${authority.capsuleId}`),
  ).toBeDefined();

  await materializer.retire({ ...authority, profileDigest });
  expect(
    await store.getSecretBlob(`runtime_input_${authority.capsuleId}`),
  ).toBeUndefined();
  // Retirement is idempotent.
  await materializer.retire({ ...authority, profileDigest });
});
