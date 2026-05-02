import assert from "node:assert/strict";
import {
  InMemoryCorePublicationResolutionStore,
  InMemoryPublicationConsumerBindingStore,
  InMemoryPublicationGrantStore,
  InMemoryPublicationProjectionStore,
  InMemoryPublicationStore,
  type Publication,
  type PublicationConsumerBinding,
  type PublicationGrant,
} from "../../domains/publications/mod.ts";
import { DomainError } from "../../shared/errors.ts";
import { PublicationDependencyPlanner } from "./mod.ts";

Deno.test("publication planner validates explicit bindings without auto-injection", async () => {
  const { service, stores } = fixture();
  await stores.publications.put(publication({
    outputs: [
      {
        name: "URL",
        valueType: "url",
        value: "https://docs.test",
        required: true,
      },
      {
        name: "TOKEN",
        valueType: "secret-ref",
        value: "secret://docs",
        required: false,
      },
    ],
  }));

  const planned = await service.planConsumerBinding({
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
    projectionId: "projection_1",
  });

  assert.deepEqual(planned.explicitOutputNames, ["URL"]);
  assert.deepEqual(planned.projection.outputs.map((output) => output.name), [
    "URL",
  ]);
  assert.equal(planned.projection.outputs[0].injectedAs?.env, "DOCS_URL");
  assert.equal(
    planned.projection.outputs.some((output) => output.name === "TOKEN"),
    false,
  );

  await assert.rejects(
    () =>
      service.planConsumerBinding({
        binding: binding({
          id: "binding_missing_required",
          outputs: {},
        }),
      }),
    (error) => isDomainConflict(error, "Required publication outputs"),
  );
});

Deno.test("publication planner blocks ambiguous short publication names", async () => {
  const { service, stores } = fixture();
  await stores.publications.put(publication({
    id: "pub_docs_a",
    address: "group-a/docs",
    producerGroupId: "group-a",
  }));
  await stores.publications.put(publication({
    id: "pub_docs_b",
    address: "group-b/docs",
    producerGroupId: "group-b",
  }));

  await assert.rejects(
    () =>
      service.validateConsumerBinding({
        binding: binding({ publicationAddress: "docs" }),
      }),
    (error) => isDomainConflict(error, "Ambiguous publication short name"),
  );
});

Deno.test("publication planner requires approvals for sensitive output injection", async () => {
  const { service, stores } = fixture();
  await stores.publications.put(publication({
    outputs: [
      { name: "URL", valueType: "url", value: "https://docs.test" },
      {
        name: "TOKEN",
        valueType: "secret-ref",
        value: "secret://docs",
        sensitive: true,
      },
    ],
  }));
  const secretBinding = binding({
    id: "binding_secret",
    outputs: {
      token: {
        outputName: "TOKEN",
        binding: "secrets.docsToken",
        valueType: "secret-ref",
        explicit: true,
      },
    },
  });

  await assert.rejects(
    () => service.planConsumerBinding({ binding: secretBinding }),
    (error) => isDomainPermissionDenied(error, "requires explicit approval"),
  );

  const planned = await service.planConsumerBinding({
    binding: secretBinding,
    approvals: [{
      bindingId: "binding_secret",
      outputName: "TOKEN",
      grantRef: "grant_docs",
      approved: true,
      approvedBy: "owner",
      approvedAt: "2026-04-27T00:00:00.000Z",
    }],
  });

  assert.deepEqual(planned.approvalRequiredOutputNames, ["TOKEN"]);
  assert.deepEqual(planned.approvedOutputNames, ["TOKEN"]);
});

Deno.test("publication planner validates grants and direct binding cycles", async () => {
  const { service, stores } = fixture({ withGrantStore: true });
  await stores.publications.put(publication());
  await stores.grants?.put(grant());

  const planned = await service.validateConsumerBinding({
    binding: binding(),
  });
  assert.equal(planned.grant?.ref, "grant_docs");

  await assert.rejects(
    () =>
      service.validateConsumerBinding({
        binding: binding({ id: "binding_bad_grant", grantRef: "missing" }),
      }),
    (error) => isDomainPermissionDenied(error, "grant was not found"),
  );

  await assert.rejects(
    () =>
      service.validateConsumerBinding({
        binding: binding({
          id: "binding_self",
          consumerGroupId: "group-a",
        }),
      }),
    (error) => isDomainConflict(error, "Publication binding cycle detected"),
  );
});

Deno.test("publication planner can require an active grant for cross-group consumption", async () => {
  const withoutGrantStore = fixture({ requireCrossGroupGrant: true });
  await withoutGrantStore.stores.publications.put(publication());

  await assert.rejects(
    () =>
      withoutGrantStore.service.validateConsumerBinding({
        binding: binding(),
      }),
    (error) =>
      isDomainPermissionDenied(
        error,
        "Cross-group publication binding requires a grant store",
      ),
  );

  const withGrantStore = fixture({
    withGrantStore: true,
    requireCrossGroupGrant: true,
  });
  await withGrantStore.stores.publications.put(publication());
  await withGrantStore.stores.grants?.put(grant());

  const planned = await withGrantStore.service.validateConsumerBinding({
    binding: binding(),
  });

  assert.equal(planned.grant?.ref, "grant_docs");
});

