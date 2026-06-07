/**
 * DependenciesService unit tests (Core Specification §14 / §15 / §18).
 *
 * Covers the structural invariants the service enforces per mode/visibility:
 * variable_injection+space (same-Space), remote_state+space (same-Space, empty
 * mapping allowed), and published_output+cross_space (backed by an active
 * OutputShare); no self-edge, cycle rejection via takosumi-graph, and
 * producer/consumer existence. Plan-time pinning + apply verification are
 * exercised by the deploy-control integration tests, not here.
 */

import { expect, test } from "bun:test";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { seedInstallationModel } from "../deploy-control/test_model_fixture.ts";
import type { OutputShare, OutputSnapshot } from "takosumi-contract/output-snapshots";
import {
  type CreateDependencyRequest,
  DependenciesService,
} from "./mod.ts";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function service(store: OpenTofuDeploymentStore): DependenciesService {
  return new DependenciesService({
    store,
    newId: deterministicIds(),
    now: () => "2026-06-06T00:00:00.000Z",
  });
}

/** Seeds two installations (producer + consumer) in the same Space. */
async function seedPair(
  store: OpenTofuDeploymentStore,
  spaceId = "space_test",
): Promise<{ producer: string; consumer: string }> {
  await seedInstallationModel(store, {
    spaceId,
    sourceId: "src_producer",
    installConfigId: "cfg_producer",
    installationId: "inst_producer",
    name: "producer",
  });
  await seedInstallationModel(store, {
    spaceId,
    sourceId: "src_consumer",
    installConfigId: "cfg_consumer",
    installationId: "inst_consumer",
    name: "consumer",
  });
  return { producer: "inst_producer", consumer: "inst_consumer" };
}

function baseRequest(
  producer: string,
  consumer: string,
  spaceId = "space_test",
): CreateDependencyRequest {
  return {
    spaceId,
    producerInstallationId: producer,
    consumerInstallationId: consumer,
    mode: "variable_injection",
    visibility: "space",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  };
}

test("createDependency persists a valid same-space variable_injection edge", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  const dependency = await svc.createDependency(baseRequest(producer, consumer));

  expect(dependency.id).toEqual("dep_0001");
  expect(dependency.spaceId).toEqual("space_test");
  expect(dependency.producerInstallationId).toEqual(producer);
  expect(dependency.consumerInstallationId).toEqual(consumer);
  expect(dependency.mode).toEqual("variable_injection");
  expect(dependency.visibility).toEqual("space");
  expect(dependency.outputs.base_domain.from).toEqual("base_domain");

  const persisted = await store.getDependency("dep_0001");
  expect(persisted?.id).toEqual("dep_0001");
});

test("listForInstallation splits asProducer / asConsumer", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  await svc.createDependency(baseRequest(producer, consumer));

  const producerView = await svc.listForInstallation(producer);
  expect(producerView.asProducer).toHaveLength(1);
  expect(producerView.asConsumer).toHaveLength(0);

  const consumerView = await svc.listForInstallation(consumer);
  expect(consumerView.asProducer).toHaveLength(0);
  expect(consumerView.asConsumer).toHaveLength(1);
});

test("deleteDependency removes the edge", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  const dep = await svc.createDependency(baseRequest(producer, consumer));
  expect(await svc.deleteDependency(dep.id)).toBe(true);
  expect(await store.getDependency(dep.id)).toBeUndefined();
  // Deleting an absent edge returns false.
  expect(await svc.deleteDependency(dep.id)).toBe(false);
});

