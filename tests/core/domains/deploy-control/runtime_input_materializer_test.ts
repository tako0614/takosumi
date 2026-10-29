// takos-secret-scan: synthetic — this in-memory test seals randomly generated
// bytes and asserts only their shape and containment.
import { expect, test } from "bun:test";
import {
  PartitionedSecretBoundaryCrypto,
  PlaceholderSecretBoundaryCrypto,
  type SecretBoundaryCrypto,
} from "../../../../core/adapters/secret-store/memory.ts";
import {
  InMemoryOpenTofuControlStore,
  type StoredSecretBlob,
} from "../../../../core/domains/deploy-control/store.ts";
import {
  carryGeneratedSecretValues,
  createRuntimeInputMaterializer,
  runtimeInputNonce,
  runtimeInputProviderInstance,
  runtimeInputProviderInstanceForStorage,
  runtimeInputProviderInstanceFromStorage,
  RUNTIME_INPUT_BUNDLE_MARKER,
  RuntimeInputPreviousGenerationError,
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
  overrides: {
    readonly runtimeBindingMaterialization?: unknown;
    readonly store?: InMemoryOpenTofuControlStore;
    readonly crypto?: SecretBoundaryCrypto;
  } = {},
) {
  const store = overrides.store ?? new InMemoryOpenTofuControlStore();
  const crypto = overrides.crypto ?? new PlaceholderSecretBoundaryCrypto();
  const seeded = await seedCapsuleModel(store, {
    installConfig: {
      runtimeBindingMaterialization: (overrides.runtimeBindingMaterialization ??
        profile) as never,
    },
  });
  const materializer = createRuntimeInputMaterializer({
    store,
    crypto,
    clock: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  const authority = {
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    installConfigId: seeded.installConfig.id,
  };
  return {
    store,
    crypto,
    seeded,
    materializer,
    authority,
    request: { ...authority, providerInstance: DEFAULT_INSTANCE },
    /** Replaces the Capsule's generated-secret declaration in place. */
    async declare(
      generatedSecrets: readonly string[],
      contract = "takosumi.runtime-binding-profile/v1",
    ) {
      await store.putInstallConfig({
        ...seeded.installConfig,
        runtimeBindingMaterialization: {
          contract,
          generatedSecrets: generatedSecrets.map((binding) => ({
            binding,
            bytes: 32,
            encoding: "hex",
          })),
        } as never,
      });
    },
    ownerRef: `runtime_input_${seeded.capsule.id}`,
  };
}

test("provider instance storage is canonical while runtime identity stays opaque", async () => {
  const defaultBinding = { moduleLocalName: "takoform" } as const;
  const edgeBinding = { moduleLocalName: "takoform", rootAlias: "edge" } as const;
  const delimiterInModule = {
    moduleLocalName: "tako\u0000form",
    rootAlias: "edge",
  } as const;
  const delimiterInAlias = {
    moduleLocalName: "tako",
    rootAlias: "form\u0000edge",
  } as const;
  const defaultIdentity = runtimeInputProviderInstance(defaultBinding);
  const emptyAliasIdentity = runtimeInputProviderInstance({
    ...defaultBinding,
    rootAlias: "",
  });
  const edgeIdentity = runtimeInputProviderInstance(edgeBinding);
  const delimiterModuleIdentity = runtimeInputProviderInstance(delimiterInModule);
  const delimiterAliasIdentity = runtimeInputProviderInstance(delimiterInAlias);

  expect(defaultIdentity).toContain("\u0000");
  expect(emptyAliasIdentity).toBe(defaultIdentity);
  expect(edgeIdentity).not.toBe(defaultIdentity);
  // The old separator encoding made these two tuples collide.
  expect(delimiterModuleIdentity).toBe(delimiterAliasIdentity);

  for (const [binding, identity, tuple] of [
    [defaultBinding, defaultIdentity, ["takoform", ""]],
    [edgeBinding, edgeIdentity, ["takoform", "edge"]],
    [delimiterInModule, delimiterModuleIdentity, ["tako\u0000form", "edge"]],
    [delimiterInAlias, delimiterAliasIdentity, ["tako", "form\u0000edge"]],
  ] as const) {
    const descriptor = runtimeInputProviderInstanceForStorage(binding);
    expect(descriptor).not.toContain("\u0000");
    expect(JSON.parse(descriptor)).toEqual(tuple);
    expect(runtimeInputProviderInstanceFromStorage(descriptor)).toBe(identity);
  }
  expect(runtimeInputProviderInstanceForStorage(defaultBinding)).toBe(
    JSON.stringify(["takoform", ""]),
  );
  expect(
    runtimeInputProviderInstanceForStorage(delimiterInModule),
  ).not.toBe(runtimeInputProviderInstanceForStorage(delimiterInAlias));

  const { materializer, request } = await fixture();
  const legacyRequest = { ...request, providerInstance: defaultIdentity };
  const storedRequest = {
    ...request,
    providerInstance: runtimeInputProviderInstanceFromStorage(
      runtimeInputProviderInstanceForStorage(defaultBinding),
    ),
  };
  const legacyNonce = await materializer.nonce(legacyRequest);
  expect(await materializer.nonce(storedRequest)).toBe(legacyNonce);
  expect(
    (await materializer.materialize({ ...legacyRequest, phase: "apply" })).nonce,
  ).toBe(legacyNonce);
});

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

test("a drifted runtime binding profile re-seals the material and keeps its values", async () => {
  const { store, seeded, materializer, request } = await fixture();
  const before = await materializer.materialize({ ...request, phase: "apply" });
  const sealedBeforeDrift = await store.getSecretBlob(
    `runtime_input_${request.capsuleId}`,
  );

  // A Capsule upgrade that adds a `secret.generated` binding changes the
  // deliverable name set. The old sealed generation cannot answer it, so a new
  // one is sealed — carrying every value the old one held. A hard fence here
  // would leave the Capsule unable to plan, and minting over the old values
  // would silently rotate keys its workload already encrypted data under.
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
  const beforeValues = before.toRunnerDispatch().values;
  const afterValues = after.toRunnerDispatch().values;
  expect(afterValues.ENCRYPTION_KEY).toBe(beforeValues.ENCRYPTION_KEY!);
  expect(afterValues.SIGNING_KEY).toBe(beforeValues.SIGNING_KEY!);
  expect(afterValues.SESSION_KEY).toMatch(/^[0-9a-f]{64}$/u);
  expect(Object.values(beforeValues)).not.toContain(afterValues.SESSION_KEY);
  // Replacement semantics: new generation, new nonce.
  expect(after.nonce).not.toBe(before.nonce);
  expect(after.profileDigest).not.toBe(before.profileDigest);
  const sealedAfterDrift = await store.getSecretBlob(
    `runtime_input_${request.capsuleId}`,
  );
  expect(sealedAfterDrift?.ciphertext).not.toBe(sealedBeforeDrift?.ciphertext);
  expect(sealedAfterDrift?.aad).not.toBe(sealedBeforeDrift?.aad);
  // The row keeps its lineage: same id and creation time, a rotation stamp.
  expect(sealedAfterDrift?.id).toBe(sealedBeforeDrift?.id);
  expect(sealedAfterDrift?.createdAt).toBe(sealedBeforeDrift?.createdAt);
  expect(sealedAfterDrift?.rotatedAt).toBe("2026-09-01T12:00:00.000Z");
  for (const value of Object.values(afterValues)) {
    expect(JSON.stringify(sealedAfterDrift)).not.toContain(value);
  }
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

// -- Carrying a sealed generation across a profile change ---------------------

/** Placeholder crypto that counts opens and can fail its next seal. */
class CountingCrypto implements SecretBoundaryCrypto {
  readonly #inner: SecretBoundaryCrypto;
  opens = 0;
  failNextSeal = false;

  constructor(inner: SecretBoundaryCrypto = new PlaceholderSecretBoundaryCrypto()) {
    this.#inner = inner;
  }

  seal(plaintext: string, partition: string, aad?: Uint8Array) {
    if (this.failNextSeal) {
      this.failNextSeal = false;
      return Promise.reject(new Error("injected seal failure"));
    }
    return this.#inner.seal(plaintext, partition, aad);
  }

  open(ciphertext: Uint8Array, partition: string, aad?: Uint8Array) {
    this.opens += 1;
    return this.#inner.open(ciphertext, partition, aad);
  }

  keyVersion(partition: string): number {
    return this.#inner.keyVersion?.(partition) ?? 1;
  }
}

/** A store whose next compare-and-replace fails before or after it commits. */
class InterruptedReplaceStore extends InMemoryOpenTofuControlStore {
  interruptNextReplace: "before-commit" | "after-commit" | undefined;

  override async replaceSecretBlobIfCurrent(
    expected: StoredSecretBlob,
    replacement: StoredSecretBlob,
  ): Promise<boolean> {
    const interruption = this.interruptNextReplace;
    this.interruptNextReplace = undefined;
    if (interruption === "before-commit") {
      throw new Error("injected store failure before the replace committed");
    }
    const committed = await super.replaceSecretBlobIfCurrent(
      expected,
      replacement,
    );
    if (interruption === "after-commit") {
      throw new Error("injected lost acknowledgement after the replace committed");
    }
    return committed;
  }
}

async function appliedValues(
  materializer: Awaited<ReturnType<typeof fixture>>["materializer"],
  request: Awaited<ReturnType<typeof fixture>>["request"],
): Promise<Readonly<Record<string, string>>> {
  return (await materializer.materialize({ ...request, phase: "apply" }))
    .toRunnerDispatch().values;
}

test("adding a generated secret keeps every existing value and mints only the new one", async () => {
  const { materializer, request, declare } = await fixture();
  const before = await appliedValues(materializer, request);

  await declare(["ENCRYPTION_KEY", "SIGNING_KEY", "WEB_PUSH_KEY"]);
  // Plan reaches the re-seal first. The nonce it bakes must be the one Apply
  // sees, so the carried generation is sealed exactly once.
  const planned = await materializer.nonce(request);
  const applied = await materializer.materialize({ ...request, phase: "apply" });
  expect(applied.nonce).toBe(planned);
  const after = applied.toRunnerDispatch().values;
  expect(after.ENCRYPTION_KEY).toBe(before.ENCRYPTION_KEY!);
  expect(after.SIGNING_KEY).toBe(before.SIGNING_KEY!);
  expect(after.WEB_PUSH_KEY).toMatch(/^[0-9a-f]{64}$/u);
  expect(Object.values(before)).not.toContain(after.WEB_PUSH_KEY);
});

test("removing a generated secret keeps the rest and really drops the removed one", async () => {
  const { materializer, request, declare } = await fixture();
  const before = await appliedValues(materializer, request);

  await declare(["ENCRYPTION_KEY"]);
  const removed = await appliedValues(materializer, request);
  expect(removed).toEqual({ ENCRYPTION_KEY: before.ENCRYPTION_KEY! });

  // The dropped value is gone from the sealed document: declaring the binding
  // again mints a fresh one rather than resurrecting it.
  await declare(["ENCRYPTION_KEY", "SIGNING_KEY"]);
  const readded = await appliedValues(materializer, request);
  expect(readded.ENCRYPTION_KEY).toBe(before.ENCRYPTION_KEY!);
  expect(readded.SIGNING_KEY).toMatch(/^[0-9a-f]{64}$/u);
  expect(readded.SIGNING_KEY).not.toBe(before.SIGNING_KEY!);
});

test("a profile contract change re-seals without moving any value", async () => {
  // A repository re-sync recompiles an old v1 profile as v2. The deliverable
  // names are identical, only the profile digest (and so the AAD) moves.
  const { store, materializer, request, declare, ownerRef } = await fixture();
  const before = await appliedValues(materializer, request);
  const sealedBefore = await store.getSecretBlob(ownerRef);

  await declare(
    ["ENCRYPTION_KEY", "SIGNING_KEY"],
    "takosumi.runtime-binding-profile/v2",
  );
  expect(await appliedValues(materializer, request)).toEqual(before);
  expect((await store.getSecretBlob(ownerRef))?.aad).not.toBe(
    sealedBefore?.aad,
  );
});

test("reshaping one generated secret mints only that binding", () => {
  // The declaration grammar admits only 32-byte hex today, so a reshape cannot
  // reach the materializer yet; the carry rule is pinned here directly so the
  // day a second shape is admitted, only the reshaped binding moves.
  const previous = new Map([
    ["KEEP_KEY", { value: "a".repeat(64), bytes: 32, encoding: "hex" }],
    ["RESHAPED_KEY", { value: "b".repeat(64), bytes: 32, encoding: "hex" }],
    ["REMOVED_KEY", { value: "c".repeat(64), bytes: 32, encoding: "hex" }],
  ]);
  const carried = carryGeneratedSecretValues({
    previous,
    generatedSecrets: [
      { binding: "KEEP_KEY", bytes: 32, encoding: "hex" },
      { binding: "RESHAPED_KEY", bytes: 64 as 32, encoding: "hex" },
      { binding: "NEW_KEY", bytes: 32, encoding: "hex" },
    ],
  });
  expect(carried.carried).toEqual(["KEEP_KEY"]);
  expect(carried.minted).toEqual(["NEW_KEY", "RESHAPED_KEY"]);
  expect(carried.dropped).toEqual(["REMOVED_KEY"]);
  expect(Object.keys(carried.values).sort()).toEqual([
    "KEEP_KEY",
    "NEW_KEY",
    "RESHAPED_KEY",
  ]);
  expect(carried.values.KEEP_KEY).toBe("a".repeat(64));
  expect(carried.values.RESHAPED_KEY).toMatch(/^[0-9a-f]{128}$/u);
  expect(carried.values.NEW_KEY).toMatch(/^[0-9a-f]{64}$/u);
});

test("a failure between sealing and storing leaves the previous generation intact", async () => {
  const store = new InterruptedReplaceStore();
  const crypto = new CountingCrypto();
  const { materializer, request, declare, ownerRef } = await fixture({
    store,
    crypto,
  });
  const before = await appliedValues(materializer, request);
  const sealedBefore = await store.getSecretBlob(ownerRef);
  await declare(["ENCRYPTION_KEY", "SIGNING_KEY", "SESSION_KEY"]);

  // The new generation fails to seal: nothing was written.
  crypto.failNextSeal = true;
  await expect(materializer.nonce(request)).rejects.toThrow(
    "injected seal failure",
  );
  expect(await store.getSecretBlob(ownerRef)).toEqual(sealedBefore);

  // The store fails before the replace commits: the old row is still there.
  store.interruptNextReplace = "before-commit";
  await expect(materializer.nonce(request)).rejects.toThrow(
    "before the replace committed",
  );
  expect(await store.getSecretBlob(ownerRef)).toEqual(sealedBefore);

  // The replace commits but its acknowledgement is lost. The next call finds
  // the committed generation under the current AAD and uses it as is.
  store.interruptNextReplace = "after-commit";
  await expect(materializer.nonce(request)).rejects.toThrow(
    "lost acknowledgement",
  );
  const committed = await store.getSecretBlob(ownerRef);
  expect(committed?.aad).not.toBe(sealedBefore?.aad);
  const nonce = await materializer.nonce(request);
  expect(await store.getSecretBlob(ownerRef)).toEqual(committed);

  const after = await materializer.materialize({ ...request, phase: "apply" });
  expect(after.nonce).toBe(nonce);
  expect(after.toRunnerDispatch().values.ENCRYPTION_KEY).toBe(
    before.ENCRYPTION_KEY!,
  );
  expect(after.toRunnerDispatch().values.SIGNING_KEY).toBe(before.SIGNING_KEY!);
});

test("concurrent re-seals agree on one generation instead of overwriting each other", async () => {
  const replaces: boolean[] = [];
  // Holds the next two reads until both have arrived, so both re-seals start
  // from the same previous row instead of running one after the other.
  let barrier: { arrived: number; release: () => void; ready: Promise<void> } | undefined;
  const recording = new (class extends InMemoryOpenTofuControlStore {
    override async getSecretBlob(
      connectionId: string,
    ): Promise<StoredSecretBlob | undefined> {
      const read = await super.getSecretBlob(connectionId);
      const gate = barrier;
      if (gate && gate.arrived < 2) {
        gate.arrived += 1;
        if (gate.arrived === 2) gate.release();
        await gate.ready;
      }
      return read;
    }

    override async replaceSecretBlobIfCurrent(
      expected: StoredSecretBlob,
      replacement: StoredSecretBlob,
    ): Promise<boolean> {
      const committed = await super.replaceSecretBlobIfCurrent(
        expected,
        replacement,
      );
      replaces.push(committed);
      return committed;
    }
  })();
  const { store, materializer, request, declare, ownerRef } = await fixture({
    store: recording,
  });
  const before = await appliedValues(materializer, request);
  await declare(["ENCRYPTION_KEY", "SIGNING_KEY", "SESSION_KEY"]);

  // Both read the same previous generation and seal their own successor; only
  // one compare-and-replace can win, and the loser adopts the winner's row.
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  barrier = { arrived: 0, release, ready };
  const [left, right] = await Promise.all([
    materializer.nonce(request),
    materializer.nonce(request),
  ]);
  expect(right).toBe(left);
  barrier = undefined;
  expect(replaces).toEqual([true, false]);
  const stored = await store.getSecretBlob(ownerRef);
  const after = await materializer.materialize({ ...request, phase: "apply" });
  expect(after.nonce).toBe(left);
  expect(await store.getSecretBlob(ownerRef)).toEqual(stored);
  expect(after.toRunnerDispatch().values.ENCRYPTION_KEY).toBe(
    before.ENCRYPTION_KEY!,
  );
});

test("an owner mismatch still refuses before the previous generation is opened", async () => {
  const crypto = new CountingCrypto();
  const { store, materializer, request, declare, ownerRef } = await fixture({
    crypto,
  });
  await appliedValues(materializer, request);
  const sealed = await store.getSecretBlob(ownerRef);
  if (!sealed) throw new Error("fixture sealed blob is missing");
  await declare(["ENCRYPTION_KEY", "SIGNING_KEY", "SESSION_KEY"]);
  const opensBefore = crypto.opens;

  // A row recorded under another Workspace fails the existing owner fence.
  const foreignRow = { ...sealed, workspaceId: "ws_someone_else" };
  await store.putSecretBlob(foreignRow);
  await expect(materializer.nonce(request)).rejects.toThrow(
    "runtime input owner fence changed",
  );
  expect(await store.getSecretBlob(ownerRef)).toEqual(foreignRow);

  // A row whose authenticated data names another Capsule is not carried, even
  // though the row's own owner columns match.
  const foreignAad = {
    ...sealed,
    aad: sealed.aad.replace(request.capsuleId, "cap_someone_else"),
  };
  expect(foreignAad.aad).not.toBe(sealed.aad);
  await store.putSecretBlob(foreignAad);
  const refusal = await materializer.nonce(request).catch((error) => error);
  expect(refusal).toBeInstanceOf(RuntimeInputPreviousGenerationError);
  expect(String(refusal)).toContain("does not name this Capsule");
  expect(await store.getSecretBlob(ownerRef)).toEqual(foreignAad);

  expect(crypto.opens).toBe(opensBefore);
});

test("an unreadable previous generation fences Plan and Apply but never retirement", async () => {
  const { store, seeded, materializer, authority, request, declare, ownerRef } =
    await fixture();
  const before = await appliedValues(materializer, request);
  const sealed = await store.getSecretBlob(ownerRef);
  if (!sealed) throw new Error("fixture sealed blob is missing");
  const corrupt = { ...sealed, ciphertext: btoa("damaged sealed material") };
  await store.putSecretBlob(corrupt);
  await declare(["ENCRYPTION_KEY", "SIGNING_KEY", "SESSION_KEY"]);

  for (const attempt of [
    () => materializer.nonce(request),
    () => materializer.materialize({ ...request, phase: "apply" }),
  ]) {
    const refusal = await attempt().catch((error) => error);
    expect(refusal).toBeInstanceOf(RuntimeInputPreviousGenerationError);
    expect(refusal.message).toContain(seeded.capsule.id);
    expect(refusal.message).toContain("could not be opened");
    expect(refusal.message).toContain("the active key version");
    expect(refusal.message).toContain("not re-minted");
    for (const value of Object.values(before)) {
      expect(refusal.message).not.toContain(value);
    }
    // Refused, not replaced: the damaged row is still the stored one.
    expect(await store.getSecretBlob(ownerRef)).toEqual(corrupt);
  }

  // Teardown never opens the material, so the destroyed Capsule still retires.
  await store.putCapsule({ ...seeded.capsule, status: "destroyed" });
  await materializer.retire(authority);
  expect(await store.getSecretBlob(ownerRef)).toBeUndefined();
});

test("a previous generation sealed under another key says so", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const sealing = await fixture({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "runtime-input-previous-key-0123456789abcdef",
    }),
  });
  await appliedValues(sealing.materializer, sealing.request);
  const sealed = await store.getSecretBlob(sealing.ownerRef);
  await sealing.declare(["ENCRYPTION_KEY", "SIGNING_KEY", "SESSION_KEY"]);

  const rotated = createRuntimeInputMaterializer({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "runtime-input-replaced-key-0123456789abcdef",
    }),
  });
  const refusal = await rotated.nonce(sealing.request).catch((error) => error);
  expect(refusal).toBeInstanceOf(RuntimeInputPreviousGenerationError);
  expect(refusal.message).toContain("a different key version");
  expect(refusal.cause).toBeDefined();
  expect(await store.getSecretBlob(sealing.ownerRef)).toEqual(sealed);
});

