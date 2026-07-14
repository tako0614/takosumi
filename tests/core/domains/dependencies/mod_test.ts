/**
 * DependenciesService unit tests (Core Specification §14 / §15 / §18).
 *
 * Covers the structural invariants the service enforces per mode/visibility:
 * variable_injection+workspace (same-Workspace), remote_state+workspace (same-Workspace, empty
 * mapping allowed), and published_output+cross_workspace (backed by an active
 * OutputShare); no self-edge, cycle rejection via takosumi-graph, and
 * producer/consumer existence. Plan-time pinning + apply verification are
 * exercised by the deploy-control integration tests, not here.
 */

import { expect, test } from "bun:test";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import {
  InMemoryCapsuleCoordination,
  CapsuleLeaseBusyError,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import type { OutputShare, Output as Output } from "takosumi-contract/outputs";
import {
  type CreateDependencyRequest,
  DependenciesService,
} from "../../../../core/domains/dependencies/mod.ts";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function service(store: OpenTofuControlStore): DependenciesService {
  return new DependenciesService({
    store,
    newId: deterministicIds(),
    now: () => "2026-06-06T00:00:00.000Z",
  });
}

/** Seeds two Capsules (producer + consumer) in the same Workspace. */
async function seedPair(
  store: OpenTofuControlStore,
  workspaceId = "workspace_test",
): Promise<{ producer: string; consumer: string }> {
  await seedCapsuleModel(store, {
    workspaceId,
    sourceId: "src_producer",
    installConfigId: "cfg_producer",
    capsuleId: "inst_producer",
    name: "producer",
  });
  await seedCapsuleModel(store, {
    workspaceId,
    sourceId: "src_consumer",
    installConfigId: "cfg_consumer",
    capsuleId: "inst_consumer",
    name: "consumer",
  });
  return { producer: "inst_producer", consumer: "inst_consumer" };
}

function baseRequest(
  producer: string,
  consumer: string,
  workspaceId = "workspace_test",
): CreateDependencyRequest {
  return {
    workspaceId,
    producerCapsuleId: producer,
    consumerCapsuleId: consumer,
    mode: "variable_injection",
    visibility: "workspace",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  };
}

test("createDependency persists a valid same-Workspace variable_injection edge", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  const dependency = await svc.createDependency(
    baseRequest(producer, consumer),
  );

  expect(dependency.id).toEqual("dep_0001");
  expect(dependency.workspaceId).toEqual("workspace_test");
  expect(dependency.producerCapsuleId).toEqual(producer);
  expect(dependency.consumerCapsuleId).toEqual(consumer);
  expect(dependency.mode).toEqual("variable_injection");
  expect(dependency.visibility).toEqual("workspace");
  expect(dependency.outputs.base_domain.from).toEqual("base_domain");

  const persisted = await store.getDependency("dep_0001");
  expect(persisted?.id).toEqual("dep_0001");
});

test("listForCapsule splits asProducer / asConsumer", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  await svc.createDependency(baseRequest(producer, consumer));

  const producerView = await svc.listForCapsule(producer);
  expect(producerView.asProducer).toHaveLength(1);
  expect(producerView.asConsumer).toHaveLength(0);

  const consumerView = await svc.listForCapsule(consumer);
  expect(consumerView.asProducer).toHaveLength(0);
  expect(consumerView.asConsumer).toHaveLength(1);
});

test("deleteDependency removes the edge", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  const dep = await svc.createDependency(baseRequest(producer, consumer));
  expect(await svc.deleteDependency(dep.id)).toBe(true);
  expect(await store.getDependency(dep.id)).toBeUndefined();
  // Deleting an absent edge returns false.
  expect(await svc.deleteDependency(dep.id)).toBe(false);
});

