import assert from "node:assert/strict";
import {
  destroyLocal,
  expandManifestLocal,
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
  "expandManifestLocal expands kernel-style template invocation (template.template = 'id@version')",
  () => {
    const resources = expandManifestLocal({
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
    assert.ok(resources.length >= 3);
    const names = resources.map((r) => r.name);
    assert.ok(names.includes("db"));
    assert.ok(names.includes("assets"));
    assert.ok(names.includes("api"));
  },
);

Deno.test(
  "expandManifestLocal expands friendlier template form (template.name = 'id')",
  () => {
    const resources = expandManifestLocal({
      apiVersion: "1.0",
      kind: "Manifest",
      template: {
        name: "selfhosted-single-vm",
        inputs: {
          serviceName: "api",
          image: "oci://example/api:latest",
          port: 8080,
        },
      },
    });
    assert.ok(resources.length >= 3);
  },
);

Deno.test(
  "expandManifestLocal throws descriptive error listing templates when neither shape matches",
  () => {
    let caught: Error | undefined;
    try {
      expandManifestLocal({ apiVersion: "1.0", kind: "Manifest" });
    } catch (err) {
      caught = err as Error;
    }
    assert.ok(caught instanceof Error);
    // The error must mention the manifest shape options and at least one
    // bundled template id so operators know what they can self-host.
    assert.match(caught.message, /resources/);
    assert.match(caught.message, /template/);
    assert.match(caught.message, /selfhosted-single-vm@v1/);
  },
);

Deno.test(
  "expandManifestLocal throws when template ref is unknown, listing bundled templates",
  () => {
    let caught: Error | undefined;
    try {
      expandManifestLocal({
        apiVersion: "1.0",
        kind: "Manifest",
        template: { template: "no-such-template@v1", inputs: {} },
      });
    } catch (err) {
      caught = err as Error;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /no-such-template@v1/);
    assert.match(caught.message, /selfhosted-single-vm@v1/);
  },
);

Deno.test(
  "expandManifestLocal surfaces template input validation issues",
  () => {
    let caught: Error | undefined;
    try {
      expandManifestLocal({
        apiVersion: "1.0",
        kind: "Manifest",
        template: { template: "selfhosted-single-vm@v1", inputs: {} },
      });
    } catch (err) {
      caught = err as Error;
    }
    assert.ok(caught instanceof Error);
    // serviceName / image / port are all required.
    assert.match(caught.message, /input validation failed/);
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