Deno.test("publication planner requires consumer rebind plan for breaking producer changes", async () => {
  const { service, stores } = fixture();
  const previous = publication({
    id: "pub_v1",
    address: "group-a/docs",
    contract: "docs.v1",
  });
  const next = publication({
    id: "pub_v2",
    address: "group-a/docs",
    contract: "docs.v2",
  });
  await stores.publications.put(previous);
  await stores.bindings.put(binding({
    id: "binding_consumer",
    publicationAddress: previous.address,
  }));

  const blocked = await service.planProducerChange({
    previous,
    next,
    compatibility: "breaking",
  });

  assert.equal(blocked.canProceed, false);
  assert.deepEqual(blocked.requiredRebinds.map((item) => item.bindingId), [
    "binding_consumer",
  ]);
  assert.deepEqual(
    blocked.dependentPlans.map((item) => ({
      planId: item.planId,
      targetPublicationAddress: item.targetPublicationAddress,
    })),
    [{
      planId: "publication-rebind:pub_v2:binding_consumer",
      targetPublicationAddress: "group-a/docs",
    }],
  );
  assert.equal(blocked.requiredRebinds[0].reason, "breaking-producer-change");
  assert.deepEqual(blocked.blockingIssues.map((issue) => issue.code), [
    "consumer_rebind_plan_required",
  ]);

  const wrongTarget = await service.planProducerChange({
    previous,
    next,
    compatibility: "breaking",
    consumerRebinds: [{
      bindingId: "binding_consumer",
      targetPublicationAddress: "group-a/other-docs",
    }],
  });
  assert.equal(wrongTarget.canProceed, false);
  assert.deepEqual(wrongTarget.blockingIssues.map((issue) => issue.code), [
    "consumer_rebind_target_mismatch",
  ]);

  const withRebind = await service.planProducerChange({
    previous,
    next,
    compatibility: "breaking",
    consumerRebinds: [{
      bindingId: "binding_consumer",
      targetPublicationAddress: next.address,
    }],
  });
  assert.equal(withRebind.canProceed, true);
});

Deno.test("publication planner detects deployment-time dependency cycles", async () => {
  const { service, stores } = fixture();
  await stores.publications.put(publication({
    id: "pub_a",
    producerGroupId: "group-a",
    address: "group-a/api",
  }));
  await stores.publications.put(publication({
    id: "pub_b",
    producerGroupId: "group-b",
    address: "group-b/api",
  }));
  await stores.bindings.put(binding({
    id: "binding_b_to_a",
    consumerGroupId: "group-b",
    publicationAddress: "group-a/api",
  }));

  await assert.rejects(
    () =>
      service.planDeployment({
        spaceId: "space-a",
        groupId: "group-a",
        bindings: [binding({
          id: "binding_a_to_b",
          consumerGroupId: "group-a",
          publicationAddress: "group-b/api",
        })],
      }),
    (error) => isDomainConflict(error, "Publication dependency cycle detected"),
  );
});

Deno.test("publication planner applies and observes deployment projections", async () => {
  const { service, stores } = fixture();
  await stores.publications.put(publication());

  const plan = await service.planDeployment({
    spaceId: "space-a",
    groupId: "group-consumer",
    bindings: [binding()],
  });

  assert.deepEqual(plan.edges, [{
    consumerGroupId: "group-consumer",
    producerGroupId: "group-a",
    publicationAddress: "group-a/docs",
    bindingId: "binding_docs",
  }]);
  assert.deepEqual(
    plan.projections.map((projection) => ({
      id: projection.id,
      bindingId: projection.bindingId,
      publicationId: projection.publicationId,
      outputNames: projection.outputs.map((output) => output.name),
    })),
    [{
      id: "publication-projection:binding_docs",
      bindingId: "binding_docs",
      publicationId: "pub_docs",
      outputNames: ["URL"],
    }],
  );
  assert.equal(
    (await stores.bindings.get("binding_docs"))?.publicationAddress,
    "group-a/docs",
  );
  assert.deepEqual(
    await stores.projections.listByConsumer("space-a", "group-consumer"),
    plan.projections,
  );
});

