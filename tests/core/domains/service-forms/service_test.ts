import { expect, test } from "bun:test";
import type { FormRef } from "takosumi-contract";
import {
  FormRegistryError,
  FormRegistryService,
  InMemoryFormRegistryStore,
  type FormPackageArtifactReader,
  type FormPackageVerifier,
  type VerifiedFormDefinition,
} from "../../../../core/domains/service-forms/mod.ts";

const packageA = `sha256:${"a".repeat(64)}`;
const packageB = `sha256:${"b".repeat(64)}`;
const schemaDigest = `sha256:${"c".repeat(64)}`;
const now = "2026-07-16T00:00:00.000Z";

const formRef: FormRef = {
  apiVersion: "forms.takoform.com/v1alpha1",
  kind: "EdgeWorker",
  definitionVersion: "1.0.0",
  schemaDigest,
};

const definition: VerifiedFormDefinition = {
  formRef,
  operations: ["create", "read", "update", "delete"],
};

class Reader implements FormPackageArtifactReader {
  async read(artifactRef: string): Promise<Uint8Array> {
    return new TextEncoder().encode(artifactRef);
  }
}

class Verifier implements FormPackageVerifier {
  readonly id = "test.data-only.v1";
  constructor(
    private readonly definitions: readonly VerifiedFormDefinition[],
    private readonly returnedDigest?: string,
  ) {}

  async verify(_bytes: Uint8Array, expectedPackageDigest: string) {
    return {
      packageDigest: this.returnedDigest ?? expectedPackageDigest,
      definitions: this.definitions,
    };
  }
}

function service(
  store: InMemoryFormRegistryStore,
  definitions: readonly VerifiedFormDefinition[] = [definition],
  returnedDigest?: string,
) {
  return new FormRegistryService({
    store,
    artifactReader: new Reader(),
    verifier: new Verifier(definitions, returnedDigest),
    now: () => now,
  });
}

async function install(
  registry: FormRegistryService,
  expectedPackageDigest = packageA,
) {
  return await registry.installPackage({
    artifactRef: `memory:${expectedPackageDigest}`,
    expectedPackageDigest,
    actorId: "acct_operator",
  });
}

test("zero-form Core starts with an empty registry", async () => {
  const store = new InMemoryFormRegistryStore();
  const registry = new FormRegistryService({ store });
  expect((await registry.listPackages()).items).toEqual([]);
  expect((await registry.listDefinitions()).items).toEqual([]);
  expect((await registry.listActivations()).items).toEqual([]);
  await expect(install(registry)).rejects.toMatchObject({
    code: "verification_unavailable",
  });
});

test("package reader and verifier are one fail-closed trust contribution", () => {
  expect(
    () =>
      new FormRegistryService({
        store: new InMemoryFormRegistryStore(),
        artifactReader: new Reader(),
      }),
  ).toThrow("must be configured together");
});

test("verified packages install exact definitions idempotently", async () => {
  const store = new InMemoryFormRegistryStore();
  const registry = service(store);
  const first = await install(registry);
  const second = await install(registry);

  expect(first.packageDigest).toBe(packageA);
  expect(second).toEqual(first);
  expect((await store.listPackages({})).items).toHaveLength(1);
  expect((await store.getDefinition(formRef))?.identity).toEqual({
    formRef,
    packageDigest: packageA,
  });
});

test("the same package digest cannot change verified definition content", async () => {
  const store = new InMemoryFormRegistryStore();
  await install(service(store));
  await expect(
    install(
      service(store, [{ ...definition, operations: ["create", "read"] }]),
    ),
  ).rejects.toMatchObject({ code: "package_conflict" });
});

test("verifier digest mismatch and duplicate FormRefs fail closed", async () => {
  await expect(
    install(service(new InMemoryFormRegistryStore(), [definition], packageB)),
  ).rejects.toMatchObject({ code: "verification_failed" });
  await expect(
    install(service(new InMemoryFormRegistryStore(), [definition, definition])),
  ).rejects.toMatchObject({ code: "verification_failed" });
});

test("one exact FormRef cannot be rebound to another package", async () => {
  const store = new InMemoryFormRegistryStore();
  await install(service(store), packageA);
  await expect(install(service(store), packageB)).rejects.toMatchObject({
    code: "package_conflict",
  });
});

