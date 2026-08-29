import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ApplyRun,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type {
  Capsule,
  InstallConfig,
  InstallConfigCommittedPostApplyRecoveryProof,
} from "takosumi-contract/install-configs";
import type { Output } from "takosumi-contract/outputs";
import type { Run } from "takosumi-contract/runs";
import type { StateVersion } from "takosumi-contract/state-versions";

import {
  stableJsonDigest,
  stableStringify,
} from "../../../../core/adapters/source/digest.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import {
  InMemoryOpenTofuControlStore,
  type CapsuleInstallConfigRebindInput,
  type CapsuleInstallConfigRebindResult,
  type MarkCapsuleStaleCommand,
  type CapsulePatch,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../../worker/src/bindings.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T00:00:01.000Z";
const WORKSPACE_ID = "workspace_rebind";
const pgClients: PGliteSqlClient[] = [];

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

function config(id: string): InstallConfig {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name: id,
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function capsule(id: string, installConfigId: string): Capsule {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    projectId: `project_${id}`,
    name: id,
    slug: id,
    sourceId: `source_${id}`,
    installConfigId,
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function seedRebind(
  store: OpenTofuControlStore,
  suffix: string,
): Promise<{
  readonly capsule: Capsule;
  readonly previous: InstallConfig;
  readonly target: InstallConfig;
  readonly next: InstallConfig;
}> {
  const previous = config(`config_previous_${suffix}`);
  const target = config(`config_target_${suffix}`);
  const next = config(`config_next_${suffix}`);
  const row = capsule(`capsule_${suffix}`, previous.id);
  await store.putInstallConfig(previous);
  await store.putInstallConfig(target);
  await store.putInstallConfig(next);
  await store.putCapsule(row);
  return { capsule: row, previous, target, next };
}

async function rebind(
  store: OpenTofuControlStore,
  input: {
    readonly capsule: Capsule;
    readonly previous: InstallConfig;
    readonly target: InstallConfig;
    readonly epoch?: number;
  },
): Promise<CapsuleInstallConfigRebindResult> {
  return await store.rebindCapsuleInstallConfig(await rebindInput(input));
}

async function rebindInput(input: {
  readonly capsule: Capsule;
  readonly previous: InstallConfig;
  readonly target: InstallConfig;
  readonly epoch?: number;
}): Promise<CapsuleInstallConfigRebindInput> {
  return {
    capsuleId: input.capsule.id,
    targetInstallConfigId: input.target.id,
    expected: {
      installConfigId: input.previous.id,
      installConfigDigest: await stableJsonDigest(input.previous),
      targetInstallConfigDigest: await stableJsonDigest(input.target),
      currentStateGeneration: input.capsule.currentStateGeneration,
      currentStateVersionId: input.capsule.currentStateVersionId,
      status: input.capsule.status,
      executionAuthorityEpoch: input.epoch ?? 1,
    },
    updatedAt: LATER,
  };
}

interface RecordedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

type RawD1PreparedStatement = D1PreparedStatement & {
  raw<T = unknown[]>(): Promise<T[]>;
};

type BeforePostgresRebindWrite = (
  transaction: SqlTransaction,
) => Promise<void>;

function postgresRebindInterleaver(inner: SqlClient): {
  readonly client: SqlClient;
  readonly rebindWrites: RecordedStatement[];
  beforeNextRebindWrite(callback: BeforePostgresRebindWrite): void;
} {
  let beforeNext: BeforePostgresRebindWrite | undefined;
  const rebindWrites: RecordedStatement[] = [];

  const wrapTransaction = (transaction: SqlTransaction): SqlTransaction => {
    const wrapped: SqlTransaction = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: SqlParameters,
      ) {
        if (isPostgresCapsuleRebindWrite(sql)) {
          rebindWrites.push({ sql, parameters: positional(parameters) });
          const before = beforeNext;
          beforeNext = undefined;
          await before?.(wrapped);
        }
        return await transaction.query<Row>(sql, parameters);
      },
      transaction: (nested) => Promise.resolve(nested(wrapped)),
    };
    return wrapped;
  };

  return {
    client: {
      query: (sql, parameters) => inner.query(sql, parameters),
      transaction: (work) =>
        inner.transaction((transaction) => work(wrapTransaction(transaction))),
    },
    rebindWrites,
    beforeNextRebindWrite(callback) {
      beforeNext = callback;
    },
  };
}

class D1RebindInterleaver implements D1Database {
  #beforeNext?: () => Promise<void>;
  readonly rebindWrites: RecordedStatement[] = [];

  constructor(private readonly inner: D1Database) {}

  beforeNextRebindWrite(callback: () => Promise<void>): void {
    this.#beforeNext = callback;
  }

  prepare(query: string): D1PreparedStatement {
    return this.#wrapStatement(query, this.inner.prepare(query), []);
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    return this.inner.batch<T>(statements);
  }

  #wrapStatement(
    query: string,
    inner: D1PreparedStatement,
    parameters: readonly unknown[],
  ): D1PreparedStatement {
    const wrapped = {
      bind: (...values) =>
        this.#wrapStatement(query, inner.bind(...values), values),
      first: <T>() => inner.first<T>(),
      all: <T>() => inner.all<T>(),
      raw: <T = unknown[]>() => (inner as RawD1PreparedStatement).raw<T>(),
      run: async <T>() => {
        if (isD1CapsuleRebindWrite(query)) {
          this.rebindWrites.push({ sql: query, parameters });
          const before = this.#beforeNext;
          this.#beforeNext = undefined;
          await before?.();
        }
        return await inner.run<T>();
      },
    };
    return wrapped as D1PreparedStatement;
  }
}

function positional(parameters?: SqlParameters): readonly unknown[] {
  return Array.isArray(parameters) ? parameters : [];
}

function isPostgresCapsuleRebindWrite(sql: string): boolean {
  const normalized = sql.trimStart().toLowerCase();
  return normalized.startsWith('update "takosumi_capsules"') &&
    normalized.includes('"execution_authority_epoch" = "takosumi_capsules"."execution_authority_epoch" +');
}

function isD1CapsuleRebindWrite(sql: string): boolean {
  const normalized = sql.trimStart().toLowerCase();
  return normalized.startsWith('update "capsules"') &&
    normalized.includes('"execution_authority_epoch" = "capsules"."execution_authority_epoch" +');
}

