import assert from "node:assert/strict";
import {
  assertObjectAddress,
  CORE_CONDITION_REASONS,
  type CoreBindingDeclaration,
  type CoreBindingResolution,
  type CoreBindingSetRevision,
  type CoreOutputDeclaration,
  type CoreOutputRevision,
  type CoreOutputValue,
  type DeploymentBinding,
  type DeploymentBindingSource,
  isCoreConditionReason,
  isObjectAddress,
  joinObjectAddressSegments,
  objectAddressSegment,
} from "./core-v1.ts";

Deno.test("isCoreConditionReason validates the exported condition reason catalog", () => {
  assert.equal(isCoreConditionReason("ProviderConfigDrift"), true);
  assert.equal(isCoreConditionReason("provider-config-drift"), false);
  assert.equal(isCoreConditionReason(undefined), false);
  assert.equal(
    CORE_CONDITION_REASONS.every((reason) => isCoreConditionReason(reason)),
    true,
  );
});

Deno.test("ObjectAddress helpers encode names and validate canonical grammar", () => {
  const address = joinObjectAddressSegments(
    objectAddressSegment("component", "api/service"),
    objectAddressSegment("contract", "public:http"),
  );

  assert.equal(address, "component:api%2Fservice/contract:public%3Ahttp");
  assert.equal(isObjectAddress(address), true);
  assert.equal(isObjectAddress("component:api/service"), false);
  assert.throws(
    () => objectAddressSegment("Component", "api"),
    /Invalid ObjectAddress namespace/,
  );
  assert.doesNotThrow(() => assertObjectAddress("app.exposure:web"));
});

Deno.test("Core condition reason catalog includes the Output / Binding vocabulary", () => {
  const required = [
    "OutputWithdrawn",
    "OutputUnavailable",
    "OutputResolutionFailed",
    "OutputProjectionFailed",
    "BindingRebindRequired",
    "BindingSourceWithdrawn",
    "BindingSourceUnavailable",
    "CredentialOutputRequiresApproval",
    "RawCredentialInjectionDenied",
  ];
  for (const reason of required) {
    assert.equal(
      isCoreConditionReason(reason),
      true,
      `expected ${reason} in CORE_CONDITION_REASONS`,
    );
  }
});

Deno.test("Legacy Publication-* condition reasons are no longer in the catalog", () => {
  const removed = [
    "PublicationWithdrawn",
    "PublicationUnavailable",
    "PublicationResolutionFailed",
    "PublicationProjectionFailed",
    "PublicationConsumerRebindRequired",
    "PublicationConsumerGrantMissing",
    "PublicationOutputInjectionDenied",
    "PublicationRouteUnavailable",
    "PublicationAuthUnavailable",
    "RepairPublicationProjectionRequired",
  ];
  for (const reason of removed) {
    assert.equal(
      isCoreConditionReason(reason),
      false,
      `expected legacy ${reason} to be removed from catalog`,
    );
  }
});

Deno.test("DeploymentBindingSource accepts only canonical sources", () => {
  const sources: DeploymentBindingSource[] = [
    "resource",
    "output",
    "secret",
    "provider-output",
  ];
  for (const source of sources) {
    const binding: DeploymentBinding = {
      bindingName: "X",
      componentAddress: "app.component:web",
      source,
      sourceAddress: source === "secret"
        ? "secret:db-password"
        : source === "output"
        ? "output:search-agent/search"
        : "resource.instance:db",
      injection: { mode: "env", target: "X" },
      sensitivity: "internal",
      enforcement: "enforced",
      resolutionPolicy: "latest-at-activation",
    };
    assert.equal(binding.source, source);
  }
});

Deno.test("CoreOutputDeclaration / OutputRevision round-trip the Output contract shape", () => {
  const declaration: CoreOutputDeclaration = {
    address: "output:search-agent/search",
    producerGroupId: "search-agent",
    contract: "output.mcp-server@v1",
    source: { exposure: "web", path: "/mcp" },
    visibility: "explicit",
    status: "declared",
  };
  const apiKey: CoreOutputValue = {
    valueType: "secret-ref",
    sensitivity: "credential",
    secretRef: "secret:takosumi-api-key/v1",
  };
  const url: CoreOutputValue = {
    valueType: "url",
    sensitivity: "internal",
    value: "https://search.example.com/mcp",
  };
  const revision: CoreOutputRevision = {
    outputAddress: declaration.address,
    revisionId: "rev-1",
    inputDigests: ["sha256:aaa"],
    values: { url, apiKey },
    status: "ready",
    digest: "sha256:bbb",
    createdAt: "2026-05-01T00:00:00Z",
  };
  assert.equal(revision.values.apiKey.sensitivity, "credential");
  assert.equal(revision.values.apiKey.secretRef, "secret:takosumi-api-key/v1");
  assert.equal(revision.outputAddress, declaration.address);
});

