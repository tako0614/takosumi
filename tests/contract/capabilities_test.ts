import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
  TAKOSUMI_API_VERSION,
  TAKOSUMI_INTERFACES_CAPABILITY,
} from "../../contract/capabilities.ts";
import { RESOURCE_SHAPE_KINDS } from "../../contract/resource-shape.ts";

test("Takosumi discovery document exposes v1alpha1 endpoint metadata", () => {
  const document = createTakosumiWellKnownDocument({
    origin: "https://takosumi.example.com/",
  });

  assert.deepEqual(document.api_versions, [TAKOSUMI_API_VERSION]);
  assert.equal(document.product, "takosumi");
  assert.equal(document.name, "Takosumi");
  assert.equal(document.apiBaseUrl, "https://takosumi.example.com/api/v1");
  assert.equal(document.oidcClientId, undefined);
  assert.deepEqual(document.auth, { oidc: true, password: false });
  assert.equal(document.features.stacks, true);
  assert.equal(document.features.resource_shapes, false);
  assert.equal(document.features.compat_framework, true);
  assert.deepEqual(document.features.compatibility_profiles, []);
  assert.equal(document.features.interfaces, false);
  assert.equal(document.endpoints.api, "https://takosumi.example.com/api");
  assert.equal(
    document.endpoints.capabilities,
    "https://takosumi.example.com/v1/capabilities",
  );
  assert.equal(document.endpoints.oidc_issuer, "https://takosumi.example.com");
});

test("Takosumi discovery advertises only the configured native PKCE client", () => {
  const document = createTakosumiWellKnownDocument({
    origin: "https://app.takosumi.com",
    mobileOidcClientId: " takosumi-mobile-cloud ",
  });

  assert.equal(document.product, "takosumi");
  assert.equal(document.oidcClientId, "takosumi-mobile-cloud");
  assert.equal(document.endpoints.oidc_issuer, "https://app.takosumi.com");
});

test("Takosumi product capabilities separate framework from enabled profiles", () => {
  const capabilities = createTakosumiProductCapabilities({
    resources: { EdgeWorker: true, ObjectBucket: true },
    compat: { "compat.s3.v1": true },
    compatibilityProfiles: {
      "compat.s3.v1": { planes: ["control", "data"] },
    },
    interfacesEnabled: true,
  });

  assert.equal(capabilities.apiVersion, TAKOSUMI_API_VERSION);
  assert.equal(capabilities.resources.Stack, true);
  assert.equal(capabilities.resources.EdgeWorker, true);
  assert.equal(capabilities.resources.ObjectBucket, true);
  assert.equal(capabilities.resources.ContainerService, false);
  assert.equal(capabilities.adapters.opentofu, true);
  assert.equal(capabilities.compat.framework, true);
  assert.equal(capabilities.compat["compat.s3.v1"], true);
  assert.deepEqual(capabilities.compatibilityProfiles["compat.s3.v1"], {
    planes: ["control", "data"],
  });
  assert.equal(capabilities.operator.runner_pools, false);
  assert.equal(capabilities.operator.managed_target_catalog, false);
  assert.equal(capabilities.identity.external_oidc_login, false);
  assert.deepEqual(capabilities.formAvailability, {
    structured: true,
    endpoint: "/v1/form-availability",
    principalScoped: true,
    readScopesAnyOf: ["forms:read", "resources:read"],
    commercialFields: false,
    forms: [],
  });
  assert.deepEqual(capabilities.extensions, [TAKOSUMI_INTERFACES_CAPABILITY]);
});

