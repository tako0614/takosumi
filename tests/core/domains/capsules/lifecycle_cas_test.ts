import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Capsule } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { Output } from "takosumi-contract/outputs";
import type { Run } from "takosumi-contract/runs";
import type { StateVersion } from "takosumi-contract/state-versions";

import {
  CAPSULE_LIFECYCLE_BUSY_REASON,
  CapsulesService,
} from "../../../../core/domains/capsules/mod.ts";
import type {
  SqlClient,
  SqlParameters,
} from "../../../../core/adapters/storage/sql.ts";
import {
  capsuleLifecycleExpected,
  type CapsuleRuntimeSafety,
  type CommitCapsuleAbandonmentInput,
  type MarkCapsuleStaleCommand,
  InMemoryOpenTofuControlStore,
  type UpdateCapsuleLifecycleCommand,
  type OpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { InMemoryGitInstallPlanStore } from "../../../../core/domains/install-plans/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import type {
  D1Database,
  D1PreparedStatement,
} from "../../../../worker/src/bindings.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  D1_MAX_BOUND_PARAMS,
  SqliteFakeD1,
} from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

const BEFORE = "2026-08-29T01:00:00.000Z";
const APPLY_AT = "2026-08-29T01:00:01.000Z";
const LIFECYCLE_AT = "2026-08-29T01:00:02.000Z";
const pgClients: PGliteSqlClient[] = [];

interface RecordedD1Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

type RawD1PreparedStatement = D1PreparedStatement & {
  raw<T = unknown[]>(): Promise<T[]>;
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class RebindAfterFirstCapsuleReadStore extends InMemoryOpenTofuControlStore {
  #fired = false;
  onFirstCapsuleRead?: (capsule: Capsule) => Promise<void>;

  override async getCapsule(id: string): Promise<Capsule | undefined> {
    const capsule = await super.getCapsule(id);
    if (!this.#fired && capsule && this.onFirstCapsuleRead) {
      this.#fired = true;
      await this.onFirstCapsuleRead(capsule);
    }
    return capsule;
  }
}

class PausingLifecycleStore extends InMemoryOpenTofuControlStore {
  readonly lifecycleStarted = deferred<void>();
  readonly releaseLifecycle = deferred<void>();
  observedLifecycleCommand?: UpdateCapsuleLifecycleCommand;
  observedAbandonmentCommand?: CommitCapsuleAbandonmentInput;

  override async updateCapsuleLifecycle(
    input: UpdateCapsuleLifecycleCommand,
  ) {
    this.observedLifecycleCommand = input;
    this.lifecycleStarted.resolve();
    await this.releaseLifecycle.promise;
    return await super.updateCapsuleLifecycle(input);
  }

  override async commitCapsuleAbandonment(
    input: CommitCapsuleAbandonmentInput,
  ) {
    this.observedAbandonmentCommand = input;
    this.lifecycleStarted.resolve();
    await this.releaseLifecycle.promise;
    return await super.commitCapsuleAbandonment(input);
  }
}

class RuntimeEvidenceAfterSafetyReadStore extends InMemoryOpenTofuControlStore {
  #injected = false;

  override async getCapsuleRuntimeSafety(
    capsuleId: string,
  ): Promise<CapsuleRuntimeSafety | undefined> {
    const observed = await super.getCapsuleRuntimeSafety(capsuleId);
    if (!this.#injected && observed === undefined) {
      this.#injected = true;
      const capsule = await super.getCapsule(capsuleId);
      if (!capsule) throw new Error("Capsule disappeared during safety read");
      const runtimeEvidence: Run = {
        id: `restore_runtime_evidence_${capsule.id}`,
        workspaceId: capsule.workspaceId,
        capsuleId: capsule.id,
        environment: capsule.environment,
        type: "restore",
        status: "running",
        createdBy: "runtime-evidence-fixture",
        createdAt: LIFECYCLE_AT,
      };
      await this.putBackupRun(runtimeEvidence);
    }
    return observed;
  }
}

async function activeWorkspaceAuthority(
  store: OpenTofuControlStore,
  workspaceId: string,
): Promise<WorkspaceManagementAuthority> {
  const management = await store.getWorkspaceManagement(workspaceId);
  if (!management || management.managementState !== "active") {
    throw new Error(`Workspace ${workspaceId} is not active`);
  }
  return {
    workspaceId: management.workspaceId,
    managementState: "active",
    managementEpoch: management.managementEpoch,
  };
}

function lifecycleCommandAuthority(
  command: UpdateCapsuleLifecycleCommand | undefined,
): WorkspaceManagementAuthority | undefined {
  if (!command) return undefined;
  switch (command.mutation.kind) {
    case "status":
    case "auto-update":
    case "auto-update-claim":
    case "compatibility":
      return command.mutation.expectedWorkspaceManagementAuthority;
    case "public-origin-reservation":
      return undefined;
  }
}

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  const memory = new InMemoryOpenTofuControlStore();
  memory.attachGitInstallPlanStore(new InMemoryGitInstallPlanStore(memory));
  return [
    ["memory", memory],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function markStaleInput(
  expected: Capsule,
  reason: MarkCapsuleStaleCommand["reason"],
): MarkCapsuleStaleCommand {
  return {
    capsuleId: expected.id,
    expected,
    reason,
    updatedAt: LIFECYCLE_AT,
  };
}

interface ReleasedStoreFixture {
  readonly label: string;
  readonly store: OpenTofuControlStore;
  readonly setReleased: (workspaceId: string) => Promise<void>;
}

async function releasedStores(): Promise<readonly ReleasedStoreFixture[]> {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  const d1 = new SqliteFakeD1();
  return [
    {
      label: "postgres",
      store: new SqlOpenTofuControlStore({ client }),
      setReleased: async (workspaceId: string) => {
        await client.query(
          "update takosumi_workspaces set management_state = 'released' where id = $1",
          [workspaceId],
        );
      },
    },
    {
      label: "d1",
      store: new CloudflareD1OpenTofuControlStore(d1),
      setReleased: async (workspaceId: string) => {
        await d1
          .prepare(
            "update workspaces set management_state = 'released' where id = ?",
          )
          .bind(workspaceId)
          .run();
      },
    },
  ];
}

function postgresLifecycleInterleaver(inner: SqlClient): {
  readonly client: SqlClient;
  beforeNextTransaction(callback: () => Promise<void>): void;
} {
  let beforeNextTransaction: (() => Promise<void>) | undefined;
  return {
    client: {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: SqlParameters,
      ) {
        return await inner.query<Row>(sql, parameters);
      },
      async transaction(work) {
        const before = beforeNextTransaction;
        beforeNextTransaction = undefined;
        await before?.();
        return await inner.transaction(work);
      },
    },
    beforeNextTransaction(callback) {
      beforeNextTransaction = callback;
    },
  };
}

function recordingD1(
  database: D1Database,
  records: RecordedD1Statement[],
): D1Database {
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
    parameters: readonly unknown[] = [],
  ): RawD1PreparedStatement => ({
    bind(...values) {
      return wrap(statement.bind(...values), sql, values);
    },
    first<T>() {
      records.push({ sql, parameters });
      return statement.first<T>();
    },
    all<T>() {
      records.push({ sql, parameters });
      return statement.all<T>();
    },
    run<T>() {
      records.push({ sql, parameters });
      return statement.run<T>();
    },
    raw<T>() {
      records.push({ sql, parameters });
      return (statement as RawD1PreparedStatement).raw<T>();
    },
  });
  return {
    prepare(sql) {
      return wrap(database.prepare(sql), sql);
    },
    batch: (statements) => database.batch(statements),
  };
}

