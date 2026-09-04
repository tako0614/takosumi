import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ApplyRun, Capsule } from "@takosumi/internal/deploy-control-api";
import type { CapsuleInterfaceBlueprint } from "takosumi-contract";
import type { Interface, InterfaceBinding } from "takosumi-contract/interfaces";
import type { Output } from "takosumi-contract/outputs";
import type { StateVersion } from "takosumi-contract/state-versions";

import {
  capsuleInterfaceMaterializationWorkItemAt,
  createCapsuleInterfaceMaterializationIntent,
  pinCapsuleInterfaceBlueprints,
  type CapsuleInterfaceMaterializationIntent,
} from "../../../../core/domains/deploy-control/interface_materialization_intent.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import {
  capsuleLeaseScope,
  InMemoryCapsuleCoordination,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  CapsuleInterfaceMaterializationIntentDrainer,
  InterfaceServiceCapsuleMaterializationTarget,
  type CapsuleInterfaceMaterializationTarget,
} from "../../../../core/domains/interfaces/materialization_intent_drain.ts";
import { OutputBackedInterfaceInputResolver } from "../../../../core/domains/interfaces/output_resolver.ts";
import { InterfaceService } from "../../../../core/domains/interfaces/service.ts";
import {
  createInMemoryInterfaceStores,
  type InterfaceStores,
} from "../../../../core/domains/interfaces/stores.ts";
import { createSqlInterfaceStores } from "../../../../core/domains/interfaces/sql_stores.ts";
import { createD1InterfaceStores } from "../../../../core/domains/interfaces/d1_stores.ts";
import { InMemoryObservabilitySink } from "../../../../core/domains/observability/mod.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

const COMMITTED_AT = "2026-08-29T10:00:00.000Z";
const CLAIMED_AT = "2026-08-29T10:01:00.000Z";
const SETTLED_AT = "2026-08-29T10:01:30.000Z";
const LEASE_EXPIRES_AT = "2026-08-29T10:02:00.000Z";
const RETRY_AT = "2026-08-29T10:05:00.000Z";
const ERROR_DIGEST = `sha256:${"9".repeat(64)}`;
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

type MaterializationWriteAuthorityFixture = {
  readonly intentId: string;
  readonly leaseToken: string;
  readonly expectedNextItemIndex: number;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly stateVersionId: string;
  readonly outputId: string;
  readonly stateGeneration: number;
};

function authorityFixture(
  workspaceId: string,
  capsuleId: string,
  intentId = "cimi_fixture",
): MaterializationWriteAuthorityFixture {
  return {
    intentId,
    leaseToken: "lease_fixture",
    expectedNextItemIndex: 0,
    workspaceId,
    capsuleId,
    installConfigId: "cfg_fixture",
    stateVersionId: "state_fixture",
    outputId: "output_fixture",
    stateGeneration: 1,
  };
}

type GuardedInterfaceStores = InterfaceStores & {
  readonly interfaces: InterfaceStores["interfaces"] & {
    create(
      record: Interface,
      authority: MaterializationWriteAuthorityFixture,
    ): Promise<boolean>;
    compareAndSet(
      record: Interface,
      expected: Parameters<InterfaceStores["interfaces"]["compareAndSet"]>[1],
      authority: MaterializationWriteAuthorityFixture,
    ): Promise<boolean>;
    claimOAuth2Resource(
      input: Parameters<
        InterfaceStores["interfaces"]["claimOAuth2Resource"]
      >[0],
      authority: MaterializationWriteAuthorityFixture,
    ): Promise<boolean>;
  };
  readonly bindings: InterfaceStores["bindings"] & {
    create(
      record: InterfaceBinding,
      authority: MaterializationWriteAuthorityFixture,
    ): Promise<boolean>;
    compareAndSet(
      record: InterfaceBinding,
      expectedGeneration: number,
      authority: MaterializationWriteAuthorityFixture,
    ): Promise<boolean>;
  };
};

async function authorityStorePairs(): Promise<
  readonly {
    readonly label: string;
    readonly control: OpenTofuControlStore;
    readonly interfaces: GuardedInterfaceStores;
  }[]
> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const d1 = new SqliteFakeD1();
  const memory = new InMemoryOpenTofuControlStore();
  return [
    {
      label: "memory",
      control: memory,
      interfaces: createInMemoryInterfaceStores({
        materializationAuthority: memory,
      }) as GuardedInterfaceStores,
    },
    {
      label: "postgres",
      control: new SqlOpenTofuControlStore({ client: pgClient }),
      interfaces: createSqlInterfaceStores(pgClient) as GuardedInterfaceStores,
    },
    {
      label: "d1",
      control: new CloudflareD1OpenTofuControlStore(d1),
      interfaces: createD1InterfaceStores(d1) as GuardedInterfaceStores,
    },
  ];
}

function resolvedInterface(
  capsule: Capsule,
  label: string,
  suffix = "current",
): Interface {
  const now = "2026-08-29T10:01:00.000Z";
  const resource = `https://${label}-${suffix}.example.test/mcp`;
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: `if_authority_${label}_${suffix}`,
      workspaceId: capsule.workspaceId,
      name: `authority-${suffix}`,
      ownerRef: { kind: "Capsule", id: capsule.id },
      generation: 1,
      createdAt: now,
      updatedAt: now,
    },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: { source: "literal", value: resource },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      resolvedInputs: { endpoint: resource },
      resourceUri: resource,
      conditions: [],
    },
  };
}

function readyBinding(
  iface: Interface,
  label: string,
  suffix = "current",
): InterfaceBinding {
  const now = "2026-08-29T10:01:00.000Z";
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "InterfaceBinding",
    metadata: {
      id: `ib_authority_${label}_${suffix}`,
      workspaceId: iface.metadata.workspaceId,
      generation: 1,
      createdAt: now,
      updatedAt: now,
    },
    spec: {
      interfaceId: iface.metadata.id,
      subjectRef: { kind: "Principal", id: `principal_${suffix}` },
      permissions: ["mcp.invoke"],
      delivery: { type: "none" },
    },
    status: {
      phase: "Ready",
      observedInterfaceRevision: iface.status.resolvedRevision,
      conditions: [],
    },
  };
}

function blueprint(key = "runtime-mcp"): CapsuleInterfaceBlueprint {
  return {
    key,
    name: `interface-${key}`,
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: { source: "capsule_output", outputName: "endpoint" },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  };
}

