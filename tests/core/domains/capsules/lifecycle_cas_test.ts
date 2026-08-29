import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Capsule } from "takosumi-contract/capsules";
import type { Output } from "takosumi-contract/outputs";
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
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import type {
  D1Database,
  D1PreparedStatement,
} from "../../../../worker/src/bindings.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
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

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function postgresLifecycleInterleaver(inner: SqlClient): {
  readonly client: SqlClient;
  beforeNextWrite(callback: () => Promise<void>): void;
} {
  let beforeNext: (() => Promise<void>) | undefined;
  return {
    client: {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: SqlParameters,
      ) {
        const normalized = sql.trimStart().toLowerCase();
        if (
          normalized.startsWith('update "takosumi_capsules"') &&
          normalized.includes('"execution_authority_epoch"') &&
          normalized.includes('"installation_json" ||')
        ) {
          const before = beforeNext;
          beforeNext = undefined;
          await before?.();
        }
        return await inner.query<Row>(sql, parameters);
      },
      transaction: (work) => inner.transaction(work),
    },
    beforeNextWrite(callback) {
      beforeNext = callback;
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
  interleaver.beforeNextWrite(async () => {
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
  interleaver.beforeNextWrite(async () => {
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
    capsuleAbandonAdmission: async ({ capsule }, work) => {
      const current = await store.getCapsule(capsule.id);
      if (!current) throw new Error("Capsule disappeared during admission");
      return await work(current);
    },
  });
  let applied:
    | { readonly state: StateVersion; readonly output: Output }
    | undefined;
  interleaver.beforeNextWrite(async () => {
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
    const expected = capsuleLifecycleExpected(seeded.capsule, epoch!);
    const applied = await commitConcurrentApply(store, seeded.capsule);

    const result = await store.updateCapsuleLifecycle({
      capsuleId: seeded.capsule.id,
      expected,
      mutation: { kind: "status", status: "destroyed" },
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
    const epoch = await store.getCapsuleExecutionAuthorityEpoch(current.id);
    const command = {
      capsuleId: current.id,
      expected: capsuleLifecycleExpected(current, epoch!),
      mutation: {
        kind: "auto-update-claim" as const,
        sourceSnapshotId: `snapshot_claim_${label}`,
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

test("destroy lifecycle CAS advances execution authority once and rejects stale replay", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_destroy_epoch_${label}`,
      capsuleId: `capsule_destroy_epoch_${label}`,
    });
    const epoch = await store.getCapsuleExecutionAuthorityEpoch(
      seeded.capsule.id,
    );
    expect(epoch, `${label}:initial epoch`).toBe(1);
    const command = {
      capsuleId: seeded.capsule.id,
      expected: capsuleLifecycleExpected(seeded.capsule, epoch!),
      mutation: { kind: "status" as const, status: "destroyed" as const },
      updatedAt: LIFECYCLE_AT,
    };

    const first = await store.updateCapsuleLifecycle(command);
    expect(first.kind, `${label}:first result`).toBe("updated");
    expect(first.kind === "updated" ? first.capsule.status : undefined, label)
      .toBe("destroyed");
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id),
      `${label}:destroy epoch`,
    ).toBe(2);

    expect(
      (await store.updateCapsuleLifecycle(command)).kind,
      `${label}:stale replay`,
    ).toBe("conflict");
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
  const epoch = await store.getCapsuleExecutionAuthorityEpoch(current.id);
  records.splice(0);

  const result = await store.updateCapsuleLifecycle({
    capsuleId: current.id,
    expected: capsuleLifecycleExpected(current, epoch!),
    mutation: {
      kind: "auto-update-claim",
      sourceSnapshotId: "snapshot_d1_lifecycle_statement",
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