Deno.test("CoreBindingDeclaration distinguishes resource / output / secret / provider-output sources", () => {
  const resource: CoreBindingDeclaration = {
    address: "app.binding:api%2FDATABASE_URL",
    componentAddress: "app.component:api",
    bindingName: "DATABASE_URL",
    source: {
      kind: "resource",
      resource: "resource.instance:db",
      access: { contract: "resource.sql.postgres@v1", mode: "database-url" },
    },
    inject: { mode: "env", target: "DATABASE_URL" },
  };
  const output: CoreBindingDeclaration = {
    address: "app.binding:web%2FSEARCH_MCP_URL",
    componentAddress: "app.component:web",
    bindingName: "SEARCH_MCP_URL",
    source: {
      kind: "output",
      output: "output:search-agent/search",
      field: "url",
    },
    inject: { mode: "env", target: "SEARCH_MCP_URL" },
  };
  const credential: CoreBindingDeclaration = {
    address: "app.binding:web%2FTAKOSUMI_API_KEY",
    componentAddress: "app.component:web",
    bindingName: "TAKOSUMI_API_KEY",
    source: {
      kind: "output",
      output: "builtin:takosumi.api-key@v1",
      field: "apiKey",
    },
    inject: { mode: "secret-ref", target: "TAKOSUMI_API_KEY" },
  };
  const providerOutput: CoreBindingDeclaration = {
    address: "app.binding:web%2FCDN_HOST",
    componentAddress: "app.component:web",
    bindingName: "CDN_HOST",
    source: {
      kind: "provider-output",
      materialization: "provider.materialization:cdn-1",
      field: "host",
    },
    inject: { mode: "env", target: "CDN_HOST" },
  };
  assert.equal(resource.source.kind, "resource");
  assert.equal(output.source.kind, "output");
  assert.equal(credential.inject.mode, "secret-ref");
  assert.equal(providerOutput.source.kind, "provider-output");
});

Deno.test("CoreBindingResolution carries policy, grant, approval, and source revision", () => {
  const resolution: CoreBindingResolution = {
    bindingDeclarationAddress: "app.binding:web%2FSEARCH_MCP_URL",
    resolvedSourceRevision: "rev-1",
    policyDecisionId: "policy-1",
    approvalRecordId: "approval-1",
    grantRef: "grant-1",
    sensitivity: "internal",
    status: "ready",
    digest: "sha256:ccc",
  };
  assert.equal(resolution.status, "ready");
  assert.equal(resolution.resolvedSourceRevision, "rev-1");
  assert.equal(resolution.policyDecisionId, "policy-1");
});

Deno.test("CoreBindingSetRevision composes declarations + resolutions immutably", () => {
  const revision: CoreBindingSetRevision = {
    id: "bsr-1",
    groupId: "checkout-prod",
    componentAddress: "app.component:web",
    structureDigest: "sha256:ddd",
    inputs: [],
    bindingDeclarations: [{
      address: "app.binding:web%2FSEARCH_MCP_URL",
      componentAddress: "app.component:web",
      bindingName: "SEARCH_MCP_URL",
      source: {
        kind: "output",
        output: "output:search-agent/search",
        field: "url",
      },
      inject: { mode: "env", target: "SEARCH_MCP_URL" },
    }],
    bindingResolutions: [{
      bindingDeclarationAddress: "app.binding:web%2FSEARCH_MCP_URL",
      resolvedSourceRevision: "rev-1",
      policyDecisionId: "policy-1",
      sensitivity: "internal",
      status: "ready",
      digest: "sha256:ccc",
    }],
  };
  assert.equal(revision.bindingDeclarations?.length, 1);
  assert.equal(revision.bindingResolutions?.length, 1);
  assert.equal(
    revision.bindingDeclarations?.[0].address,
    revision.bindingResolutions?.[0].bindingDeclarationAddress,
  );
});