function isPostgresCapsuleStaleWrite(sql: string): boolean {
  const normalized = sql.trimStart().toLowerCase();
  return normalized.startsWith('update "takosumi_capsules"') &&
    normalized.includes('"installation_json" =') &&
    normalized.includes('"takosumi_capsules"."id" =');
}

function isD1CapsuleStaleWrite(sql: string): boolean {
  const normalized = sql.trimStart().toLowerCase();
  return normalized.startsWith('update "capsules"') &&
    normalized.includes('"record_json" =') &&
    normalized.includes('"capsules"."id" =');
}

function postgresStaleInterleaver(inner: SqlClient): {
  readonly client: SqlClient;
  readonly staleWrites: RecordedStatement[];
  beforeNextStaleWrite(callback: () => Promise<void>): void;
} {
  let beforeNext: (() => Promise<void>) | undefined;
  const staleWrites: RecordedStatement[] = [];
  return {
    client: {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: SqlParameters,
      ) {
        if (isPostgresCapsuleStaleWrite(sql)) {
          staleWrites.push({ sql, parameters: positional(parameters) });
          const before = beforeNext;
          beforeNext = undefined;
          await before?.();
        }
        return await inner.query<Row>(sql, parameters);
      },
      transaction: (work) => inner.transaction(work),
    },
    staleWrites,
    beforeNextStaleWrite(callback) {
      beforeNext = callback;
    },
  };
}

class D1StaleInterleaver implements D1Database {
  #beforeNext?: () => Promise<void>;
  readonly staleWrites: RecordedStatement[] = [];

  constructor(private readonly inner: D1Database) {}

  beforeNextStaleWrite(callback: () => Promise<void>): void {
    this.#beforeNext = callback;
  }

  prepare(query: string): D1PreparedStatement {
    return this.#wrapStatement(query, this.inner.prepare(query), []);
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    return this.inner.batch<T>(statements);
  }

  #wrapStatement(
    query: string,
    inner: D1PreparedStatement,
    parameters: readonly unknown[],
  ): D1PreparedStatement {
    const wrapped = {
      bind: (...values) =>
        this.#wrapStatement(query, inner.bind(...values), values),
      first: <T>() => inner.first<T>(),
      all: <T>() => inner.all<T>(),
      raw: <T = unknown[]>() => (inner as RawD1PreparedStatement).raw<T>(),
      run: async <T>() => {
        if (isD1CapsuleStaleWrite(query)) {
          this.staleWrites.push({ sql: query, parameters });
          const before = this.#beforeNext;
          this.#beforeNext = undefined;
          await before?.();
        }
        return await inner.run<T>();
      },
    };
    return wrapped as D1PreparedStatement;
  }
}

function sqlWhere(sql: string): string {
  const index = sql.toLowerCase().indexOf(" where ");
  if (index < 0) throw new Error(`expected UPDATE WHERE clause: ${sql}`);
  return sql.slice(index);
}

function jsonParameterMatches(parameter: unknown, expected: unknown): boolean {
  if (typeof parameter === "string") {
    try {
      return stableStringify(JSON.parse(parameter)) === stableStringify(expected);
    } catch {
      return false;
    }
  }
  return stableStringify(parameter) === stableStringify(expected);
}

function nonAuthorityCapsulePatch(suffix: string): CapsulePatch {
  return {
    autoUpdate: true,
    compatibilityStatus: "needs_patch",
    autoUpdateAttemptSourceSnapshotId: `snapshot_non_authority_${suffix}`,
    // Deliberately collide with the observed audit timestamp. updatedAt is not
    // a revision and must not make a changed full record pass the rebind CAS.
    updatedAt: NOW,
  };
}

function markStaleInput(
  expected: Capsule,
  reason: MarkCapsuleStaleCommand["reason"] = "source-revision",
): MarkCapsuleStaleCommand {
  return {
    capsuleId: expected.id,
    expected,
    reason,
    updatedAt: LATER,
  };
}

