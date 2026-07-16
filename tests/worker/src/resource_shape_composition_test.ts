import { expect, test } from "bun:test";
import {
  composeResourceShapeSchemaRegistries,
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
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
  ).toThrow("EdgeWorker has no installed schema");
  const installed = composeResourceShapeSchemaRegistries(
    LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    schemas,
  );
  expect(
    configuredResourceShapeKinds("EdgeWorker,CustomService", installed),
  ).toEqual(["EdgeWorker", "CustomService"]);
});

test("Resource Shape all means only explicitly installed compatibility schemas", () => {
  const installed = composeResourceShapeSchemaRegistries(
    LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    schemas,
  );
  expect(configuredResourceShapeKinds("all", installed)).toEqual([
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
  expect(configuredResourceShapeKinds("all")).toEqual([]);
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