async function commitConcurrentApply(
  store: OpenTofuControlStore,
  capsule: Capsule,
): Promise<{ readonly state: StateVersion; readonly output: Output }> {
  const state: StateVersion = {
    id: `state_concurrent_${capsule.id}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: `state/${capsule.id}/1`,
    digest: `sha256:${"a".repeat(64)}`,
    createdByRunId: `apply_concurrent_${capsule.id}`,
    createdAt: APPLY_AT,
  };
  const output: Output = {
    id: `output_concurrent_${capsule.id}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateGeneration: 1,
    rawArtifactRef: `raw/${capsule.id}/1`,
    publicOutputs: { endpoint: "https://new.example.test" },
    workspaceOutputs: { endpoint: "https://new.example.test" },
    outputDigest: `sha256:${"b".repeat(64)}`,
    createdAt: APPLY_AT,
  };
  await store.commitRunState({
    stateVersion: state,
    output,
    capsulePatch: {
      id: capsule.id,
      patch: {
        currentStateVersionId: state.id,
        currentStateGeneration: state.generation,
        currentOutputId: output.id,
        status: "active",
        updatedAt: APPLY_AT,
      },
      guard: {
        currentStateVersionId: capsule.currentStateVersionId,
        status: capsule.status,
      },
    },
  });
  return { state, output };
}