test("activation requires the exact installed identity and uses revision CAS", async () => {
  const store = new InMemoryFormRegistryStore();
  const registry = service(store);
  await install(registry);

  await expect(
    registry.createActivation({
      id: "activation_wrong_package",
      identity: { formRef, packageDigest: packageB },
      scope: { type: "operator" },
      actorId: "acct_operator",
    }),
  ).rejects.toMatchObject({ code: "definition_not_installed" });

  const created = await registry.createActivation({
    id: "activation_edge",
    identity: { formRef, packageDigest: packageA },
    scope: { type: "workspace", id: "ws_1" },
    eligibleTargetPoolClasses: ["edge", "edge"],
    actorId: "acct_operator",
  });
  expect(created.status).toBe("inactive");
  expect(created.revision).toBe(1);
  expect(created.eligibleTargetPoolClasses).toEqual(["edge"]);

  const updated = await registry.updateActivation({
    id: created.id,
    expectedRevision: 1,
    status: "active",
    actorId: "acct_operator",
  });
  expect(updated.status).toBe("active");
  expect(updated.revision).toBe(2);

  await expect(
    registry.updateActivation({
      id: created.id,
      expectedRevision: 1,
      status: "inactive",
      actorId: "acct_operator",
    }),
  ).rejects.toBeInstanceOf(FormRegistryError);
});

test("revoked package cannot activate or return to deprecated", async () => {
  const store = new InMemoryFormRegistryStore();
  const registry = service(store);
  await install(registry);
  await registry.setPackageStatus(packageA, "revoked");

  await expect(
    registry.createActivation({
      id: "activation_revoked",
      identity: { formRef, packageDigest: packageA },
      scope: { type: "operator" },
      actorId: "acct_operator",
    }),
  ).rejects.toMatchObject({ code: "package_unavailable" });
  await expect(
    registry.setPackageStatus(packageA, "deprecated"),
  ).rejects.toMatchObject({ code: "package_unavailable" });
});

test("revoked exact definitions stay retained, verifiable, and undeletable", async () => {
  const store = new InMemoryFormRegistryStore();
  const registry = service(store);
  await install(registry);
  await registry.setPackageStatus(packageA, "revoked");
  const identity = { formRef, packageDigest: packageA };

  expect(await registry.getRetainedIdentity(identity)).toMatchObject({
    definition: { identity },
    package: { packageDigest: packageA, status: "revoked" },
  });
  expect(await registry.verifyRetainedIdentity(identity)).toMatchObject({
    definition: { identity },
    package: { packageDigest: packageA, status: "revoked" },
  });
  await expect(registry.deletePackage(packageA)).rejects.toMatchObject({
    code: "package_retained",
  });
  expect((await store.getDefinition(formRef))?.identity).toEqual(identity);
  expect((await store.getPackage(packageA))?.status).toBe("revoked");
});

test("retained replay fails closed when package bytes cannot be re-verified", async () => {
  const store = new InMemoryFormRegistryStore();
  await install(service(store));
  const registryWithoutVerifier = new FormRegistryService({ store });

  await expect(
    registryWithoutVerifier.verifyRetainedIdentity({
      formRef,
      packageDigest: packageA,
    }),
  ).rejects.toMatchObject({ code: "verification_unavailable" });
});

test("the store atomically prevents a stale status writer from weakening revocation", async () => {
  const store = new InMemoryFormRegistryStore();
  const registry = service(store);
  await install(registry);
  const staleRead = await store.getPackage(packageA);
  expect(staleRead?.status).toBe("installed");
  expect(
    (await store.updatePackageStatus(packageA, "revoked", now)).status,
  ).toBe("updated");
  expect(
    (await store.updatePackageStatus(packageA, "deprecated", now)).status,
  ).toBe("invalid_transition");
  expect((await store.getPackage(packageA))?.status).toBe("revoked");
});

test("an existing activation cannot be enabled after package revocation", async () => {
  const store = new InMemoryFormRegistryStore();
  const registry = service(store);
  await install(registry);
  const activation = await registry.createActivation({
    id: "activation_later_revoked",
    identity: { formRef, packageDigest: packageA },
    scope: { type: "operator" },
    actorId: "acct_operator",
  });
  await registry.setPackageStatus(packageA, "revoked");

  await expect(
    registry.updateActivation({
      id: activation.id,
      expectedRevision: activation.revision,
      status: "active",
      actorId: "acct_operator",
    }),
  ).rejects.toMatchObject({ code: "package_unavailable" });
});