async function commitPendingIntent(
  store: OpenTofuControlStore,
  capsule: Capsule,
  applyRunId: string,
  generation = 1,
  committedAt = COMMITTED_AT,
): Promise<CapsuleInterfaceMaterializationIntent> {
  const state: StateVersion = {
    id: `state_${applyRunId}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation,
    stateRef: `state/${applyRunId}`,
    digest: `sha256:${"a".repeat(64)}`,
    createdByRunId: applyRunId,
    createdAt: committedAt,
  };
  const output: Output = {
    id: `output_${applyRunId}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateGeneration: generation,
    rawArtifactRef: `raw/${applyRunId}`,
    publicOutputs: { endpoint: "https://runtime.example.test/mcp" },
    workspaceOutputs: { endpoint: "https://runtime.example.test/mcp" },
    outputDigest: `sha256:${"b".repeat(64)}`,
    createdAt: committedAt,
  };
  const planRunId = `plan_${applyRunId}`;
  const applyRun: ApplyRun = {
    id: applyRunId,
    planRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId,
      capsuleId: capsule.id,
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
    createdAt: Date.parse(committedAt),
    updatedAt: Date.parse(committedAt),
    startedAt: Date.parse(committedAt),
    finishedAt: Date.parse(committedAt),
  };
  const pinned = await pinCapsuleInterfaceBlueprints({
    installConfigId: capsule.installConfigId,
    blueprints: [blueprint()],
  });
  const intent = createCapsuleInterfaceMaterializationIntent({
    applyRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateVersionId: state.id,
    outputId: output.id,
    stateGeneration: generation,
    pinned: pinned!,
    createdAt: committedAt,
  });
  await store.commitRunState({
    stateVersion: state,
    output,
    capsulePatch: {
      id: capsule.id,
      patch: {
        currentStateVersionId: state.id,
        currentStateGeneration: generation,
        currentOutputId: output.id,
        status: "active",
        updatedAt: committedAt,
      },
      guard: {
        currentStateVersionId: capsule.currentStateVersionId,
        status: capsule.status,
      },
    },
    applyRunTerminal: applyRun,
    interfaceMaterializationIntent: intent,
  });
  return intent;
}

test("exact intent drain cannot claim an older due row across stores", async () => {
  for (const [label, store] of await stores()) {
    const olderSeed = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_exact_older_${label}`,
      capsuleId: `capsule_intent_exact_older_${label}`,
      sourceId: `source_intent_exact_older_${label}`,
      snapshotId: `snapshot_intent_exact_older_${label}`,
      installConfigId: `config_intent_exact_older_${label}`,
    });
    const targetSeed = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_exact_target_${label}`,
      capsuleId: `capsule_intent_exact_target_${label}`,
      sourceId: `source_intent_exact_target_${label}`,
      snapshotId: `snapshot_intent_exact_target_${label}`,
      installConfigId: `config_intent_exact_target_${label}`,
    });
    const older = await commitPendingIntent(
      store,
      olderSeed.capsule,
      `apply_intent_exact_older_${label}`,
      1,
      "2026-08-29T09:59:00.000Z",
    );
    const target = await commitPendingIntent(
      store,
      targetSeed.capsule,
      `apply_intent_exact_target_${label}`,
    );
    const materializedIntentIds: string[] = [];
    let lease = 0;
    const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
      store,
      coordination: new InMemoryCapsuleCoordination({
        now: () => Date.parse(CLAIMED_AT),
      }),
      target: {
        materializeItem: (input) => {
          materializedIntentIds.push(input.intentId);
          return Promise.resolve({ kind: "materialized" });
        },
      },
      now: () => CLAIMED_AT,
      newLeaseToken: () => `lease_intent_exact_${label}_${lease++}`,
    });

    expect(await drainer.drainIntent(target.id), `${label}: exact`).toMatchObject(
      {
        claimed: 1,
        completed: 1,
        workItemsCompleted: 1,
      },
    );
    expect(materializedIntentIds, `${label}: exact target`).toEqual([target.id]);
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(older.id),
      `${label}: older untouched`,
    ).toMatchObject({ status: "pending", attempts: 0 });

    expect(await drainer.drain({ limit: 1 }), `${label}: global`).toMatchObject({
      claimed: 1,
      completed: 1,
      workItemsCompleted: 1,
    });
    expect(materializedIntentIds, `${label}: global remains oldest-first`).toEqual(
      [target.id, older.id],
    );
  }
});

test("exact intent drain no-ops ineligible rows and reclaims only its expired row across stores", async () => {
  for (const [label, store] of await stores()) {
    const delayedSeed = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_exact_delayed_${label}`,
      capsuleId: `capsule_intent_exact_delayed_${label}`,
      sourceId: `source_intent_exact_delayed_${label}`,
      snapshotId: `snapshot_intent_exact_delayed_${label}`,
      installConfigId: `config_intent_exact_delayed_${label}`,
    });
    const delayed = await commitPendingIntent(
      store,
      delayedSeed.capsule,
      `apply_intent_exact_delayed_${label}`,
    );
    const delayedLease = `lease_intent_exact_delayed_${label}`;
    expect(
      await store.claimCapsuleInterfaceMaterializationIntent({
        intentId: delayed.id,
        leaseToken: delayedLease,
        claimedAt: CLAIMED_AT,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      }),
      `${label}: exact seed claim`,
    ).toMatchObject({ id: delayed.id });
    await store.settleCapsuleInterfaceMaterializationIntent({
      id: delayed.id,
      leaseToken: delayedLease,
      expectedNextItemIndex: 0,
      settledAt: SETTLED_AT,
      outcome: {
        kind: "retry",
        code: "interface_materialization_unavailable",
        detailDigest: ERROR_DIGEST,
        nextRetryAt: RETRY_AT,
      },
    });

    const leasedSeed = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_exact_leased_${label}`,
      capsuleId: `capsule_intent_exact_leased_${label}`,
      sourceId: `source_intent_exact_leased_${label}`,
      snapshotId: `snapshot_intent_exact_leased_${label}`,
      installConfigId: `config_intent_exact_leased_${label}`,
    });
    const leased = await commitPendingIntent(
      store,
      leasedSeed.capsule,
      `apply_intent_exact_leased_${label}`,
    );
    const liveLeaseToken = `lease_intent_exact_live_${label}`;
    expect(
      await store.claimCapsuleInterfaceMaterializationIntent({
        intentId: leased.id,
        leaseToken: liveLeaseToken,
        claimedAt: CLAIMED_AT,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      }),
      `${label}: live seed claim`,
    ).toMatchObject({ id: leased.id });

    let now = SETTLED_AT;
    const materializedIntentIds: string[] = [];
    const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
      store,
      coordination: new InMemoryCapsuleCoordination({
        now: () => Date.parse(now),
      }),
      target: {
        materializeItem: (input) => {
          materializedIntentIds.push(input.intentId);
          return Promise.resolve({ kind: "materialized" });
        },
      },
      now: () => now,
      newLeaseToken: () => `lease_intent_exact_noop_${label}`,
    });
    const noClaim = {
      claimed: 0,
      completed: 0,
      progressed: 0,
      workItemsCompleted: 0,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    };
    expect(
      await drainer.drainIntent(`cimi_unknown_${label}`),
      `${label}: unknown`,
    ).toEqual(noClaim);
    expect(
      await drainer.drainIntent(delayed.id),
      `${label}: not due`,
    ).toEqual(noClaim);
    expect(
      await drainer.drainIntent(leased.id),
      `${label}: live lease`,
    ).toEqual(noClaim);
    expect(materializedIntentIds, `${label}: no target writes`).toEqual([]);
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(leased.id),
      `${label}: lease preserved`,
    ).toMatchObject({
      status: "pending",
      attempts: 1,
      leaseToken: liveLeaseToken,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    });

    now = RETRY_AT;
    expect(
      await drainer.drainIntent(`cimi_unknown_due_peer_${label}`),
      `${label}: unknown never falls through to a due peer`,
    ).toEqual(noClaim);
    expect(
      await drainer.drainIntent(leased.id),
      `${label}: expired exact lease`,
    ).toMatchObject({ claimed: 1, completed: 1, workItemsCompleted: 1 });
    expect(
      materializedIntentIds,
      `${label}: expired exact target only`,
    ).toEqual([leased.id]);
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(delayed.id),
      `${label}: older due delayed row remains untouched`,
    ).toMatchObject({ status: "pending", attempts: 1 });
  }
});