test(
  "Capsule lifecycle authority carries the early execution epoch across a first-read rebind",
  async () => {
    const store = new RebindAfterFirstCapsuleReadStore();
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_lifecycle_epoch_rebind",
      capsuleId: "capsule_lifecycle_epoch_rebind",
    });
    const target: InstallConfig = {
      ...seeded.installConfig,
      id: "cfg_lifecycle_epoch_rebind_target",
      name: "lifecycle-epoch-rebind-target",
      createdAt: LIFECYCLE_AT,
      updatedAt: LIFECYCLE_AT,
    };
    await store.putInstallConfig(target);
    const before = await store.getCapsule(seeded.capsule.id);
    const epoch = await store.getCapsuleExecutionAuthorityEpoch(
      seeded.capsule.id,
    );
    if (!before || epoch === undefined) {
      throw new Error("Capsule lifecycle epoch fixture is incomplete");
    }

    store.onFirstCapsuleRead = async (observed) => {
      const rebound = await store.rebindCapsuleInstallConfig({
        capsuleId: observed.id,
        targetInstallConfigId: target.id,
        expected: {
          installConfigId: observed.installConfigId,
          installConfigDigest: await stableJsonDigest(seeded.installConfig),
          targetInstallConfigDigest: await stableJsonDigest(target),
          currentStateGeneration: observed.currentStateGeneration,
          currentStateVersionId: observed.currentStateVersionId,
          status: observed.status,
          executionAuthorityEpoch: epoch,
        },
        updatedAt: LIFECYCLE_AT,
      });
      expect(rebound.status).toBe("updated");
    };

    const service = new CapsulesService({
      store,
      now: () => new Date(LIFECYCLE_AT),
    });

    await expect(
      service.patchCapsuleStatus(seeded.capsule.id, "active"),
    ).rejects.toMatchObject({
      code: "failed_precondition",
      details: { reason: CAPSULE_LIFECYCLE_BUSY_REASON },
    });
    expect(await store.getCapsule(seeded.capsule.id)).toMatchObject({
      installConfigId: target.id,
      status: "pending",
    });
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id),
    ).toBe(epoch + 1);
  },
);

test(
  "Capsule lifecycle authority rejects a stale supplied Workspace authority",
  async () => {
    const store = new InMemoryOpenTofuControlStore();
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_lifecycle_stale_workspace_authority",
      capsuleId: "capsule_lifecycle_stale_workspace_authority",
    });
    const authority = await activeWorkspaceAuthority(
      store,
      seeded.workspace.id,
    );
    expect(
      (await store.beginWorkspaceDraining(seeded.workspace.id, authority)).status,
    ).toBe("started");

    const service = new CapsulesService({
      store,
      now: () => new Date(LIFECYCLE_AT),
    });

    await expect(
      service.setCapsuleAutoUpdate(seeded.capsule.id, true, authority),
    ).rejects.toMatchObject({
      code: "failed_precondition",
      details: { reason: "workspace_management_admission_conflict" },
    });
    expect(await store.getCapsule(seeded.capsule.id)).toEqual(
      seeded.capsule,
    );
  },
);

test(
  "Capsule lifecycle authority rejects status, auto-update, and abandonment after a drain during preparation",
  async () => {
    for (const operation of ["status", "auto-update", "abandon"] as const) {
      const store = new PausingLifecycleStore();
      const seeded = await seedCapsuleModel(store, {
        workspaceId: `workspace_lifecycle_drain_${operation}`,
        capsuleId: `capsule_lifecycle_drain_${operation}`,
      });
      const authority = await activeWorkspaceAuthority(
        store,
        seeded.workspace.id,
      );
      const service = new CapsulesService({
        store,
        now: () => new Date(LIFECYCLE_AT),
        ...(operation === "abandon"
          ? {
              capsuleLifecycleAdmission: async ({ capsule }, work) => {
                const current = await store.getCapsule(capsule.id);
                if (!current) throw new Error("Capsule disappeared in hook");
                return await work(current);
              },
            }
          : {}),
      });
      const attempt =
        operation === "status"
          ? service.patchCapsuleStatus(seeded.capsule.id, "active")
          : operation === "auto-update"
            ? service.setCapsuleAutoUpdate(seeded.capsule.id, true)
            : service.abandonUnappliedCapsule(
                seeded.capsule.id,
                "operator abandoned during preparation",
              );

      try {
        await Promise.race([
          store.lifecycleStarted.promise,
          attempt.then(() => {
            throw new Error(
              "Capsule lifecycle mutation completed before the pause",
            );
          }),
        ]);
        expect(
          (await store.beginWorkspaceDraining(seeded.workspace.id, authority))
            .status,
        ).toBe("started");
      } finally {
        store.releaseLifecycle.resolve();
      }

      await expect(attempt).rejects.toMatchObject({
        code: "failed_precondition",
        details: { reason: CAPSULE_LIFECYCLE_BUSY_REASON },
      });
      expect(
        store.observedAbandonmentCommand?.expectedWorkspaceManagementAuthority ??
          lifecycleCommandAuthority(store.observedLifecycleCommand),
      ).toEqual(authority);
      expect(await store.getCapsule(seeded.capsule.id)).toMatchObject({
        status: "pending",
      });
      expect(
        await store.getProviderBindingSetByCapsule(
          seeded.capsule.id,
          seeded.capsule.environment,
        ),
      ).toBeDefined();
    }
  },
);