function planRun(input: {
  readonly id: string;
  readonly capsuleId: string;
  readonly epoch: number;
  readonly consumed?: boolean;
  readonly status?: PlanRun["status"];
}): PlanRun {
  return {
    id: input.id,
    workspaceId: WORKSPACE_ID,
    capsuleId: input.capsuleId,
    capsuleContext: {
      workspaceId: WORKSPACE_ID,
      capsuleId: input.capsuleId,
      environment: "production",
    },
    capsuleCurrentStateVersionId: null,
    capsuleExecutionAuthorityEpoch: input.epoch,
    source: {
      kind: "git",
      url: "https://git.example.test/app.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    sourceSnapshotId: "snapshot_rebind",
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: input.status ?? "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: "sha256:plan",
    planArtifact: {
      kind: "runner-local",
      ref: `runner-local://plan/${input.id}`,
      digest: "sha256:plan",
    },
    baseStateGeneration: 0,
    ...(input.consumed ? { appliedApplyRunId: `apply_${input.id}` } : {}),
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function applyRun(input: {
  readonly id: string;
  readonly capsuleId: string;
  readonly operation?: "update" | "destroy";
  readonly status: ApplyRun["status"];
  readonly providerDispatched?: boolean;
  readonly started?: boolean;
}): ApplyRun {
  const planRunId = `plan_${input.id}`;
  return {
    id: input.id,
    planRunId,
    workspaceId: WORKSPACE_ID,
    capsuleId: input.capsuleId,
    operation: input.operation ?? "update",
    runnerProfileId: "opentofu-default",
    status: input.status,
    expected: {
      planRunId,
      capsuleId: input.capsuleId,
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:plan",
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: input.providerDispatched
      ? [
          {
            id: `audit_${input.id}`,
            type: "apply.failed",
            at: 2,
            data: { providerDispatched: true },
          },
        ]
      : [],
    createdAt: 1,
    updatedAt: 2,
    ...(input.started ? { startedAt: 1 } : {}),
    ...(["succeeded", "failed", "expired"].includes(input.status)
      ? { finishedAt: 2 }
      : {}),
  };
}

async function seedCommittedPostApplyRecovery(
  store: OpenTofuControlStore,
  seeded: Awaited<ReturnType<typeof seedRebind>>,
  suffix: string,
): Promise<{
  readonly capsule: Capsule;
  readonly proof: InstallConfigCommittedPostApplyRecoveryProof;
  readonly target: InstallConfig;
  readonly failedApply: ApplyRun;
  readonly stateVersion: StateVersion;
  readonly output: Output;
}> {
  const failedApplyRunId = `apply_failed_post_apply_${suffix}`;
  const stateVersionId = `state_failed_post_apply_${suffix}`;
  const outputId = `output_failed_post_apply_${suffix}`;
  const stateGeneration = 3;
  const current = {
    ...seeded.capsule,
    status: "error" as const,
    currentStateVersionId: stateVersionId,
    currentOutputId: outputId,
    currentStateGeneration: stateGeneration,
  };
  await store.putCapsule(current);
  const stateVersion: StateVersion = {
    id: stateVersionId,
    workspaceId: current.workspaceId,
    capsuleId: current.id,
    environment: current.environment,
    generation: stateGeneration,
    stateRef: `state/ref/${suffix}`,
    digest: `sha256:${"a".repeat(64)}`,
    createdByRunId: failedApplyRunId,
    createdAt: NOW,
  };
  const output: Output = {
    id: outputId,
    workspaceId: current.workspaceId,
    capsuleId: current.id,
    stateGeneration,
    rawArtifactRef: `output/ref/${suffix}`,
    publicOutputs: {},
    workspaceOutputs: {},
    outputDigest: `sha256:${"b".repeat(64)}`,
    createdAt: NOW,
  };
  const failedApply: ApplyRun = {
    ...applyRun({
      id: failedApplyRunId,
      capsuleId: current.id,
      status: "failed",
      providerDispatched: true,
      started: true,
    }),
    stateVersionId,
    outputId,
    auditEvents: [
      {
        id: `audit_apply_completed_${suffix}`,
        type: "apply.completed",
        at: 2,
        data: { stateVersionId, outputId },
      },
      {
        id: `audit_apply_failed_${suffix}`,
        type: "apply.failed",
        at: 2,
        data: {
          providerDispatched: true,
          providerApplySucceeded: true,
          lifecycleActionPhase: "post_apply",
          lifecycleActionStatus: "failed",
        },
      },
    ],
  };
  await store.putStateVersion(stateVersion);
  await store.putOutput(output);
  await store.putApplyRun(failedApply);
  const proofCore = {
    failedApplyRunId,
    failedApplyRunDigest: await stableJsonDigest(failedApply),
    stateVersionId,
    stateVersionDigest: await stableJsonDigest(stateVersion),
    outputId,
    outputDigest: await stableJsonDigest(output),
    stateGeneration,
  };
  const proof = {
      ...proofCore,
      evidenceDigest: await stableJsonDigest({
        contract:
          "takosumi.capsule-install-config-committed-post-apply-recovery/v1",
        ...proofCore,
      }),
    };
  const target: InstallConfig = {
    ...seeded.target,
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: `snapshot_${suffix}`,
      reAdoption: {
        capsuleId: current.id,
        actorSubject: "subject_test",
        reason: "Recover exact committed post-apply state",
        idempotencyKeyHash: `sha256:${"c".repeat(64)}`,
        requestDigest: `sha256:${"d".repeat(64)}`,
        previousInstallConfigId: seeded.previous.id,
        previousInstallConfigDigest: await stableJsonDigest(seeded.previous),
        previousCapsuleStatus: current.status,
        previousStateGeneration: current.currentStateGeneration,
        previousStateVersionId: current.currentStateVersionId,
        previousExecutionAuthorityEpoch: 1,
        authorityGuard: `sha256:${"e".repeat(64)}`,
        committedPostApplyRecovery: proof,
        derivedTargetDigest: `sha256:${"f".repeat(64)}`,
        baseInstallConfigId: seeded.previous.id,
        sourceSnapshotId: `snapshot_${suffix}`,
      },
    },
  };
  await store.putInstallConfig(target);
  return {
    capsule: current,
    proof,
    target,
    failedApply,
    stateVersion,
    output,
  };
}

async function recoveryRebindInput(
  seeded: Awaited<ReturnType<typeof seedRebind>>,
  recovery: Awaited<ReturnType<typeof seedCommittedPostApplyRecovery>>,
): Promise<CapsuleInstallConfigRebindInput> {
  const input = await rebindInput({
    ...seeded,
    capsule: recovery.capsule,
    target: recovery.target,
  });
  return {
    ...input,
    expected: {
      ...input.expected,
      committedPostApplyRecovery: recovery.proof,
    },
  };
}

async function recoveryProofWith(
  proof: InstallConfigCommittedPostApplyRecoveryProof,
  overrides: Partial<
    Omit<InstallConfigCommittedPostApplyRecoveryProof, "evidenceDigest">
  >,
): Promise<InstallConfigCommittedPostApplyRecoveryProof> {
  const proofCore = {
    failedApplyRunId:
      overrides.failedApplyRunId ?? proof.failedApplyRunId,
    failedApplyRunDigest:
      overrides.failedApplyRunDigest ?? proof.failedApplyRunDigest,
    stateVersionId: overrides.stateVersionId ?? proof.stateVersionId,
    stateVersionDigest:
      overrides.stateVersionDigest ?? proof.stateVersionDigest,
    outputId: overrides.outputId ?? proof.outputId,
    outputDigest: overrides.outputDigest ?? proof.outputDigest,
    stateGeneration: overrides.stateGeneration ?? proof.stateGeneration,
  };
  return {
    ...proofCore,
    evidenceDigest: await stableJsonDigest({
      contract:
        "takosumi.capsule-install-config-committed-post-apply-recovery/v1",
      ...proofCore,
    }),
  };
}

async function replaceRecoveryProof(
  store: OpenTofuControlStore,
  recovery: Awaited<ReturnType<typeof seedCommittedPostApplyRecovery>>,
  proof: InstallConfigCommittedPostApplyRecoveryProof,
): Promise<Awaited<ReturnType<typeof seedCommittedPostApplyRecovery>>> {
  const receipt = recovery.target.internal?.reAdoption;
  if (!receipt) throw new Error("recovery target receipt is missing");
  const target: InstallConfig = {
    ...recovery.target,
    internal: {
      ...recovery.target.internal!,
      reAdoption: {
        ...receipt,
        committedPostApplyRecovery: proof,
      },
    },
  };
  await store.putInstallConfig(target);
  return { ...recovery, proof, target };
}

function restoreRun(input: {
  readonly id: string;
  readonly capsuleId: string;
  readonly status: Run["status"];
}): Run {
  return {
    id: input.id,
    workspaceId: WORKSPACE_ID,
    capsuleId: input.capsuleId,
    environment: "production",
    type: "restore",
    status: input.status,
    backupId: `backup_${input.id}`,
    restoreStateGeneration: 0,
    createdBy: "operator",
    createdAt: NOW,
    ...(input.status !== "queued" ? { startedAt: NOW } : {}),
    ...(["succeeded", "failed", "expired"].includes(input.status)
      ? { finishedAt: LATER }
      : {}),
  };
}

test("InstallConfig rebind is CAS-fenced, idempotent, and epoch-advancing across every store", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedRebind(store, `basic_${label}`);
    const updated = await rebind(store, seeded);
    expect(updated.status, label).toBe("updated");
    expect(updated.status === "updated" && updated.capsule.installConfigId, label)
      .toBe(seeded.target.id);
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id),
      label,
    ).toBe(2);

    const replayed = await rebind(store, seeded);
    expect(replayed.status, label).toBe("replayed");

    const stale = await rebind(store, {
      ...seeded,
      target: seeded.next,
    });
    expect(stale.status, label).toBe("conflict");
  }
});