test("two Interface intent claimants produce exactly one lease owner", async () => {
  for (const [label, store] of await stores()) {
    const { capsule } = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_claim_${label}`,
      capsuleId: `capsule_intent_claim_${label}`,
    });
    const intent = await commitPendingIntent(
      store,
      capsule,
      `apply_intent_claim_${label}`,
    );

    const [first, second] = await Promise.all([
      store.claimCapsuleInterfaceMaterializationIntent({
        leaseToken: `lease_claim_a_${label}`,
        claimedAt: CLAIMED_AT,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      }),
      store.claimCapsuleInterfaceMaterializationIntent({
        leaseToken: `lease_claim_b_${label}`,
        claimedAt: CLAIMED_AT,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      }),
    ]);

    const winners = [first, second].filter(
      (candidate): candidate is CapsuleInterfaceMaterializationIntent =>
        candidate !== undefined,
    );
    expect(winners, label).toHaveLength(1);
    expect(winners[0], label).toMatchObject({
      id: intent.id,
      attempts: 1,
      status: "pending",
      leaseExpiresAt: LEASE_EXPIRES_AT,
    });
    expect(
      [`lease_claim_a_${label}`, `lease_claim_b_${label}`],
      label,
    ).toContain(winners[0]!.leaseToken);
  }
});

test("two exact Interface intent claimants preserve the same single-winner lease CAS", async () => {
  for (const [label, store] of await stores()) {
    const { capsule } = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_exact_claim_${label}`,
      capsuleId: `capsule_intent_exact_claim_${label}`,
    });
    const intent = await commitPendingIntent(
      store,
      capsule,
      `apply_intent_exact_claim_${label}`,
    );
    const [first, second] = await Promise.all([
      store.claimCapsuleInterfaceMaterializationIntent({
        intentId: intent.id,
        leaseToken: `lease_exact_claim_a_${label}`,
        claimedAt: CLAIMED_AT,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      }),
      store.claimCapsuleInterfaceMaterializationIntent({
        intentId: intent.id,
        leaseToken: `lease_exact_claim_b_${label}`,
        claimedAt: CLAIMED_AT,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      }),
    ]);
    const winners = [first, second].filter(
      (candidate): candidate is CapsuleInterfaceMaterializationIntent =>
        candidate !== undefined,
    );
    expect(winners, label).toHaveLength(1);
    expect(winners[0], label).toMatchObject({ id: intent.id, attempts: 1 });
  }
});

test("an expired intent lease and successor Capsule generation atomically fence every Interface authority write across stores", async () => {
  for (const { label, control, interfaces } of await authorityStorePairs()) {
    const { capsule } = await seedCapsuleModel(control, {
      workspaceId: `workspace_atomic_authority_${label}`,
      capsuleId: `capsule_atomic_authority_${label}`,
    });
    const intent = await commitPendingIntent(
      control,
      capsule,
      `apply_atomic_authority_${label}`,
    );
    const currentInterface = resolvedInterface(capsule, label);
    const currentBinding = readyBinding(currentInterface, label);

    const claimedAtMs = Date.now();
    const claimedAt = new Date(claimedAtMs).toISOString();
    const leaseExpiresAt = new Date(claimedAtMs + 60_000).toISOString();
    const leaseToken = `lease_atomic_authority_${label}`;
    const claimed = await control.claimCapsuleInterfaceMaterializationIntent({
      leaseToken,
      claimedAt,
      leaseExpiresAt,
    });
    expect(claimed?.id, `${label}:claim`).toBe(intent.id);
    const staleAuthority: MaterializationWriteAuthorityFixture = {
      intentId: intent.id,
      leaseToken,
      expectedNextItemIndex: intent.nextItemIndex,
      workspaceId: intent.workspaceId,
      capsuleId: intent.capsuleId,
      installConfigId: intent.installConfigId,
      stateVersionId: intent.stateVersionId,
      outputId: intent.outputId,
      stateGeneration: intent.stateGeneration,
    };
    expect(
      await interfaces.interfaces.create(currentInterface, staleAuthority),
      `${label}:current Interface authority`,
    ).toBe(true);
    expect(
      await interfaces.bindings.create(currentBinding, staleAuthority),
      `${label}:current Binding authority`,
    ).toBe(true);

    const successorClaimedAtMs = claimedAtMs + 60_001;
    expect(
      await control.claimCapsuleInterfaceMaterializationIntent({
        leaseToken: `lease_atomic_authority_successor_${label}`,
        claimedAt: new Date(successorClaimedAtMs).toISOString(),
        leaseExpiresAt: new Date(successorClaimedAtMs + 60_000).toISOString(),
      }),
      `${label}:expired lease takeover`,
    ).toMatchObject({ id: intent.id });
    const currentCapsule = (await control.getCapsule(capsule.id))!;
    await control.putCapsule({
      ...currentCapsule,
      currentStateVersionId: `state_atomic_authority_successor_${label}`,
      currentStateGeneration: intent.stateGeneration + 1,
      currentOutputId: `output_atomic_authority_successor_${label}`,
      updatedAt: new Date(successorClaimedAtMs).toISOString(),
    });

    const newInterface = resolvedInterface(capsule, label, "new");
    const changedInterface: Interface = {
      ...currentInterface,
      metadata: {
        ...currentInterface.metadata,
        updatedAt: new Date(successorClaimedAtMs).toISOString(),
      },
      status: {
        ...currentInterface.status,
        resolvedRevision: currentInterface.status.resolvedRevision + 1,
      },
    };
    const newBinding = readyBinding(currentInterface, label, "new");
    const changedBinding: InterfaceBinding = {
      ...currentBinding,
      metadata: {
        ...currentBinding.metadata,
        generation: currentBinding.metadata.generation + 1,
        updatedAt: new Date(successorClaimedAtMs).toISOString(),
      },
    };
    const outcomes = [
      await interfaces.interfaces.create(newInterface, staleAuthority),
      await interfaces.interfaces.claimOAuth2Resource(
        {
          record: currentInterface,
          resource: currentInterface.status.resourceUri!,
        },
        staleAuthority,
      ),
      await interfaces.interfaces.compareAndSet(
        changedInterface,
        {
          generation: currentInterface.metadata.generation,
          resolvedRevision: currentInterface.status.resolvedRevision,
          record: currentInterface,
        },
        staleAuthority,
      ),
      await interfaces.bindings.create(newBinding, staleAuthority),
      await interfaces.bindings.compareAndSet(
        changedBinding,
        currentBinding.metadata.generation,
        staleAuthority,
      ),
    ];

    expect(outcomes, `${label}:all stale writes`).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(
      await interfaces.interfaces.get(newInterface.metadata.id),
      `${label}:no ghost Interface`,
    ).toBeUndefined();
    expect(
      await interfaces.bindings.get(newBinding.metadata.id),
      `${label}:no ghost Binding`,
    ).toBeUndefined();
  }
});

