import { test } from "bun:test";
// Phase 4 (space simplification) acceptance tests for P4/P5/P6.
//
// RolloutCanaryService drives a chain of Deployment records via
// DeploymentService. The registry (P4), output (P5), and rollout (P6)
// acceptance assertions remain self-contained and continue
// to run.

import assert from "node:assert/strict";
import {
  InMemoryBundledRegistry,
  InMemoryPackageDescriptorStore,
  InMemoryPackageResolutionStore,
  InMemoryTrustRecordStore,
  type PackageDescriptor,
  type PackageResolution,
  type TrustRecord,
} from "../../domains/registry/mod.ts";
import {
  InMemoryOutputConsumerBindingStore,
  InMemoryOutputProjectionStore,
  InMemoryOutputStore,
  type Output,
  type OutputConsumerBinding,
} from "../../domains/outputs/mod.ts";
import { OutputDependencyPlanner } from "../../services/output-planner/mod.ts";
import { DomainError } from "../../shared/errors.ts";

test("acceptance P4: registry resolution carries active trust for selected package digest", async () => {
  const descriptors = new InMemoryPackageDescriptorStore();
  const resolutions = new InMemoryPackageResolutionStore();
  const trustRecords = new InMemoryTrustRecordStore();
  const oldDescriptor = providerDescriptor("sha256:provider-old", "1.0.0");
  const currentDescriptor = providerDescriptor(
    "sha256:provider-current",
    "1.1.0",
  );
  const currentResolution: PackageResolution = {
    kind: "backend-plugin",
    ref: "providers/postgres",
    digest: currentDescriptor.digest,
    registry: "bundled",
    trustRecordId: "trust_provider_current",
    resolvedAt: "2026-04-27T00:00:03.000Z",
  };
  const currentTrust: TrustRecord = {
    id: "trust_provider_current",
    packageKind: currentResolution.kind,
    packageRef: currentResolution.ref,
    packageDigest: currentResolution.digest,
    trustLevel: "reference",
    status: "active",
    conformanceTier: "tested",
    verifiedBy: "takos",
    verifiedAt: "2026-04-27T00:00:04.000Z",
  };

  await descriptors.put(oldDescriptor);
  await descriptors.put(currentDescriptor);
  await resolutions.record(currentResolution);
  await trustRecords.put({
    id: "trust_provider_old",
    packageKind: "backend-plugin",
    packageRef: "providers/postgres",
    packageDigest: oldDescriptor.digest,
    trustLevel: "reference",
    status: "superseded",
    conformanceTier: "tested",
    verifiedBy: "takos",
    verifiedAt: "2026-04-27T00:00:01.000Z",
    reason: "replaced by 1.1.0",
  });
  await trustRecords.put(currentTrust);

  const registry = new InMemoryBundledRegistry(
    descriptors,
    resolutions,
    trustRecords,
    [{
      backendPluginRef: "providers/postgres",
      backendPluginDigest: currentDescriptor.digest,
      resourceContracts: ["postgres.v1"],
      capabilityProfiles: ["runtime.worker.v1"],
      conformanceTier: "tested",
    }],
  );

  const resolution = await registry.resolve(
    "backend-plugin",
    "providers/postgres",
  );
  assert.deepEqual(resolution, currentResolution);
  assert.equal(
    (await registry.getDescriptor(
      "backend-plugin",
      "providers/postgres",
      resolution?.digest ?? "",
    ))?.version,
    "1.1.0",
  );
  assert.deepEqual(
    resolution?.trustRecordId
      ? await registry.getTrustRecord(resolution.trustRecordId)
      : undefined,
    currentTrust,
  );
  assert.equal(
    (await trustRecords.findForPackage(
      "backend-plugin",
      "providers/postgres",
      currentDescriptor.digest,
    ))?.status,
    "active",
  );
  assert.deepEqual(
    (await registry.listProviderSupport()).map((report) => ({
      ref: report.backendPluginRef,
      digest: report.backendPluginDigest,
      tier: report.conformanceTier,
    })),
    [{
      ref: "providers/postgres",
      digest: "sha256:provider-current",
      tier: "tested",
    }],
  );
});

