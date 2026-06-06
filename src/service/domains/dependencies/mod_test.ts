/**
 * DependenciesService unit tests (Core Specification §14 / §15).
 *
 * Covers the structural invariants the service enforces: same-Space producer +
 * consumer, variable_injection-only / space-visibility-only, no self-edge, cycle
 * rejection via takosumi-graph, producer/consumer existence, and the non-empty
 * outputs mapping. Plan-time pinning + apply verification are exercised by the
 * deploy-control integration tests, not here.
 */

import { expect, test } from "bun:test";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { seedInstallationModel } from "../deploy-control/test_model_fixture.ts";
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

test("a non-variable_injection mode is rejected not_implemented", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency({
      ...baseRequest(producer, consumer),
      mode: "remote_state",
    }),
  ).rejects.toMatchObject({ code: "not_implemented" });
});

test("cross_space visibility is rejected not_implemented", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { producer, consumer } = await seedPair(store);
  const svc = service(store);

  await expect(
    svc.createDependency({
      ...baseRequest(producer, consumer),
      visibility: "cross_space",
    }),
  ).rejects.toMatchObject({ code: "not_implemented" });
});

test("an empty outputs mapping is rejected invalid_argument", async () => {
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