Deno.test("publication planner keeps consumer binding stable while output value changes create a new Core resolution", async () => {
  const { service, stores } = fixture();
  const firstPublication = publication({
    id: "pub_docs_v1",
    outputs: [{
      name: "URL",
      valueType: "url",
      value: "https://docs-v1.test",
      required: true,
    }],
  });
  await stores.publications.put(firstPublication);
  await service.planConsumerBinding({
    binding: binding(),
    projectionId: "projection_docs_v1",
    persist: true,
  });

  const storedBinding = await stores.bindings.get("binding_docs");
  await stores.publications.put(publication({
    id: "pub_docs_v2",
    outputs: [{
      name: "URL",
      valueType: "url",
      value: "https://docs-v2.test",
      required: true,
    }],
    updatedAt: "2026-04-27T00:01:00.000Z",
  }));

  const planned = await service.planConsumerBinding({
    binding: binding(),
    projectionId: "projection_docs_v2",
    projectedAt: "2026-04-27T00:01:01.000Z",
    persist: true,
  });
  const resolutions = await stores.resolutions.listByBinding("binding_docs");

  assert.deepEqual(await stores.bindings.get("binding_docs"), storedBinding);
  assert.equal(resolutions.length, 2);
  assert.notEqual(resolutions[0].digest, resolutions[1].digest);
  assert.equal(planned.resolution.rebindCandidate, true);
  assert.equal(planned.projection.resolutionId, planned.resolution.id);
  assert.equal(planned.projection.resolutionDigest, planned.resolution.digest);
  assert.equal(planned.projection.outputs[0].value, "https://docs-v2.test");
  assert.equal(
    (await stores.projections.get("projection_docs_v2"))?.resolutionDigest,
    planned.resolution.digest,
  );
});

Deno.test("publication planner invalidates persisted projections for withdrawn publications", async () => {
  const { service, stores } = fixture();
  const currentPublication = publication({
    policy: { withdrawal: "retain-last-projection", rebind: "compatible-only" },
  });
  await stores.publications.put(currentPublication);
  await service.planConsumerBinding({
    binding: binding(),
    projectionId: "projection_docs",
    persist: true,
  });

  const plan = await service.planPublicationWithdrawal({
    publication: currentPublication,
    withdrawnAt: "2026-04-27T00:05:00.000Z",
    projectedAt: "2026-04-27T00:05:01.000Z",
    persist: true,
  });

  assert.equal(plan.reason, "OutputWithdrawn");
  assert.deepEqual(plan.affectedBindingIds, ["binding_docs"]);
  assert.equal(plan.projections[0].status, "degraded");
  assert.equal(plan.projections[0].reason, "OutputWithdrawn");
  assert.equal(plan.projections[0].withdrawn, true);
  assert.equal(
    (await stores.projections.get("projection_docs"))?.reason,
    "OutputWithdrawn",
  );

  await assert.rejects(
    () =>
      service.validateConsumerBinding({
        binding: binding(),
      }),
    (error) => isDomainConflict(error, "Publication has been withdrawn"),
  );
});

function fixture(
  options: {
    readonly withGrantStore?: boolean;
    readonly requireCrossGroupGrant?: boolean;
  } = {},
) {
  const stores = {
    publications: new InMemoryPublicationStore(),
    bindings: new InMemoryPublicationConsumerBindingStore(),
    grants: options.withGrantStore
      ? new InMemoryPublicationGrantStore()
      : undefined,
    resolutions: new InMemoryCorePublicationResolutionStore(),
    projections: new InMemoryPublicationProjectionStore(),
  };
  return {
    stores,
    service: new PublicationDependencyPlanner({
      stores,
      idFactory: () => "generated_id",
      clock: () => new Date("2026-04-27T00:00:00.000Z"),
      requireCrossGroupGrant: options.requireCrossGroupGrant,
    }),
  };
}

function grant(overrides: Partial<PublicationGrant> = {}): PublicationGrant {
  return {
    ref: "grant_docs",
    spaceId: "space-a",
    consumerGroupId: "group-consumer",
    producerGroupId: "group-a",
    publicationAddress: "group-a/docs",
    contract: "docs.v1",
    status: "active",
    grantedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: "pub_docs",
    spaceId: "space-a",
    producerGroupId: "group-a",
    activationId: "activation-a",
    appReleaseId: "release-a",
    name: "docs",
    address: "group-a/docs",
    contract: "docs.v1",
    version: "1.0.0",
    type: "service",
    visibility: "space",
    outputs: [{
      name: "URL",
      valueType: "url",
      value: "https://docs.test",
      required: true,
    }],
    policy: { withdrawal: "fail-consumers", rebind: "compatible-only" },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

function binding(
  overrides: Partial<PublicationConsumerBinding> = {},
): PublicationConsumerBinding {
  return {
    id: "binding_docs",
    spaceId: "space-a",
    consumerGroupId: "group-consumer",
    publicationAddress: "group-a/docs",
    contract: "docs.v1",
    outputs: {
      url: {
        outputName: "URL",
        env: "DOCS_URL",
        valueType: "url",
        explicit: true,
      },
    },
    grantRef: "grant_docs",
    rebindPolicy: "compatible-only",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

function isDomainConflict(error: unknown, messageIncludes: string): boolean {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, "conflict");
  assert.match(error.message, new RegExp(messageIncludes));
  return true;
}

function isDomainPermissionDenied(
  error: unknown,
  messageIncludes: string,
): boolean {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, "permission_denied");
  assert.match(error.message, new RegExp(messageIncludes));
  return true;
}