test("retryable Interface intent failure is durably reclaimed after backoff", async () => {
  for (const [label, store] of await stores()) {
    const { capsule } = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_retry_${label}`,
      capsuleId: `capsule_intent_retry_${label}`,
    });
    const intent = await commitPendingIntent(
      store,
      capsule,
      `apply_intent_retry_${label}`,
    );
    const first = await store.claimCapsuleInterfaceMaterializationIntent({
      leaseToken: `lease_retry_a_${label}`,
      claimedAt: CLAIMED_AT,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    });
    expect(first?.id, label).toBe(intent.id);

    expect(
      await store.settleCapsuleInterfaceMaterializationIntent({
        id: intent.id,
        leaseToken: `lease_retry_a_${label}`,
        expectedNextItemIndex: 0,
        settledAt: SETTLED_AT,
        outcome: {
          kind: "retry",
          code: "oauth_authority_unavailable",
          detailDigest: ERROR_DIGEST,
          nextRetryAt: RETRY_AT,
        },
      }),
      label,
    ).toMatchObject({ kind: "updated", intent: { status: "pending" } });
    expect(
      await store.claimCapsuleInterfaceMaterializationIntent({
        leaseToken: `lease_retry_early_${label}`,
        claimedAt: "2026-08-29T10:04:59.999Z",
        leaseExpiresAt: "2026-08-29T10:05:59.999Z",
      }),
      `${label}:before backoff`,
    ).toBeUndefined();

    const reclaimed = await store.claimCapsuleInterfaceMaterializationIntent({
      leaseToken: `lease_retry_b_${label}`,
      claimedAt: RETRY_AT,
      leaseExpiresAt: "2026-08-29T10:06:00.000Z",
    });
    expect(reclaimed, label).toMatchObject({
      id: intent.id,
      attempts: 2,
      leaseToken: `lease_retry_b_${label}`,
      error: { code: "oauth_authority_unavailable" },
    });
    expect(
      await store.settleCapsuleInterfaceMaterializationIntent({
        id: intent.id,
        leaseToken: `lease_retry_a_${label}`,
        expectedNextItemIndex: 0,
        settledAt: RETRY_AT,
        outcome: { kind: "completed", disposition: "materialized" },
      }),
      `${label}:lost claimant`,
    ).toEqual({ kind: "lease-lost" });
  }
});

test("scheduled recovery materializes an Apply intent after the committing isolate dies", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_intent_crash_recovery",
    capsuleId: "capsule_intent_crash_recovery",
  });
  const intent = await commitPendingIntent(
    store,
    capsule,
    "apply_intent_crash_recovery",
  );
  const calls: string[] = [];
  const target: CapsuleInterfaceMaterializationTarget = {
    materializeItem: (input) => {
      calls.push(input.intentId);
      return Promise.resolve({ kind: "materialized" });
    },
  };
  const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
    store,
    coordination: new InMemoryCapsuleCoordination({
      now: () => Date.parse(CLAIMED_AT),
    }),
    target,
    now: () => CLAIMED_AT,
    newLeaseToken: () => "lease_crash_recovery",
  });

  expect(await drainer.drain({ limit: 1 })).toEqual({
    claimed: 1,
    completed: 1,
    progressed: 0,
    workItemsCompleted: 1,
    retried: 0,
    deadLettered: 0,
    leaseLost: 0,
  });
  expect(calls).toEqual([intent.id]);
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(intent.id),
  ).toMatchObject({
    status: "completed",
    receipt: { disposition: "materialized" },
  });
});

test("two drainers race but only the lease owner starts the side effect", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_intent_drain_race",
    capsuleId: "capsule_intent_drain_race",
  });
  await commitPendingIntent(store, capsule, "apply_intent_drain_race");
  let sideEffects = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  const target: CapsuleInterfaceMaterializationTarget = {
    materializeItem: async () => {
      sideEffects += 1;
      started();
      await blocked;
      return { kind: "materialized" };
    },
  };
  let token = 0;
  const coordination = new InMemoryCapsuleCoordination({
    now: () => Date.parse(CLAIMED_AT),
  });
  const createDrainer = () =>
    new CapsuleInterfaceMaterializationIntentDrainer({
      store,
      coordination,
      target,
      now: () => CLAIMED_AT,
      newLeaseToken: () => `lease_drain_race_${++token}`,
    });

  const first = createDrainer().drain({ limit: 1 });
  await didStart;
  const second = await createDrainer().drain({ limit: 1 });
  expect(second.claimed).toBe(0);
  expect(sideEffects).toBe(1);
  release();
  expect((await first).completed).toBe(1);
  expect(sideEffects).toBe(1);
});

test("an expired claimant is fenced out after another claimant reclaims the intent", async () => {
  for (const [label, store] of await stores()) {
    const { capsule } = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_expired_${label}`,
      capsuleId: `capsule_intent_expired_${label}`,
    });
    const intent = await commitPendingIntent(
      store,
      capsule,
      `apply_intent_expired_${label}`,
    );
    expect(
      await store.claimCapsuleInterfaceMaterializationIntent({
        leaseToken: `lease_expired_a_${label}`,
        claimedAt: CLAIMED_AT,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      }),
      label,
    ).toMatchObject({ id: intent.id, attempts: 1 });

    expect(
      await store.claimCapsuleInterfaceMaterializationIntent({
        leaseToken: `lease_expired_b_${label}`,
        claimedAt: LEASE_EXPIRES_AT,
        leaseExpiresAt: RETRY_AT,
      }),
      label,
    ).toMatchObject({
      id: intent.id,
      attempts: 2,
      leaseToken: `lease_expired_b_${label}`,
    });
    expect(
      await store.settleCapsuleInterfaceMaterializationIntent({
        id: intent.id,
        leaseToken: `lease_expired_a_${label}`,
        expectedNextItemIndex: 0,
        settledAt: LEASE_EXPIRES_AT,
        outcome: { kind: "completed", disposition: "materialized" },
      }),
      label,
    ).toEqual({ kind: "lease-lost" });
  }
});