test("compatibility profile authority rejects unversioned tokens", () => {
  assert.throws(
    () =>
      createTakosumiProductCapabilities({
        compatibilityProfiles: {
          "compat.example.storage": { planes: ["data"] },
        },
      }),
    /scoped compat\.\* version token/u,
  );
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

test("external OIDC login is advertised only when explicitly configured", () => {
  assert.equal(
    createTakosumiProductCapabilities().identity.external_oidc_login,
    false,
  );
  assert.equal(
    createTakosumiProductCapabilities({
      identity: { external_oidc_login: true },
    }).identity.external_oidc_login,
    true,
  );
});

test("Takosumi compatibility capabilities can carry operator-defined versioned profiles", () => {
  const capabilities = createTakosumiProductCapabilities({
    compat: {
      "operator.redis.v1": true,
    },
  });

  assert.equal(capabilities.compat.framework, true);
  assert.equal(capabilities.compat["operator.redis.v1"], true);
});

test("Takosumi Operator and extension capabilities stay open-ended", () => {
  const capabilities = createTakosumiProductCapabilities({
    operator: { "operator.backup-policy.v2": true },
    extensions: ["example.runtime.v1", "example.runtime.v1"],
    interfacesEnabled: true,
  });

  assert.equal(capabilities.operator["operator.backup-policy.v2"], true);
  assert.deepEqual(capabilities.extensions, [
    "example.runtime.v1",
    TAKOSUMI_INTERFACES_CAPABILITY,
  ]);
});

test("commercial functions are open extension tokens and never imply OSS showback", () => {
  const capabilities = createTakosumiProductCapabilities({
    extensions: ["billing.commercial.v1", "billing.payment-enforcement.v1"],
  });

  assert.deepEqual(capabilities.extensions, [
    "billing.commercial.v1",
    "billing.payment-enforcement.v1",
  ]);
  assert.equal(capabilities.operator.usage_showback, false);
});

test("Takosumi discovery publishes arbitrary compatibility endpoints by token", () => {
  const document = createTakosumiWellKnownDocument({
    origin: "https://takosumi.example.com/",
    compat: { "compat.example.storage.v2": true },
    compatibilityProfiles: {
      "compat.example.storage.v2": { planes: ["data"] },
    },
    endpoints: {
      "compat.example.storage.v2":
        "https://takosumi.example.com/compat/storage/v2",
    },
  });

  assert.deepEqual(document.features.compatibility_profiles, [
    "compat.example.storage.v2",
  ]);
  assert.equal(
    document.endpoints.extensions?.["compat.example.storage.v2"],
    "https://takosumi.example.com/compat/storage/v2",
  );
});

test("Takosumi discovery does not treat an untyped compat token as an installed profile", () => {
  const document = createTakosumiWellKnownDocument({
    origin: "https://takosumi.example.com/",
    compat: { "compat.legacy.v1": true },
  });

  assert.deepEqual(document.features.compatibility_profiles, []);
});

test("Takosumi product capabilities expose Operator operations without requiring an admin UI", () => {
  const capabilities = createTakosumiProductCapabilities({
    operator: {
      multi_tenant_workspaces: true,
      workspace_members: true,
      runner_pools: true,
      operator_connections: true,
      managed_target_catalog: true,
      db_backed_configuration: true,
      cli_api_operations: true,
      usage_showback: true,
      audit_evidence: true,
    },
    extensions: ["operator.customer-management.v1"],
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
  assert.deepEqual(capabilities.extensions, [
    "operator.customer-management.v1",
  ]);
  assert.equal(
    Object.hasOwn(capabilities.operator as object, "operator_console"),
    false,
  );
});

test("compatibility profiles are separate from typed Resource Shapes", () => {
  const capabilities = createTakosumiProductCapabilities({
    resources: { ObjectBucket: true },
  });

  assert.equal(capabilities.resources.EdgeWorker, false);
  assert.equal(capabilities.resources.ObjectBucket, true);
  assert.deepEqual(capabilities.compat, { framework: true });
  assert.deepEqual(capabilities.compatibilityProfiles, {});
});

test("compatibility profile authority planes are explicit and deduplicated", () => {
  const capabilities = createTakosumiProductCapabilities({
    compat: { "compat.example.v1": true },
    compatibilityProfiles: {
      "compat.example.v1": {
        planes: ["data", "control", "data"],
      },
    },
  });

  assert.deepEqual(capabilities.compatibilityProfiles, {
    "compat.example.v1": { planes: ["control", "data"] },
  });
});

test("compatibility profile discovery owns no lifecycle state", () => {
  const capabilities = createTakosumiProductCapabilities({
    compatibilityProfiles: {
      "compat.example.v1": { planes: ["control"] },
    },
  });
  const profile = capabilities.compatibilityProfiles["compat.example.v1"];

  assert.equal(capabilities.compat["compat.example.v1"], true);
  assert.deepEqual(Object.keys(profile ?? {}), ["planes"]);
  for (const forbidden of [
    "phase",
    "status",
    "state",
    "generation",
    "resource",
    "nativeResources",
  ]) {
    assert.equal(Object.hasOwn(profile ?? {}, forbidden), false);
  }
});

test("v1alpha1 bundled Resource Shapes expose portable services but exclude Secret", () => {
  assert.deepEqual(RESOURCE_SHAPE_KINDS, [
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
  ]);
  assert.equal(RESOURCE_SHAPE_KINDS.includes("Secret" as never), false);
});

test("resource capability discovery accepts operator-defined tokens without changing typed shapes", () => {
  const capabilities = createTakosumiProductCapabilities({
    resources: {
      PushNotification: true,
    } as Partial<
      ReturnType<typeof createTakosumiProductCapabilities>["resources"]
    >,
  });

  assert.equal(capabilities.resources.PushNotification, true);
  assert.equal(
    RESOURCE_SHAPE_KINDS.includes("PushNotification" as never),
    false,
  );
});
