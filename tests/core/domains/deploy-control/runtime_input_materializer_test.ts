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

  // Neither may a repository re-sync that repoints the Capsule at a
  // content-identical InstallConfig under a new id. Nothing about the sealed
  // material changed, so the apply-idempotency identity must not move.
  const resynced = {
    ...seeded.installConfig,
    id: "icfg_resynced_identical",
  };
  await store.putInstallConfig(resynced);
  await store.putCapsule({
    ...seeded.capsule,
    installConfigId: resynced.id,
  });
  expect(
    await materializer.nonce({ ...request, installConfigId: resynced.id }),
  ).toBe(nonce);

  // Only the material generation moves it: the profile digest and the sealed
  // material generation are both preimage parts, and `installConfigId` is not.
  const parts = {
    workspaceId: request.workspaceId,
    capsuleId: request.capsuleId,
    profileDigest: "sha256:profile",
    materialGeneration: "sha256:generation-a",
    providerInstance: DEFAULT_INSTANCE,
  };
  expect(await runtimeInputNonce(parts)).toBe(await runtimeInputNonce(parts));
  expect(
    await runtimeInputNonce({ ...parts, materialGeneration: "sha256:b" }),
  ).not.toBe(await runtimeInputNonce(parts));
  expect(
    await runtimeInputNonce({ ...parts, profileDigest: "sha256:other" }),
  ).not.toBe(await runtimeInputNonce(parts));
  expect(await runtimeInputNonce({ ...parts, capsuleId: "cap_other" })).not.toBe(
    await runtimeInputNonce(parts),
  );
});

test("re-sealing the same Capsule rotates the nonce", async () => {
  const { store, materializer, request } = await fixture();
  const before = await materializer.nonce(request);
  // A store restore or partial wipe that loses the sealed row must not leave
  // fresh values live under a byte-identical nonce: the Host would keep the
  // preparation it made from the retired ones.
  await store.deleteSecretBlob(`runtime_input_${request.capsuleId}`);
  expect(await materializer.nonce(request)).not.toBe(before);
});

test("a drifted runtime binding profile rotates the material instead of bricking the Capsule", async () => {
  const { store, seeded, materializer, request } = await fixture();
  const before = await materializer.materialize({ ...request, phase: "apply" });
  const sealedBeforeDrift = await store.getSecretBlob(
    `runtime_input_${request.capsuleId}`,
  );

  // A Capsule upgrade that adds a `secret.generated` binding changes the
  // deliverable name set. The old sealed generation cannot answer it, so it is
  // retired and a new one is sealed — a hard fence here would leave the Capsule
  // unable to plan OR destroy, with no recovery path at all.
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
  const after = await materializer.materialize({ ...request, phase: "apply" });
  expect(after.names).toEqual([
    "ENCRYPTION_KEY",
    "SESSION_KEY",
    "SIGNING_KEY",
  ]);
  // Replacement semantics: new generation, new nonce.
  expect(after.nonce).not.toBe(before.nonce);
  expect(after.profileDigest).not.toBe(before.profileDigest);
  const sealedAfterDrift = await store.getSecretBlob(
    `runtime_input_${request.capsuleId}`,
  );
  expect(sealedAfterDrift?.ciphertext).not.toBe(sealedBeforeDrift?.ciphertext);
  expect(sealedAfterDrift?.aad).not.toBe(sealedBeforeDrift?.aad);
  // Stable once more under the new profile.
  expect(
    (await materializer.materialize({ ...request, phase: "apply" }))
      .toRunnerDispatch(),
  ).toEqual(after.toRunnerDispatch());

  // The Capsule authority fence is untouched.
  await expect(
    materializer.nonce({ ...request, installConfigId: "wrong" }),
  ).rejects.toThrow("authority");
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