test("a stale lifecycle status writer cannot replace a concurrent Apply commit", async () => {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  const interleaver = postgresLifecycleInterleaver(client);
  const store = new SqlOpenTofuControlStore({ client: interleaver.client });
  const concurrentStore = new SqlOpenTofuControlStore({ client });
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_lifecycle_status_cas",
    capsuleId: "capsule_lifecycle_status_cas",
  });
  await store.putCapsule({ ...seeded.capsule, updatedAt: BEFORE });
  const service = new CapsulesService({
    store,
    now: () => new Date(LIFECYCLE_AT),
  });
  let applied:
    | { readonly state: StateVersion; readonly output: Output }
    | undefined;
  interleaver.beforeNextTransaction(async () => {
    applied = await commitConcurrentApply(concurrentStore, seeded.capsule);
  });

  const outcome = await service.patchCapsuleStatus(
    seeded.capsule.id,
    "disabled",
  ).then(
    () => "resolved",
    (error: unknown) =>
      typeof error === "object" && error !== null && "details" in error
        ? (error as { details?: { reason?: string } }).details?.reason
        : "rejected",
  );

  expect(outcome).toBe(CAPSULE_LIFECYCLE_BUSY_REASON);
  expect(applied).toBeDefined();
  expect(await store.getCapsule(seeded.capsule.id)).toMatchObject({
    currentStateVersionId: applied!.state.id,
    currentStateGeneration: applied!.state.generation,
    currentOutputId: applied!.output.id,
    status: "active",
    updatedAt: APPLY_AT,
  });
  expect(await store.getStateVersion(applied!.state.id)).toEqual(applied!.state);
  expect(await store.getOutput(applied!.output.id)).toEqual(applied!.output);
});

test("a stale auto-update toggle cannot replace a concurrent Apply commit", async () => {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  const interleaver = postgresLifecycleInterleaver(client);
  const store = new SqlOpenTofuControlStore({ client: interleaver.client });
  const concurrentStore = new SqlOpenTofuControlStore({ client });
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_lifecycle_auto_update_cas",
    capsuleId: "capsule_lifecycle_auto_update_cas",
  });
  await store.putCapsule({ ...seeded.capsule, updatedAt: BEFORE });
  const service = new CapsulesService({
    store,
    now: () => new Date(LIFECYCLE_AT),
  });
  let applied:
    | { readonly state: StateVersion; readonly output: Output }
    | undefined;
  interleaver.beforeNextTransaction(async () => {
    applied = await commitConcurrentApply(concurrentStore, seeded.capsule);
  });

  const outcome = await service.setCapsuleAutoUpdate(
    seeded.capsule.id,
    true,
  ).then(
    () => "resolved",
    (error: unknown) =>
      typeof error === "object" && error !== null && "details" in error
        ? (error as { details?: { reason?: string } }).details?.reason
        : "rejected",
  );

  expect(outcome).toBe(CAPSULE_LIFECYCLE_BUSY_REASON);
  expect(applied).toBeDefined();
  expect(await store.getCapsule(seeded.capsule.id)).toMatchObject({
    currentStateVersionId: applied!.state.id,
    currentStateGeneration: applied!.state.generation,
    currentOutputId: applied!.output.id,
    status: "active",
    updatedAt: APPLY_AT,
  });
});

test("abandonment cannot retire a Capsule after a concurrent Apply commit", async () => {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  const interleaver = postgresLifecycleInterleaver(client);
  const store = new SqlOpenTofuControlStore({ client: interleaver.client });
  const concurrentStore = new SqlOpenTofuControlStore({ client });
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_lifecycle_abandon_cas",
    capsuleId: "capsule_lifecycle_abandon_cas",
  });
  await store.putCapsule({ ...seeded.capsule, updatedAt: BEFORE });
  const service = new CapsulesService({
    store,
    now: () => new Date(LIFECYCLE_AT),
    capsuleLifecycleAdmission: async ({ capsule }, work) => {
      const current = await store.getCapsule(capsule.id);
      if (!current) throw new Error("Capsule disappeared during admission");
      return await work(current);
    },
  });
  let applied:
    | { readonly state: StateVersion; readonly output: Output }
    | undefined;
  interleaver.beforeNextTransaction(async () => {
    applied = await commitConcurrentApply(concurrentStore, seeded.capsule);
  });

  const outcome = await service.abandonUnappliedCapsule(
    seeded.capsule.id,
    "operator abandoned an unapplied Capsule",
  ).then(
    () => "resolved",
    (error: unknown) =>
      typeof error === "object" && error !== null && "details" in error
        ? (error as { details?: { reason?: string } }).details?.reason
        : "rejected",
  );

  expect(outcome).toBe(CAPSULE_LIFECYCLE_BUSY_REASON);
  expect(applied).toBeDefined();
  expect(await store.getCapsule(seeded.capsule.id)).toMatchObject({
    currentStateVersionId: applied!.state.id,
    currentStateGeneration: applied!.state.generation,
    currentOutputId: applied!.output.id,
    status: "active",
    updatedAt: APPLY_AT,
  });
});

