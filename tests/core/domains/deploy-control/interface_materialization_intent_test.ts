import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ApplyRun, Capsule } from "@takosumi/internal/deploy-control-api";
import type { CapsuleInterfaceBlueprint } from "takosumi-contract";
import type { Output } from "takosumi-contract/outputs";
import type { StateVersion } from "takosumi-contract/state-versions";

import {
  CAPSULE_INTERFACE_BLUEPRINTS_MAX_BYTES,
  capsuleInterfaceBlueprintsJson,
  createCapsuleInterfaceMaterializationIntent,
  pinCapsuleInterfaceBlueprints,
  type CapsuleInterfaceMaterializationIntent,
  validateCapsuleInterfaceMaterializationIntent,
} from "../../../../core/domains/deploy-control/interface_materialization_intent.ts";
import {
  InMemoryOpenTofuControlStore,
  type CommitRunStateInput,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../../worker/src/bindings.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

const NOW = "2026-08-29T00:00:00.000Z";
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

function blueprint(
  key: string,
  document: Readonly<Record<string, unknown>> = {
    transport: "streamable-http",
  },
): CapsuleInterfaceBlueprint {
  return {
    key,
    name: `interface-${key}`,
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document,
      inputs: {
        endpoint: { source: "capsule_output", outputName: "endpoint" },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  };
}

async function commitFixture(input: {
  readonly capsule: Capsule;
  readonly applyRunId: string;
  readonly generation: number;
  readonly blueprints?: readonly CapsuleInterfaceBlueprint[];
  readonly currentStateVersionId?: string;
}): Promise<{
  readonly commit: CommitRunStateInput;
  readonly intent?: CapsuleInterfaceMaterializationIntent;
  readonly state: StateVersion;
  readonly output: Output;
}> {
  const state: StateVersion = {
    id: `state_${input.applyRunId}_${input.generation}`,
    workspaceId: input.capsule.workspaceId,
    capsuleId: input.capsule.id,
    environment: input.capsule.environment,
    generation: input.generation,
    stateRef: `state/${input.applyRunId}/${input.generation}`,
    digest: `sha256:${"a".repeat(64)}`,
    createdByRunId: input.applyRunId,
    createdAt: NOW,
  };
  const output: Output = {
    id: `output_${input.applyRunId}_${input.generation}`,
    workspaceId: input.capsule.workspaceId,
    capsuleId: input.capsule.id,
    stateGeneration: input.generation,
    rawArtifactRef: `raw/${input.applyRunId}/${input.generation}`,
    publicOutputs: {
      endpoint: "https://resolved-output-value.example.test/mcp",
    },
    workspaceOutputs: {
      endpoint: "https://resolved-output-value.example.test/mcp",
    },
    outputDigest: `sha256:${"b".repeat(64)}`,
    createdAt: NOW,
  };
  const planRunId = `plan_${input.applyRunId}`;
  const applyRunTerminal: ApplyRun = {
    id: input.applyRunId,
    planRunId,
    workspaceId: input.capsule.workspaceId,
    capsuleId: input.capsule.id,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId,
      capsuleId: input.capsule.id,
      runnerProfileId: "opentofu-default",
      sourceDigest: `sha256:${"c".repeat(64)}`,
      variablesDigest: `sha256:${"d".repeat(64)}`,
      policyDecisionDigest: `sha256:${"e".repeat(64)}`,
      planDigest: `sha256:${"f".repeat(64)}`,
      planArtifactDigest: `sha256:${"f".repeat(64)}`,
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    finishedAt: 2,
  };
  const pinned = await pinCapsuleInterfaceBlueprints({
    installConfigId: input.capsule.installConfigId,
    blueprints: input.blueprints,
  });
  const intent = pinned
    ? createCapsuleInterfaceMaterializationIntent({
        applyRunId: input.applyRunId,
        workspaceId: input.capsule.workspaceId,
        capsuleId: input.capsule.id,
        stateVersionId: state.id,
        outputId: output.id,
        stateGeneration: input.generation,
        pinned,
        createdAt: NOW,
      })
    : undefined;
  return {
    state,
    output,
    ...(intent ? { intent } : {}),
    commit: {
      stateVersion: state,
      output,
      capsulePatch: {
        id: input.capsule.id,
        patch: {
          currentStateVersionId: state.id,
          currentStateGeneration: input.generation,
          currentOutputId: output.id,
          status: "active",
          updatedAt: NOW,
        },
        guard: {
          currentStateVersionId: input.currentStateVersionId,
          status: input.currentStateVersionId ? "active" : "pending",
        },
      },
      applyRunTerminal,
      ...(intent ? { interfaceMaterializationIntent: intent } : {}),
    },
  };
}

test("Interface intent codec is canonical, value-free, and capped at one MiB", async () => {
  const pinned = await pinCapsuleInterfaceBlueprints({
    installConfigId: "config_codec",
    blueprints: [blueprint("codec")],
  });
  expect(pinned).toBeDefined();
  const intent = createCapsuleInterfaceMaterializationIntent({
    applyRunId: "apply_codec",
    workspaceId: "workspace_codec",
    capsuleId: "capsule_codec",
    stateVersionId: "state_codec",
    outputId: "output_codec",
    stateGeneration: 1,
    pinned: pinned!,
    createdAt: NOW,
  });
  const encoded = JSON.stringify(intent);
  expect(encoded).not.toContain("resolved-output-value.example.test");
  expect(encoded).not.toContain("provider-token-do-not-persist");
  expect(encoded).not.toContain("raw-state-do-not-persist");
  expect(Object.keys(intent).sort()).toEqual([
    "applyRunId",
    "attempts",
    "blueprints",
    "blueprintsDigest",
    "capsuleId",
    "createdAt",
    "id",
    "installConfigId",
    "nextItemIndex",
    "nextRetryAt",
    "outputId",
    "stateGeneration",
    "stateVersionId",
    "status",
    "totalItems",
    "updatedAt",
    "workspaceId",
  ]);
  await expect(
    validateCapsuleInterfaceMaterializationIntent({
      ...intent,
      generatedCredentials: { token: "provider-token-do-not-persist" },
    } as never),
  ).rejects.toThrow("contains an unsupported field");
  expect(
    new TextEncoder().encode(capsuleInterfaceBlueprintsJson(intent.blueprints))
      .byteLength,
  ).toBeLessThanOrEqual(CAPSULE_INTERFACE_BLUEPRINTS_MAX_BYTES);

  const oversized = Array.from({ length: 64 }, (_, index) =>
    blueprint(`large-${index}`, { padding: "x".repeat(17_000) })
  );
  await expect(
    pinCapsuleInterfaceBlueprints({
      installConfigId: "config_oversized",
      blueprints: oversized,
    }),
  ).rejects.toThrow("exceeds 1048576 bytes");
});

test("Interface intent commit/replay/conflict behavior is atomic across stores", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_${label}`,
      capsuleId: `capsule_intent_${label}`,
    });
    const first = await commitFixture({
      capsule: seeded.capsule,
      applyRunId: `apply_intent_${label}`,
      generation: 1,
      blueprints: [blueprint("first")],
    });
    await store.commitRunState(first.commit);
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(first.intent!.id),
      `${label}:persist`,
    ).toEqual(first.intent);

    await store.commitRunState({
      ...first.commit,
      capsulePatch: {
        ...first.commit.capsulePatch,
        guard: { currentStateVersionId: first.state.id, status: "active" },
      },
    });
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(first.intent!.id),
      `${label}:replay`,
    ).toEqual(first.intent);

    const sameIdentityConflict = await commitFixture({
      capsule: seeded.capsule,
      applyRunId: `apply_intent_${label}`,
      generation: 2,
      blueprints: [blueprint("changed")],
      currentStateVersionId: first.state.id,
    });
    await expect(
      store.commitRunState(sameIdentityConflict.commit),
      `${label}:identity-conflict`,
    ).rejects.toThrow();
    expect(
      await store.getStateVersion(sameIdentityConflict.state.id),
      `${label}:identity-state-rollback`,
    ).toBeUndefined();
    expect(
      await store.getOutput(sameIdentityConflict.output.id),
      `${label}:identity-output-rollback`,
    ).toBeUndefined();
    expect(
      (await store.getCapsule(seeded.capsule.id))?.currentStateVersionId,
      `${label}:identity-capsule-rollback`,
    ).toBe(first.state.id);

    const generationConflict = await commitFixture({
      capsule: seeded.capsule,
      applyRunId: `apply_other_${label}`,
      generation: 1,
      blueprints: [blueprint("other")],
      currentStateVersionId: first.state.id,
    });
    await expect(
      store.commitRunState(generationConflict.commit),
      `${label}:generation-conflict`,
    ).rejects.toThrow();
    expect(
      await store.getStateVersion(generationConflict.state.id),
      `${label}:generation-state-rollback`,
    ).toBeUndefined();
    expect(
      await store.getOutput(generationConflict.output.id),
      `${label}:generation-output-rollback`,
    ).toBeUndefined();
    expect(
      (await store.getCapsule(seeded.capsule.id))?.currentStateVersionId,
      `${label}:generation-capsule-rollback`,
    ).toBe(first.state.id);
  }
});

interface RecordedD1Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

class RecordingBatchD1 implements D1Database {
  readonly batches: RecordedD1Statement[][] = [];
  readonly #metadata = new WeakMap<
    D1PreparedStatement,
    RecordedD1Statement & { readonly inner: D1PreparedStatement }
  >();

  constructor(private readonly inner: D1Database) {}

  prepare(query: string): D1PreparedStatement {
    return this.#wrap(this.inner.prepare(query), query, []);
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const metadata = statements.map((statement) => {
      const current = this.#metadata.get(statement);
      if (!current) throw new Error("unrecorded D1 batch statement");
      return current;
    });
    this.batches.push(
      metadata.map(({ sql, parameters }) => ({ sql, parameters })),
    );
    return this.inner.batch<T>(metadata.map(({ inner }) => inner));
  }

  #wrap(
    inner: D1PreparedStatement,
    sql: string,
    parameters: readonly unknown[],
  ): D1PreparedStatement {
    const wrapped = {
      bind: (...values) => this.#wrap(inner.bind(...values), sql, values),
      first: <T>() => inner.first<T>(),
      all: <T>() => inner.all<T>(),
      raw: <T = unknown[]>() =>
        (inner as D1PreparedStatement & { raw<U = unknown[]>(): Promise<U[]> })
          .raw<T>(),
      run: <T>() => inner.run<T>(),
    } as D1PreparedStatement;
    this.#metadata.set(wrapped, { inner, sql, parameters });
    return wrapped;
  }
}

async function recordedD1Commit(
  blueprintCount: number,
): Promise<readonly RecordedD1Statement[]> {
  const recording = new RecordingBatchD1(new SqliteFakeD1());
  const store = new CloudflareD1OpenTofuControlStore(recording);
  const seeded = await seedCapsuleModel(store, {
    workspaceId: `workspace_d1_count_${blueprintCount}`,
    capsuleId: `capsule_d1_count_${blueprintCount}`,
  });
  recording.batches.splice(0);
  const fixture = await commitFixture({
    capsule: seeded.capsule,
    applyRunId: `apply_d1_count_${blueprintCount}`,
    generation: 1,
    ...(blueprintCount > 0
      ? {
          blueprints: Array.from({ length: blueprintCount }, (_, index) =>
            blueprint(`count-${index}`)
          ),
        }
      : {}),
  });
  await store.commitRunState(fixture.commit);
  return recording.batches.at(-1) ?? [];
}

test("D1 adds one fixed, bounded intent statement independent of blueprint count", async () => {
  const withoutIntent = await recordedD1Commit(0);
  const one = await recordedD1Commit(1);
  const many = await recordedD1Commit(64);
  const intentStatements = (batch: readonly RecordedD1Statement[]) =>
    batch.filter((statement) =>
      statement.sql.includes("capsule_interface_materialization_intents")
    );
  expect(intentStatements(withoutIntent)).toHaveLength(0);
  expect(intentStatements(one)).toHaveLength(1);
  expect(intentStatements(many)).toHaveLength(1);
  expect(one).toHaveLength(withoutIntent.length + 1);
  expect(many).toHaveLength(one.length);
  expect(intentStatements(one)[0]!.sql).toBe(intentStatements(many)[0]!.sql);
  expect(intentStatements(one)[0]!.parameters).toHaveLength(
    intentStatements(many)[0]!.parameters.length,
  );
  expect(intentStatements(many)[0]!.parameters.length).toBeLessThanOrEqual(100);
  expect(new TextEncoder().encode(intentStatements(many)[0]!.sql).byteLength)
    .toBeLessThan(16_384);
});
