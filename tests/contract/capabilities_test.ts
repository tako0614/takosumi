import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
  TAKOSUMI_API_VERSION,
} from "../../contract/capabilities.ts";
import { RESOURCE_SHAPE_KINDS } from "../../contract/resource-shape.ts";

test("Takosumi discovery document exposes v1alpha1 endpoint metadata", () => {
  const document = createTakosumiWellKnownDocument({
    origin: "https://takosumi.example.com/",
  });

  assert.deepEqual(document.api_versions, [TAKOSUMI_API_VERSION]);
  assert.equal(document.edition, undefined);
  assert.equal(document.features.stacks, true);
  assert.equal(document.features.resource_shapes, false);
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
    resources: { EdgeWorker: true, ObjectBucket: true },
    compat: { s3: true },
  });

  assert.equal(capabilities.apiVersion, TAKOSUMI_API_VERSION);
  assert.equal(capabilities.resources.Stack, true);
  assert.equal(capabilities.resources.EdgeWorker, true);
  assert.equal(capabilities.resources.ObjectBucket, true);
  assert.equal(capabilities.resources.ContainerService, false);
  assert.equal(capabilities.adapters.opentofu, true);
  assert.equal(capabilities.compat.framework, true);
  assert.equal(capabilities.compat.s3, true);
  assert.equal(capabilities.compat.provider_cloudflare_workers, false);
  assert.equal(capabilities.operator.runner_pools, false);
  assert.equal(capabilities.operator.managed_target_catalog, false);
  assert.equal(capabilities.commercial.payment_enforcement, false);
});

test("Takosumi adapter capabilities can carry operator-defined extension tokens", () => {
  const capabilities = createTakosumiProductCapabilities({
    adapters: {
      "operator.edge-runtime": true,
    },
  });

  assert.equal(capabilities.adapters.opentofu, true);
  assert.equal(capabilities.adapters["operator.edge-runtime"], true);
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

test("Takosumi product capabilities expose Operator operations without requiring an admin UI", () => {
  const capabilities = createTakosumiProductCapabilities({
    operatorTenants: true,
    commercialBilling: true,
    paymentEnforcement: true,
    operator: {
      runner_pools: true,
      operator_connections: true,
      managed_target_catalog: true,
      db_backed_configuration: true,
      cli_api_operations: true,
      usage_showback: true,
      audit_evidence: true,
    },
  });

  assert.equal(capabilities.operator.multi_tenant_workspaces, true);
  assert.equal(capabilities.operator.workspace_members, true);
  assert.equal(capabilities.operator.runner_pools, true);
  assert.equal(capabilities.operator.operator_connections, true);
  assert.equal(capabilities.operator.managed_target_catalog, true);
  assert.equal(capabilities.operator.db_backed_configuration, true);
  assert.equal(capabilities.operator.cli_api_operations, true);
  assert.equal(capabilities.operator.usage_showback, true);
  assert.equal(capabilities.operator.audit_evidence, true);
  assert.equal(capabilities.commercial.operator_tenants, true);
  assert.equal(capabilities.commercial.billing, true);
  assert.equal(capabilities.commercial.payment_enforcement, true);
  assert.equal(
    Object.hasOwn(capabilities.operator as object, "operator_console"),
    false,
  );
});

test("S3 compatibility is separate from the ObjectBucket Resource Shape", () => {
  const capabilities = createTakosumiProductCapabilities({
    resources: { ObjectBucket: true },
  });

  assert.equal(capabilities.resources.EdgeWorker, false);
  assert.equal(capabilities.resources.ObjectBucket, true);
  assert.equal(capabilities.compat.s3, false);
});

test("push notification delivery is not a Takosumi resource/provider capability", () => {
  const capabilities = createTakosumiProductCapabilities({
    resources: {
      PushNotification: true,
    } as Partial<
      ReturnType<typeof createTakosumiProductCapabilities>["resources"]
    >,
  });

  assert.equal(
    Object.hasOwn(capabilities.resources, "PushNotification"),
    false,
  );
  assert.equal(
    RESOURCE_SHAPE_KINDS.includes("PushNotification" as never),
    false,
  );
});