test("acceptance P5: output bindings do not auto-inject outputs and secrets require explicit target", async () => {
  const { planner, stores } = outputHarness();
  await stores.outputs.put(output({
    outputs: [
      {
        name: "URL",
        valueType: "url",
        value: "https://docs.example.test",
        required: true,
      },
      {
        name: "API_TOKEN",
        valueType: "secret-ref",
        value: "secret://docs/api-token",
        sensitive: true,
      },
    ],
  }));

  const publicOnly = await planner.planConsumerBinding({
    binding: binding({
      outputs: {
        url: {
          outputName: "URL",
          env: "DOCS_URL",
          valueType: "url",
          explicit: true,
        },
      },
    }),
    projectionId: "projection_public_only",
    persist: true,
  });

  assert.deepEqual(publicOnly.explicitOutputNames, ["URL"]);
  assert.deepEqual(
    publicOnly.projection.outputs.map((output) => output.name),
    ["URL"],
  );
  assert.equal(
    publicOnly.projection.outputs.some((output) =>
      output.valueType === "secret-ref"
    ),
    false,
  );
  assert.deepEqual(
    (await stores.bindings.listByConsumer("space_acceptance", "web")).map((
      item,
    ) => item.id),
    ["binding_docs"],
  );

  const withSecret = await planner.planConsumerBinding({
    binding: binding({
      id: "binding_docs_secret",
      outputs: {
        url: {
          outputName: "URL",
          env: "DOCS_URL",
          valueType: "url",
          explicit: true,
        },
        token: {
          outputName: "API_TOKEN",
          binding: "secrets.docsApiToken",
          valueType: "secret-ref",
          explicit: true,
        },
      },
    }),
    approvals: [{
      bindingId: "binding_docs_secret",
      outputName: "API_TOKEN",
      grantRef: "grant_docs_site",
      approved: true,
      approvedBy: "space-owner",
      approvedAt: "2026-04-27T00:00:00.000Z",
    }],
    projectionId: "projection_with_secret",
  });

  assert.deepEqual(withSecret.explicitOutputNames, ["URL", "API_TOKEN"]);
  assert.deepEqual(withSecret.approvedOutputNames, ["API_TOKEN"]);
  assert.deepEqual(
    withSecret.projection.outputs.map((output) => ({
      name: output.name,
      valueType: output.valueType,
      injectedAs: output.injectedAs,
    })),
    [
      {
        name: "URL",
        valueType: "url",
        injectedAs: { env: "DOCS_URL", binding: undefined },
      },
      {
        name: "API_TOKEN",
        valueType: "secret-ref",
        injectedAs: { env: undefined, binding: "secrets.docsApiToken" },
      },
    ],
  );

  await assert.rejects(
    () =>
      planner.planConsumerBinding({
        binding: binding({
          id: "binding_secret_without_approval",
          outputs: {
            token: {
              outputName: "API_TOKEN",
              binding: "secrets.docsApiToken",
              valueType: "secret-ref",
              explicit: true,
            },
          },
        }),
      }),
    (error) =>
      isDomainError(error, "permission_denied", "requires explicit approval"),
  );

  await assert.rejects(
    () =>
      planner.planConsumerBinding({
        binding: binding({
          id: "binding_implicit_secret",
          outputs: {
            token: {
              outputName: "API_TOKEN",
              binding: "secrets.docsApiToken",
              valueType: "secret-ref",
              explicit: false,
            },
          } as unknown as OutputConsumerBinding["outputs"],
        }),
      }),
    (error) => isDomainError(error, "invalid_argument", "must be explicit"),
  );
});

// Phase 17D `acceptance P6: canary rollout` removed alongside the dormant
// rollout / event-planner services (Wave J Component contract minimization).
// Canary rollout / HTTP-weighted assignment model are no longer service
// concerns; route shaping moved to the worker materializer layer.

function providerDescriptor(
  digest: string,
  version: string,
): PackageDescriptor {
  return {
    kind: "backend-plugin",
    ref: "providers/postgres",
    digest,
    publisher: "takos",
    version,
    body: { provider: "postgres", version },
    publishedAt: version === "1.0.0"
      ? "2026-04-27T00:00:00.000Z"
      : "2026-04-27T00:00:02.000Z",
  };
}

function outputHarness(): {
  readonly planner: OutputDependencyPlanner;
  readonly stores: {
    readonly outputs: InMemoryOutputStore;
    readonly bindings: InMemoryOutputConsumerBindingStore;
    readonly projections: InMemoryOutputProjectionStore;
  };
} {
  const stores = {
    outputs: new InMemoryOutputStore(),
    bindings: new InMemoryOutputConsumerBindingStore(),
    projections: new InMemoryOutputProjectionStore(),
  };
  return {
    stores,
    planner: new OutputDependencyPlanner({
      stores,
      idFactory: () => "generated_projection",
      clock: () => new Date("2026-04-27T00:00:00.000Z"),
    }),
  };
}

function output(overrides: Partial<Output> = {}): Output {
  return {
    id: "output_docs",
    spaceId: "space_acceptance",
    producerGroupId: "docs",
    activationId: "activation_docs",
    appReleaseId: "release_docs",
    name: "docs",
    address: "docs/site",
    contract: "web.site.v1",
    version: "1.0.0",
    type: "web-site",
    visibility: "space",
    outputs: [],
    policy: { withdrawal: "fail-consumers", rebind: "compatible-only" },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

function binding(
  overrides: Partial<OutputConsumerBinding> = {},
): OutputConsumerBinding {
  return {
    id: "binding_docs",
    spaceId: "space_acceptance",
    consumerGroupId: "web",
    outputAddress: "docs/site",
    contract: "web.site.v1",
    outputs: {},
    grantRef: "grant_docs_site",
    rebindPolicy: "compatible-only",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

function isDomainError(
  error: unknown,
  code: DomainError["code"],
  messageIncludes: string,
): boolean {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, code);
  assert.match(error.message, new RegExp(messageIncludes));
  return true;
}
