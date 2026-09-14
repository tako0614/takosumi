import { afterEach, expect, test } from "bun:test";

import type { ApplyRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import {
  capsuleLifecycleExpected,
  type CapsuleLifecycleMutation,
  type CommitCapsuleAbandonmentInput,
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const UPDATED_AT = "2026-09-14T00:00:01.000Z";
const pgClients: PGliteSqlClient[] = [];

interface Adapter {
  readonly label: string;
  readonly store: OpenTofuControlStore;
  readonly pg?: PGliteSqlClient;
  readonly d1?: SqliteFakeD1;
}

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function adapters(): Promise<readonly Adapter[]> {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const d1 = new SqliteFakeD1();
  return [
    { label: "memory", store: new InMemoryOpenTofuControlStore() },
    { label: "postgres", store: new SqlOpenTofuControlStore({ client: pg }), pg },
    { label: "d1", store: new CloudflareD1OpenTofuControlStore(d1), d1 },
  ];
}

async function commandFor(
  store: OpenTofuControlStore,
  capsule: Capsule,
  overrides: Partial<CommitCapsuleAbandonmentInput["expected"]> = {},
): Promise<CommitCapsuleAbandonmentInput> {
  const epoch = await store.getCapsuleExecutionAuthorityEpoch(capsule.id);
  const management = await store.getWorkspaceManagement(capsule.workspaceId);
  if (!epoch || !management || management.managementState !== "active") {
    throw new Error("abandonment fixture authority is incomplete");
  }
  return {
    capsuleId: capsule.id,
    expected: {
      ...capsuleLifecycleExpected(capsule, epoch),
      workspaceId: capsule.workspaceId,
      environment: capsule.environment,
      ...overrides,
    },
    expectedWorkspaceManagementAuthority: {
      workspaceId: capsule.workspaceId,
      managementState: "active",
      managementEpoch: management.managementEpoch,
    },
    updatedAt: UPDATED_AT,
  };
}

function restoreRun(capsule: Capsule): Run {
  return {
    id: `restore_${capsule.id}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    type: "restore",
    status: "running",
    createdBy: "capsule-abandonment-storage-test",
    createdAt: UPDATED_AT,
  };
}

function applyRun(capsule: Capsule): ApplyRun {
  return {
    id: `apply_${capsule.id}`,
    planRunId: `plan_${capsule.id}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    operation: "update",
    runnerProfileId: "runner",
    status: "queued",
    expected: {
      planRunId: `plan_${capsule.id}`,
      capsuleId: capsule.id,
      runnerProfileId: "runner",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "operator-managed", ref: "state" },
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function dropBinding(adapter: Adapter, capsule: Capsule): Promise<boolean> {
  if (adapter.pg) {
    await adapter.pg.query(
      "delete from takosumi_provider_env_binding_sets where installation_id = $1 and environment = $2",
      [capsule.id, capsule.environment],
    );
    return true;
  }
  if (adapter.d1) {
    await adapter.d1
      .prepare(
        "delete from provider_env_binding_sets where installation_id = ? and environment = ?",
      )
      .bind(capsule.id, capsule.environment)
      .run();
    return true;
  }
  return false;
}

test("Capsule abandonment atomicity accepts an absent binding slot", async () => {
  for (const adapter of await adapters()) {
    const seeded = await seedCapsuleModel(adapter.store, {
      workspaceId: `workspace_abandon_missing_${adapter.label}`,
      capsuleId: `capsule_abandon_missing_${adapter.label}`,
    });
    if (!(await dropBinding(adapter, seeded.capsule))) continue;
    const command = await commandFor(adapter.store, seeded.capsule);
    const result = await adapter.store.commitCapsuleAbandonment(command);
    expect(result.kind, adapter.label).toBe("updated");
    expect((await adapter.store.getCapsule(seeded.capsule.id))?.status).toBe(
      "destroyed",
    );
    expect(
      await adapter.store.getProviderBindingSetByCapsule(
        seeded.capsule.id,
        seeded.capsule.environment,
      ),
      adapter.label,
    ).toBeUndefined();
  }
});

test("Capsule abandonment atomicity fences state, runtime, queued Apply, Workspace, and rebind mismatches", async () => {
  for (const scenario of ["state", "runtime", "apply", "drain", "rebind"] as const) {
    for (const adapter of await adapters()) {
      const seeded = await seedCapsuleModel(adapter.store, {
        workspaceId: `workspace_abandon_${scenario}_${adapter.label}`,
        capsuleId: `capsule_abandon_${scenario}_${adapter.label}`,
      });
      const command = await commandFor(adapter.store, seeded.capsule);
      if (scenario === "state") {
        const mismatch = await commandFor(adapter.store, seeded.capsule, {
          currentStateVersionId: "state-not-zero",
          currentStateGeneration: 1,
        });
        expect(
          (await adapter.store.commitCapsuleAbandonment(mismatch)).kind,
          `${scenario}:${adapter.label}`,
        ).toBe("conflict");
        const persisted = {
          ...seeded.capsule,
          currentStateVersionId: "state-present",
          currentStateGeneration: 0,
        };
        await adapter.store.putCapsule(persisted);
        expect(
          (await adapter.store.commitCapsuleAbandonment(
            await commandFor(adapter.store, persisted),
          )).kind,
          `${scenario}:present:${adapter.label}`,
        ).toBe("conflict");
        await adapter.store.putCapsule(seeded.capsule);
      } else if (scenario === "runtime") {
        await adapter.store.putBackupRun(restoreRun(seeded.capsule));
        expect(
          (await adapter.store.commitCapsuleAbandonment(command)).kind,
          `${scenario}:${adapter.label}`,
        ).toBe("conflict");
      } else if (scenario === "apply") {
        for (const status of ["queued", "running"] as const) {
          await adapter.store.putApplyRun({
            ...applyRun(seeded.capsule),
            status,
          });
          expect(
            (await adapter.store.commitCapsuleAbandonment(command)).kind,
            `${scenario}:${status}:${adapter.label}`,
          ).toBe("conflict");
        }
      } else if (scenario === "drain") {
        await adapter.store.beginWorkspaceDraining(
          seeded.workspace.id,
          command.expectedWorkspaceManagementAuthority,
        );
        expect(
          (await adapter.store.commitCapsuleAbandonment(command)).kind,
          `${scenario}:${adapter.label}`,
        ).toBe("conflict");
      } else {
        const baseMismatch = await commandFor(adapter.store, seeded.capsule, {
          workspaceId: "workspace-rebound",
          environment: seeded.capsule.environment,
        });
        const mismatch: CommitCapsuleAbandonmentInput = {
          ...baseMismatch,
          expectedWorkspaceManagementAuthority: {
            ...command.expectedWorkspaceManagementAuthority,
            workspaceId: "workspace-rebound",
          },
        };
        expect(
          (await adapter.store.commitCapsuleAbandonment(mismatch)).kind,
          `${scenario}:${adapter.label}`,
        ).toBe("conflict");
      }
      expect(await adapter.store.getCapsule(seeded.capsule.id), `${scenario}:${adapter.label}`)
        .toEqual(seeded.capsule);
      expect(
        await adapter.store.getProviderBindingSetByCapsule(
          seeded.capsule.id,
          seeded.capsule.environment,
        ),
        `${scenario}:${adapter.label}`,
      ).toBeDefined();
    }
  }
});

test("Capsule abandonment atomicity never cleans an arbitrary destroyed row", async () => {
  for (const adapter of await adapters()) {
    const seeded = await seedCapsuleModel(adapter.store, {
      workspaceId: `workspace_abandon_destroyed_${adapter.label}`,
      capsuleId: `capsule_abandon_destroyed_${adapter.label}`,
    });
    const destroyed = { ...seeded.capsule, status: "destroyed" as const };
    await adapter.store.putCapsule(destroyed);
    const result = await adapter.store.commitCapsuleAbandonment(
      await commandFor(adapter.store, seeded.capsule),
    );
    expect(result.kind, adapter.label).toBe("conflict");
    expect(
      await adapter.store.getProviderBindingSetByCapsule(
        seeded.capsule.id,
        seeded.capsule.environment,
      ),
      adapter.label,
    ).toBeDefined();
  }
});

test("Capsule abandonment atomicity rejects generic lifecycle entry to and from destroyed", async () => {
  for (const adapter of await adapters()) {
    const seeded = await seedCapsuleModel(adapter.store, {
      workspaceId: `workspace_abandon_generic_destroyed_${adapter.label}`,
      capsuleId: `capsule_abandon_generic_destroyed_${adapter.label}`,
    });
    const command = await commandFor(adapter.store, seeded.capsule);
    const malformedTarget: CapsuleLifecycleMutation = {
      kind: "status",
      // Runtime input can still carry a legacy/forged target despite the
      // Exclude<> type; this is the one intentional malformed-boundary cast.
      status: "destroyed",
      expectedWorkspaceManagementAuthority:
        command.expectedWorkspaceManagementAuthority,
    } as unknown as CapsuleLifecycleMutation;
    const toDestroyed = await adapter.store.updateCapsuleLifecycle({
      capsuleId: seeded.capsule.id,
      expected: capsuleLifecycleExpected(
        seeded.capsule,
        (await adapter.store.getCapsuleExecutionAuthorityEpoch(
          seeded.capsule.id,
        ))!,
      ),
      mutation: malformedTarget,
      updatedAt: UPDATED_AT,
    });
    expect(toDestroyed.kind, adapter.label).toBe("conflict");
    expect(await adapter.store.getCapsule(seeded.capsule.id), adapter.label)
      .toEqual(seeded.capsule);

    const destroyed = { ...seeded.capsule, status: "destroyed" as const };
    await adapter.store.putCapsule(destroyed);
    const destroyedEpoch = await adapter.store.getCapsuleExecutionAuthorityEpoch(
      destroyed.id,
    );
    if (destroyedEpoch === undefined) {
      throw new Error(`${adapter.label}: destroyed epoch is missing`);
    }
    const fromDestroyed = await adapter.store.updateCapsuleLifecycle({
      capsuleId: destroyed.id,
      expected: capsuleLifecycleExpected(destroyed, destroyedEpoch),
      mutation: {
        kind: "status",
        status: "active",
        expectedWorkspaceManagementAuthority:
          command.expectedWorkspaceManagementAuthority,
      },
      updatedAt: UPDATED_AT,
    });
    expect(fromDestroyed.kind, adapter.label).toBe("conflict");
    expect(await adapter.store.getCapsule(destroyed.id), adapter.label).toEqual(
      destroyed,
    );
    expect(
      await adapter.store.getCapsuleExecutionAuthorityEpoch(destroyed.id),
      adapter.label,
    ).toBe(destroyedEpoch);
  }
});

test("Capsule abandonment atomicity refuses a D1 binding row with mismatched physical and JSON ownership", async () => {
  const database = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(database);
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_abandon_orphan_binding",
    capsuleId: "capsule_abandon_orphan_binding",
  });
  const binding = await store.getProviderBindingSetByCapsule(
    seeded.capsule.id,
    seeded.capsule.environment,
  );
  if (!binding) throw new Error("abandonment binding fixture is incomplete");
  await database
    .prepare(
      "update provider_env_binding_sets set space_id = ?, record_json = json_set(record_json, '$.workspaceId', ?) where installation_id = ? and environment = ?",
    )
    .bind(
      "workspace_orphan",
      "workspace_orphan",
      seeded.capsule.id,
      seeded.capsule.environment,
    )
    .run();

  const result = await store.commitCapsuleAbandonment(
    await commandFor(store, seeded.capsule),
  );
  expect(result.kind).toBe("conflict");
  expect(await store.getCapsule(seeded.capsule.id)).toEqual(seeded.capsule);
  expect(
    await store.getProviderBindingSetByCapsule(
      seeded.capsule.id,
      seeded.capsule.environment,
    ),
  ).toMatchObject({ workspaceId: "workspace_orphan" });
});

test("Capsule abandonment atomicity refuses a D1 binding row with mismatched physical id", async () => {
  const database = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(database);
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_abandon_physical_id",
    capsuleId: "capsule_abandon_physical_id",
  });
  const binding = await store.getProviderBindingSetByCapsule(
    seeded.capsule.id,
    seeded.capsule.environment,
  );
  if (!binding) throw new Error("abandonment binding fixture is incomplete");
  const physicalId = `${binding.id}_physical`;
  await database
    .prepare(
      "update provider_env_binding_sets set id = ? where installation_id = ? and environment = ?",
    )
    .bind(physicalId, seeded.capsule.id, seeded.capsule.environment)
    .run();

  const result = await store.commitCapsuleAbandonment(
    await commandFor(store, seeded.capsule),
  );
  expect(result.kind).toBe("conflict");
  expect(await store.getCapsule(seeded.capsule.id)).toEqual(seeded.capsule);
  expect(
    await database
      .prepare(
        "select id from provider_env_binding_sets where installation_id = ? and environment = ?",
      )
      .bind(seeded.capsule.id, seeded.capsule.environment)
      .first(),
  ).toEqual({ id: physicalId });
});