test("rebind cannot erase an observed Capsule's concurrent non-authority JSON patch", async () => {
  const memory = new InMemoryOpenTofuControlStore();
  const memorySeed = await seedRebind(memory, "capsule_json_memory");
  const memoryInput = await rebindInput(memorySeed);
  const memoryRebind = memory.rebindCapsuleInstallConfig(memoryInput);
  await memory.patchCapsule(
    memorySeed.capsule.id,
    nonAuthorityCapsulePatch("memory"),
  );
  const memoryResult = await memoryRebind;
  expect(memoryResult.status).toBe("updated");
  expect(memoryResult.status === "updated" && memoryResult.capsule).toMatchObject(
    {
      ...nonAuthorityCapsulePatch("memory"),
      installConfigId: memorySeed.target.id,
      updatedAt: LATER,
    },
  );
  expect(
    await memory.getCapsuleExecutionAuthorityEpoch(memorySeed.capsule.id),
  ).toBe(2);
  expect(await memory.listActivityEvents(WORKSPACE_ID)).toEqual([]);

  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const pgInterleaving = postgresRebindInterleaver(pg);
  const pgStore = new SqlOpenTofuControlStore({
    client: pgInterleaving.client,
  });
  const pgSeed = await seedRebind(pgStore, "capsule_json_pg");
  pgInterleaving.beforeNextRebindWrite(async (transaction) => {
    const concurrentStore = new SqlOpenTofuControlStore({
      client: transaction,
    });
    await concurrentStore.patchCapsule(
      pgSeed.capsule.id,
      nonAuthorityCapsulePatch("pg"),
    );
  });
  const pgResult = await rebind(pgStore, pgSeed);
  expect(pgResult.status).toBe("conflict");
  expect(await pgStore.getCapsule(pgSeed.capsule.id)).toMatchObject({
    installConfigId: pgSeed.previous.id,
    ...nonAuthorityCapsulePatch("pg"),
  });
  expect(await pgStore.getCapsuleExecutionAuthorityEpoch(pgSeed.capsule.id))
    .toBe(1);
  expect(await pgStore.listActivityEvents(WORKSPACE_ID)).toEqual([]);
  expect(pgInterleaving.rebindWrites).toHaveLength(1);
  const pgWhere = sqlWhere(pgInterleaving.rebindWrites[0]!.sql);
  expect(pgWhere).toContain(
    '"takosumi_capsules"."installation_json" = $',
  );
  expect(
    pgInterleaving.rebindWrites[0]!.parameters.some((parameter) =>
      jsonParameterMatches(parameter, pgSeed.capsule)
    ),
  ).toBe(true);

  const d1 = new SqliteFakeD1();
  const d1Interleaving = new D1RebindInterleaver(d1);
  const d1Store = new CloudflareD1OpenTofuControlStore(d1Interleaving);
  const d1Seed = await seedRebind(d1Store, "capsule_json_d1");
  d1Interleaving.beforeNextRebindWrite(async () => {
    const concurrentStore = new CloudflareD1OpenTofuControlStore(d1);
    await concurrentStore.patchCapsule(
      d1Seed.capsule.id,
      nonAuthorityCapsulePatch("d1"),
    );
  });
  const d1Result = await rebind(d1Store, d1Seed);
  expect(d1Result.status).toBe("conflict");
  expect(await d1Store.getCapsule(d1Seed.capsule.id)).toMatchObject({
    installConfigId: d1Seed.previous.id,
    ...nonAuthorityCapsulePatch("d1"),
  });
  expect(await d1Store.getCapsuleExecutionAuthorityEpoch(d1Seed.capsule.id))
    .toBe(1);
  expect(await d1Store.listActivityEvents(WORKSPACE_ID)).toEqual([]);
  expect(d1Interleaving.rebindWrites).toHaveLength(1);
  const d1Where = sqlWhere(d1Interleaving.rebindWrites[0]!.sql);
  expect(d1Where).toContain('"capsules"."record_json" = ?');
  expect(
    d1Interleaving.rebindWrites[0]!.parameters.some((parameter) =>
      jsonParameterMatches(parameter, d1Seed.capsule)
    ),
  ).toBe(true);
});

test("markCapsuleStale returns typed exact-record CAS outcomes across every store", async () => {
  for (const [label, store] of await stores()) {
    const missing = capsule(`capsule_stale_missing_${label}`, "missing_config");
    expect(
      await store.markCapsuleStale(markStaleInput(missing)),
      `${label}:missing`,
    ).toEqual({ kind: "not-found" });

    const updateSeed = await seedRebind(store, `stale_update_${label}`);
    const updated = await store.markCapsuleStale(
      markStaleInput(updateSeed.capsule),
    );
    expect(updated.kind, `${label}:updated`).toBe("updated");
    expect(updated.kind === "updated" && updated.capsule, label).toEqual({
      ...updateSeed.capsule,
      status: "stale",
      updatedAt: LATER,
    });

    const conflictSeed = await seedRebind(store, `stale_conflict_${label}`);
    const newer = (await store.patchCapsule(conflictSeed.capsule.id, {
      currentStateVersionId: `state_newer_${label}`,
      currentStateGeneration: 7,
      status: "error",
      autoUpdate: true,
      compatibilityStatus: "needs_patch",
      updatedAt: NOW,
    }))!;
    const conflict = await store.markCapsuleStale(
      markStaleInput(conflictSeed.capsule, "dependency-output"),
    );
    expect(conflict, `${label}:conflict`).toEqual({
      kind: "conflict",
      current: newer,
    });
    expect(await store.getCapsule(conflictSeed.capsule.id), label).toEqual(
      newer,
    );
  }
});