test(
  "Capsule abandonment atomicity rolls back the Capsule when binding deletion fails",
  async () => {
    const database = new SqliteFakeD1();
    const store = new CloudflareD1OpenTofuControlStore(database);
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_abandonment_binding_failure",
      capsuleId: "capsule_abandonment_binding_failure",
      requiredProviders: ["registry.opentofu.org/examplecorp/example"],
    });
    const binding = await store.getProviderBindingSetByCapsule(
      seeded.capsule.id,
      seeded.capsule.environment,
    );
    if (!binding) throw new Error("abandonment binding fixture is incomplete");

    await database.exec(`
      CREATE TRIGGER reject_capsule_abandonment_binding_delete
      BEFORE DELETE ON provider_env_binding_sets
      BEGIN
        SELECT RAISE(ABORT, 'fixture capsule abandonment binding failure');
      END;
    `);

    const service = new CapsulesService({
      store,
      now: () => new Date(LIFECYCLE_AT),
    });
    await expect(
      service.abandonUnappliedCapsule(
        seeded.capsule.id,
        "operator abandoned an unapplied Capsule",
      ),
    ).rejects.toThrow();

    expect(await store.getCapsule(seeded.capsule.id)).toEqual(seeded.capsule);
    expect(
      await store.getProviderBindingSetByCapsule(
        seeded.capsule.id,
        seeded.capsule.environment,
      ),
    ).toEqual(binding);
  },
);

test(
  "Capsule abandonment atomicity rejects runtime evidence arriving after the safety read",
  async () => {
    const store = new RuntimeEvidenceAfterSafetyReadStore();
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_abandonment_runtime_arrival",
      capsuleId: "capsule_abandonment_runtime_arrival",
      requiredProviders: ["registry.opentofu.org/examplecorp/example"],
    });
    const binding = await store.getProviderBindingSetByCapsule(
      seeded.capsule.id,
      seeded.capsule.environment,
    );
    if (!binding) throw new Error("abandonment binding fixture is incomplete");

    const service = new CapsulesService({
      store,
      now: () => new Date(LIFECYCLE_AT),
    });
    await expect(
      service.abandonUnappliedCapsule(
        seeded.capsule.id,
        "operator abandoned an unapplied Capsule",
      ),
    ).rejects.toMatchObject({ code: "failed_precondition" });

    expect(await store.getCapsule(seeded.capsule.id)).toEqual(seeded.capsule);
    expect(
      await store.getProviderBindingSetByCapsule(
        seeded.capsule.id,
        seeded.capsule.environment,
      ),
    ).toEqual(binding);
    expect(
      await store.getBackupRun(`restore_runtime_evidence_${seeded.capsule.id}`),
    ).toMatchObject({ status: "running" });
  },
);

test("InstallConfig re-adoption uses the same host lifecycle admission as provider work", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_lifecycle_rebind_admission",
    capsuleId: "capsule_lifecycle_rebind_admission",
  });
  const target = {
    ...seeded.installConfig,
    id: "cfg_lifecycle_rebind_admission_target",
    name: "lifecycle-rebind-admission-target",
    updatedAt: LIFECYCLE_AT,
  };
  await store.putInstallConfig(target);
  let admitted = false;
  const service = new CapsulesService({
    store,
    now: () => new Date(LIFECYCLE_AT),
    capsuleLifecycleAdmission: async ({
      capsule,
      holderId,
      joinExistingHolder,
    }) => {
      admitted = true;
      expect(capsule.id).toBe(seeded.capsule.id);
      expect(holderId.startsWith("capsule-rebind_")).toBe(true);
      expect(holderId).toHaveLength("capsule-rebind_".length + 64);
      expect(joinExistingHolder).toBe(true);
      throw new Error("simulated materialization lease holder");
    },
  });

  await expect(
    service.rebindInstallConfig({
      capsuleId: seeded.capsule.id,
      targetInstallConfigId: target.id,
      expected: {
        installConfigId: seeded.installConfig.id,
        installConfigDigest: await stableJsonDigest(seeded.installConfig),
        currentStateGeneration: seeded.capsule.currentStateGeneration,
        currentStateVersionId: seeded.capsule.currentStateVersionId,
        status: seeded.capsule.status,
        executionAuthorityEpoch:
          (await store.getCapsuleExecutionAuthorityEpoch(
            seeded.capsule.id,
          )) ?? 1,
      },
      actorSubject: "principal_rebind_admission",
      reason: "exercise shared lifecycle admission",
      requestDigest: `sha256:${"c".repeat(64)}`,
    }),
  ).rejects.toThrow("simulated materialization lease holder");
  expect(admitted).toBe(true);
  expect(await store.getCapsule(seeded.capsule.id)).toMatchObject({
    installConfigId: seeded.installConfig.id,
  });
});