test("a self-edge is rejected invalid_argument", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency(baseRequest(producer, producer)),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("cross_workspace + variable_injection is rejected failed_precondition", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  // variable_injection cannot cross a Workspace boundary; cross_workspace requires a
  // published_output edge backed by an OutputShare.
  await expect(
    svc.createDependency({
      ...baseRequest(producer, consumer),
      visibility: "cross_workspace",
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("published_output + workspace visibility is rejected invalid_argument", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  // published_output is the cross-Workspace mode; same-Workspace output flow is
  // variable_injection.
  await expect(
    svc.createDependency({
      ...baseRequest(producer, consumer),
      mode: "published_output",
      visibility: "workspace",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("a variable_injection edge with an empty outputs mapping is rejected invalid_argument", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency({ ...baseRequest(producer, consumer), outputs: {} }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("a missing producer or consumer is rejected not_found", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { consumer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency(baseRequest("inst_missing", consumer)),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("a cross-Workspace edge is rejected failed_precondition", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedPair(store, "workspace_a");
  // Producer in workspace_a, but request claims workspace_b.
  const svc = service(store);

  await expect(
    svc.createDependency(
      baseRequest("inst_producer", "inst_consumer", "workspace_b"),
    ),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("a cycle-creating edge is rejected failed_precondition (dependency_cycle)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  // producer -> consumer is fine.
  await svc.createDependency(baseRequest(producer, consumer));
  // consumer -> producer would close a cycle.
  await expect(
    svc.createDependency(baseRequest(consumer, producer)),
  ).rejects.toMatchObject({ code: "failed_precondition" });
  await expect(
    svc.createDependency(baseRequest(consumer, producer)),
  ).rejects.toThrow(/dependency_cycle/);
});

test("concurrent inverse-edge creates under a Workspace lease: at most one persists (no DAG wedge)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  // A coordination-injected service serializes the per-Workspace cycle
  // check-then-write. Two concurrent inverse-edge creates (A→B and B→A) must NOT
  // both pass the acyclic check and persist (which would wedge the DAG with a
  // cycle); the lease lets at most one through.
  const svc = new DependenciesService({
    store,
    newId: deterministicIds(),
    now: () => "2026-06-06T00:00:00.000Z",
    coordination: new InMemoryCapsuleCoordination(),
  });

  const results = await Promise.allSettled([
    svc.createDependency(baseRequest(producer, consumer)),
    svc.createDependency(baseRequest(consumer, producer)),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  // At most one create persisted (the lease prevents the double-insert).
  expect(fulfilled.length).toBeLessThanOrEqual(1);
  // The Workspace holds at most one edge -> the graph is still a DAG (acyclic).
  const persisted = await store.listDependenciesByWorkspace("workspace_test");
  expect(persisted.length).toBeLessThanOrEqual(1);
  // Any loser rejects with a TYPED error (lease-busy or the cycle precondition),
  // never an uncaught bare Error.
  for (const r of rejected) {
    const reason = r.reason;
    const typed =
      reason instanceof CapsuleLeaseBusyError ||
      reason instanceof OpenTofuControllerError;
    expect(typed).toBe(true);
  }
});

test("createDependency surfaces OpenTofuControllerError instances", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer } = await seedPair(store);
  const svc = service(store);
  await expect(
    svc.createDependency(baseRequest(producer, producer)),
  ).rejects.toBeInstanceOf(OpenTofuControllerError);
});

// ---------------------------------------------------------------------------
// remote_state (spec §15): same-Workspace only; outputs mapping MAY be empty.
// ---------------------------------------------------------------------------

test("a same-Workspace remote_state edge with an empty outputs mapping is accepted", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  const dependency = await svc.createDependency({
    workspaceId: "workspace_test",
    producerCapsuleId: producer,
    consumerCapsuleId: consumer,
    mode: "remote_state",
    visibility: "workspace",
    outputs: {},
  });
  expect(dependency.mode).toEqual("remote_state");
  expect(Object.keys(dependency.outputs)).toHaveLength(0);
});

test("a same-Workspace remote_state edge with a non-empty mapping is validated and accepted", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  const dependency = await svc.createDependency({
    workspaceId: "workspace_test",
    producerCapsuleId: producer,
    consumerCapsuleId: consumer,
    mode: "remote_state",
    visibility: "workspace",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  expect(dependency.mode).toEqual("remote_state");
  expect(dependency.outputs.base_domain.from).toEqual("base_domain");
});

test("a remote_state edge with cross_workspace visibility is rejected failed_precondition", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency({
      workspaceId: "workspace_test",
      producerCapsuleId: producer,
      consumerCapsuleId: consumer,
      mode: "remote_state",
      visibility: "cross_workspace",
      outputs: {},
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

// ---------------------------------------------------------------------------
// published_output (spec §18): cross_workspace backed by an ACTIVE OutputShare.
// ---------------------------------------------------------------------------

/**
 * Seeds a producer Capsule in `workspace_producer` and a consumer Capsule
 * in `workspace_consumer`, with the producer having published `base_domain` in its
 * latest Output.
 */
async function seedCrossWorkspacePair(
  store: OpenTofuControlStore,
): Promise<{ producer: string; consumer: string }> {
  await seedCapsuleModel(store, {
    workspaceId: "workspace_producer",
    sourceId: "src_producer",
    installConfigId: "cfg_producer",
    capsuleId: "inst_producer",
    name: "producer",
  });
  await seedCapsuleModel(store, {
    workspaceId: "workspace_consumer",
    sourceId: "src_consumer",
    installConfigId: "cfg_consumer",
    capsuleId: "inst_consumer",
    name: "consumer",
  });
  const snapshot: Output = {
    id: "out_producer",
    workspaceId: "workspace_producer",
    capsuleId: "inst_producer",
    stateGeneration: 1,
    rawArtifactRef:
      "workspaces/workspace_producer/capsules/inst_producer/x.enc",
    publicOutputs: {},
    workspaceOutputs: { base_domain: "shota.example.com" },
    outputDigest: "sha256:deadbeef",
    createdAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putOutput(snapshot);
  return { producer: "inst_producer", consumer: "inst_consumer" };
}

async function seedShare(
  store: OpenTofuControlStore,
  overrides: Partial<OutputShare> = {},
): Promise<OutputShare> {
  const share: OutputShare = {
    id: "oshare_1",
    fromWorkspaceId: "workspace_producer",
    toWorkspaceId: "workspace_consumer",
    producerCapsuleId: "inst_producer",
    outputs: [{ name: "base_domain", sensitive: false }],
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
  return await store.putOutputShare(share);
}

function publishedRequest(from: string): CreateDependencyRequest {
  return {
    workspaceId: "workspace_consumer",
    producerCapsuleId: "inst_producer",
    consumerCapsuleId: "inst_consumer",
    mode: "published_output",
    visibility: "cross_workspace",
    outputs: {
      // The consumer maps from the SHARED name the grant exposes.
      base_domain: { from, to: "base_domain", required: true },
    },
  };
}

test("a published_output edge covered by an active share is accepted", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedCrossWorkspacePair(store);
  await seedShare(store);
  const svc = service(store);

  const dependency = await svc.createDependency(
    publishedRequest("base_domain"),
  );
  expect(dependency.mode).toEqual("published_output");
  expect(dependency.visibility).toEqual("cross_workspace");
  expect(dependency.workspaceId).toEqual("workspace_consumer");
});

test("a published_output edge maps from the share ALIAS when the grant renames", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedCrossWorkspacePair(store);
  // The grant exposes base_domain under the alias `upstream_domain`.
  await seedShare(store, {
    outputs: [
      { name: "base_domain", alias: "upstream_domain", sensitive: false },
    ],
  });
  const svc = service(store);

  // Mapping from the producer name (no alias) is NOT covered.
  await expect(
    svc.createDependency(publishedRequest("base_domain")),
  ).rejects.toThrow(/output_share_required/);
  // Mapping from the ALIAS the grant exposes is covered.
  const dependency = await svc.createDependency(
    publishedRequest("upstream_domain"),
  );
  expect(dependency.outputs.base_domain.from).toEqual("upstream_domain");
});

test("a published_output edge with no active share is rejected failed_precondition (output_share_required)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedCrossWorkspacePair(store);
  const svc = service(store);

  await expect(
    svc.createDependency(publishedRequest("base_domain")),
  ).rejects.toMatchObject({ code: "failed_precondition" });
  await expect(
    svc.createDependency(publishedRequest("base_domain")),
  ).rejects.toThrow(/output_share_required/);
});

test("a published_output edge with only a pending share is rejected output_share_required", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedCrossWorkspacePair(store);
  await seedShare(store, { status: "pending" });
  const deps = service(store);

  await expect(
    deps.createDependency(publishedRequest("base_domain")),
  ).rejects.toThrow(/output_share_required/);
});

test("a published_output edge with a revoked share is rejected output_share_required", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedCrossWorkspacePair(store);
  await seedShare(store, {
    status: "revoked",
    revokedAt: "2026-06-06T01:00:00.000Z",
  });
  const svc = service(store);

  await expect(
    svc.createDependency(publishedRequest("base_domain")),
  ).rejects.toThrow(/output_share_required/);
});

test("a published_output edge can be covered by a sensitive share entry", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedCrossWorkspacePair(store);
  await seedShare(store, {
    outputs: [{ name: "admin_token", sensitive: true }],
  });
  const deps = service(store);

  const dependency = await deps.createDependency({
    ...publishedRequest("admin_token"),
    outputs: {
      admin_token: {
        from: "admin_token",
        to: "admin_token",
        required: true,
      },
    },
  });
  expect(dependency.outputs.admin_token.from).toEqual("admin_token");
});

test("a published_output edge within one Workspace is rejected failed_precondition", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  // Same-Workspace producer + consumer but cross_workspace/published_output: there is no
  // boundary to cross.
  await expect(
    svc.createDependency({
      workspaceId: "workspace_test",
      producerCapsuleId: producer,
      consumerCapsuleId: consumer,
      mode: "published_output",
      visibility: "cross_workspace",
      outputs: {
        base_domain: { from: "base_domain", to: "base_domain", required: true },
      },
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});