test("markCapsuleStale cannot erase a newer Postgres or D1 Capsule committed at its write boundary", async () => {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const pgInterleaving = postgresStaleInterleaver(pg);
  const pgStore = new SqlOpenTofuControlStore({
    client: pgInterleaving.client,
  });
  const pgConcurrentStore = new SqlOpenTofuControlStore({ client: pg });
  const pgSeed = await seedRebind(pgStore, "stale_race_pg");
  let pgNewer: Capsule | undefined;
  pgInterleaving.beforeNextStaleWrite(async () => {
    pgNewer = await pgConcurrentStore.patchCapsule(pgSeed.capsule.id, {
      currentStateVersionId: "state_newer_pg",
      currentStateGeneration: 8,
      status: "error",
      autoUpdate: true,
      compatibilityStatus: "needs_patch",
      updatedAt: NOW,
    });
  });
  expect(
    await pgStore.markCapsuleStale(markStaleInput(pgSeed.capsule)),
  ).toEqual({ kind: "conflict", current: pgNewer });
  expect(await pgStore.getCapsule(pgSeed.capsule.id)).toEqual(pgNewer);
  expect(pgInterleaving.staleWrites).toHaveLength(1);
  expect(sqlWhere(pgInterleaving.staleWrites[0]!.sql)).toContain(
    '"takosumi_capsules"."installation_json" = $',
  );
  expect(
    pgInterleaving.staleWrites[0]!.parameters.some((parameter) =>
      jsonParameterMatches(parameter, pgSeed.capsule)
    ),
  ).toBe(true);

  const d1 = new SqliteFakeD1();
  const d1Interleaving = new D1StaleInterleaver(d1);
  const d1Store = new CloudflareD1OpenTofuControlStore(d1Interleaving);
  const d1ConcurrentStore = new CloudflareD1OpenTofuControlStore(d1);
  const d1Seed = await seedRebind(d1Store, "stale_race_d1");
  let d1Newer: Capsule | undefined;
  d1Interleaving.beforeNextStaleWrite(async () => {
    d1Newer = await d1ConcurrentStore.patchCapsule(d1Seed.capsule.id, {
      currentStateVersionId: "state_newer_d1",
      currentStateGeneration: 8,
      status: "error",
      autoUpdate: true,
      compatibilityStatus: "needs_patch",
      updatedAt: NOW,
    });
  });
  expect(
    await d1Store.markCapsuleStale(markStaleInput(d1Seed.capsule)),
  ).toEqual({ kind: "conflict", current: d1Newer });
  expect(await d1Store.getCapsule(d1Seed.capsule.id)).toEqual(d1Newer);
  expect(d1Interleaving.staleWrites).toHaveLength(1);
  expect(sqlWhere(d1Interleaving.staleWrites[0]!.sql)).toContain(
    '"capsules"."record_json" = ?',
  );
  expect(
    d1Interleaving.staleWrites[0]!.parameters.some((parameter) =>
      jsonParameterMatches(parameter, d1Seed.capsule)
    ),
  ).toBe(true);
});

test("production staleness writers use markCapsuleStale instead of direct patchCapsule status writes", () => {
  const root = resolve(import.meta.dir, "../../../..");
  const directStalePatch =
    /\.patchCapsule\s*\(\s*[^,]+,\s*\{[^}]*\bstatus\s*:\s*["']stale["']/g;
  const violations: string[] = [];
  for (const pattern of ["core/**/*.ts", "worker/src/**/*.ts"]) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      if (directStalePatch.test(readFileSync(resolve(root, path), "utf8"))) {
        violations.push(path);
      }
      directStalePatch.lastIndex = 0;
    }
  }
  expect(violations).toEqual([]);
});

test("concurrent same-target rebind is one update plus one idempotent replay", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedRebind(store, `same_target_${label}`);
    const [first, second] = await Promise.all([
      rebind(store, seeded),
      rebind(store, seeded),
    ]);
    expect([first.status, second.status].sort(), label).toEqual([
      "replayed",
      "updated",
    ]);
    expect((await store.getCapsule(seeded.capsule.id))?.installConfigId).toBe(
      seeded.target.id,
    );
    expect(await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id))
      .toBe(2);
  }
});

test("only a current unconsumed Plan blocks rebind; consumed history and stale epochs do not", async () => {
  for (const [label, store] of await stores()) {
    const current = await seedRebind(store, `current_plan_${label}`);
    await store.putPlanRun(
      planRun({
        id: `plan_current_${label}`,
        capsuleId: current.capsule.id,
        epoch: 1,
      }),
    );
    expect((await rebind(store, current)).status, `${label}:current`).toBe(
      "busy",
    );

    const consumed = await seedRebind(store, `consumed_plan_${label}`);
    await store.putPlanRun(
      planRun({
        id: `plan_consumed_${label}`,
        capsuleId: consumed.capsule.id,
        epoch: 1,
        consumed: true,
      }),
    );
    expect((await rebind(store, consumed)).status, `${label}:consumed`).toBe(
      "updated",
    );

    const stale = await seedRebind(store, `stale_plan_${label}`);
    const first = await rebind(store, stale);
    if (first.status !== "updated") throw new Error(`${label}: seed failed`);
    await store.putPlanRun(
      planRun({
        id: `plan_stale_${label}`,
        capsuleId: stale.capsule.id,
        epoch: 1,
      }),
    );
    expect(
      (
        await rebind(store, {
          capsule: first.capsule,
          previous: stale.target,
          target: stale.next,
          epoch: 2,
        })
      ).status,
      `${label}:stale`,
    ).toBe("updated");
  }
});