test("an intent owner can renew only its still-live exact lease and cursor across stores", async () => {
  for (const [label, store] of await stores()) {
    const { capsule } = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_renew_${label}`,
      capsuleId: `capsule_intent_renew_${label}`,
    });
    const intent = await commitPendingIntent(
      store,
      capsule,
      `apply_intent_renew_${label}`,
    );
    const leaseToken = `lease_renew_a_${label}`;
    await store.claimCapsuleInterfaceMaterializationIntent({
      leaseToken,
      claimedAt: CLAIMED_AT,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    });

    expect(
      await store.renewCapsuleInterfaceMaterializationIntentLease({
        id: intent.id,
        leaseToken,
        expectedNextItemIndex: 0,
        renewedAt: "2026-08-29T10:01:30.000Z",
        leaseExpiresAt: "2026-08-29T10:03:00.000Z",
      }),
      label,
    ).toMatchObject({
      kind: "updated",
      intent: {
        id: intent.id,
        leaseToken,
        leaseExpiresAt: "2026-08-29T10:03:00.000Z",
      },
    });
    expect(
      await store.claimCapsuleInterfaceMaterializationIntent({
        leaseToken: `lease_renew_b_${label}`,
        claimedAt: LEASE_EXPIRES_AT,
        leaseExpiresAt: RETRY_AT,
      }),
      `${label}:renewed lease remains owned`,
    ).toBeUndefined();
    expect(
      await store.renewCapsuleInterfaceMaterializationIntentLease({
        id: intent.id,
        leaseToken,
        expectedNextItemIndex: 1,
        renewedAt: "2026-08-29T10:02:00.000Z",
        leaseExpiresAt: "2026-08-29T10:04:00.000Z",
      }),
      `${label}:cursor fence`,
    ).toEqual({ kind: "lease-lost" });
  }
});

test("completed and dead-letter terminal outcomes are durable across stores", async () => {
  for (const [label, store] of await stores()) {
    for (const outcomeKind of ["completed", "dead-letter"] as const) {
      const { capsule } = await seedCapsuleModel(store, {
        workspaceId: `workspace_intent_terminal_${label}_${outcomeKind}`,
        capsuleId: `capsule_intent_terminal_${label}_${outcomeKind}`,
        sourceId: `source_intent_terminal_${label}_${outcomeKind}`,
        snapshotId: `snapshot_intent_terminal_${label}_${outcomeKind}`,
        installConfigId: `config_intent_terminal_${label}_${outcomeKind}`,
      });
      const intent = await commitPendingIntent(
        store,
        capsule,
        `apply_intent_terminal_${label}_${outcomeKind}`,
      );
      const leaseToken = `lease_terminal_${label}_${outcomeKind}`;
      expect(
        await store.claimCapsuleInterfaceMaterializationIntent({
          leaseToken,
          claimedAt: CLAIMED_AT,
          leaseExpiresAt: LEASE_EXPIRES_AT,
        }),
        `${label}:${outcomeKind}:claim`,
      ).toMatchObject({ id: intent.id });
      const outcome =
        outcomeKind === "completed"
          ? ({ kind: "completed", disposition: "materialized" } as const)
          : ({
              kind: "dead-letter",
              code: "interface_provenance_conflict",
              detailDigest: ERROR_DIGEST,
            } as const);

      expect(
        await store.settleCapsuleInterfaceMaterializationIntent({
          id: intent.id,
          leaseToken,
          expectedNextItemIndex: 0,
          settledAt: SETTLED_AT,
          outcome,
        }),
        `${label}:${outcomeKind}:settle`,
      ).toMatchObject({
        kind: "updated",
        intent: {
          status: outcomeKind === "completed" ? "completed" : "dead_letter",
        },
      });
      expect(
        await store.claimCapsuleInterfaceMaterializationIntent({
          leaseToken: `lease_terminal_replay_${label}_${outcomeKind}`,
          claimedAt: RETRY_AT,
          leaseExpiresAt: "2026-08-29T10:06:00.000Z",
        }),
        `${label}:${outcomeKind}:replay`,
      ).toBeUndefined();
    }
  }
});

test("retryable drainer failure persists backoff and later completes idempotently", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_intent_drainer_retry",
    capsuleId: "capsule_intent_drainer_retry",
  });
  const intent = await commitPendingIntent(
    store,
    capsule,
    "apply_intent_drainer_retry",
  );
  let now = CLAIMED_AT;
  let materializations = 0;
  let invoked = 0;
  const target: CapsuleInterfaceMaterializationTarget = {
    materializeItem: () => {
      invoked += 1;
      if (invoked === 1) {
        materializations += 1;
        return Promise.reject(new Error("isolate died after canonical writes"));
      }
      return Promise.resolve({ kind: "materialized" });
    },
  };
  let lease = 0;
  const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
    store,
    coordination: new InMemoryCapsuleCoordination({
      now: () => Date.parse(now),
    }),
    target,
    now: () => now,
    newLeaseToken: () => `lease_drainer_retry_${++lease}`,
    retryBaseMs: 30_000,
  });

  expect(await drainer.drain({ limit: 1 })).toMatchObject({
    claimed: 1,
    retried: 1,
  });
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(intent.id),
  ).toMatchObject({
    status: "pending",
    attempts: 1,
    nextRetryAt: "2026-08-29T10:01:30.000Z",
    error: { code: "interface_materialization_unavailable" },
  });
  now = "2026-08-29T10:01:29.999Z";
  expect((await drainer.drain({ limit: 1 })).claimed).toBe(0);
  now = "2026-08-29T10:01:30.000Z";
  expect(await drainer.drain({ limit: 1 })).toMatchObject({
    claimed: 1,
    completed: 1,
  });
  expect(invoked).toBe(2);
  expect(materializations).toBe(1);
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(intent.id),
  ).toMatchObject({ status: "completed" });
});

test("a non-retryable materialization result is durable and never replayed", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_intent_dead_letter",
    capsuleId: "capsule_intent_dead_letter",
  });
  const intent = await commitPendingIntent(
    store,
    capsule,
    "apply_intent_dead_letter",
  );
  let calls = 0;
  const activities: unknown[] = [];
  const observability = new InMemoryObservabilitySink();
  const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
    store,
    coordination: new InMemoryCapsuleCoordination({
      now: () => Date.parse(CLAIMED_AT),
    }),
    target: {
      materializeItem: () => {
        calls += 1;
        return Promise.resolve({
          kind: "dead-letter",
          code: "interface_provenance_conflict",
        });
      },
    },
    now: () => CLAIMED_AT,
    newLeaseToken: () => "lease_dead_letter",
    activity: {
      record: (event) => {
        activities.push(event);
        return Promise.resolve(undefined);
      },
    },
    observability,
  });

  expect(await drainer.drain({ limit: 1 })).toMatchObject({
    claimed: 1,
    deadLettered: 1,
  });
  expect(await drainer.drain({ limit: 1 })).toMatchObject({ claimed: 0 });
  expect(calls).toBe(1);
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(intent.id),
  ).toMatchObject({
    status: "dead_letter",
    error: { code: "interface_provenance_conflict" },
  });
  expect(activities).toEqual([
    expect.objectContaining({
      workspaceId: capsule.workspaceId,
      action: "interface_materialization.dead_lettered",
      targetId: intent.id,
      metadata: expect.objectContaining({
        blueprintsDigest: intent.blueprintsDigest,
        errorCode: "interface_provenance_conflict",
      }),
    }),
  ]);
  expect(
    await observability.listMetrics({
      name: "takosumi.interface_materialization.dead_lettered",
    }),
  ).toEqual([
    expect.objectContaining({
      workspaceId: capsule.workspaceId,
      value: 1,
      tags: { error_code: "interface_provenance_conflict" },
    }),
  ]);
  expect(JSON.stringify({ activities }), "value-free activity").not.toContain(
    "runtime.example.test",
  );
});

test("non-authoritative telemetry failure cannot erase a durable dead letter", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_intent_dead_letter_telemetry",
    capsuleId: "capsule_intent_dead_letter_telemetry",
  });
  const intent = await commitPendingIntent(
    store,
    capsule,
    "apply_intent_dead_letter_telemetry",
  );
  const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
    store,
    coordination: new InMemoryCapsuleCoordination({
      now: () => Date.parse(CLAIMED_AT),
    }),
    target: {
      materializeItem: () =>
        Promise.resolve({
          kind: "dead-letter",
          code: "interface_provenance_conflict",
        }),
    },
    activity: {
      record: () => Promise.reject(new Error("activity unavailable")),
    },
    observability: {
      recordMetric: () => Promise.reject(new Error("metrics unavailable")),
    },
    now: () => CLAIMED_AT,
    newLeaseToken: () => "lease_dead_letter_telemetry",
  });

  expect(await drainer.drain({ limit: 1 })).toMatchObject({
    claimed: 1,
    deadLettered: 1,
    leaseLost: 0,
  });
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(intent.id),
  ).toMatchObject({ status: "dead_letter" });
});

test("a newer generation or destroyed Capsule completes stale intent without materializing", async () => {
  for (const scenario of ["superseded", "destroyed"] as const) {
    const store = new InMemoryOpenTofuControlStore();
    const { capsule } = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_${scenario}`,
      capsuleId: `capsule_intent_${scenario}`,
    });
    const intent = await commitPendingIntent(
      store,
      capsule,
      `apply_intent_${scenario}`,
    );
    const current = (await store.getCapsule(capsule.id))!;
    await store.putCapsule(
      scenario === "destroyed"
        ? { ...current, status: "destroyed", updatedAt: CLAIMED_AT }
        : {
            ...current,
            currentStateGeneration: 2,
            currentStateVersionId: "state_newer_generation",
            currentOutputId: "output_newer_generation",
            updatedAt: CLAIMED_AT,
          },
    );
    let calls = 0;
    const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
      store,
      coordination: new InMemoryCapsuleCoordination({
        now: () => Date.parse(CLAIMED_AT),
      }),
      target: {
        materializeItem: () => {
          calls += 1;
          return Promise.resolve({ kind: "materialized" });
        },
      },
      now: () => CLAIMED_AT,
      newLeaseToken: () => `lease_${scenario}`,
    });

    expect((await drainer.drain({ limit: 1 })).completed).toBe(1);
    expect(calls).toBe(0);
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(intent.id),
    ).toMatchObject({
      status: "completed",
      receipt: {
        disposition:
          scenario === "destroyed"
            ? "retired_before_materialization"
            : "superseded_before_materialization",
      },
    });
  }
});

