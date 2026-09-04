import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { DependencySnapshot } from "takosumi-contract/dependencies";
import {
  InMemoryOpenTofuControlStore,
  planRunExecutionInputsDigestMaterial,
  PlanRunPreparationConflictError,
  type OpenTofuControlStore,
  type PlanRunInputs,
} from "../../../../core/domains/deploy-control/store.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../../worker/src/bindings.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

async function preparation(label: string): Promise<{
  readonly run: PlanRun;
  readonly inputs: PlanRunInputs;
  readonly dependencySnapshot: DependencySnapshot;
}> {
  const runId = `plan_prepare_${label}`;
  const dependencySnapshot: DependencySnapshot = {
    id: `depsnap_prepare_${label}`,
    runId,
    dependencies: [
      {
        dependencyId: `dep_prepare_${label}`,
        producerCapsuleId: `producer_prepare_${label}`,
        producerStateGeneration: 4,
        producerOutputId: `output_prepare_${label}`,
        producerOutputDigest: "sha256:producer-output",
        valuesDigest: "sha256:dependency-values",
        values: { apiUrl: "https://api.example.test" },
      },
    ],
    mode: "strict",
    createdAt: "2026-09-03T00:00:00.000Z",
  };
  const inputs: PlanRunInputs = {
    planRunId: runId,
    variables: { replicaCount: 3 },
    generatedRoot: {
      files: {
        "main.tf": `module "app" { source = "./module" }`,
        "outputs.tf": `output "endpoint" { value = module.app.endpoint }`,
      },
    },
    moduleVariableMaterializationDigest: "sha256:oidc-materialization",
    workspaceOutputAllowlist: {
      internalEndpoint: {
        from: "internal_endpoint",
        type: "url",
        required: true,
      },
    },
    outputAllowlist: {
      endpoint: { from: "endpoint", required: true, type: "url" },
    },
    sourceBuild: {
      commands: [{ argv: ["bun", "run", "build"] }],
      outputs: ["dist"],
    },
    runtimeInputs: [
      {
        contract: "takosumi.dispatch-runtime-inputs/v1",
        variableName: "takosumi_runtime_inputs",
        providerInstance: "cloudflare:main",
        nonce: "reviewed-nonce",
        names: ["OIDC_CLIENT_SECRET", "SESSION_SECRET"],
        profileDigest: "sha256:runtime-profile",
      },
    ],
    lifecycleActions: [
      {
        apiVersion: "takosumi.dev/v1alpha1",
        kind: "command",
        id: "activate",
        phase: "post_apply",
        executor: "runner",
        command: ["bun", "run", "activate"],
        runnerCapability: "capsule.lifecycle.command.v1",
      },
    ],
    interfaceMaterialization: {
      installConfigId: `install_config_prepare_${label}`,
      blueprints: [
        {
          key: "service-api",
          name: "Service API",
          spec: {
            type: "example.service.http",
            version: "v1",
            document: { protocol: "https" },
            access: { visibility: "workspace" },
          },
        },
      ],
      blueprintsDigest: "sha256:interface-blueprints",
    },
  };
  const variablesDigest = await stableJsonDigest(inputs.variables);
  const executionInputsDigest = await stableJsonDigest(
    planRunExecutionInputsDigestMaterial(inputs, dependencySnapshot),
  );
  const run = {
    id: runId,
    workspaceId: `workspace_prepare_${label}`,
    capsuleId: `capsule_prepare_${label}`,
    source: {
      kind: "git",
      url: "https://git.example.test/acme/app.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest,
    executionInputsDigest,
    requiredProviders: [],
    requiredProviderRequirements: [],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    dependencySnapshotId: dependencySnapshot.id,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  } as PlanRun;
  return { run, inputs, dependencySnapshot };
}

function transactionFaultClient(
  client: SqlClient,
  failAtInsert: number,
): SqlClient {
  return {
    query: <Row extends Record<string, unknown>>(
      sql: string,
      parameters?: SqlParameters,
    ): Promise<SqlQueryResult<Row>> => client.query<Row>(sql, parameters),
    transaction: <T>(
      body: (transaction: SqlTransaction) => T | Promise<T>,
    ): Promise<T> =>
      client.transaction(async (transaction) => {
        let insertCount = 0;
        const faulting: SqlTransaction = {
          query: <Row extends Record<string, unknown>>(
            sql: string,
            parameters?: SqlParameters,
          ): Promise<SqlQueryResult<Row>> => {
            if (/^insert\s+into\s+"takosumi_/iu.test(sql.trim())) {
              insertCount += 1;
              if (insertCount === failAtInsert) {
                throw new Error(`injected postgres insert ${insertCount}`);
              }
            }
            return transaction.query<Row>(sql, parameters);
          },
          transaction: <Nested>(
            nested: (
              transaction: SqlTransaction,
            ) => Nested | Promise<Nested>,
          ): Promise<Nested> => Promise.resolve(nested(faulting)),
        };
        const result = await body(faulting);
        if (failAtInsert === 4 && insertCount === 3) {
          throw new Error("injected postgres after insert 3");
        }
        return result;
      }),
  };
}

function batchFaultDatabase(database: D1Database): {
  readonly database: D1Database;
  arm(failAtStatement: number, timing?: "before" | "after"): void;
} {
  let failAt: number | undefined;
  let faultTiming: "before" | "after" = "before";
  return {
    database: {
      prepare: (query) => database.prepare(query),
      batch: <T>(
        statements: readonly D1PreparedStatement[],
      ): Promise<readonly D1Result<T>[]> => {
        if (failAt === undefined) return database.batch<T>(statements);
        const armedAt = failAt;
        const armedTiming = faultTiming;
        failAt = undefined;
        return database.batch<T>(
          statements.map((statement, index) =>
            index + 1 === armedAt
              ? {
                  bind: (...values: readonly unknown[]) =>
                    statement.bind(...values),
                  first: <Row>() => statement.first<Row>(),
                  all: <Row>() => statement.all<Row>(),
                  run: async <Row>() => {
                    if (armedTiming === "after") {
                      await statement.run<Row>();
                    }
                    throw new Error(
                      `injected d1 ${armedTiming} statement ${index + 1}`,
                    );
                  },
                }
              : statement,
          ),
        );
      },
    },
    arm(failAtStatement, timing = "before") {
      failAt = failAtStatement;
      faultTiming = timing;
    },
  };
}

test("PlanRun preparation publishes the queued run and its exact inputs as one store command", async () => {
  for (const [label, store] of await stores()) {
    const prepared = await preparation(label);

    const result = await store.preparePlanRun(prepared);

    expect(result, label).toEqual({ status: "created", run: prepared.run });
    expect(await store.getPlanRun(prepared.run.id), label).toEqual(prepared.run);
    expect(await store.getPlanRunInputs(prepared.run.id), label).toEqual(
      prepared.inputs,
    );
    expect(
      await store.getDependencySnapshot(prepared.dependencySnapshot.id),
      label,
    ).toEqual(prepared.dependencySnapshot);
  }
});

test("terminal policy-denied PlanRun preparation does not retain private inputs", async () => {
  for (const [label, store] of await stores()) {
    const prepared = await preparation(`policy_denied_${label}`);
    const denied: PlanRun = {
      ...prepared.run,
      status: "failed",
      policy: {
        status: "blocked",
        reasons: ["provider policy denied the requested operation"],
        checkedAt: 1,
      },
      finishedAt: 1,
    };

    await store.preparePlanRun({ ...prepared, run: denied });

    expect(await store.getPlanRun(denied.id), label).toEqual(denied);
    expect(await store.getPlanRunInputs(denied.id), label).toBeUndefined();
  }
});

test("PlanRun preparation rejects a cross-kind Run ID collision in every adapter", async () => {
  for (const [label, store] of await stores()) {
    const prepared = await preparation(`cross_kind_${label}`);
    const existingApply: ApplyRun = {
      id: prepared.run.id,
      planRunId: `existing_plan_${label}`,
      workspaceId: prepared.run.workspaceId,
      operation: "update",
      runnerProfileId: prepared.run.runnerProfileId,
      status: "queued",
      expected: {
        planRunId: `existing_plan_${label}`,
        runnerProfileId: prepared.run.runnerProfileId,
        sourceDigest: prepared.run.sourceDigest,
        variablesDigest: prepared.run.variablesDigest,
        policyDecisionDigest: prepared.run.policyDecisionDigest,
        planDigest: "sha256:existing-plan",
        planArtifactDigest: "sha256:existing-plan",
      },
      stateBackend: { kind: "managed", ref: "state" },
      stateLock: { status: "pending", backendRef: "state" },
      auditEvents: [],
      createdAt: 1,
      updatedAt: 1,
    };
    await store.putApplyRun(existingApply);

    await expect(store.preparePlanRun(prepared), label).rejects.toBeInstanceOf(
      PlanRunPreparationConflictError,
    );
  }
});

test("durable restart recovery preserves the exact reviewed preparation bundle", async () => {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const d1 = new SqliteFakeD1();
  const durableAdapters = [
    {
      label: "postgres",
      writer: new SqlOpenTofuControlStore({ client: pgClient }),
      restart: () => new SqlOpenTofuControlStore({ client: pgClient }),
    },
    {
      label: "d1",
      writer: new CloudflareD1OpenTofuControlStore(d1),
      restart: () => new CloudflareD1OpenTofuControlStore(d1),
    },
  ] as const;

  for (const adapter of durableAdapters) {
    const prepared = await preparation(`restart_${adapter.label}`);
    await adapter.writer.preparePlanRun(prepared);

    const restarted = adapter.restart();
    const run = await restarted.getPlanRun(prepared.run.id);
    const inputs = await restarted.getPlanRunInputs(prepared.run.id);
    const snapshot = await restarted.getDependencySnapshot(
      prepared.dependencySnapshot.id,
    );

    expect(run, adapter.label).toEqual(prepared.run);
    expect(run?.variablesDigest, adapter.label).toBe(
      await stableJsonDigest(prepared.inputs.variables),
    );
    expect(run?.executionInputsDigest, adapter.label).toBe(
      await stableJsonDigest(
        planRunExecutionInputsDigestMaterial(
          prepared.inputs,
          prepared.dependencySnapshot,
        ),
      ),
    );
    expect(inputs, adapter.label).toEqual(prepared.inputs);
    expect(inputs, adapter.label).toMatchObject({
      generatedRoot: prepared.inputs.generatedRoot,
      moduleVariableMaterializationDigest:
        prepared.inputs.moduleVariableMaterializationDigest,
      workspaceOutputAllowlist: prepared.inputs.workspaceOutputAllowlist,
      outputAllowlist: prepared.inputs.outputAllowlist,
      runtimeInputs: prepared.inputs.runtimeInputs,
      lifecycleActions: prepared.inputs.lifecycleActions,
      interfaceMaterialization: prepared.inputs.interfaceMaterialization,
    });
    expect(snapshot, adapter.label).toEqual(prepared.dependencySnapshot);
    expect(
      (
        await restarted.listRecoverableOpenTofuRuns({
          staleQueuedBeforeMs: 2,
          staleRunningBeforeMs: 2,
          limit: 10,
        })
      ).map((candidate) => candidate.id),
      adapter.label,
    ).toContain(prepared.run.id);
  }
});

test("PlanRun preparation is retry-safe and rejects a conflicting immutable bundle", async () => {
  for (const [label, store] of await stores()) {
    const prepared = await preparation(`retry_${label}`);

    const [first, second] = await Promise.all([
      store.preparePlanRun(prepared),
      store.preparePlanRun(prepared),
    ]);

    expect(
      [first.status, second.status].sort(),
      label,
    ).toEqual(["created", "existing"]);
    await expect(
      store.preparePlanRun({
        ...prepared,
        run: { ...prepared.run, executionInputsDigest: "sha256:different" },
      }),
      label,
    ).rejects.toBeInstanceOf(PlanRunPreparationConflictError);
    await expect(
      store.preparePlanRun({
        ...prepared,
        run: { ...prepared.run, sourceDigest: "sha256:different-source" },
      }),
      label,
    ).rejects.toBeInstanceOf(PlanRunPreparationConflictError);
    expect(await store.getPlanRunInputs(prepared.run.id), label).toEqual(
      prepared.inputs,
    );
  }
});

test("PlanRun preparation adopts retry-equivalent randomized sealed storage", async () => {
  for (const [label, store] of await stores()) {
    const base = await preparation(`sealed_retry_${label}`);
    const firstSnapshot = {
      ...base.dependencySnapshot,
      dependencies: base.dependencySnapshot.dependencies.map((entry) => ({
        ...entry,
        sealedValues: {
          ciphertext: "randomized-snapshot-ciphertext-first",
          contentDigest: "sha256:sealed-dependency-values",
          names: ["apiUrl"],
        },
      })),
    };
    const first = {
      run: {
        ...base.run,
        executionInputsDigest: await stableJsonDigest(
          planRunExecutionInputsDigestMaterial(base.inputs, firstSnapshot),
        ),
      },
      inputs: {
        planRunId: base.run.id,
        variables: {},
        sealed: {
          ciphertext: "randomized-ciphertext-first",
          contentDigest: "sha256:sealed-plan-inputs",
          names: ["OIDC_CLIENT_SECRET"],
        },
      },
      dependencySnapshot: firstSnapshot,
    } satisfies Parameters<OpenTofuControlStore["preparePlanRun"]>[0];
    const retrySnapshot = {
      ...first.dependencySnapshot,
      id: `${first.dependencySnapshot.id}_retry`,
      createdAt: "2026-09-03T00:00:01.000Z",
      dependencies: first.dependencySnapshot.dependencies.map((entry) => ({
        ...entry,
        sealedValues: {
          ...entry.sealedValues!,
          ciphertext: "randomized-snapshot-ciphertext-retry",
        },
      })),
    };
    const retry = {
      run: {
        ...first.run,
        dependencySnapshotId: retrySnapshot.id,
      },
      inputs: {
        ...first.inputs,
        sealed: {
          ...first.inputs.sealed,
          ciphertext: "randomized-ciphertext-retry",
        },
      },
      dependencySnapshot: retrySnapshot,
    } satisfies Parameters<OpenTofuControlStore["preparePlanRun"]>[0];

    expect(await store.preparePlanRun(first), label).toMatchObject({
      status: "created",
    });
    expect(await store.preparePlanRun(retry), label).toEqual({
      status: "existing",
      run: first.run,
    });
    expect(await store.getPlanRunInputs(first.run.id), label).toEqual(
      first.inputs,
    );
    expect(
      await store.getDependencySnapshot(retrySnapshot.id),
      label,
    ).toBeUndefined();
  }
});

test("Postgres rolls back PlanRun preparation after every former write boundary", async () => {
  // Before insert 2 = after Run, before insert 3 = after snapshot, and 4 =
  // after inputs but before transaction commit.
  for (const failAtInsert of [2, 3, 4]) {
    const client = await PGliteSqlClient.create();
    pgClients.push(client);
    const store = new SqlOpenTofuControlStore({
      client: transactionFaultClient(client, failAtInsert),
    });
    const prepared = await preparation(`postgres_fault_${failAtInsert}`);

    let failure: unknown;
    try {
      await store.preparePlanRun(prepared);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const observedFailure =
      (failure as Error & { readonly cause?: unknown }).cause ?? failure;
    expect(observedFailure).toMatchObject({
      message:
        failAtInsert === 4
          ? "injected postgres after insert 3"
          : `injected postgres insert ${failAtInsert}`,
    });
    expect(await store.getPlanRun(prepared.run.id)).toBeUndefined();
    expect(await store.getPlanRunInputs(prepared.run.id)).toBeUndefined();
    expect(
      await store.getDependencySnapshot(prepared.dependencySnapshot.id),
    ).toBeUndefined();
  }
});

test("D1 rolls back PlanRun preparation after every former write boundary", async () => {
  // Mirror the same after-Run, after-snapshot, and after-inputs boundaries in
  // the one D1 batch transaction.
  for (const faultCase of [
    { statement: 2, timing: "before" },
    { statement: 3, timing: "before" },
    { statement: 3, timing: "after" },
  ] as const) {
    const fault = batchFaultDatabase(new SqliteFakeD1());
    const store = new CloudflareD1OpenTofuControlStore(fault.database);
    // Bootstrap is deliberately outside the armed fault. Only the preparation
    // batch is under test.
    await store.getPlanRun("bootstrap");
    fault.arm(faultCase.statement, faultCase.timing);
    const prepared = await preparation(
      `d1_fault_${faultCase.timing}_${faultCase.statement}`,
    );

    await expect(store.preparePlanRun(prepared)).rejects.toThrow(
      `injected d1 ${faultCase.timing} statement ${faultCase.statement}`,
    );
    expect(await store.getPlanRun(prepared.run.id)).toBeUndefined();
    expect(await store.getPlanRunInputs(prepared.run.id)).toBeUndefined();
    expect(
      await store.getDependencySnapshot(prepared.dependencySnapshot.id),
    ).toBeUndefined();
  }
});

test("scheduled recovery retains legacy torn PlanRuns for fail-closed repair", async () => {
  for (const [label, store] of await stores()) {
    const complete = await preparation(`recoverable_complete_${label}`);
    const torn = await preparation(`recoverable_torn_${label}`);
    await store.preparePlanRun(complete);
    await store.putPlanRun(torn.run);

    expect(
      (
        await store.listRecoverableOpenTofuRuns({
          staleQueuedBeforeMs: 2,
          staleRunningBeforeMs: 2,
          limit: 10,
        })
      ).map((run) => run.id),
      label,
    ).toEqual([complete.run.id, torn.run.id]);
  }
});