test("production lifecycle metadata never uses generic patchCapsule", () => {
  const root = resolve(import.meta.dir, "../../../..");
  const violations: string[] = [];
  for (const pattern of ["core/**/*.ts", "worker/src/**/*.ts"]) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      if (readFileSync(resolve(root, path), "utf8").includes(".patchCapsule(")) {
        violations.push(path);
      }
    }
  }
  expect(violations.sort()).toEqual([]);
});

test("lifecycle CAS preserves a newer Apply across every store", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_lifecycle_parity_${label}`,
      capsuleId: `capsule_lifecycle_parity_${label}`,
    });
    const epoch = await store.getCapsuleExecutionAuthorityEpoch(
      seeded.capsule.id,
    );
    expect(epoch, `${label}:epoch`).toBe(1);
    const management = await activeWorkspaceAuthority(
      store,
      seeded.capsule.workspaceId,
    );
    const expected = capsuleLifecycleExpected(seeded.capsule, epoch!);
    const applied = await commitConcurrentApply(store, seeded.capsule);

    const result = await store.updateCapsuleLifecycle({
      capsuleId: seeded.capsule.id,
      expected,
      mutation: {
        kind: "status",
        status: "error",
        expectedWorkspaceManagementAuthority: management,
      },
      updatedAt: LIFECYCLE_AT,
    });

    expect(result.kind, `${label}:result`).toBe("conflict");
    expect(await store.getCapsule(seeded.capsule.id), `${label}:capsule`)
      .toMatchObject({
        currentStateVersionId: applied.state.id,
        currentStateGeneration: applied.state.generation,
        currentOutputId: applied.output.id,
        status: "active",
        updatedAt: APPLY_AT,
      });
  }
});

test(
  "Capsule stale frozen boundary preserves active and draining observation, but refuses frozen state",
  async () => {
    const reasons = ["source-revision", "dependency-output"] as const;
    for (const [label, store] of await stores()) {
      for (const managementState of ["active", "draining"] as const) {
        for (const reason of reasons) {
          const seeded = await seedCapsuleModel(store, {
            workspaceId: `workspace_stale_${managementState}_${reason}_${label}`,
            capsuleId: `capsule_stale_${managementState}_${reason}_${label}`,
            sourceId: `source_stale_${managementState}_${reason}_${label}`,
            snapshotId: `snapshot_stale_${managementState}_${reason}_${label}`,
            installConfigId: `config_stale_${managementState}_${reason}_${label}`,
          });
          if (managementState === "draining") {
            const authority = await activeWorkspaceAuthority(
              store,
              seeded.workspace.id,
            );
            const draining = await store.beginWorkspaceDraining(
              seeded.workspace.id,
              authority,
            );
            expect(draining.status, `${label}:${reason}:drain`).toBe("started");
          }
          const result = await store.markCapsuleStale(
            markStaleInput(seeded.capsule, reason),
          );
          expect(result.kind, `${label}:${managementState}:${reason}`).toBe(
            "updated",
          );
          expect(await store.getCapsule(seeded.capsule.id)).toEqual({
            ...seeded.capsule,
            status: "stale",
            updatedAt: LIFECYCLE_AT,
          });
        }
      }

      const frozenSeed = await seedCapsuleModel(store, {
        workspaceId: `workspace_stale_frozen_${label}`,
        capsuleId: `capsule_stale_frozen_${label}`,
        sourceId: `source_stale_frozen_${label}`,
        snapshotId: `snapshot_stale_frozen_${label}`,
        installConfigId: `config_stale_frozen_${label}`,
      });
      const authority = await activeWorkspaceAuthority(
        store,
        frozenSeed.workspace.id,
      );
      const draining = await store.beginWorkspaceDraining(
        frozenSeed.workspace.id,
        authority,
      );
      if (draining.status !== "started") {
        throw new Error(`${label}: failed to start Workspace drain`);
      }
      expect(
        (await store.freezeWorkspaceManagementIfQuiescent(draining.management))
          .status,
        `${label}:freeze`,
      ).toBe("frozen");
      for (const reason of reasons) {
        expect(
          await store.markCapsuleStale(markStaleInput(frozenSeed.capsule, reason)),
          `${label}:frozen:${reason}`,
        ).toEqual({ kind: "conflict", current: frozenSeed.capsule });
        expect(await store.getCapsule(frozenSeed.capsule.id), label).toEqual(
          frozenSeed.capsule,
        );
      }

      const orphan = {
        ...frozenSeed.capsule,
        id: `capsule_stale_orphan_${label}`,
        workspaceId: `workspace_stale_missing_${label}`,
        projectId: `project_stale_orphan_${label}`,
        name: `stale-orphan-${label}`,
        slug: `stale-orphan-${label}`,
      };
      await store.putCapsule(orphan);
      expect(
        await store.markCapsuleStale(markStaleInput(orphan, reasons[0])),
        `${label}:orphan`,
      ).toEqual({ kind: "conflict", current: orphan });
      expect(await store.getCapsule(orphan.id), `${label}:orphan:unchanged`).toEqual(
        orphan,
      );
    }
  },
);

test(
  "Capsule stale frozen boundary refuses released state without mutation in durable stores",
  async () => {
    const reasons = ["source-revision", "dependency-output"] as const;
    for (const { label, store, setReleased } of await releasedStores()) {
      const seeded = await seedCapsuleModel(store, {
        workspaceId: `workspace_stale_released_${label}`,
        capsuleId: `capsule_stale_released_${label}`,
      });
      await setReleased(seeded.workspace.id);
      expect(
        (await store.getWorkspaceManagement(seeded.workspace.id))
          ?.managementState,
        `${label}:released fixture`,
      ).toBe("released");
      for (const reason of reasons) {
        expect(
          await store.markCapsuleStale(markStaleInput(seeded.capsule, reason)),
          `${label}:released:${reason}`,
        ).toEqual({ kind: "conflict", current: seeded.capsule });
        expect(await store.getCapsule(seeded.capsule.id), label).toEqual(
          seeded.capsule,
        );
      }
    }
  },
);

test("auto-update claim replay has one winner across every store", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_auto_claim_${label}`,
      capsuleId: `capsule_auto_claim_${label}`,
    });
    const current = {
      ...seeded.capsule,
      status: "stale" as const,
      autoUpdate: true,
    };
    await store.putCapsule(current);
    const management = await store.getWorkspaceManagement(current.workspaceId);
    if (!management || management.managementState !== "active") {
      throw new Error(`${label}: Workspace management is not active`);
    }
    const epoch = await store.getCapsuleExecutionAuthorityEpoch(current.id);
    const command = {
      capsuleId: current.id,
      expected: capsuleLifecycleExpected(current, epoch!),
      mutation: {
        kind: "auto-update-claim" as const,
        sourceSnapshotId: `snapshot_claim_${label}`,
        expectedWorkspaceManagementAuthority: {
          workspaceId: management.workspaceId,
          managementState: "active" as const,
          managementEpoch: management.managementEpoch,
        },
      },
      updatedAt: LIFECYCLE_AT,
    };

    expect((await store.updateCapsuleLifecycle(command)).kind, label).toBe(
      "updated",
    );
    expect((await store.updateCapsuleLifecycle(command)).kind, label).toBe(
      "unchanged",
    );
    expect(
      (await store.getCapsule(current.id))
        ?.autoUpdateAttemptSourceSnapshotId,
      label,
    ).toBe(command.mutation.sourceSnapshotId);
  }
});

