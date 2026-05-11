import assert from "node:assert/strict";
import {
  destroyLocal,
  expandManifestLocal,
  planLocal,
} from "../src/local_runner.ts";

Deno.test(
  "expandManifestLocal returns resources[] when manifest carries them",
  () => {
    const resources = [
      {
        shape: "object-store@v1",
        name: "logs",
        provider: "@takos/selfhost-filesystem",
        spec: { name: "logs" },
      },
    ];
    const expanded = expandManifestLocal({
      apiVersion: "1.0",
      kind: "Manifest",
      resources,
    });
    assert.equal(expanded.length, 1);
    assert.equal(expanded[0].name, "logs");
    assert.equal(expanded[0].provider, "@takos/selfhost-filesystem");
  },
);

Deno.test(
  "expandManifestLocal rejects retired top-level template shorthand",
  () => {
    let caught: Error | undefined;
    try {
      expandManifestLocal({
        apiVersion: "1.0",
        kind: "Manifest",
        template: {
          template: "selfhosted-single-vm@v1",
          inputs: {
            serviceName: "api",
            image: "oci://example/api:latest",
            port: 8080,
          },
        },
      });
    } catch (err) {
      caught = err as Error;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /template is not a known field/);
  },
);

Deno.test(
  "expandManifestLocal throws when resources[] is missing",
  () => {
    let caught: Error | undefined;
    try {
      expandManifestLocal({ apiVersion: "1.0", kind: "Manifest" });
    } catch (err) {
      caught = err as Error;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /manifest\.resources\[\] is required/);
  },
);

Deno.test(
  "destroyLocal calls provider.destroy for each resource and reports them",
  async () => {
    const resources = [
      {
        shape: "object-store@v1",
        name: "alpha",
        provider: "@takos/selfhost-filesystem",
        spec: { name: "alpha" },
      },
      {
        shape: "object-store@v1",
        name: "beta",
        provider: "@takos/selfhost-filesystem",
        spec: { name: "beta" },
      },
    ];
    const outcome = await destroyLocal(resources);
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.errors.length, 0);
    assert.equal(outcome.destroyed.length, 2);
    const destroyedNames = outcome.destroyed.map((d) => d.name);
    // destroyV2 walks reverse DAG order: with no inter-resource refs, that
    // is the reverse of the manifest order.
    assert.deepEqual(destroyedNames, ["beta", "alpha"]);
  },
);

Deno.test(
  "destroyLocal returns failed-validation when manifest is invalid",
  async () => {
    const outcome = await destroyLocal([
      {
        shape: "object-store@v1",
        name: "ok",
        provider: "@takos/no-such-provider",
        spec: {},
      },
    ]);
    assert.equal(outcome.status, "failed-validation");
    assert.ok(outcome.issues.length > 0);
  },
);

Deno.test("planLocal includes the public OperationPlan preview", async () => {
  const outcome = await planLocal([
    {
      shape: "object-store@v1",
      name: "logs",
      provider: "@takos/selfhost-filesystem",
      spec: { name: "logs" },
    },
  ]);

  assert.equal(outcome.status, "succeeded");
  assert.ok(outcome.operationPlanPreview);
  assert.equal(outcome.operationPlanPreview!.spaceId, "local");
  assert.equal(
    outcome.operationPlanPreview!.operations[0].resourceName,
    "logs",
  );
});
