import { expect, test } from "bun:test";
import type { FormRef, InstalledFormReference } from "takosumi-contract";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  FormRegistryService,
  InMemoryFormRegistryStore,
  type FormPackageArtifactReader,
  type FormPackageVerifier,
} from "../../../../core/domains/service-forms/mod.ts";
import {
  ResourceFormPinOperations,
  createInMemoryResourceShapeStores,
  formatResourceShapeId,
  type ResolutionLockRecord,
  type ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/mod.ts";
import type { SpaceId } from "../../../../core/shared/ids.ts";

const NOW = "2026-07-16T12:00:00.000Z";
const SPACE = "ws_form_pin" as SpaceId;
const FORM_REF: FormRef = {
  apiVersion: "forms.takoform.com/v1alpha1",
  kind: "ObjectBucket",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};
const IDENTITY: InstalledFormReference = {
  formRef: FORM_REF,
  packageDigest: `sha256:${"b".repeat(64)}`,
};

class Reader implements FormPackageArtifactReader {
  async read(artifactRef: string): Promise<Uint8Array> {
    return new TextEncoder().encode(artifactRef);
  }
}

class Verifier implements FormPackageVerifier {
  readonly id = "test.data-only.v1";
  async verify(_bytes: Uint8Array, expectedPackageDigest: string) {
    return {
      packageDigest: expectedPackageDigest,
      definitions: [
        {
          formRef: FORM_REF,
          operations: ["create", "read", "delete"] as const,
        },
      ],
    };
  }
}

async function fixture() {
  const stores = createInMemoryResourceShapeStores();
  const formStore = new InMemoryFormRegistryStore();
  const forms = new FormRegistryService({
    store: formStore,
    artifactReader: new Reader(),
    verifier: new Verifier(),
    now: () => NOW,
  });
  await forms.installPackage({
    artifactRef: "memory:object-bucket-v1",
    expectedPackageDigest: IDENTITY.packageDigest,
    actorId: "acct_operator",
  });
  const activation = await forms.createActivation({
    id: "activation_object_bucket",
    identity: IDENTITY,
    scope: { type: "workspace", id: SPACE },
    actorId: "acct_operator",
  });
  await forms.updateActivation({
    id: activation.id,
    expectedRevision: activation.revision,
    status: "active",
    actorId: "acct_operator",
  });
  const activityStore = new InMemoryOpenTofuControlStore();
  const activity = new ActivityService({
    store: activityStore,
    now: () => new Date(NOW),
  });
  const operations = new ResourceFormPinOperations({
    stores,
    forms,
    activity,
    now: () => NOW,
  });
  return { stores, forms, activityStore, operations };
}

function legacyPair(name: string): {
  readonly resource: ResourceShapeRecord;
  readonly lock: ResolutionLockRecord;
} {
  const id = formatResourceShapeId(SPACE, "ObjectBucket", name);
  return {
    resource: {
      id,
      spaceId: SPACE,
      kind: "ObjectBucket",
      name,
      managedBy: "opentofu",
      spec: { marker: `DO-NOT-LEAK-${name}` },
      phase: "Ready",
      generation: 1,
      observedGeneration: 1,
      outputs: { marker: `DO-NOT-LEAK-OUTPUT-${name}` },
      createdAt: NOW,
      updatedAt: NOW,
    },
    lock: {
      resourceId: id,
      selectedImplementation: "object_store",
      target: "target_1",
      locked: true,
      reason: ["legacy"],
      lockedAt: NOW,
      updatedAt: NOW,
    },
  };
}

async function seedPair(
  stores: ReturnType<typeof createInMemoryResourceShapeStores>,
  pair: ReturnType<typeof legacyPair>,
) {
  await stores.resources.upsert(pair.resource);
  await stores.locks.put(pair.lock);
}

test("operator backfill is bounded, dry-run safe, cursorable, and audited without values", async () => {
  const { stores, operations, activityStore } = await fixture();
  const first = legacyPair("a");
  const second = legacyPair("b");
  await seedPair(stores, first);
  await seedPair(stores, second);

  const dry = await operations.backfill({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "ObjectBucket",
    activationIds: ["activation_object_bucket"],
    actorId: "acct_operator",
    dryRun: true,
    limit: 1,
  });
  expect(dry).toMatchObject({
    dryRun: true,
    scanned: 1,
    wouldPin: 1,
    pinned: 0,
    refused: 0,
  });
  expect(dry.nextCursor).toBeDefined();
  expect((await stores.resources.get(first.resource.id))?.form).toBeUndefined();

  const applied = await operations.backfill({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "ObjectBucket",
    activationIds: ["activation_object_bucket"],
    actorId: "acct_operator",
    limit: 1,
  });
  expect(applied.pinned).toBe(1);
  expect((await stores.resources.get(first.resource.id))?.form).toEqual(
    IDENTITY,
  );
  expect((await stores.locks.get(first.resource.id))?.form).toEqual(IDENTITY);

  const next = await operations.backfill({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "ObjectBucket",
    activationIds: ["activation_object_bucket"],
    actorId: "acct_operator",
    cursor: dry.nextCursor,
    limit: 1,
  });
  expect(next.pinned).toBe(1);
  expect((await stores.resources.get(second.resource.id))?.form).toEqual(
    IDENTITY,
  );

  const events = await activityStore.listActivityEvents(SPACE);
  expect(
    events.filter((event) => event.action === "resource.form_pin.backfilled"),
  ).toHaveLength(2);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain("DO-NOT-LEAK");
  expect(serialized).not.toContain("DO-NOT-LEAK-OUTPUT");
});

test("backfill refuses missing, ambiguous, and revoked activation authority", async () => {
  const { stores, forms, operations } = await fixture();
  const pair = legacyPair("refused");
  await seedPair(stores, pair);

  const missing = await operations.backfill({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "ObjectBucket",
    activationIds: ["activation_missing"],
    actorId: "acct_operator",
  });
  expect(missing.evidence[0]).toMatchObject({
    outcome: "refused",
    reason: "activation_missing",
  });

  const partialCandidateSet = await operations.backfill({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "ObjectBucket",
    activationIds: ["activation_object_bucket", "activation_missing"],
    actorId: "acct_operator",
  });
  expect(partialCandidateSet.evidence[0]).toMatchObject({
    outcome: "refused",
    reason: "activation_missing",
  });

  const duplicate = await forms.createActivation({
    id: "activation_object_bucket_2",
    identity: IDENTITY,
    scope: { type: "space", id: SPACE },
    status: "active",
    actorId: "acct_operator",
  });
  expect(duplicate.status).toBe("active");
  const ambiguous = await operations.backfill({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "ObjectBucket",
    activationIds: ["activation_object_bucket", "activation_object_bucket_2"],
    actorId: "acct_operator",
  });
  expect(ambiguous.evidence[0]).toMatchObject({
    outcome: "refused",
    reason: "activation_ambiguous",
  });

  await forms.setPackageStatus(IDENTITY.packageDigest, "revoked");
  const revoked = await operations.backfill({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "ObjectBucket",
    activationIds: ["activation_object_bucket"],
    actorId: "acct_operator",
  });
  expect(revoked.evidence[0]).toMatchObject({
    outcome: "refused",
    reason: "package_revoked",
  });
  expect((await stores.resources.get(pair.resource.id))?.form).toBeUndefined();
});

test("backup replay re-verifies retained bytes and restores the exact pair without resolution", async () => {
  const { stores, forms, operations, activityStore } = await fixture();
  const pair = legacyPair("restore");
  await seedPair(stores, pair);
  await forms.setPackageStatus(IDENTITY.packageDigest, "revoked");

  const request = {
    workspaceId: SPACE,
    spaceId: SPACE,
    actorId: "acct_operator",
    entries: [
      {
        resourceId: pair.resource.id,
        resourceScopeId: SPACE,
        kind: "ObjectBucket",
        identity: IDENTITY,
      },
    ],
  } as const;
  const restored = await operations.restore(request);
  expect(restored).toMatchObject({ pinned: 1, refused: 0 });
  expect((await stores.resources.get(pair.resource.id))?.form).toEqual(
    IDENTITY,
  );
  expect((await stores.locks.get(pair.resource.id))?.form).toEqual(IDENTITY);

  const replayed = await operations.restore(request);
  expect(replayed).toMatchObject({ alreadyPinned: 1, pinned: 0, refused: 0 });

  const otherSpace = "ws_form_pin_other" as SpaceId;
  const foreign = legacyPair("foreign");
  const foreignId = formatResourceShapeId(
    otherSpace,
    "ObjectBucket",
    "foreign",
  );
  await seedPair(stores, {
    resource: { ...foreign.resource, id: foreignId, spaceId: otherSpace },
    lock: { ...foreign.lock, resourceId: foreignId },
  });
  const crossSpace = await operations.restore({
    ...request,
    entries: [
      {
        resourceId: foreignId,
        resourceScopeId: SPACE,
        kind: "ObjectBucket",
        identity: IDENTITY,
      },
    ],
  });
  expect(crossSpace.evidence[0]).toMatchObject({
    outcome: "refused",
    reason: "backup_scope_mismatch",
  });
  expect((await stores.resources.get(foreignId))?.form).toBeUndefined();

  const events = await activityStore.listActivityEvents(SPACE);
  expect(
    events.filter((event) => event.action === "resource.form_pin.restored"),
  ).toHaveLength(1);
});