test("a self-edge is rejected invalid_argument", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency(baseRequest(producer, producer)),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("cross_space + variable_injection is rejected failed_precondition", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  // variable_injection cannot cross a Space boundary; cross_space requires a
  // published_output edge backed by an OutputShare.
  await expect(
    svc.createDependency({
      ...baseRequest(producer, consumer),
      visibility: "cross_space",
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("published_output + space visibility is rejected invalid_argument", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  // published_output is the cross-Space mode; same-Space output flow is
  // variable_injection.
  await expect(
    svc.createDependency({
      ...baseRequest(producer, consumer),
      mode: "published_output",
      visibility: "space",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("a variable_injection edge with an empty outputs mapping is rejected invalid_argument", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency({ ...baseRequest(producer, consumer), outputs: {} }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("a missing producer or consumer is rejected not_found", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { consumer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency(baseRequest("inst_missing", consumer)),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("a cross-space edge is rejected failed_precondition", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedPair(store, "space_a");
  // Producer in space_a, but request claims space_b.
  const svc = service(store);

  await expect(
    svc.createDependency(baseRequest("inst_producer", "inst_consumer", "space_b")),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("a cycle-creating edge is rejected failed_precondition (dependency_cycle)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
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

test("createDependency surfaces OpenTofuControllerError instances", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer } = await seedPair(store);
  const svc = service(store);
  await expect(
    svc.createDependency(baseRequest(producer, producer)),
  ).rejects.toBeInstanceOf(OpenTofuControllerError);
});

// ---------------------------------------------------------------------------
// remote_state (spec §15): same-Space only; outputs mapping MAY be empty.
// ---------------------------------------------------------------------------

test("a same-space remote_state edge with an empty outputs mapping is accepted", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  const dependency = await svc.createDependency({
    spaceId: "space_test",
    producerInstallationId: producer,
    consumerInstallationId: consumer,
    mode: "remote_state",
    visibility: "space",
    outputs: {},
  });
  expect(dependency.mode).toEqual("remote_state");
  expect(Object.keys(dependency.outputs)).toHaveLength(0);
});

test("a same-space remote_state edge with a non-empty mapping is validated and accepted", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  const dependency = await svc.createDependency({
    spaceId: "space_test",
    producerInstallationId: producer,
    consumerInstallationId: consumer,
    mode: "remote_state",
    visibility: "space",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  expect(dependency.mode).toEqual("remote_state");
  expect(dependency.outputs.base_domain.from).toEqual("base_domain");
});

test("a remote_state edge with cross_space visibility is rejected failed_precondition", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency({
      spaceId: "space_test",
      producerInstallationId: producer,
      consumerInstallationId: consumer,
      mode: "remote_state",
      visibility: "cross_space",
      outputs: {},
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

// ---------------------------------------------------------------------------
// published_output (spec §18): cross_space backed by an ACTIVE OutputShare.
// ---------------------------------------------------------------------------

/**
 * Seeds a producer Installation in `space_producer` and a consumer Installation
 * in `space_consumer`, with the producer having published `base_domain` in its
 * latest OutputSnapshot.
 */
async function seedCrossSpacePair(
  store: OpenTofuDeploymentStore,
): Promise<{ producer: string; consumer: string }> {
  await seedInstallationModel(store, {
    spaceId: "space_producer",
    sourceId: "src_producer",
    installConfigId: "cfg_producer",
    installationId: "inst_producer",
    name: "producer",
  });
  await seedInstallationModel(store, {
    spaceId: "space_consumer",
    sourceId: "src_consumer",
    installConfigId: "cfg_consumer",
    installationId: "inst_consumer",
    name: "consumer",
  });
  const snapshot: OutputSnapshot = {
    id: "out_producer",
    spaceId: "space_producer",
    installationId: "inst_producer",
    stateGeneration: 1,
    rawOutputArtifactKey: "spaces/space_producer/installations/inst_producer/x.enc",
    publicOutputs: {},
    spaceOutputs: { base_domain: "shota.example.com" },
    outputDigest: "sha256:deadbeef",
    createdAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putOutputSnapshot(snapshot);
  return { producer: "inst_producer", consumer: "inst_consumer" };
}

async function seedShare(
  store: OpenTofuDeploymentStore,
  overrides: Partial<OutputShare> = {},
): Promise<OutputShare> {
  const share: OutputShare = {
    id: "oshare_1",
    fromSpaceId: "space_producer",
    toSpaceId: "space_consumer",
    producerInstallationId: "inst_producer",
    outputs: [{ name: "base_domain", sensitive: false }],
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
  return await store.putOutputShare(share);
}

function publishedRequest(
  from: string,
): CreateDependencyRequest {
  return {
    spaceId: "space_consumer",
    producerInstallationId: "inst_producer",
    consumerInstallationId: "inst_consumer",
    mode: "published_output",
    visibility: "cross_space",
    outputs: {
      // The consumer maps from the SHARED name the grant exposes.
      base_domain: { from, to: "base_domain", required: true },
    },
  };
}

test("a published_output edge covered by an active share is accepted", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedCrossSpacePair(store);
  await seedShare(store);
  const svc = service(store);

  const dependency = await svc.createDependency(publishedRequest("base_domain"));
  expect(dependency.mode).toEqual("published_output");
  expect(dependency.visibility).toEqual("cross_space");
  expect(dependency.spaceId).toEqual("space_consumer");
});

test("a published_output edge maps from the share ALIAS when the grant renames", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedCrossSpacePair(store);
  // The grant exposes base_domain under the alias `upstream_domain`.
  await seedShare(store, {
    outputs: [{ name: "base_domain", alias: "upstream_domain", sensitive: false }],
  });
  const svc = service(store);

  // Mapping from the producer name (no alias) is NOT covered.
  await expect(
    svc.createDependency(publishedRequest("base_domain")),
  ).rejects.toThrow(/output_share_required/);
  // Mapping from the ALIAS the grant exposes is covered.
  const dependency = await svc.createDependency(publishedRequest("upstream_domain"));
  expect(dependency.outputs.base_domain.from).toEqual("upstream_domain");
});

test("a published_output edge with no active share is rejected failed_precondition (output_share_required)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedCrossSpacePair(store);
  const svc = service(store);

  await expect(
    svc.createDependency(publishedRequest("base_domain")),
  ).rejects.toMatchObject({ code: "failed_precondition" });
  await expect(
    svc.createDependency(publishedRequest("base_domain")),
  ).rejects.toThrow(/output_share_required/);
});

test("a published_output edge with a revoked share is rejected output_share_required", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedCrossSpacePair(store);
  await seedShare(store, { status: "revoked", revokedAt: "2026-06-06T01:00:00.000Z" });
  const svc = service(store);

  await expect(
    svc.createDependency(publishedRequest("base_domain")),
  ).rejects.toThrow(/output_share_required/);
});

test("a published_output edge within one Space is rejected failed_precondition", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  // Same-Space producer + consumer but cross_space/published_output: there is no
  // boundary to cross.
  await expect(
    svc.createDependency({
      spaceId: "space_test",
      producerInstallationId: producer,
      consumerInstallationId: consumer,
      mode: "published_output",
      visibility: "cross_space",
      outputs: {
        base_domain: { from: "base_domain", to: "base_domain", required: true },
      },
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});
