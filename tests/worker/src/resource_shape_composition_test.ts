import { expect, test } from "bun:test";
import {
  MapResourceShapeModuleRegistry,
  MapResourceShapeSchemaRegistry,
} from "../../../core/domains/resource-shape/mod.ts";
import {
  configuredResourceShapeKinds,
  resourceShapeHostContributionsFromEnv,
} from "../../../worker/src/resource_shape_composition.ts";

const schemas = new MapResourceShapeSchemaRegistry({
  CustomService: () => ({
    ok: true,
    value: { spec: {}, interfaces: [], connections: {} },
  }),
});

test("custom Resource Shape tokens require a code-installed schema", () => {
  expect(() =>
    configuredResourceShapeKinds("EdgeWorker,CustomService"),
  ).toThrow("CustomService has no installed schema");
  expect(
    configuredResourceShapeKinds("EdgeWorker,CustomService", schemas),
  ).toEqual(["EdgeWorker", "CustomService"]);
});

test("Resource Shape all means bundled plus actually registered schemas", () => {
  expect(configuredResourceShapeKinds("all", schemas)).toEqual([
    "EdgeWorker",
    "ObjectBucket",
    "KVStore",
    "Queue",
    "SQLDatabase",
    "ContainerService",
    "VectorIndex",
    "DurableWorkflow",
    "StatefulActorNamespace",
    "Schedule",
    "CustomService",
  ]);
});

test("host composition carries schema and module registries as runtime objects", () => {
  const modules = new MapResourceShapeModuleRegistry({
    "operator/push-notification": {
      files: [{ path: "main.tf", text: "terraform {}\n" }],
    },
  });
  const contributions = resourceShapeHostContributionsFromEnv({
    TAKOSUMI_RESOURCE_SHAPE_SCHEMA_REGISTRY: schemas,
    TAKOSUMI_RESOURCE_SHAPE_MODULE_REGISTRY: modules,
  });

  expect(contributions.schemaRegistry).toBe(schemas);
  expect(contributions.moduleRegistry).toBe(modules);
  expect(
    contributions.moduleRegistry?.get("operator/push-notification")?.files[0]
      ?.path,
  ).toBe("main.tf");
});

test("invalid registry contributions fail configuration", () => {
  expect(() =>
    resourceShapeHostContributionsFromEnv({
      TAKOSUMI_RESOURCE_SHAPE_SCHEMA_REGISTRY: {
        kinds: () => ["CustomService"],
        get: () => undefined,
      },
    }),
  ).toThrow("has no parser for CustomService");
  expect(() => configuredResourceShapeKinds('["EdgeWorker", 1]')).toThrow(
    "must be a string array",
  );
});
