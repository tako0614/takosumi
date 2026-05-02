import assert from "node:assert/strict";
import {
  InMemoryBindingSetRevisionStore,
  InMemoryMigrationLedgerStore,
  InMemoryResourceBindingStore,
  InMemoryResourceInstanceStore,
} from "../../domains/resources/mod.ts";
import { MemoryEncryptedSecretStore } from "../../adapters/secret-store/mod.ts";
import { DomainError } from "../../shared/errors.ts";
import {
  ResourceOperationService,
  type ResourceOperationStores,
} from "./mod.ts";

Deno.test("ResourceOperationService creates, binds, and unbinds through resource stores", async () => {
  const { service, stores } = createService({
    ids: [
      "resource_db",
      "binding_db",
      "revision_bind",
      "revision_unbind",
      "binding_db_rebound",
      "revision_rebind",
    ],
  });

  const resource = await service.createResource({
    spaceId: "space_a",
    groupId: "group_a",
    contract: "postgres.v1",
  });
  assert.equal(resource.id, "resource_db");
  assert.equal(resource.lifecycle.status, "ready");
  assert.equal(resource.lifecycle.generation, 1);
  assert.equal(await stores.instances.get("resource_db"), resource);

  const bound = await service.bindResource({
    spaceId: "space_a",
    groupId: "group_a",
    claimAddress: "claims.db",
    instanceId: resource.id,
  });
  assert.equal(bound.binding.id, "binding_db");
  assert.equal(bound.binding.role, "owner");
  assert.deepEqual(bound.revision.resourceBindingIds, ["binding_db"]);
  assert.equal(bound.revision.componentAddress, "group:group_a");
  assert.match(bound.revision.structureDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(bound.revision.inputs, [{
    bindingName: "claims.db",
    source: "resource",
    sourceAddress: "resource:resource_db",
    access: { contract: "postgres.v1", mode: "owner" },
    injection: { mode: "runtime-binding", target: "claims.db" },
    sensitivity: "credential",
    enforcement: "enforced",
  }]);
  assert.equal(
    (await stores.bindings.findByClaim("group_a", "claims.db"))?.id,
    "binding_db",
  );

  const unbound = await service.unbindResource({ bindingId: "binding_db" });
  assert.equal(unbound.binding.id, "binding_db");
  assert.equal(unbound.revision.id, "revision_unbind");
  assert.deepEqual(unbound.revision.resourceBindingIds, []);
  assert.deepEqual(unbound.revision.inputs, []);

  const rebound = await service.bindResource({
    spaceId: "space_a",
    groupId: "group_a",
    claimAddress: "claims.db",
    instanceId: resource.id,
  });
  assert.equal(rebound.binding.id, "binding_db_rebound");
  assert.deepEqual(rebound.revision.resourceBindingIds, ["binding_db_rebound"]);
  assert.deepEqual(rebound.revision.inputs?.map((input) => input.bindingName), [
    "claims.db",
  ]);
  assert.deepEqual(
    (await stores.bindingSetRevisions.listByGroup("group_a")).map((item) =>
      item.id
    ),
    ["revision_bind", "revision_unbind", "revision_rebind"],
  );
});

Deno.test("ResourceOperationService rejects changed migration ledger checksums", async () => {
  const { service } = createService({ ids: ["resource_db", "migration_1"] });
  const resource = await service.createResource({
    spaceId: "space_a",
    groupId: "group_a",
    contract: "postgres.v1",
  });
  await service.recordMigration({
    resourceInstanceId: resource.id,
    migrationRef: "postgres:20260427_add_accounts",
    toVersion: "2",
    checksum: "sha256:old",
    checkpoints: [{ name: "ddl", checksum: "sha256:ddl-old" }],
  });

  await assert.rejects(
    () =>
      service.validateMigration({
        resourceInstanceId: resource.id,
        migrationRef: "postgres:20260427_add_accounts",
        checksum: "sha256:new",
        checkpoints: [{ name: "ddl", checksum: "sha256:ddl-old" }],
      }),
    (error) => isDomainConflict(error, "Applied migration checksum changed"),
  );
  await assert.rejects(
    () =>
      service.validateMigration({
        resourceInstanceId: resource.id,
        migrationRef: "postgres:20260427_add_accounts",
        checksum: "sha256:old",
        checkpoints: [{ name: "ddl", checksum: "sha256:ddl-new" }],
      }),
    (error) =>
      isDomainConflict(
        error,
        "Applied migration checkpoint checksum changed",
      ),
  );
});

Deno.test("ResourceOperationService blocks imported bind-only and shared readonly migrations", async () => {
  const { service } = createService({
    ids: ["resource_imported", "resource_shared"],
  });
  const imported = await service.createResource({
    spaceId: "space_a",
    contract: "postgres.v1",
    origin: "imported-bind-only",
  });
  const shared = await service.createResource({
    spaceId: "space_a",
    contract: "postgres.v1",
    sharingMode: "shared-readonly",
  });

  await assert.rejects(
    () =>
      service.recordMigration({
        resourceInstanceId: imported.id,
        migrationRef: "postgres:migrate",
      }),
    (error) =>
      isDomainConflict(
        error,
        "Imported bind-only resources cannot be migrated",
      ),
  );
  await assert.rejects(
    () =>
      service.recordMigration({
        resourceInstanceId: shared.id,
        migrationRef: "postgres:migrate",
      }),
    (error) =>
      isDomainConflict(error, "Shared readonly resources cannot be migrated"),
  );
});

Deno.test("ResourceOperationService enforces sharing and import binding roles", async () => {
  const { service } = createService({
    ids: [
      "resource_exclusive",
      "binding_owner",
      "revision_owner",
      "resource_readonly",
      "resource_imported",
    ],
  });
  const exclusive = await service.createResource({
    spaceId: "space_a",
    groupId: "group_owner",
    contract: "postgres.v1",
  });
  await service.bindResource({
    spaceId: "space_a",
    groupId: "group_owner",
    claimAddress: "claims.db",
    instanceId: exclusive.id,
  });
  await assert.rejects(
    () =>
      service.bindResource({
        spaceId: "space_a",
        groupId: "group_consumer",
        claimAddress: "claims.db",
        instanceId: exclusive.id,
      }),
    (error) =>
      isDomainConflict(
        error,
        "Exclusive resources cannot be shared across groups",
      ),
  );

  const readonly = await service.createResource({
    spaceId: "space_a",
    contract: "postgres.v1",
    sharingMode: "shared-readonly",
  });
  await assert.rejects(
    () =>
      service.bindResource({
        spaceId: "space_a",
        groupId: "group_consumer",
        claimAddress: "claims.readonly",
        instanceId: readonly.id,
        role: "owner",
      }),
    (error) =>
      isDomainConflict(
        error,
        "Shared readonly resources only allow readonly bindings",
      ),
  );

  const imported = await service.createResource({
    spaceId: "space_a",
    contract: "postgres.v1",
    origin: "imported-bind-only",
  });
  await assert.rejects(
    () =>
      service.bindResource({
        spaceId: "space_a",
        groupId: "group_import",
        claimAddress: "claims.imported",
        instanceId: imported.id,
        role: "owner",
      }),
    (error) =>
      isDomainConflict(
        error,
        "Imported bind-only resources only allow bind-only role",
      ),
  );
});

Deno.test("ResourceOperationService advances durable generation for completed migrations", async () => {
  const { service, stores } = createService({
    ids: ["resource_db", "migration_1"],
  });
  const resource = await service.createResource({
    spaceId: "space_a",
    groupId: "group_a",
    contract: "postgres.v1",
  });

  const migration = await service.recordMigration({
    resourceInstanceId: resource.id,
    migrationRef: "postgres:20260427_add_accounts",
    checksum: "sha256:migration",
  });

  assert.equal(migration.status, "completed");
  const updated = await stores.instances.get(resource.id);
  assert.equal(updated?.lifecycle.generation, 2);
  assert.equal(
    updated?.lifecycle.conditions?.find((item) =>
      item.type === "ResourceMigrationApplied"
    )?.reason ?? null,
    null,
  );
});

Deno.test("ResourceOperationService models restore as a resource operation separate from rollback", async () => {
  const { service, stores } = createService({
    ids: ["resource_db", "restore_ledger"],
  });
  const resource = await service.createResource({
    spaceId: "space_a",
    groupId: "group_a",
    contract: "postgres.v1",
  });

  const result = await service.restoreResource({
    resourceInstanceId: resource.id,
    restoreRef: "backup_20260427",
    mode: "snapshot",
    sourceBackupRef: "s3://backups/db/20260427",
    checksum: "sha256:backup",
  });

  assert.equal(result.kind, "restore");
  assert.equal(result.ledgerEntry.id, "restore_ledger");
  assert.equal(result.ledgerEntry.migrationRef, "restore:backup_20260427");
  assert.equal(result.ledgerEntry.metadata?.operationKind, "restore");
  assert.notEqual(result.ledgerEntry.metadata?.operationKind, "rollback");
  assert.equal(result.resource.lifecycle.generation, 2);
  assert.equal(
    (await stores.instances.get(resource.id))?.lifecycle.generation,
    2,
  );
  assert.deepEqual(
    (await stores.migrationLedger.listByResource(resource.id)).map((entry) => [
      entry.id,
      entry.metadata?.operationKind,
    ]),
    [["restore_ledger", "restore"]],
  );
});

Deno.test("ResourceOperationService rejects unsafe provider-native restores", async () => {
  const { service } = createService({
    ids: ["resource_db", "resource_imported", "resource_readonly"],
  });
  const resource = await service.createResource({
    spaceId: "space_a",
    groupId: "group_a",
    contract: "postgres.v1",
    provider: "postgres-provider",
    providerResourceId: "provider-resource-1",
    providerMaterializationId: "materialization-1",
  });

  await assert.rejects(
    () =>
      service.restoreResource({
        resourceInstanceId: resource.id,
        restoreRef: "backup_native",
        mode: "provider-native",
        sourceBackupRef: "provider-backup-1",
        expectedResourceGeneration: 2,
      }),
    (error) => isDomainConflict(error, "Restore target generation changed"),
  );
  await assert.rejects(
    () =>
      service.restoreResource({
        resourceInstanceId: resource.id,
        restoreRef: "backup_native",
        mode: "provider-native",
        sourceBackupRef: "provider-backup-1",
        expectedResourceGeneration: 1,
        sourceProviderMaterializationId: "materialization-old",
      }),
    (error) =>
      isDomainConflict(
        error,
        "Provider-native restore materialization changed",
      ),
  );

  const imported = await service.createResource({
    spaceId: "space_a",
    contract: "postgres.v1",
    origin: "imported-bind-only",
  });
  await assert.rejects(
    () =>
      service.restoreResource({
        resourceInstanceId: imported.id,
        restoreRef: "backup_native",
        mode: "snapshot",
      }),
    (error) =>
      isDomainConflict(
        error,
        "Imported bind-only resources cannot be restored",
      ),
  );

  const readonly = await service.createResource({
    spaceId: "space_a",
    contract: "postgres.v1",
    sharingMode: "shared-readonly",
  });
  await assert.rejects(
    () =>
      service.restoreResource({
        resourceInstanceId: readonly.id,
        restoreRef: "backup_native",
        mode: "snapshot",
      }),
    (error) =>
      isDomainConflict(error, "Shared readonly resources cannot be restored"),
  );
});

Deno.test("ResourceOperationService stores secret binding value resolutions and repair condition for revoked versions", async () => {
  const { service, stores } = createService({
    ids: ["revision_secret"],
    withSecrets: true,
  });
  const secret = await stores.secrets?.putSecret({
    name: "DATABASE_URL",
    value: "postgres://example",
    metadata: {
      status: "revoked",
      revokedAt: "2026-04-27T00:00:00.000Z",
    },
  });

  const result = await service.bindSecret({
    spaceId: "space_a",
    groupId: "group_a",
    bindingName: "DATABASE_URL",
    secretName: "DATABASE_URL",
    resolution: "pinned-version",
    pinnedVersionId: secret?.version,
  });

  assert.deepEqual(result.revision.secretBindings, [{
    bindingName: "DATABASE_URL",
    secretName: "DATABASE_URL",
    resolution: "pinned-version",
    pinnedVersionId: secret?.version,
    rollbackPolicy: "reuse-pinned-version",
  }]);
  assert.deepEqual(result.revision.bindingValueResolutions, [{
    bindingSetRevisionId: "revision_secret",
    bindingName: "DATABASE_URL",
    sourceAddress: "secret:DATABASE_URL",
    resolutionPolicy: "pinned-version",
    resolvedVersion: secret?.version,
    resolvedAt: "2026-04-27T00:00:00.000Z",
    sensitivity: "secret",
  }]);
  assert.equal(
    result.revision.conditions?.[0]?.reason,
    "RepairMaterializationRequired",
  );
  assert.match(
    result.revision.conditions?.[0]?.message ?? "",
    /status=revoked/,
  );
});

function createService(options: {
  readonly ids: readonly string[];
  readonly withSecrets?: boolean;
}): {
  readonly service: ResourceOperationService;
  readonly stores: ResourceOperationStores;
} {
  const secrets = options.withSecrets
    ? new MemoryEncryptedSecretStore({
      clock: fixedClock("2026-04-27T00:00:00.000Z"),
      idGenerator: sequenceIds(["secret_v1"]),
    })
    : undefined;
  const stores = {
    instances: new InMemoryResourceInstanceStore(),
    bindings: new InMemoryResourceBindingStore(),
    bindingSetRevisions: new InMemoryBindingSetRevisionStore(),
    migrationLedger: new InMemoryMigrationLedgerStore(),
    ...(secrets ? { secrets } : {}),
  };
  return {
    service: new ResourceOperationService({
      stores,
      idFactory: sequenceIds(options.ids),
      clock: fixedClock("2026-04-27T00:00:00.000Z"),
    }),
    stores,
  };
}

function isDomainConflict(error: unknown, message: string): boolean {
  return error instanceof DomainError && error.code === "conflict" &&
    error.message === message;
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function sequenceIds(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("test id sequence exhausted");
    index += 1;
    return value;
  };
}