test("atomic abandonment advances execution authority once and observes exact replay", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_destroy_epoch_${label}`,
      capsuleId: `capsule_destroy_epoch_${label}`,
    });
    const epoch = await store.getCapsuleExecutionAuthorityEpoch(
      seeded.capsule.id,
    );
    expect(epoch, `${label}:initial epoch`).toBe(1);
    const management = await activeWorkspaceAuthority(
      store,
      seeded.capsule.workspaceId,
    );
    const command = {
      capsuleId: seeded.capsule.id,
      expected: {
        ...capsuleLifecycleExpected(seeded.capsule, epoch!),
        workspaceId: seeded.capsule.workspaceId,
        environment: seeded.capsule.environment,
      },
      expectedWorkspaceManagementAuthority: management,
      updatedAt: LIFECYCLE_AT,
    };

    const first = await store.commitCapsuleAbandonment(command);
    expect(first.kind, `${label}:first result`).toBe("updated");
    expect(first.kind === "updated" ? first.capsule.status : undefined, label)
      .toBe("destroyed");
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id),
      `${label}:destroy epoch`,
    ).toBe(2);

    expect(
      (await store.commitCapsuleAbandonment(command)).kind,
      `${label}:exact replay`,
    ).toBe("unchanged");
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id),
      `${label}:replay epoch`,
    ).toBe(2);
  }
});

test("D1 lifecycle CAS uses one fixed bounded conditional update", async () => {
  const records: RecordedD1Statement[] = [];
  const store = new CloudflareD1OpenTofuControlStore(
    recordingD1(new SqliteFakeD1(), records),
  );
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_d1_lifecycle_statement",
    capsuleId: "capsule_d1_lifecycle_statement",
  });
  const current = {
    ...seeded.capsule,
    status: "stale" as const,
    autoUpdate: true,
  };
  await store.putCapsule(current);
  const management = await store.getWorkspaceManagement(current.workspaceId);
  if (!management || management.managementState !== "active") {
    throw new Error("D1 lifecycle statement Workspace management is not active");
  }
  const epoch = await store.getCapsuleExecutionAuthorityEpoch(current.id);
  records.splice(0);

  const result = await store.updateCapsuleLifecycle({
    capsuleId: current.id,
    expected: capsuleLifecycleExpected(current, epoch!),
    mutation: {
      kind: "auto-update-claim",
      sourceSnapshotId: "snapshot_d1_lifecycle_statement",
      expectedWorkspaceManagementAuthority: {
        workspaceId: management.workspaceId,
        managementState: "active" as const,
        managementEpoch: management.managementEpoch,
      },
    },
    updatedAt: LIFECYCLE_AT,
  });

  expect(result.kind).toBe("updated");
  const writes = records.filter((record) =>
    /^update\s+["`]capsules["`]/iu.test(record.sql.trim()),
  );
  expect(writes).toHaveLength(1);
  const [write] = writes;
  expect(write).toBeDefined();
  expect(write!.parameters.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  expect(new TextEncoder().encode(write!.sql).byteLength).toBeLessThan(16_384);
  for (const requiredFence of [
    "execution_authority_epoch",
    "current_state_version_id",
    "current_state_generation",
    "current_output_snapshot_id",
    "status",
    "autoUpdateAttemptSourceSnapshotId",
  ]) {
    expect(write!.sql, requiredFence).toContain(requiredFence);
  }
});