test("runtime-safety authority rejects every ambiguous external-effect phase with store parity", async () => {
  const unsafeCases = [
    {
      name: "queued_apply",
      run: (capsuleId: string) =>
        applyRun({ id: `apply_queued_${capsuleId}`, capsuleId, status: "queued" }),
    },
    {
      name: "provider_failed_apply",
      run: (capsuleId: string) =>
        applyRun({
          id: `apply_failed_${capsuleId}`,
          capsuleId,
          status: "failed",
          providerDispatched: true,
          started: true,
        }),
    },
    {
      name: "provider_failed_destroy",
      run: (capsuleId: string) =>
        applyRun({
          id: `destroy_failed_${capsuleId}`,
          capsuleId,
          operation: "destroy",
          status: "failed",
          providerDispatched: true,
          started: true,
        }),
    },
    {
      name: "started_expired_apply",
      run: (capsuleId: string) =>
        applyRun({
          id: `apply_expired_${capsuleId}`,
          capsuleId,
          status: "expired",
          started: true,
        }),
    },
    {
      name: "started_expired_destroy",
      run: (capsuleId: string) =>
        applyRun({
          id: `destroy_expired_${capsuleId}`,
          capsuleId,
          operation: "destroy",
          status: "expired",
          started: true,
        }),
    },
  ] as const;
  const unsafeRestores = ["queued", "running", "failed", "expired"] as const;

  for (const [label, store] of await stores()) {
    for (const entry of unsafeCases) {
      const seeded = await seedRebind(store, `${entry.name}_${label}`);
      await store.putApplyRun(entry.run(seeded.capsule.id));
      expect(
        (await rebind(store, seeded)).status,
        `${label}:${entry.name}`,
      ).toBe("busy");
    }
    for (const status of unsafeRestores) {
      const seeded = await seedRebind(store, `restore_${status}_${label}`);
      await store.putBackupRun(
        restoreRun({
          id: `restore_${status}_${label}`,
          capsuleId: seeded.capsule.id,
          status,
        }),
      );
      expect(
        (await rebind(store, seeded)).status,
        `${label}:restore:${status}`,
      ).toBe("busy");
    }

    for (const status of ["succeeded"] as const) {
      const applySeed = await seedRebind(store, `safe_apply_${label}`);
      await store.putApplyRun(
        applyRun({
          id: `apply_safe_${label}`,
          capsuleId: applySeed.capsule.id,
          status,
          started: true,
        }),
      );
      expect((await rebind(store, applySeed)).status, `${label}:safe_apply`).toBe(
        "updated",
      );

      const restoreSeed = await seedRebind(store, `safe_restore_${label}`);
      await store.putBackupRun(
        restoreRun({
          id: `restore_safe_${label}`,
          capsuleId: restoreSeed.capsule.id,
          status,
        }),
      );
      expect(
        (await rebind(store, restoreSeed)).status,
        `${label}:safe_restore`,
      ).toBe("updated");
    }
  }
});

test("receipt-fenced committed post-apply recovery permits exact rebind across every store", async () => {
  const statuses: string[] = [];
  for (const [label, store] of await stores()) {
    const seeded = await seedRebind(store, `post_apply_recovery_${label}`);
    const recovery = await seedCommittedPostApplyRecovery(
      store,
      seeded,
      label,
    );
    const result = await store.rebindCapsuleInstallConfig(
      await recoveryRebindInput(seeded, recovery),
    );

    statuses.push(`${label}:${result.status}`);
    expect(result.status === "updated" && result.capsule, label).toMatchObject({
      installConfigId: recovery.target.id,
      status: "error",
      currentStateGeneration: recovery.capsule.currentStateGeneration,
      currentStateVersionId: recovery.capsule.currentStateVersionId,
      currentOutputId: recovery.capsule.currentOutputId,
    });
    expect(await store.getCapsuleExecutionAuthorityEpoch(recovery.capsule.id))
      .toBe(2);
  }
  expect(statuses).toEqual([
    "memory:updated",
    "postgres:updated",
    "d1:updated",
  ]);
});

test("receipt-fenced recovery fails closed on missing, drifted, or provider-uncertain evidence", async () => {
  for (const [label, store] of await stores()) {
    const seed = async (caseName: string) => {
      const seeded = await seedRebind(store, `${caseName}_${label}`);
      const recovery = await seedCommittedPostApplyRecovery(
        store,
        seeded,
        `${caseName}_${label}`,
      );
      return { seeded, recovery };
    };

    {
      const { seeded, recovery } = await seed("missing_proof");
      const input = await rebindInput({
        ...seeded,
        capsule: recovery.capsule,
        target: seeded.next,
      });
      expect(
        (await store.rebindCapsuleInstallConfig(input)).status,
        `${label}:missing-proof`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery } = await seed("run_drift");
      await store.putApplyRun({
        ...recovery.failedApply,
        diagnostics: [{ severity: "warning", message: "row drift" }],
      });
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:run-drift`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery } = await seed("state_drift");
      await store.putStateVersion({
        ...recovery.stateVersion,
        stateRef: `${recovery.stateVersion.stateRef}/drifted`,
      });
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:state-drift`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery } = await seed("output_drift");
      await store.putOutput({
        ...recovery.output,
        outputDigest: `sha256:${"9".repeat(64)}`,
      });
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:output-drift`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery: original } = await seed("missing_row");
      const proof = await recoveryProofWith(original.proof, {
        stateVersionId: `state_missing_${label}`,
      });
      const recovery = await replaceRecoveryProof(store, original, proof);
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:missing-row`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery: original } = await seed("provider_partial");
      const partial: ApplyRun = {
        ...original.failedApply,
        auditEvents: [
          {
            id: `audit_provider_partial_${label}`,
            type: "apply.failed",
            at: 2,
            data: {
              providerDispatched: true,
              providerApplySucceeded: false,
              statePersistence: "persisted",
              stateVersionId: original.stateVersion.id,
            },
          },
        ],
      };
      await store.putApplyRun(partial);
      const proof = await recoveryProofWith(original.proof, {
        failedApplyRunDigest: await stableJsonDigest(partial),
      });
      const recovery = await replaceRecoveryProof(store, original, proof);
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:provider-partial`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery: original } = await seed(
        "provider_uncertain",
      );
      const uncertain: ApplyRun = {
        ...original.failedApply,
        auditEvents: original.failedApply.auditEvents.map((event) =>
          event.type === "apply.failed"
            ? {
              ...event,
              data: {
                providerDispatched: true,
                lifecycleActionPhase: "post_apply",
                lifecycleActionStatus: "failed",
              },
            }
            : event
        ),
      };
      await store.putApplyRun(uncertain);
      const proof = await recoveryProofWith(original.proof, {
        failedApplyRunDigest: await stableJsonDigest(uncertain),
      });
      const recovery = await replaceRecoveryProof(store, original, proof);
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:provider-uncertain`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery } = await seed("receipt_mismatch");
      const receipt = recovery.target.internal?.reAdoption;
      if (!receipt) throw new Error("recovery target receipt is missing");
      const {
        committedPostApplyRecovery: _committedPostApplyRecovery,
        ...receiptWithoutRecovery
      } = receipt;
      const target = {
        ...recovery.target,
        internal: {
          ...recovery.target.internal!,
          reAdoption: receiptWithoutRecovery,
        },
      } satisfies InstallConfig;
      await store.putInstallConfig(target);
      const input = await recoveryRebindInput(seeded, recovery);
      expect(
        (
          await store.rebindCapsuleInstallConfig({
            ...input,
            expected: {
              ...input.expected,
              targetInstallConfigDigest: await stableJsonDigest(target),
            },
          })
        ).status,
        `${label}:receipt-mismatch`,
      ).toBe("conflict");
    }
  }
});

