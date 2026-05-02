// Backup / restore service tests — Deployment-centric port.
//
// These tests cover the resource-side restore semantics that this service
// owns. Group-level rollback delegates to `DeploymentService.rollbackGroup`
// and is exercised in Phase 4 alongside Agent A's `deployment_service.ts`.

import assert from "node:assert/strict";
import {
  InMemoryBindingSetRevisionStore,
  InMemoryMigrationLedgerStore,
  InMemoryResourceBindingStore,
  InMemoryResourceInstanceStore,
  type ResourceInstance,
} from "../../domains/resources/mod.ts";
import { DomainError } from "../../shared/errors.ts";
import {
  BackupRestoreService,
  type BackupRestoreStore,
  InMemoryBackupRestoreStore,
} from "./mod.ts";
import {
  ResourceOperationService,
  type ResourceOperationStores,
} from "../resources/mod.ts";

Deno.test("BackupRestoreService blocks unsupported restore providers", async () => {
  const { service } = await createFixture({
    provider: "unsupported-provider",
  });

  await assert.rejects(
    () =>
      service.planRestore({
        id: "restore_plan_unsupported",
        backupId: "backup_1",
        resourceInstanceIds: ["resource_db"],
        mode: "snapshot",
      }),
    (error) =>
      error instanceof DomainError && error.code === "conflict" &&
      error.message === "Resource provider does not support restore",
  );
});

Deno.test("BackupRestoreService blocks unsupported restore modes", async () => {
  const { service } = await createFixture({
    provider: "postgres-provider",
    providerSupport: [{
      provider: "postgres-provider",
      restoreModes: ["snapshot"],
    }],
  });

  await assert.rejects(
    () =>
      service.planRestore({
        id: "restore_plan_unsupported_mode",
        backupId: "backup_1",
        resourceInstanceIds: ["resource_db"],
        mode: "point-in-time",
      }),
    (error) =>
      error instanceof DomainError && error.code === "conflict" &&
      error.message === "Resource provider does not support restore",
  );
});

Deno.test("BackupRestoreService validates backup metadata against current resource", async () => {
  const { service, backupRestoreStore } = await createFixture({
    provider: "postgres-provider",
    providerSupport: [{
      provider: "postgres-provider",
      restoreModes: ["snapshot"],
    }],
  });

  const backup = await backupRestoreStore.getBackupMetadata("backup_1");
  assert.equal(backup?.resources[0]?.capturedGeneration, 1);
  assert.equal(
    backup?.resources[0]?.providerMaterializationId,
    "materialization-1",
  );

  await assert.rejects(
    () =>
      service.registerBackupMetadata({
        id: "backup_bad_contract",
        spaceId: "space_a",
        groupId: "group_a",
        resources: [{
          resourceInstanceId: "resource_db",
          contract: "mysql.v1",
        }],
      }),
    (error) =>
      error instanceof DomainError && error.code === "conflict" &&
      error.message ===
        "Backup resource contract does not match current resource",
  );
});

Deno.test("BackupRestoreService blocks expired rollback-window backups", async () => {
  const { service } = await createFixture({
    provider: "postgres-provider",
    providerSupport: [{
      provider: "postgres-provider",
      restoreModes: ["snapshot"],
    }],
    backupId: "backup_expired",
    expiresAt: "2026-04-26T00:00:00.000Z",
  });

  await assert.rejects(
    () =>
      service.planRestore({
        id: "restore_plan_expired",
        backupId: "backup_expired",
        resourceInstanceIds: ["resource_db"],
        mode: "snapshot",
      }),
    (error) =>
      error instanceof DomainError && error.code === "conflict" &&
      error.message === "Backup rollback window expired",
  );
});

Deno.test("BackupRestoreService guards provider-native restore safety", async () => {
  const { service, resources } = await createFixture({
    provider: "postgres-provider",
    providerSupport: [{
      provider: "postgres-provider",
      restoreModes: ["provider-native"],
    }],
    backupId: "backup_native",
  });

  const plan = await service.planRestore({
    id: "restore_plan_native",
    backupId: "backup_native",
    resourceInstanceIds: ["resource_db"],
    mode: "provider-native",
  });
  assert.equal(plan.resources[0]?.targetGeneration, 1);
  assert.equal(
    plan.resources[0]?.providerMaterializationId,
    "materialization-1",
  );

  await resources.update({
    ...resource({ provider: "postgres-provider" }),
    lifecycle: {
      status: "ready",
      generation: 2,
      updatedAt: "2026-04-27T00:01:00.000Z",
    },
    updatedAt: "2026-04-27T00:01:00.000Z",
  });
  await assert.rejects(
    () =>
      service.startRestore({
        id: "restore_operation_drifted",
        planId: plan.id,
      }),
    (error) =>
      error instanceof DomainError && error.code === "conflict" &&
      error.message === "Restore target changed after plan",
  );
});

Deno.test("BackupRestoreService rejects provider-native backups without materialization identity", async () => {
  const { service } = await createFixture({
    provider: "postgres-provider",
    providerSupport: [{
      provider: "postgres-provider",
      restoreModes: ["provider-native"],
    }],
    providerMaterializationId: null,
  });

  await assert.rejects(
    () =>
      service.planRestore({
        id: "restore_plan_native_unsafe",
        backupId: "backup_1",
        resourceInstanceIds: ["resource_db"],
        mode: "provider-native",
      }),
    (error) =>
      error instanceof DomainError && error.code === "conflict" &&
      error.message ===
        "Provider-native restore requires backup materialization identity",
  );
});

