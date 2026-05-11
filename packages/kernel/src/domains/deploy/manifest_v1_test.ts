import assert from "node:assert/strict";
import type { ManifestResource } from "takosumi-contract";
import {
  readDeploymentNameV1,
  resolveManifestResourcesV1,
} from "./manifest_v1.ts";

const EXTRA_RESOURCE: ManifestResource = {
  shape: "object-store@v1",
  name: "backups",
  provider: "@takos/selfhost-filesystem",
  spec: { name: "backups" },
};

Deno.test("manifest v1 resolver accepts resources without provider pin", () => {
  const result = resolveManifestResourcesV1({
    apiVersion: "1.0",
    kind: "Manifest",
    resources: [{
      shape: "object-store@v1",
      name: "assets",
      spec: { name: "assets" },
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value[0].provider : undefined, undefined);
});

Deno.test("manifest v1 resolver rejects retired top-level template", () => {
  const result = resolveManifestResourcesV1({
    apiVersion: "1.0",
    kind: "Manifest",
    template: {
      template: "selfhosted-single-vm@v1",
      inputs: { name: "assets" },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /\$\.template/);
  assert.match(result.ok ? "" : result.error, /template is not a known field/);
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

Deno.test("manifest v1 resolver requires resources[]", () => {
  const result = resolveManifestResourcesV1({
    apiVersion: "1.0",
    kind: "Manifest",
  });
  assert.equal(result.ok, false);
  assert.match(
    result.ok ? "" : result.error,
    /manifest\.resources\[\] is required/,
  );
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