test("the canonical InterfaceService target replays the pinned snapshot without rereading InstallConfig", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_intent_service_target",
    capsuleId: "capsule_intent_service_target",
  });
  const intent = await commitPendingIntent(
    store,
    capsule,
    "apply_intent_service_target",
  );
  const interfaceStores = createInMemoryInterfaceStores({
    materializationAuthority: store,
    now: () => CLAIMED_AT,
  });
  const interfaces = new InterfaceService({
    stores: interfaceStores,
    resolver: new OutputBackedInterfaceInputResolver({ opentofu: store }),
    now: () => CLAIMED_AT,
    ownerExists: () => Promise.resolve(true),
    ownerReady: () => Promise.resolve(true),
    lifecycleGuard: () => Promise.resolve(undefined),
  });
  const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
    store,
    coordination: new InMemoryCapsuleCoordination({
      now: () => Date.parse(CLAIMED_AT),
    }),
    target: new InterfaceServiceCapsuleMaterializationTarget(interfaces),
    now: () => CLAIMED_AT,
    newLeaseToken: () => "lease_service_target",
  });

  expect((await drainer.drain({ limit: 1 })).completed).toBe(1);
  const [materialized] = await interfaces.list({
    workspaceId: capsule.workspaceId,
    ownerKind: "Capsule",
    ownerId: capsule.id,
    includeRetired: true,
  });
  expect(materialized).toMatchObject({
    metadata: {
      ownerRef: { kind: "Capsule", id: capsule.id },
      materializedFrom: {
        source: "capsule_blueprint",
        key: "runtime-mcp",
      },
    },
    status: { phase: "Resolved" },
  });
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(intent.id),
  ).toMatchObject({ status: "completed" });
  expect((await drainer.drain({ limit: 1 })).claimed).toBe(0);
  expect(
    await interfaces.list({
      workspaceId: capsule.workspaceId,
      ownerKind: "Capsule",
      ownerId: capsule.id,
      includeRetired: true,
    }),
  ).toHaveLength(1);
});

