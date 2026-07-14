import { expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { StateVersion } from "takosumi-contract/state-versions";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createInMemoryResourceShapeStores,
  LegacyResourceStateAdoptionError,
  LegacyResourceStateAdoptionService,
  legacyBackingCapsuleName,
  type ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/mod.ts";

const WORKSPACE_ID = "space_1";
const RESOURCE_ID = "tkrn:space_1:ObjectBucket:assets";
const RESOURCE_UPDATED_AT = "2026-07-13T00:00:00.000Z";
const CONFIRMED_AT = "2026-07-13T01:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

function resource(): ResourceShapeRecord {
  return {
    id: RESOURCE_ID,
    spaceId: WORKSPACE_ID,
    kind: "ObjectBucket",
    name: "assets",
    managedBy: "opentofu",
    spec: { name: "assets" },
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    createdAt: RESOURCE_UPDATED_AT,
    updatedAt: RESOURCE_UPDATED_AT,
  };
}

function capsule(resourceRecord: ResourceShapeRecord): Capsule {
  return {
    id: "cap_legacy_resource_assets",
    workspaceId: WORKSPACE_ID,
    projectId: "prj_default_space_1",
    name: legacyBackingCapsuleName(resourceRecord),
    slug: legacyBackingCapsuleName(resourceRecord),
    sourceId: "src_retired_internal",
    installConfigId: "cfg-internal-resource-shape-backing-capsule",
    environment: "resource-shape",
    currentStateVersionId: "state_legacy_7",
    currentStateGeneration: 7,
    status: "active",
    createdAt: RESOURCE_UPDATED_AT,
    updatedAt: RESOURCE_UPDATED_AT,
  };
}

function stateVersion(capsuleId: string): StateVersion {
  return {
    id: "state_legacy_7",
    workspaceId: WORKSPACE_ID,
    capsuleId,
    environment: "resource-shape",
    generation: 7,
    stateRef: `spaces/${WORKSPACE_ID}/installations/${capsuleId}/envs/resource-shape/states/00000007.tfstate.enc`,
    digest: DIGEST,
    createdByRunId: "run_legacy_apply",
    createdAt: RESOURCE_UPDATED_AT,
  };
}

async function fixture() {
  const stores = createInMemoryResourceShapeStores();
  const opentofu = new InMemoryOpenTofuControlStore();
  const resourceRecord = resource();
  const legacyCapsule = capsule(resourceRecord);
  await stores.resources.upsert(resourceRecord);
  await opentofu.putCapsule(legacyCapsule);
  await opentofu.putStateVersion(stateVersion(legacyCapsule.id));
  return {
    stores,
    opentofu,
    migration: new LegacyResourceStateAdoptionService(
      stores,
      opentofu,
      () => CONFIRMED_AT,
    ),
  };
}

test("candidate report is read-only and requires the exact retired Capsule and StateVersion identity", async () => {
  const { stores, migration } = await fixture();

  const report = await migration.report(WORKSPACE_ID);

  expect(report.issues).toEqual([]);
  expect(report.candidates).toHaveLength(1);
  expect(report.candidates[0]).toEqual({
    resourceId: RESOURCE_ID,
    resourceUpdatedAt: RESOURCE_UPDATED_AT,
    expectedLegacyCapsuleName: legacyBackingCapsuleName(resource()),
    capsuleId: "cap_legacy_resource_assets",
    stateVersionId: "state_legacy_7",
    stateGeneration: 7,
    stateRef:
      "spaces/space_1/installations/cap_legacy_resource_assets/envs/resource-shape/states/00000007.tfstate.enc",
    stateDigest: DIGEST,
  });
  expect(
    (await stores.resources.get(RESOURCE_ID))?.stateAdoption,
  ).toBeUndefined();
});

test("operator confirmation persists only the unchanged reviewed candidate", async () => {
  const { stores, migration } = await fixture();
  const candidate = (await migration.report(WORKSPACE_ID)).candidates[0]!;

  await expect(
    migration.confirm({
      ...candidate,
      stateDigest: `sha256:${"b".repeat(64)}`,
      confirmedBy: "operator_1",
    }),
  ).rejects.toMatchObject<Partial<LegacyResourceStateAdoptionError>>({
    code: "candidate_changed",
  });

  const descriptor = await migration.confirm({
    ...candidate,
    confirmedBy: "operator_1",
  });
  expect(descriptor).toEqual({
    kind: "legacy_backing_capsule_state",
    sourceWorkspaceId: WORKSPACE_ID,
    sourceCapsuleId: candidate.capsuleId,
    sourceEnvironment: "resource-shape",
    sourceStateVersionId: candidate.stateVersionId,
    stateGeneration: 7,
    stateRef: candidate.stateRef,
    stateDigest: DIGEST,
    confirmedBy: "operator_1",
    confirmedAt: CONFIRMED_AT,
  });
  expect((await stores.resources.get(RESOURCE_ID))?.stateAdoption).toEqual(
    descriptor,
  );
  expect((await migration.report(WORKSPACE_ID)).issues[0]?.reason).toBe(
    "adoption_already_pending",
  );
});

test("confirmation rejects a Resource that already owns canonical execution state", async () => {
  const { stores, migration } = await fixture();
  const candidate = (await migration.report(WORKSPACE_ID)).candidates[0]!;
  const current = (await stores.resources.get(RESOURCE_ID))!;
  await stores.resources.upsert({
    ...current,
    execution: {
      runId: "run_resource_apply",
      stateGeneration: 8,
      stateRef:
        "workspaces/space_1/resources/tkrn_space_1_ObjectBucket_assets/environments/default/state-versions/00000008.tfstate.enc",
      stateDigest: DIGEST,
      updatedAt: CONFIRMED_AT,
    },
    updatedAt: CONFIRMED_AT,
  });

  await expect(
    migration.confirm({ ...candidate, confirmedBy: "operator_1" }),
  ).rejects.toMatchObject<Partial<LegacyResourceStateAdoptionError>>({
    code: "resource_state_already_owned",
  });
});

test("ambiguous deterministic Capsule matches are reported and never auto-selected", async () => {
  class AmbiguousOpenTofuStore extends InMemoryOpenTofuControlStore {
    extra!: Capsule;

    override async listCapsules(
      workspaceId?: string,
    ): Promise<readonly Capsule[]> {
      return [...(await super.listCapsules(workspaceId)), this.extra];
    }
  }
  const stores = createInMemoryResourceShapeStores();
  const opentofu = new AmbiguousOpenTofuStore();
  const resourceRecord = resource();
  await stores.resources.upsert(resourceRecord);
  await opentofu.putCapsule(capsule(resourceRecord));
  const duplicate = {
    ...capsule(resourceRecord),
    id: "cap_legacy_resource_assets_duplicate",
    currentStateVersionId: "state_legacy_duplicate",
  };
  opentofu.extra = duplicate;
  const migration = new LegacyResourceStateAdoptionService(
    stores,
    opentofu,
    () => CONFIRMED_AT,
  );

  const report = await migration.report(WORKSPACE_ID);
  expect(report.candidates).toEqual([]);
  expect(report.issues[0]).toMatchObject({
    resourceId: RESOURCE_ID,
    reason: "legacy_capsule_ambiguous",
    capsuleIds: [
      "cap_legacy_resource_assets",
      "cap_legacy_resource_assets_duplicate",
    ],
  });
});
