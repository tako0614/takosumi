import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
  TAKOSUMI_API_VERSION,
} from "../../contract/capabilities.ts";

test("Takosumi discovery document exposes v1alpha1 endpoint metadata", () => {
  const document = createTakosumiWellKnownDocument({
    origin: "https://takosumi.example.com/",
  });

  assert.deepEqual(document.api_versions, [TAKOSUMI_API_VERSION]);
  assert.equal(document.edition, undefined);
  assert.equal(document.features.stacks, true);
  assert.equal(document.features.resource_shapes, true);
  assert.equal(document.features.compat_framework, true);
  assert.equal(document.features.compat_s3, false);
  assert.equal(document.endpoints.api, "https://takosumi.example.com/api");
  assert.equal(
    document.endpoints.capabilities,
    "https://takosumi.example.com/v1/capabilities",
  );
  assert.equal(document.endpoints.oidc_issuer, "https://takosumi.example.com");
});

test("Takosumi product capabilities separate framework from enabled profiles", () => {
  const capabilities = createTakosumiProductCapabilities({
    resources: { EdgeWorker: false },
    compat: { s3: true },
  });

  assert.equal(capabilities.apiVersion, TAKOSUMI_API_VERSION);
  assert.equal(capabilities.resources.Stack, true);
  assert.equal(capabilities.resources.EdgeWorker, false);
  assert.equal(capabilities.resources.ObjectBucket, true);
  assert.equal(capabilities.resources.ContainerService, true);
  assert.equal(capabilities.adapters.opentofu, true);
  assert.equal(capabilities.compat.framework, true);
  assert.equal(capabilities.compat.s3, true);
  assert.equal(capabilities.compat.cloudflare_subset, false);
  assert.equal(capabilities.commercial.payment_enforcement, false);
});

test("Takosumi discovery can publish a scoped S3-compatible endpoint", () => {
  const document = createTakosumiWellKnownDocument({
    origin: "https://takosumi.example.com/",
    compat: { s3: true },
    endpoints: { s3: "https://takosumi.example.com/compat/s3/v1" },
  });

  assert.equal(document.features.compat_s3, true);
  assert.equal(
    document.endpoints.s3,
    "https://takosumi.example.com/compat/s3/v1",
  );
});

test("S3 compatibility is separate from the ObjectBucket Resource Shape", () => {
  const capabilities = createTakosumiProductCapabilities();

  assert.equal(capabilities.resources.EdgeWorker, true);
  assert.equal(capabilities.resources.ObjectBucket, true);
  assert.equal(capabilities.compat.s3, false);
});
