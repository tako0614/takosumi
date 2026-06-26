import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  assertObjectAddress,
  isObjectAddress,
  joinObjectAddressSegments,
  objectAddressSegment,
} from "../../contract/object-address.ts";
import {
  CORE_CONDITION_REASONS,
  isCoreConditionReason,
} from "../../contract/condition-reasons.ts";
import {
  type CoreBindingResolutionInput,
  type CoreBindingSource,
  type CoreBindingValueResolution,
} from "../../contract/binding-resolution.ts";

test("isCoreConditionReason validates the exported condition reason catalog", () => {
  assert.equal(isCoreConditionReason("ProviderConfigDrift"), true);
  assert.equal(isCoreConditionReason("provider-config-drift"), false);
  assert.equal(isCoreConditionReason(undefined), false);
  assert.equal(
    CORE_CONDITION_REASONS.every((reason) => isCoreConditionReason(reason)),
    true,
  );
});

test("ObjectAddress helpers encode names and validate canonical grammar", () => {
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

test("condition reason catalog includes the Output / Binding vocabulary", () => {
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

test("Retired Publication-* condition reasons are no longer in the catalog", () => {
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
      `expected ${reason} to be absent from catalog`,
    );
  }
});

test("CoreBindingResolutionInput accepts only canonical binding sources", () => {
  const sources: CoreBindingSource[] = [
    "resource",
    "output",
    "secret",
    "provider-output",
  ];
  for (const source of sources) {
    const binding: CoreBindingResolutionInput = {
      bindingName: "X",
      source,
      sourceAddress: source === "secret"
        ? "secret:db-password"
        : source === "output"
        ? "output:search-agent/search"
        : "resource.instance:db",
      injection: { mode: "env", target: "X" },
      sensitivity: "internal",
      enforcement: "enforced",
    };
    assert.equal(binding.source, source);
  }
});

test("CoreBindingValueResolution retains value-level resolution snapshot", () => {
  const resolution: CoreBindingValueResolution = {
    bindingSetRevisionId: "bsr-1",
    bindingName: "DATABASE_URL",
    sourceAddress: "resource.instance:db",
    resolutionPolicy: "latest-at-activation",
    resolvedVersion: "rev-1",
    resolvedAt: "2026-05-01T00:00:00Z",
    sensitivity: "internal",
  };
  assert.equal(resolution.resolutionPolicy, "latest-at-activation");
  assert.equal(resolution.resolvedVersion, "rev-1");
});
