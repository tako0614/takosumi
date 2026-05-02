import assert from "node:assert/strict";
import type {
  DeploymentProviderAdapter,
  OperationOutcome,
  PlannedOperation,
} from "../domains/deploy/apply_orchestrator.ts";
import {
  DeploymentService,
  InMemoryDeploymentStore,
} from "../domains/deploy/deployment_service.ts";
import type { PublicDeployManifest } from "../domains/deploy/types.ts";
import {
  InMemoryBindingSetRevisionStore,
  InMemoryMigrationLedgerStore,
  InMemoryResourceBindingStore,
  InMemoryResourceInstanceStore,
} from "../domains/resources/mod.ts";
import { ResourceOperationService } from "../services/resources/mod.ts";

const DEMO_IMAGE =
  "registry.example.test/demo@sha256:1111111111111111111111111111111111111111111111111111111111111111";

Deno.test("acceptance migration: post-migration apply failure leaves GroupHead unchanged", async () => {
  const deployStore = new InMemoryDeploymentStore();
  const deploy = new DeploymentService({
    store: deployStore,
    idFactory: sequenceIds(["deployment_v1"]),
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resource = createResourceService(["resource_db", "migration_expand"]);

  const v1 = await deploy.resolveDeployment({
    spaceId: "space_acceptance",
    manifest: manifest("1.0.0"),
  });
  await deploy.applyDeployment({ deploymentId: v1.id });

  const db = await resource.service.createResource({
    id: "resource_db",
    spaceId: "space_acceptance",
    groupId: "demo-app",
    contract: "postgres.v1",
  });
  await resource.service.recordMigration({
    id: "migration_expand",
    resourceInstanceId: db.id,
    migrationRef: "postgres:expand-secondDeployment",
    toVersion: "2",
    checksum: "sha256:expand-secondDeployment",
  });

  const failingDeploy = new DeploymentService({
    store: deployStore,
    idFactory: sequenceIds(["deployment_v2"]),
    clock: fixedClock("2026-04-27T00:05:00.000Z"),
    providerAdapter: failOnRuntimeDeploy(),
  });
  const secondDeployment = await failingDeploy.resolveDeployment({
    spaceId: "space_acceptance",
    manifest: manifest("2.0.0"),
  });
  const failed = await failingDeploy.applyDeployment({
    deploymentId: secondDeployment.id,
  });

  const head = await deployStore.getGroupHead({
    spaceId: "space_acceptance",
    groupId: "demo-app",
  });
  const migrated = await resource.stores.instances.get(db.id);
  assert.equal(failed.status, "failed");
  assert.equal(head?.current_deployment_id, v1.id);
  assert.equal(migrated?.lifecycle.generation, 2);
});

Deno.test("acceptance migration: rollback does not reverse durable resource generation", async () => {
  const deployStore = new InMemoryDeploymentStore();
  const deploy = new DeploymentService({
    store: deployStore,
    idFactory: sequenceIds(["deployment_v1", "deployment_v2"]),
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resource = createResourceService(["resource_db", "migration_expand"]);

  const v1 = await deploy.resolveDeployment({
    spaceId: "space_acceptance",
    manifest: manifest("1.0.0"),
  });
  await deploy.applyDeployment({ deploymentId: v1.id });
  const secondDeployment = await deploy.resolveDeployment({
    spaceId: "space_acceptance",
    manifest: manifest("2.0.0"),
  });
  await deploy.applyDeployment({ deploymentId: secondDeployment.id });

  const db = await resource.service.createResource({
    id: "resource_db",
    spaceId: "space_acceptance",
    groupId: "demo-app",
    contract: "postgres.v1",
  });
  await resource.service.recordMigration({
    id: "migration_expand",
    resourceInstanceId: db.id,
    migrationRef: "postgres:expand-secondDeployment",
    toVersion: "2",
    checksum: "sha256:expand-secondDeployment",
  });

  await deploy.rollbackGroup({
    spaceId: "space_acceptance",
    groupId: "demo-app",
    targetDeploymentId: v1.id,
  });

  const head = await deployStore.getGroupHead({
    spaceId: "space_acceptance",
    groupId: "demo-app",
  });
  const migrated = await resource.stores.instances.get(db.id);
  assert.equal(head?.current_deployment_id, v1.id);
  assert.equal(migrated?.lifecycle.generation, 2);
});

function manifest(version: string): PublicDeployManifest {
  return {
    name: "demo-app",
    version,
    compute: {
      web: {
        type: "container",
        image: DEMO_IMAGE,
        port: 8080,
      },
    },
    resources: {
      db: { type: "postgres", plan: "dev" },
    },
    routes: {
      web: { target: "web", path: "/" },
    },
  };
}

function createResourceService(ids: readonly string[]) {
  const stores = {
    instances: new InMemoryResourceInstanceStore(),
    bindings: new InMemoryResourceBindingStore(),
    bindingSetRevisions: new InMemoryBindingSetRevisionStore(),
    migrationLedger: new InMemoryMigrationLedgerStore(),
  };
  return {
    stores,
    service: new ResourceOperationService({
      stores,
      idFactory: sequenceIds(ids),
      clock: fixedClock("2026-04-27T00:00:00.000Z"),
    }),
  };
}

function failOnRuntimeDeploy(): DeploymentProviderAdapter {
  return {
    materialize(_deployment, operation): OperationOutcome {
      if (operation.kind === "runtime.deploy") {
        return {
          success: false,
          reason: "BuildFailedAfterMigration",
          message: "simulated build failure after expand migration",
        };
      }
      return { success: true, reason: "ok" };
    },
    rollback(_deployment, _operation: PlannedOperation): OperationOutcome {
      return { success: true, reason: "rollback-ok" };
    },
  };
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