/**
 * The host public-origin reservation is Capsule metadata like any other, so it
 * has to survive the same three backends and the same CAS fence. It is written
 * outside an Apply commit — a plan asks the host to fix an origin — which is
 * exactly why it must not be a whole-record patch: the Capsule it lands on may
 * have moved under a concurrent Apply.
 */
test("a public-origin reservation round-trips and is fenced across every store", async () => {
  const reservation = {
    reservationRef: "tshpr_opaque_reference",
    origin: "https://yurucommu-abcdef.takoform.test",
    requestedLabel: "yurucommu-abcdef",
    reservedAt: "2026-08-29T01:00:00.000Z",
  };
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_public_origin_${label}`,
      capsuleId: `capsule_public_origin_${label}`,
    });
    const epoch = await store.getCapsuleExecutionAuthorityEpoch(
      seeded.capsule.id,
    );
    const expected = capsuleLifecycleExpected(seeded.capsule, epoch!);

    const held = await store.updateCapsuleLifecycle({
      capsuleId: seeded.capsule.id,
      expected,
      mutation: { kind: "public-origin-reservation", reservation },
      updatedAt: LIFECYCLE_AT,
    });
    expect(held.kind, `${label}:held`).toBe("updated");
    expect(
      (await store.getCapsule(seeded.capsule.id))?.publicOriginReservation,
      `${label}:stored`,
    ).toEqual(reservation);

    // Releasing retires the record in place; every backend must keep the added
    // member rather than drop or flatten the object it merges.
    const current = await store.getCapsule(seeded.capsule.id);
    const releasedAt = "2026-08-29T02:00:00.000Z";
    const released = await store.updateCapsuleLifecycle({
      capsuleId: seeded.capsule.id,
      expected: capsuleLifecycleExpected(current!, epoch!),
      mutation: {
        kind: "public-origin-reservation",
        reservation: { ...reservation, releasedAt },
      },
      updatedAt: releasedAt,
    });
    expect(released.kind, `${label}:released`).toBe("updated");
    expect(
      (await store.getCapsule(seeded.capsule.id))?.publicOriginReservation,
      `${label}:retired`,
    ).toEqual({ ...reservation, releasedAt });

    // The reservation is deliberately NOT part of the fenced revision: it is
    // written outside an Apply and must not make every other lifecycle
    // mutation conflict. What it must never do is win against a Capsule that
    // moved, so a plan-time write against a pre-Apply revision loses.
    const applied = await commitConcurrentApply(
      store,
      (await store.getCapsule(seeded.capsule.id))!,
    );
    const lost = await store.updateCapsuleLifecycle({
      capsuleId: seeded.capsule.id,
      expected,
      mutation: { kind: "public-origin-reservation", reservation },
      updatedAt: LIFECYCLE_AT,
    });
    expect(lost.kind, `${label}:stale`).toBe("conflict");
    const survivor = await store.getCapsule(seeded.capsule.id);
    expect(survivor?.publicOriginReservation?.releasedAt, `${label}:kept`).toBe(
      releasedAt,
    );
    // The Apply's own cursor is intact: the losing write touched nothing.
    expect(survivor?.currentStateVersionId, `${label}:cursor`).toBe(
      applied.state.id,
    );
  }
});