async function installFailureTrigger(
  adapter: Adapter,
  stage: "delete" | "update",
): Promise<() => Promise<void>> {
  if (adapter.d1) {
    const table = stage === "delete" ? "provider_env_binding_sets" : "capsules";
    const trigger = `reject_capsule_abandonment_${stage}`;
    await adapter.d1.exec(`
      CREATE TRIGGER ${trigger}
      BEFORE ${stage === "delete" ? "DELETE" : "UPDATE"} ON ${table}
      BEGIN
        SELECT RAISE(ABORT, 'fixture capsule abandonment ${stage} failure');
      END;
    `);
    return async () => {
      await adapter.d1!.exec(`DROP TRIGGER ${trigger}`);
    };
  }
  if (adapter.pg) {
    const trigger = `reject_capsule_abandonment_${stage}`;
    const table = stage === "delete"
      ? "takosumi_provider_env_binding_sets"
      : "takosumi_capsules";
    const operation = stage === "delete" ? "DELETE" : "UPDATE";
    await adapter.pg.query(`
      create function ${trigger}_fn() returns trigger
      language plpgsql
      as $$ begin raise exception 'fixture capsule abandonment ${stage} failure'; end; $$
    `);
    await adapter.pg.query(`
      create trigger ${trigger}
      before ${operation} on ${table}
      for each row execute function ${trigger}_fn()
    `);
    return async () => {
      await adapter.pg!.query(`drop trigger ${trigger} on ${table}`);
      await adapter.pg!.query(`drop function ${trigger}_fn()`);
    };
  }
  return async () => {};
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  while (error instanceof Error) {
    messages.push(error.message);
    error = error.cause;
  }
  return messages;
}