test("a previous generation whose document is not ours is refused without echoing it", async () => {
  const crypto = new PlaceholderSecretBoundaryCrypto();
  const { store, materializer, request, declare, ownerRef } = await fixture({
    crypto,
  });
  await appliedValues(materializer, request);
  const sealed = await store.getSecretBlob(ownerRef);
  if (!sealed) throw new Error("fixture sealed blob is missing");
  const partition = `runtime-input:${request.capsuleId}`;
  const reseal = async (document: string): Promise<StoredSecretBlob> => {
    const bytes = await crypto.seal(
      document,
      partition,
      new TextEncoder().encode(sealed.aad),
    );
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { ...sealed, ciphertext: btoa(binary) };
  };
  await declare(["ENCRYPTION_KEY", "SIGNING_KEY", "SESSION_KEY"]);

  for (const [document, problem] of [
    ['{"ENCRYPTION_KEY":"not-a-hex-secret-value"', "not a binding map"],
    ['["ENCRYPTION_KEY"]', "not a binding map"],
    ['{"ENCRYPTION_KEY":"not-a-hex-secret-value"}', "not a 32-byte hex secret"],
    ['{"lower_case":"' + "a".repeat(64) + '"}', "invalid binding name"],
  ] as const) {
    const planted = await reseal(document);
    await store.putSecretBlob(planted);
    const refusal = await materializer.nonce(request).catch((error) => error);
    expect(refusal).toBeInstanceOf(RuntimeInputPreviousGenerationError);
    expect(refusal.message).toContain(problem);
    expect(refusal.message).not.toContain("not-a-hex-secret-value");
    expect(refusal.message).not.toContain("lower_case");
    expect(await store.getSecretBlob(ownerRef)).toEqual(planted);
  }
});