Deno.test("BackupRestoreService records restore through resource operation semantics", async () => {
  const { service, backupRestoreStore, resourceOperationStores } =
    await createFixture({
      provider: "postgres-provider",
      providerSupport: [{
        provider: "postgres-provider",
        restoreModes: ["snapshot"],
      }],
    });

  const plan = await service.planRestore({
    id: "restore_plan_1",
    backupId: "backup_1",
    resourceInstanceIds: ["resource_db"],
    mode: "snapshot",
    createdBy: "acct_operator",
  });
  const operation = await service.startRestore({
    id: "restore_operation_1",
    planId: plan.id,
  });
  const completed = await service.completeRestore({
    operationId: operation.id,
  });

  assert.equal(plan.kind, "restore-plan");
  assert.equal(Object.hasOwn(plan, "rollbackPlanId"), false);
  assert.equal(operation.kind, "restore");
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.resourceInstanceIds, ["resource_db"]);
  assert.deepEqual(completed.metadata?.resourceRestoreLedgerIds, [
    "resource-restore:restore_operation_1:resource_db",
  ]);
  assert.equal(
    (await resourceOperationStores.migrationLedger.listByResource(
      "resource_db",
    ))[0]?.metadata?.operationKind,
    "restore",
  );
  assert.equal(
    (await resourceOperationStores.instances.get("resource_db"))?.lifecycle
      .generation,
    2,
  );
  assert.equal(
    (await backupRestoreStore.getRestoreOperation("restore_operation_1"))
      ?.status,
    "completed",
  );
});

Deno.test("BackupRestoreService requires resource operation semantics before completing restore", async () => {
  const { service } = await createFixture({
    provider: "postgres-provider",
    providerSupport: [{
      provider: "postgres-provider",
      restoreModes: ["snapshot"],
    }],
    withResourceOperations: false,
  });

  const plan = await service.planRestore({
    id: "restore_plan_without_resource_ops",
    backupId: "backup_1",
    resourceInstanceIds: ["resource_db"],
    mode: "snapshot",
  });
  const operation = await service.startRestore({
    id: "restore_operation_without_resource_ops",
    planId: plan.id,
  });

  await assert.rejects(
    () => service.completeRestore({ operationId: operation.id }),
    (error) =>
      error instanceof DomainError && error.code === "conflict" &&
      error.message ===
        "Restore completion requires resource operation restore semantics",
  );
});

Deno.test("BackupRestoreService rejects group rollback when no deployment service is wired", async () => {
  const { service } = await createFixture({
    provider: "postgres-provider",
    providerSupport: [{
      provider: "postgres-provider",
      restoreModes: ["snapshot"],
    }],
  });

  await assert.rejects(
    () =>
      service.rollbackGroup({
        spaceId: "space_a",
        groupId: "group_a",
      }),
    (error) =>
      error instanceof DomainError && error.code === "conflict" &&
      error.message === "Deployment service is required for group rollback",
  );
});

async function createFixture(options: {
  readonly provider: string;
  readonly providerSupport?: ConstructorParameters<
    typeof BackupRestoreService
  >[0]["providerSupport"];
  readonly backupId?: string;
  readonly expiresAt?: string;
  readonly providerMaterializationId?: string | null;
  readonly withResourceOperations?: boolean;
}): Promise<{
  readonly service: BackupRestoreService;
  readonly backupRestoreStore: BackupRestoreStore;
  readonly resources: InMemoryResourceInstanceStore;
  readonly resourceOperationStores: ResourceOperationStores;
}> {
  const resources = new InMemoryResourceInstanceStore();
  await resources.create(resource({
    provider: options.provider,
    providerMaterializationId: options.providerMaterializationId === null
      ? undefined
      : options.providerMaterializationId ?? "materialization-1",
  }));
  const backupRestoreStore = new InMemoryBackupRestoreStore();
  const resourceOperationStores: ResourceOperationStores = {
    instances: resources,
    bindings: new InMemoryResourceBindingStore(),
    bindingSetRevisions: new InMemoryBindingSetRevisionStore(),
    migrationLedger: new InMemoryMigrationLedgerStore(),
  };
  const service = new BackupRestoreService({
    stores: {
      backupRestore: backupRestoreStore,
      resources,
      resourceOperations: options.withResourceOperations === false
        ? undefined
        : new ResourceOperationService({
          stores: resourceOperationStores,
          idFactory: () => "generated_resource_operation",
          clock: fixedClock("2026-04-27T00:00:00.000Z"),
        }),
    },
    providerSupport: options.providerSupport,
    idFactory: sequenceIds([
      "generated_backup",
      "generated_plan",
      "generated_operation",
    ]),
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await service.registerBackupMetadata({
    id: options.backupId ?? "backup_1",
    spaceId: "space_a",
    groupId: "group_a",
    expiresAt: options.expiresAt,
    resources: [{
      resourceInstanceId: "resource_db",
      contract: "postgres.v1",
      provider: options.provider,
      providerBackupRef: "provider-backup-1",
      checksum: "sha256:backup",
    }],
  });
  return {
    service,
    backupRestoreStore,
    resources,
    resourceOperationStores,
  };
}

function resource(input: {
  readonly provider: string;
  readonly providerMaterializationId?: string;
}): ResourceInstance {
  return {
    id: "resource_db",
    spaceId: "space_a",
    groupId: "group_a",
    contract: "postgres.v1",
    origin: "managed",
    sharingMode: "exclusive",
    provider: input.provider,
    providerResourceId: "provider-resource-1",
    providerMaterializationId: input.providerMaterializationId,
    lifecycle: {
      status: "ready",
      generation: 1,
      updatedAt: "2026-04-27T00:00:00.000Z",
    },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function sequenceIds(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? crypto.randomUUID();
}