test("Capsule abandonment atomicity rolls back both rows on binding-delete failure", async () => {
  for (const adapter of await adapters()) {
    if (!adapter.pg && !adapter.d1) continue;
    const seeded = await seedCapsuleModel(adapter.store, {
      workspaceId: `workspace_abandon_delete_fault_${adapter.label}`,
      capsuleId: `capsule_abandon_delete_fault_${adapter.label}`,
    });
    const binding = await adapter.store.getProviderBindingSetByCapsule(
      seeded.capsule.id,
      seeded.capsule.environment,
    );
    const cleanup = await installFailureTrigger(adapter, "delete");
    let failure: unknown;
    try {
      await adapter.store.commitCapsuleAbandonment(
        await commandFor(adapter.store, seeded.capsule),
      );
    } catch (error) {
      failure = error;
    } finally {
      await cleanup();
    }
    expect(errorMessages(failure).some((message) =>
      message.includes("fixture capsule abandonment delete failure")
    ), adapter.label).toBe(true);
    expect(await adapter.store.getCapsule(seeded.capsule.id)).toEqual(
      seeded.capsule,
    );
    expect(
      await adapter.store.getProviderBindingSetByCapsule(
        seeded.capsule.id,
        seeded.capsule.environment,
      ),
    ).toEqual(binding);
  }
});