test("receipt-fenced recovery is subordinate to latest safety and blocking Run authority", async () => {
  for (const [label, store] of await stores()) {
    const seed = async (caseName: string) => {
      const seeded = await seedRebind(store, `${caseName}_${label}`);
      const recovery = await seedCommittedPostApplyRecovery(
        store,
        seeded,
        `${caseName}_${label}`,
      );
      return { seeded, recovery };
    };

    {
      const { seeded, recovery } = await seed("newer_safe_apply");
      await store.putApplyRun({
        ...applyRun({
          id: `apply_newer_safe_${label}`,
          capsuleId: recovery.capsule.id,
          status: "succeeded",
          started: true,
        }),
        createdAt: 3,
        updatedAt: 4,
        finishedAt: 4,
      });
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:newer-safe-apply`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery } = await seed("destroy_in_flight");
      await store.putApplyRun({
        ...applyRun({
          id: `destroy_running_${label}`,
          capsuleId: recovery.capsule.id,
          operation: "destroy",
          status: "running",
          started: true,
        }),
        createdAt: 3,
        updatedAt: 4,
      });
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:destroy-in-flight`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery } = await seed("restore_in_flight");
      await store.putBackupRun({
        ...restoreRun({
          id: `restore_running_${label}`,
          capsuleId: recovery.capsule.id,
          status: "running",
        }),
        startedAt: LATER,
      });
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:restore-in-flight`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery } = await seed("unconsumed_plan");
      await store.putPlanRun(
        planRun({
          id: `plan_blocking_recovery_${label}`,
          capsuleId: recovery.capsule.id,
          epoch: 1,
        }),
      );
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:unconsumed-plan`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery } = await seed("queued_apply");
      await store.putApplyRun(
        applyRun({
          id: `apply_blocking_recovery_${label}`,
          capsuleId: recovery.capsule.id,
          status: "queued",
        }),
      );
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:queued-apply`,
      ).toBe("busy");
    }

    {
      const { seeded, recovery } = await seed("running_apply");
      await store.putApplyRun(
        applyRun({
          id: `apply_running_recovery_${label}`,
          capsuleId: recovery.capsule.id,
          status: "running",
          started: true,
        }),
      );
      expect(
        (
          await store.rebindCapsuleInstallConfig(
            await recoveryRebindInput(seeded, recovery),
          )
        ).status,
        `${label}:running-apply`,
      ).toBe("busy");
    }
  }
});

test("receipt rows are revalidated inside the pointer and epoch CAS", async () => {
  {
    const store = new InMemoryOpenTofuControlStore();
    const seeded = await seedRebind(store, "recovery_race_memory");
    const recovery = await seedCommittedPostApplyRecovery(
      store,
      seeded,
      "recovery_race_memory",
    );
    const pending = store.rebindCapsuleInstallConfig(
      await recoveryRebindInput(seeded, recovery),
    );
    await store.putOutput({
      ...recovery.output,
      outputDigest: `sha256:${"8".repeat(64)}`,
    });
    expect((await pending).status).toBe("busy");
    expect((await store.getCapsule(recovery.capsule.id))?.installConfigId).toBe(
      seeded.previous.id,
    );
    expect(await store.getCapsuleExecutionAuthorityEpoch(recovery.capsule.id))
      .toBe(1);
  }

  {
    const pg = await PGliteSqlClient.create();
    pgClients.push(pg);
    const interleaving = postgresRebindInterleaver(pg);
    const store = new SqlOpenTofuControlStore({ client: interleaving.client });
    const seeded = await seedRebind(store, "recovery_race_pg");
    const recovery = await seedCommittedPostApplyRecovery(
      store,
      seeded,
      "recovery_race_pg",
    );
    interleaving.beforeNextRebindWrite(async (transaction) => {
      await new SqlOpenTofuControlStore({ client: transaction }).putOutput({
        ...recovery.output,
        outputDigest: `sha256:${"8".repeat(64)}`,
      });
    });
    expect(
      (
        await store.rebindCapsuleInstallConfig(
          await recoveryRebindInput(seeded, recovery),
        )
      ).status,
    ).toBe("busy");
    expect(interleaving.rebindWrites).toHaveLength(1);
    const where = sqlWhere(interleaving.rebindWrites[0]!.sql);
    expect(where).toContain("takosumi_runs");
    expect(where).toContain("takosumi_state_versions");
    expect(where).toContain("takosumi_outputs");
    expect((await store.getCapsule(recovery.capsule.id))?.installConfigId).toBe(
      seeded.previous.id,
    );
    expect(await store.getCapsuleExecutionAuthorityEpoch(recovery.capsule.id))
      .toBe(1);
  }

  {
    const d1 = new SqliteFakeD1();
    const interleaving = new D1RebindInterleaver(d1);
    const store = new CloudflareD1OpenTofuControlStore(interleaving);
    const seeded = await seedRebind(store, "recovery_race_d1");
    const recovery = await seedCommittedPostApplyRecovery(
      store,
      seeded,
      "recovery_race_d1",
    );
    interleaving.beforeNextRebindWrite(async () => {
      await new CloudflareD1OpenTofuControlStore(d1).putOutput({
        ...recovery.output,
        outputDigest: `sha256:${"8".repeat(64)}`,
      });
    });
    expect(
      (
        await store.rebindCapsuleInstallConfig(
          await recoveryRebindInput(seeded, recovery),
        )
      ).status,
    ).toBe("busy");
    expect(interleaving.rebindWrites).toHaveLength(1);
    const where = sqlWhere(interleaving.rebindWrites[0]!.sql);
    expect(where).toContain("runs");
    expect(where).toContain("state_versions");
    expect(where).toContain("outputs");
    expect(interleaving.rebindWrites[0]!.parameters.length).toBeLessThanOrEqual(
      100,
    );
    expect((await store.getCapsule(recovery.capsule.id))?.installConfigId).toBe(
      seeded.previous.id,
    );
    expect(await store.getCapsuleExecutionAuthorityEpoch(recovery.capsule.id))
      .toBe(1);
  }
});

test("concurrent rebinds commit one winner and same-target retry returns the canonical row", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedRebind(store, `race_${label}`);
    const [first, second] = await Promise.all([
      rebind(store, seeded),
      rebind(store, { ...seeded, target: seeded.next }),
    ]);
    expect(
      [first.status, second.status].sort(),
      `${label}:different-target`,
    ).toEqual(["conflict", "updated"]);

    const canonical = (await store.getCapsule(seeded.capsule.id))!;
    const winningTarget = canonical.installConfigId === seeded.target.id
      ? seeded.target
      : seeded.next;
    const replay = await rebind(store, {
      ...seeded,
      target: winningTarget,
    });
    expect(replay.status, `${label}:lost-ack`).toBe("replayed");
    expect(
      replay.status === "replayed" && replay.capsule.installConfigId,
      label,
    ).toBe(winningTarget.id);
  }
});

test("a same-id InstallConfig patch is digest-fenced against rebind on every store", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedRebind(store, `config_patch_${label}`);
    const patched = {
      ...seeded.previous,
      variableMapping: { public_url: "https://changed.example.test" },
      updatedAt: LATER,
    };
    // A patch that already won after the caller received its guard must make
    // the rebind conflict even though the InstallConfig id is unchanged.
    await store.putInstallConfig(patched);
    expect((await rebind(store, seeded)).status, `${label}:won-patch`).toBe(
      "conflict",
    );

    const raced = await seedRebind(store, `config_patch_race_${label}`);
    const racedPatch = {
      ...raced.previous,
      variableMapping: { public_url: "https://race.example.test" },
      updatedAt: LATER,
    };
    const completion: string[] = [];
    const rebindPromise = rebind(store, raced).then((result) => {
      completion.push("rebind");
      return result;
    });
    const patchPromise = store.putInstallConfig(racedPatch).then(() => {
      completion.push("patch");
    });
    const [result] = await Promise.all([rebindPromise, patchPromise]);
    if (completion[0] === "patch") {
      expect(result.status, `${label}:patch-linearized-first`).toBe("conflict");
    } else {
      expect(result.status, `${label}:rebind-linearized-first`).toBe("updated");
    }
    const current = await store.getCapsule(raced.capsule.id);
    expect(current?.installConfigId, `${label}:canonical-pointer`).toBe(
      result.status === "updated" ? raced.target.id : raced.previous.id,
    );
  }
});

test("target patching cannot be adopted by an orphan or lost-ack rebind retry", async () => {
  for (const [label, store] of await stores()) {
    const orphan = await seedRebind(store, `target_orphan_${label}`);
    const originalTarget = orphan.target;
    await store.putInstallConfig({
      ...originalTarget,
      variableMapping: { injected: "must-not-be-adopted" },
      updatedAt: LATER,
    });
    expect((await rebind(store, orphan)).status, `${label}:orphan`).toBe(
      "conflict",
    );
    expect((await store.getCapsule(orphan.capsule.id))?.installConfigId).toBe(
      orphan.previous.id,
    );

    const replay = await seedRebind(store, `target_replay_${label}`);
    expect((await rebind(store, replay)).status, `${label}:initial`).toBe(
      "updated",
    );
    await store.putInstallConfig({
      ...replay.target,
      variableMapping: { injected: "must-not-be-replayed" },
      updatedAt: LATER,
    });
    expect((await rebind(store, replay)).status, `${label}:lost-ack`).toBe(
      "conflict",
    );

    const raced = await seedRebind(store, `target_race_${label}`);
    const completion: string[] = [];
    const rebindPromise = rebind(store, raced).then((result) => {
      completion.push("rebind");
      return result;
    });
    const targetPatchPromise = store
      .putInstallConfig({
        ...raced.target,
        variableMapping: { injected: "race" },
        updatedAt: LATER,
      })
      .then(() => {
        completion.push("patch");
      });
    const [result] = await Promise.all([rebindPromise, targetPatchPromise]);
    if (completion[0] === "patch") {
      expect(result.status, `${label}:target-patch-first`).toBe("conflict");
    } else {
      expect(result.status, `${label}:target-rebind-first`).toBe("updated");
    }
  }
});

test("D1 and Postgres update physical and JSON InstallConfig pointers atomically", async () => {
  const d1 = new SqliteFakeD1();
  const d1Store = new CloudflareD1OpenTofuControlStore(d1);
  const d1Seed = await seedRebind(d1Store, "physical_d1");
  expect((await rebind(d1Store, d1Seed)).status).toBe("updated");
  expect(
    await d1
      .prepare(
        `select install_config_id as physical,
                json_extract(record_json, '$.installConfigId') as json,
                execution_authority_epoch as epoch
           from capsules where id = ?`,
      )
      .bind(d1Seed.capsule.id)
      .first(),
  ).toEqual({ physical: d1Seed.target.id, json: d1Seed.target.id, epoch: 2 });

  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const pgStore = new SqlOpenTofuControlStore({ client: pg });
  const pgSeed = await seedRebind(pgStore, "physical_pg");
  expect((await rebind(pgStore, pgSeed)).status).toBe("updated");
  const pgRows = await pg.query<{
    readonly physical: string;
    readonly json: string;
    readonly epoch: number;
  }>(
    `select install_config_id as physical,
            installation_json ->> 'installConfigId' as json,
            execution_authority_epoch as epoch
       from takosumi_capsules where id = $1`,
    [pgSeed.capsule.id],
  );
  expect(pgRows.rows).toEqual([
    { physical: pgSeed.target.id, json: pgSeed.target.id, epoch: 2 },
  ]);
});
