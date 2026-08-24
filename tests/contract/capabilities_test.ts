import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
  TAKOSUMI_API_VERSION,
  TAKOSUMI_INTERFACES_CAPABILITY,
} from "../../contract/capabilities.ts";

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
  assert.equal(document.features.interfaces, false);
  assert.equal(document.endpoints.api, "https://takosumi.example.com/api/v1");
  assert.equal(
    document.endpoints.capabilities,
    "https://takosumi.example.com/api/v1/capabilities",
  );
  assert.equal(
    document.endpoints.openapi,
    "https://takosumi.example.com/openapi.json",
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

test("Takosumi product capabilities expose generic provider and interface support", () => {
  const capabilities = createTakosumiProductCapabilities({
    resources: { EdgeWorker: true, ObjectBucket: true },
    interfacesEnabled: true,
  });

  assert.equal(capabilities.apiVersion, TAKOSUMI_API_VERSION);
  assert.equal(capabilities.resources.Stack, true);
  assert.equal(capabilities.resources.EdgeWorker, true);
  assert.equal(capabilities.resources.ObjectBucket, true);
  assert.equal(capabilities.resources.ContainerService, false);
  assert.equal(capabilities.adapters.opentofu, true);
  assert.equal(capabilities.operator.runner_pools, false);
  assert.equal(capabilities.operator.target_catalog, false);
  assert.equal(capabilities.identity.external_oidc_login, false);
  assert.equal("formAvailability" in capabilities, false);
  assert.deepEqual(capabilities.extensions, [TAKOSUMI_INTERFACES_CAPABILITY]);
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

test("Takosumi product capabilities expose Operator operations without requiring an admin UI", () => {
  const capabilities = createTakosumiProductCapabilities({
    operator: {
      multi_tenant_workspaces: true,
      workspace_members: true,
      runner_pools: true,
      operator_connections: true,
      target_catalog: true,
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
  assert.equal(capabilities.operator.target_catalog, true);
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

test("resource capability discovery accepts operator-defined provider tokens", () => {
  const capabilities = createTakosumiProductCapabilities({
    resources: {
      PushNotification: true,
    } as Partial<
      ReturnType<typeof createTakosumiProductCapabilities>["resources"]
    >,
  });

  assert.equal(capabilities.resources.PushNotification, true);
});