test("Capsule abandonment atomicity rolls back both rows on Capsule-update failure", async () => {
  for (const adapter of await adapters()) {
    if (!adapter.pg && !adapter.d1) continue;
    const seeded = await seedCapsuleModel(adapter.store, {
      workspaceId: `workspace_abandon_update_fault_${adapter.label}`,
      capsuleId: `capsule_abandon_update_fault_${adapter.label}`,
    });
    const binding = await adapter.store.getProviderBindingSetByCapsule(
      seeded.capsule.id,
      seeded.capsule.environment,
    );
    const cleanup = await installFailureTrigger(adapter, "update");
    let failure: unknown;
    try {
      await adapter.store.commitCapsuleAbandonment(
        await commandFor(adapter.store, seeded.capsule),
      );
    } catch (error) {
      failure = error;
    } finally {
      await cleanup();
    }
    expect(errorMessages(failure).some((message) =>
      message.includes("fixture capsule abandonment update failure")
    ), adapter.label).toBe(true);
    expect(await adapter.store.getCapsule(seeded.capsule.id)).toEqual(
      seeded.capsule,
    );
    expect(
      await adapter.store.getProviderBindingSetByCapsule(
        seeded.capsule.id,
        seeded.capsule.environment,
      ),
    ).toEqual(binding);
  }
});
