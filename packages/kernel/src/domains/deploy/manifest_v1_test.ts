import assert from "node:assert/strict";
import type { ManifestResource, Template } from "takosumi-contract";
import { registerTemplate, unregisterTemplate } from "takosumi-contract";
import {
  readDeploymentNameV1,
  resolveManifestResourcesV1,
} from "./manifest_v1.ts";

const TEMPLATE_ID = "manifest-v1-test-template";
const TEMPLATE_VERSION = "v1";
const TEMPLATE_REF = `${TEMPLATE_ID}@${TEMPLATE_VERSION}`;

const EXTRA_RESOURCE: ManifestResource = {
  shape: "object-store@v1",
  name: "backups",
  provider: "@takos/selfhost-filesystem",
  spec: { name: "backups" },
};

const testTemplate: Template = {
  id: TEMPLATE_ID,
  version: TEMPLATE_VERSION,
  validateInputs(value, issues) {
    if (
      typeof value !== "object" || value === null || Array.isArray(value)
    ) {
      issues.push({ path: "$", message: "must be an object" });
      return;
    }
    const input = value as Record<string, unknown>;
    if (typeof input.name !== "string" || input.name.length === 0) {
      issues.push({ path: "$.name", message: "must be a non-empty string" });
    }
  },
  expand(input) {
    const name = (input as { name: string }).name;
    return [{
      shape: "object-store@v1",
      name,
      provider: "@takos/selfhost-filesystem",
      spec: { name },
    }];
  },
};

Deno.test("manifest v1 resolver expands canonical template.template", () => {
  registerTemplate(testTemplate);
  try {
    const result = resolveManifestResourcesV1({
      apiVersion: "1.0",
      kind: "Manifest",
      template: {
        template: TEMPLATE_REF,
        inputs: { name: "assets" },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value[0].name : undefined, "assets");
  } finally {
    unregisterTemplate(TEMPLATE_ID, TEMPLATE_VERSION);
  }
});

Deno.test("manifest v1 resolver keeps template.ref as legacy compatibility", () => {
  registerTemplate(testTemplate);
  try {
    const result = resolveManifestResourcesV1({
      apiVersion: "1.0",
      kind: "Manifest",
      template: {
        ref: TEMPLATE_REF,
        inputs: { name: "assets" },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value[0].name : undefined, "assets");
  } finally {
    unregisterTemplate(TEMPLATE_ID, TEMPLATE_VERSION);
  }
});

Deno.test("manifest v1 resolver appends resources after template expansion", () => {
  registerTemplate(testTemplate);
  try {
    const result = resolveManifestResourcesV1({
      apiVersion: "1.0",
      kind: "Manifest",
      template: {
        template: TEMPLATE_REF,
        inputs: { name: "assets" },
      },
      resources: [EXTRA_RESOURCE],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok ? result.value.map((resource) => resource.name) : [],
      ["assets", "backups"],
    );
  } finally {
    unregisterTemplate(TEMPLATE_ID, TEMPLATE_VERSION);
  }
});

Deno.test("manifest v1 resolver rejects unknown closed-envelope fields", () => {
  const result = resolveManifestResourcesV1({
    apiVersion: "1.0",
    kind: "Manifest",
    profile: "legacy",
    resources: [EXTRA_RESOURCE],
  });
  assert.equal(result.ok, false);
  assert.match(
    result.ok ? "" : result.error,
    /\$\.profile: profile is not a known field/,
  );
});

Deno.test("manifest v1 resolver validates metadata and resource field shape", () => {
  const result = resolveManifestResourcesV1({
    apiVersion: "1.0",
    kind: "Manifest",
    metadata: {
      name: "app",
      labels: { tier: 1 },
    },
    resources: [{
      ...EXTRA_RESOURCE,
      extra: true,
      requires: ["versioning", ""],
    }],
  });
  assert.equal(result.ok, false);
  const message = result.ok ? "" : result.error;
  assert.match(message, /\$\.metadata\.labels\.tier: must be a string/);
  assert.match(
    message,
    /\$\.resources\[0\]\.extra: extra is not a known field/,
  );
  assert.match(
    message,
    /\$\.resources\[0\]\.requires\[1\]: requires entries must be non-empty strings/,
  );
});

Deno.test("manifest v1 resolver rejects conflicting template aliases", () => {
  const result = resolveManifestResourcesV1({
    apiVersion: "1.0",
    kind: "Manifest",
    template: {
      template: TEMPLATE_REF,
      ref: "other-template@v1",
      inputs: { name: "assets" },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /conflict/);
});

Deno.test("manifest v1 resolver allows CLI-local template.name only by option", () => {
  const strict = resolveManifestResourcesV1({
    apiVersion: "1.0",
    kind: "Manifest",
    template: { name: TEMPLATE_ID, inputs: { name: "assets" } },
  }, { templates: [testTemplate] });
  assert.equal(strict.ok, false);

  const compat = resolveManifestResourcesV1({
    apiVersion: "1.0",
    kind: "Manifest",
    template: { name: TEMPLATE_ID, inputs: { name: "assets" } },
  }, { templates: [testTemplate], allowTemplateName: true });
  assert.equal(compat.ok, true);
  assert.equal(compat.ok ? compat.value[0].name : undefined, "assets");
});

Deno.test("manifest v1 deployment name falls back deterministically", () => {
  assert.equal(
    readDeploymentNameV1({ metadata: { name: "app" } }, [EXTRA_RESOURCE]),
    "app",
  );
  const first = readDeploymentNameV1({ apiVersion: "1.0" }, [EXTRA_RESOURCE]);
  const second = readDeploymentNameV1({ apiVersion: "1.0" }, [EXTRA_RESOURCE]);
  assert.match(first, /^unnamed-[0-9a-f]+$/);
  assert.equal(first, second);
});