test("a stalled materializer cannot write an Interface after both leases expire and a newer Capsule generation wins", async () => {
  for (const [label, store] of await stores()) {
    const { capsule } = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_stalled_fence_${label}`,
      capsuleId: `capsule_intent_stalled_fence_${label}`,
    });
    const intent = await commitPendingIntent(
      store,
      capsule,
      `apply_intent_stalled_fence_${label}`,
    );
    let nowMs = Date.parse(CLAIMED_AT);
    const now = () => new Date(nowMs).toISOString();
    const coordination = new InMemoryCapsuleCoordination({ now: () => nowMs });
    let releaseOwnerCheck!: () => void;
    const ownerCheckBlocked = new Promise<void>((resolve) => {
      releaseOwnerCheck = resolve;
    });
    let ownerCheckStarted!: () => void;
    const ownerCheckDidStart = new Promise<void>((resolve) => {
      ownerCheckStarted = resolve;
    });
    const interfaces = new InterfaceService({
      stores: createInMemoryInterfaceStores(),
      ownerExists: async () => {
        ownerCheckStarted();
        await ownerCheckBlocked;
        return true;
      },
      now,
    });
    const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
      store,
      coordination,
      target: new InterfaceServiceCapsuleMaterializationTarget(interfaces),
      now,
      newLeaseToken: () => `lease_stalled_fence_${label}`,
      intentLeaseMs: 1_000,
      capsuleLeaseMs: 1_000,
    });

    const draining = drainer.drain({
      limit: 1,
      maxWorkItems: 1,
      timeBudgetMs: 10_000,
    });
    await ownerCheckDidStart;
    nowMs += 2_000;
    const takeover = await coordination.acquireLease({
      scope: capsuleLeaseScope(capsule.id, capsule.environment),
      holderId: `concurrent-apply-${label}`,
      ttlMs: 10_000,
    });
    expect(takeover.acquired, label).toBe(true);
    const current = (await store.getCapsule(capsule.id))!;
    await store.putCapsule({
      ...current,
      currentStateVersionId: `state_concurrent_generation_${label}`,
      currentStateGeneration: intent.stateGeneration + 1,
      currentOutputId: `output_concurrent_generation_${label}`,
      updatedAt: now(),
    });
    releaseOwnerCheck();

    expect(await draining, label).toMatchObject({ claimed: 1, leaseLost: 1 });
    expect(
      await interfaces.list({
        workspaceId: capsule.workspaceId,
        ownerKind: "Capsule",
        ownerId: capsule.id,
        includeRetired: true,
      }),
      `${label}:no stale Interface`,
    ).toEqual([]);
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(intent.id),
      `${label}:cursor remains pending`,
    ).toMatchObject({ status: "pending", nextItemIndex: 0 });
  }
});

test("a stalled target cannot authority-write after the per-claim deadline", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_intent_deadline_fence",
    capsuleId: "capsule_intent_deadline_fence",
  });
  const intent = await commitPendingIntent(
    store,
    capsule,
    "apply_intent_deadline_fence",
  );
  let monotonicNow = 0;
  let releaseTarget!: () => void;
  const targetBlocked = new Promise<void>((resolve) => {
    releaseTarget = resolve;
  });
  let targetStarted!: () => void;
  const targetDidStart = new Promise<void>((resolve) => {
    targetStarted = resolve;
  });
  let authorityWrites = 0;
  const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
    store,
    coordination: new InMemoryCapsuleCoordination({
      now: () => Date.parse(CLAIMED_AT),
    }),
    target: {
      materializeItem: async (input) => {
        targetStarted();
        await targetBlocked;
        await input.authorityFence.assertCurrent();
        authorityWrites += 1;
        return { kind: "materialized" };
      },
    },
    now: () => CLAIMED_AT,
    monotonicNow: () => monotonicNow,
    newLeaseToken: () => "lease_deadline_fence",
  });

  const draining = drainer.drain({
    limit: 1,
    maxWorkItems: 1,
    timeBudgetMs: 10,
  });
  await targetDidStart;
  monotonicNow = 11;
  releaseTarget();

  expect(await draining).toMatchObject({
    claimed: 1,
    completed: 0,
    retried: 1,
  });
  expect(authorityWrites).toBe(0);
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(intent.id),
  ).toMatchObject({
    status: "pending",
    nextItemIndex: 0,
    error: { code: "interface_materialization_budget_exhausted" },
  });
});

test("the InterfaceService target fences every Interface, Binding, and OAuth authority write", async () => {
  const inner = createInMemoryInterfaceStores({
    materializationAuthority: {
      isCapsuleInterfaceMaterializationWriteAuthorityCurrent: () => true,
    },
    now: () => CLAIMED_AT,
  });
  const materializationAuthority = authorityFixture(
    "workspace_fenced_writes",
    "capsule_fenced_writes",
    "cimi_fenced_writes",
  );
  let writePermit = false;
  const writes: string[] = [];
  const guardWrite = async <T>(
    name: string,
    authority: MaterializationWriteAuthorityFixture | undefined,
    write: () => Promise<T>,
  ) => {
    if (!writePermit) throw new Error(`unfenced authority write: ${name}`);
    if (authority !== materializationAuthority) {
      throw new Error(`missing atomic authority: ${name}`);
    }
    writePermit = false;
    writes.push(name);
    return await write();
  };
  const stores: InterfaceStores = {
    persistence: inner.persistence,
    interfaces: {
      create: (record, authority) =>
        guardWrite("interface.create", authority, () =>
          inner.interfaces.create(record, authority),
        ),
      get: (id) => inner.interfaces.get(id),
      getByName: (input) => inner.interfaces.getByName(input),
      list: (filter) => inner.interfaces.list(filter),
      listProjectionPage: (input) =>
        inner.interfaces.listProjectionPage(input),
      compareAndSet: (record, expected, authority) =>
        guardWrite("interface.compareAndSet", authority, () =>
          inner.interfaces.compareAndSet(record, expected, authority),
        ),
      claimOAuth2Resource: (input, authority) =>
        guardWrite("interface.claimOAuth2Resource", authority, () =>
          inner.interfaces.claimOAuth2Resource(input, authority),
        ),
      findOAuth2ResourceClaim: (input) =>
        inner.interfaces.findOAuth2ResourceClaim(input),
    },
    bindings: {
      create: (record, authority) =>
        guardWrite("binding.create", authority, () =>
          inner.bindings.create(record, authority),
        ),
      get: (id) => inner.bindings.get(id),
      listByInterface: (interfaceId) =>
        inner.bindings.listByInterface(interfaceId),
      compareAndSet: (record, expectedGeneration, authority) =>
        guardWrite("binding.compareAndSet", authority, () =>
          inner.bindings.compareAndSet(
            record,
            expectedGeneration,
            authority,
          ),
        ),
    },
    authorized: inner.authorized,
  };
  const service = new InterfaceService({
    stores,
    now: () => CLAIMED_AT,
    oauth2ResourceAuthorizer: () => true,
    credentialIssuer: {
      issuePrincipalOAuth2Token: () =>
        Promise.resolve({
          accessToken: "unused",
          expiresAt: "2026-08-29T10:01:30.000Z",
        }),
    },
  });
  const target = new InterfaceServiceCapsuleMaterializationTarget(service);
  const oauthBlueprint: CapsuleInterfaceBlueprint = {
    ...blueprint("fenced-oauth-runtime"),
    spec: {
      ...blueprint("fenced-oauth-runtime").spec,
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://fenced-runtime.example.test/mcp",
        },
      },
    },
    bindings: [
      {
        key: "principal",
        subjectRef: { kind: "Principal", id: "principal_fenced" },
        permissions: ["mcp.invoke"],
        delivery: { type: "oauth2" },
      },
    ],
  };
  const item = capsuleInterfaceMaterializationWorkItemAt(
    [oauthBlueprint],
    1,
  );
  const abortController = new AbortController();

  expect(
    await target.materializeItem({
      intentId: "cimi_fenced_writes",
      workspaceId: "workspace_fenced_writes",
      capsuleId: "capsule_fenced_writes",
      blueprintsDigest: `sha256:${"7".repeat(64)}`,
      itemIndex: item.itemIndex,
      item,
      authorityFence: {
        signal: abortController.signal,
        assertCurrent: () => {
          writePermit = true;
          return Promise.resolve(materializationAuthority);
        },
      },
    }),
  ).toEqual({ kind: "materialized" });
  expect(writes).toEqual(
    expect.arrayContaining([
      "interface.create",
      "interface.compareAndSet",
      "binding.create",
      "interface.claimOAuth2Resource",
      "binding.compareAndSet",
    ]),
  );
});

test("Capsule blueprint Interface and Binding identities are deterministic", async () => {
  const pinnedBlueprint: CapsuleInterfaceBlueprint = {
    ...blueprint("deterministic-runtime"),
    spec: {
      ...blueprint("deterministic-runtime").spec,
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://runtime.example.test/mcp",
        },
      },
    },
    bindings: [
      {
        key: "installer",
        subjectRef: { kind: "Principal", id: "principal_installer" },
        permissions: ["mcp.invoke"],
        delivery: { type: "none" },
      },
    ],
  };
  const materialize = async (randomSuffix: string) => {
    const service = new InterfaceService({
      stores: createInMemoryInterfaceStores(),
      now: () => CLAIMED_AT,
      newId: (prefix) => `${prefix}_${randomSuffix}`,
    });
    const [iface] = await service.ensureCapsuleBlueprints({
      workspaceId: "workspace_deterministic_identity",
      capsuleId: "capsule_deterministic_identity",
      blueprints: [pinnedBlueprint],
    });
    const [binding] = await service.listBindings(iface!.metadata.id);
    return { interfaceId: iface!.metadata.id, bindingId: binding!.metadata.id };
  };

  const first = await materialize("random_a");
  const second = await materialize("random_b");
  expect(first).toEqual(second);
  expect(first.interfaceId).not.toContain("random");
  expect(first.bindingId).not.toContain("random");
});

test("the InterfaceService target distinguishes retryable OAuth readiness from durable revocation", async () => {
  const materializationAuthority = authorityFixture(
    "workspace_target_oauth",
    "capsule_target_oauth",
    "cimi_target_oauth",
  );
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores({
      materializationAuthority: {
        isCapsuleInterfaceMaterializationWriteAuthorityCurrent: () => true,
      },
      now: () => CLAIMED_AT,
    }),
    now: () => CLAIMED_AT,
  });
  const target = new InterfaceServiceCapsuleMaterializationTarget(service);
  const oauthBlueprint: CapsuleInterfaceBlueprint = {
    ...blueprint("oauth-runtime"),
    spec: {
      ...blueprint("oauth-runtime").spec,
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://runtime.example.test/mcp",
        },
      },
    },
    bindings: [
      {
        key: "installer",
        subjectRef: { kind: "Principal", id: "principal_installer" },
        permissions: ["mcp.invoke"],
        delivery: { type: "oauth2" },
      },
    ],
  };
  const baseInput = {
    intentId: "cimi_target_oauth",
    workspaceId: "workspace_target_oauth",
    capsuleId: "capsule_target_oauth",
    blueprintsDigest: `sha256:${"8".repeat(64)}`,
    authorityFence: {
      signal: new AbortController().signal,
      assertCurrent: () => Promise.resolve(materializationAuthority),
    },
  } as const;
  const bindingItem = capsuleInterfaceMaterializationWorkItemAt(
    [oauthBlueprint],
    1,
  );
  const input = {
    ...baseInput,
    itemIndex: bindingItem.itemIndex,
    item: bindingItem,
  } as const;

  expect(await target.materializeItem(input)).toEqual({
    kind: "retry",
    code: "oauth_authority_unavailable",
  });
  const [iface] = await service.list({
    workspaceId: baseInput.workspaceId,
    ownerKind: "Capsule",
    ownerId: baseInput.capsuleId,
    includeRetired: true,
  });
  const [binding] = await service.listBindings(iface!.metadata.id);
  await service.revokeBinding(iface!.metadata.id, binding!.metadata.id);
  expect(await target.materializeItem(input)).toEqual({
    kind: "dead-letter",
    code: "binding_authority_revoked",
  });
});

test("bootstrap terminal observers no longer reread InstallConfig or write Capsule blueprints", async () => {
  const source = await Bun.file(
    new URL("../../../../core/bootstrap.ts", import.meta.url),
  ).text();
  const terminalObserver = source.slice(
    source.indexOf("setTerminalRunObserver"),
    source.indexOf("setApplyRunQueuedObserver"),
  );
  expect(terminalObserver).not.toContain("getInstallConfig");
  expect(terminalObserver).not.toContain("ensureCapsuleBlueprints");
  expect(source).toContain("CapsuleInterfaceMaterializationIntentDrainer");
  expect(source).toContain("drainInterfaceMaterializationIntents");
});
