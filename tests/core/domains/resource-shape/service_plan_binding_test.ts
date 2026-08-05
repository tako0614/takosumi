import { expect, test } from "bun:test";
import type {
  FormDefinition,
  FormPackage,
  InstalledFormReference,
  ResourceDeploymentReview,
  TargetImplementationDescriptor,
  TargetPoolSpec,
} from "takosumi-contract";
import {
  createInMemoryResourceShapeStores,
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  ResourceShapeService,
  StubResourceShapeAdapter,
  type AdapterApplyInput,
  type ApplyResourceRequest,
  type ImportResourceRequest,
  type ResourceShapeLifecycleEvent,
  type ResourceShapeLifecycleObserver,
  type ResourceShapeStores,
} from "../../../../core/domains/resource-shape/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { TEST_RESOURCE_SHAPE_MODULE_REGISTRY } from "../../../helpers/resource-shape/operator-module-registry.ts";

const NOW = "2026-07-29T00:00:00.000Z";
const ACTOR = {
  actorAccountId: "portable-plan-binding-principal",
  roles: [],
  requestId: "portable-plan-binding-request",
} as const;
const FORM: InstalledFormReference = {
  type: "object_bucket",
  version: "3.0.0",
  schemaDigest: `sha256:${"1".repeat(64)}`,
  packageDigest: `sha256:${"2".repeat(64)}`,
};
const RESOURCE_ID = "tkrn:plan-binding-space:ObjectBucket:object-bucket";

const POOL: TargetPoolSpec = {
  targets: [
    {
      name: "portable-target",
      type: "portable-test",
      ref: "portable-target",
      priority: 100,
      implementations: [
        {
          shape: "ObjectBucket",
          implementation: "portable_object_bucket",
          nativeResourceType: "portable.object_bucket",
          providerSource: "registry.opentofu.org/example/portable",
          moduleTemplate: "cloudflare-r2-bucket",
          moduleImportAddress: "portable_object_bucket.this",
          moduleOutputs: [{ name: "bucket_name", type: "string" }],
          interfaces: {
            object_store: "native",
            s3_api: "native",
            storage_class_infrequent_access: "native",
          },
        },
        {
          shape: "KVStore",
          implementation: "portable_kv_store",
          nativeResourceType: "portable.kv_store",
          providerSource: "registry.opentofu.org/example/portable",
          moduleTemplate: "cloudflare-kv-store",
          moduleImportAddress: "portable_kv_store.this",
          moduleOutputs: [{ name: "namespace_name", type: "string" }],
          interfaces: {
            kv_store: "native",
            runtime_binding: "native",
          },
        },
      ],
    },
  ],
};

const PLUGIN_POOL: TargetPoolSpec = {
  targets: [
    {
      name: "portable-plugin-target",
      type: "portable-test",
      ref: "portable-plugin-target",
      priority: 100,
      implementations: [
        {
          shape: "ObjectBucket",
          implementation: "portable_object_bucket_plugin",
          nativeResourceType: "portable.object_bucket",
          plugin: "portable-object-bucket-plugin",
          moduleOutputs: [{ name: "bucket_name", type: "string" }],
          interfaces: {
            object_store: "native",
            s3_api: "native",
            storage_class_infrequent_access: "native",
          },
        },
      ],
    },
  ],
};

class RecordingAdapter extends StubResourceShapeAdapter {
  readonly previewInputs: AdapterApplyInput[] = [];
  readonly applyInputs: AdapterApplyInput[] = [];
  readonly importInputs: (AdapterApplyInput & { readonly nativeId: string })[] =
    [];
  failNextImport = false;

  override availabilityForImplementation(
    implementation: TargetImplementationDescriptor,
  ) {
    return implementation.plugin
      ? { adapterId: this.id }
      : super.availabilityForImplementation(implementation);
  }

  override preview(input: AdapterApplyInput) {
    this.previewInputs.push(input);
    return super.preview(input);
  }

  override apply(input: AdapterApplyInput) {
    this.applyInputs.push(input);
    return super.apply(input);
  }

  override importResource(
    input: AdapterApplyInput & { readonly nativeId: string },
  ) {
    this.importInputs.push(input);
    if (this.failNextImport) {
      this.failNextImport = false;
      throw new Error("simulated read-only import failure");
    }
    return super.importResource(input);
  }
}

class LifecycleSpy implements ResourceShapeLifecycleObserver {
  readonly events: ResourceShapeLifecycleEvent[] = [];

  observe(event: ResourceShapeLifecycleEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

function formRefOf(identity: InstalledFormReference) {
  return {
    type: identity.type,
    version: identity.version,
    schemaDigest: identity.schemaDigest,
  };
}

function formRegistry() {
  const definition: FormDefinition = {
    identity: FORM,
    displayName: "Object bucket",
    operations: ["create", "read", "update", "delete", "import", "refresh"],
    installedAt: NOW,
  };
  const formPackage: FormPackage = {
    packageDigest: FORM.packageDigest,
    artifactRef: "memory:portable-object-bucket",
    verifierId: "test-verifier",
    status: "installed",
    definitionRefs: [formRefOf(FORM)],
    installedAt: NOW,
    installedBy: "test",
    updatedAt: NOW,
  };
  return {
    getDefinition: async (formRef: ReturnType<typeof formRefOf>) =>
      JSON.stringify(formRef) === JSON.stringify(formRefOf(FORM))
        ? definition
        : undefined,
    getPackage: async (packageDigest: string) =>
      packageDigest === FORM.packageDigest ? formPackage : undefined,
    getPackages: async (packageDigests: readonly string[]) =>
      packageDigests.includes(FORM.packageDigest) ? [formPackage] : [],
    getActivationsForForms: async () => [],
  };
}

async function fixture() {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new RecordingAdapter();
  const lifecycle = new LifecycleSpy();
  const service = new ResourceShapeService({
    stores,
    adapter,
    lifecycleObserver: lifecycle,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
    schemaRegistry: LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    formRegistry: formRegistry(),
    formDesiredStateAdmission: async () => undefined,
  });
  for (const space of ["plan-binding-space", "alternate-space"]) {
    expect((await service.putTargetPool(space, "default", POOL)).ok).toBe(true);
  }
  return { adapter, lifecycle, service, stores };
}

async function reviewedApply(
  service: ResourceShapeService,
  request: ApplyResourceRequest,
) {
  const preview = await service.preview(request);
  if (!preview.ok) throw new Error(preview.error.message);
  expect(preview.ok).toBe(true);
  const review = { planDigest: preview.value.planDigest };
  const applied = await service.apply(request, review);
  expect(applied.ok).toBe(true);
  if (!applied.ok) throw new Error(applied.error.message);
  return applied.value;
}

test("dry-run deployment review accepts the exact reviewed request without adapter or Resource mutation", async () => {
  const { adapter, service, stores } = await fixture();
  await reviewedApply(service, {
    actor: ACTOR,
    space: "plan-binding-space",
    kind: "ObjectBucket",
    form: FORM,
    name: "object-bucket",
    expectedGeneration: 0,
    spec: {
      name: "object-bucket",
      storageClass: "standard",
      interfaces: ["s3_api"],
    },
  });
  const request: ApplyResourceRequest = {
    actor: ACTOR,
    space: "plan-binding-space",
    project: "project-a",
    environment: "production",
    kind: "ObjectBucket",
    form: FORM,
    name: "object-bucket",
    expectedGeneration: 1,
    labels: { owner: "platform" },
    spec: {
      name: "object-bucket",
      storageClass: "archive",
      interfaces: ["s3_api"],
    },
  };
  const preview = await service.preview(request);
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error(preview.error.message);
  const review: ResourceDeploymentReview = {
    planDigest: preview.value.planDigest,
  };
  const resourceBefore = structuredClone(
    await stores.resources.get(RESOURCE_ID),
  );
  const lockBefore = structuredClone(await stores.locks.get(RESOURCE_ID));
  const adapterCounts = {
    previews: adapter.previewInputs.length,
    applies: adapter.applyInputs.length,
    imports: adapter.importInputs.length,
  };

  expect(await service.validateDeploymentReview(request, review)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await stores.resources.get(RESOURCE_ID)).toEqual(resourceBefore);
  expect(await stores.locks.get(RESOURCE_ID)).toEqual(lockBefore);
  expect(adapter.previewInputs).toHaveLength(adapterCounts.previews);
  expect(adapter.applyInputs).toHaveLength(adapterCounts.applies);
  expect(adapter.importInputs).toHaveLength(adapterCounts.imports);
});

test("dry-run deployment review rejects every request input bound by the canonical plan without mutation", async () => {
  const { adapter, service, stores } = await fixture();
  await reviewedApply(service, {
    actor: ACTOR,
    space: "plan-binding-space",
    kind: "ObjectBucket",
    form: FORM,
    name: "object-bucket",
    expectedGeneration: 0,
    spec: {
      name: "object-bucket",
      storageClass: "standard",
      interfaces: ["s3_api"],
    },
  });
  const request: ApplyResourceRequest = {
    actor: ACTOR,
    space: "plan-binding-space",
    project: "project-a",
    environment: "production",
    kind: "ObjectBucket",
    form: FORM,
    name: "object-bucket",
    expectedGeneration: 1,
    labels: { owner: "platform" },
    spec: {
      name: "object-bucket",
      storageClass: "archive",
      interfaces: ["s3_api"],
    },
  };
  const preview = await service.preview(request);
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error(preview.error.message);
  const review = { planDigest: preview.value.planDigest };
  const resourceBefore = structuredClone(
    await stores.resources.get(RESOURCE_ID),
  );
  const lockBefore = structuredClone(await stores.locks.get(RESOURCE_ID));
  const adapterCounts = {
    previews: adapter.previewInputs.length,
    applies: adapter.applyInputs.length,
    imports: adapter.importInputs.length,
  };
  const substitutions: readonly [
    string,
    ApplyResourceRequest,
  ][] = [
    ["space", { ...request, space: "alternate-space" }],
    ["project", { ...request, project: "project-b" }],
    ["environment", { ...request, environment: "staging" }],
    ["kind", { ...request, kind: "KVStore" }],
    [
      "form type",
      { ...request, form: { ...FORM, type: "kv_store" } },
    ],
    [
      "form version",
      { ...request, form: { ...FORM, version: "999.0.0" } },
    ],
    [
      "form schema digest",
      {
        ...request,
        form: { ...FORM, schemaDigest: `sha256:${"3".repeat(64)}` },
      },
    ],
    [
      "form package digest",
      {
        ...request,
        form: { ...FORM, packageDigest: `sha256:${"4".repeat(64)}` },
      },
    ],
    ["name", { ...request, name: "other-object-bucket" }],
    ["resource version", { ...request, expectedGeneration: 2 }],
    [
      "spec",
      {
        ...request,
        spec: { ...request.spec, storageClass: "infrequent_access" },
      },
    ],
    ["labels", { ...request, labels: { owner: "security" } }],
  ];

  for (const [field, substitution] of substitutions) {
    const result = await service.validateDeploymentReview(
      substitution,
      review,
    );
    expect(result, field).toEqual({
      ok: false,
      error: {
        code: "deployment_plan_changed",
        message:
          "deployment changed after preview; preview the current service definition again",
      },
    });
  }

  expect(await stores.resources.get(RESOURCE_ID)).toEqual(resourceBefore);
  expect(await stores.locks.get(RESOURCE_ID)).toEqual(lockBefore);
  expect(adapter.previewInputs).toHaveLength(adapterCounts.previews);
  expect(adapter.applyInputs).toHaveLength(adapterCounts.applies);
  expect(adapter.importInputs).toHaveLength(adapterCounts.imports);
});

test("existing Resource import uses the supplied native identity and advances one fenced generation", async () => {
  const { adapter, lifecycle, service, stores } = await fixture();
  const create: ImportResourceRequest = {
    actor: ACTOR,
    space: "plan-binding-space",
    kind: "ObjectBucket",
    form: FORM,
    name: "object-bucket",
    expectedGeneration: 0,
    nativeId: "provider-object-bucket",
    spec: {
      name: "object-bucket",
      storageClass: "standard",
      interfaces: ["s3_api"],
    },
  };
  const created = await service.importResource(create);
  if (!created.ok) throw new Error(created.error.message);
  expect(created.ok).toBe(true);
  expect(created.value.resource.metadata.generation).toBe(1);

  const update: ImportResourceRequest = {
    ...create,
    expectedGeneration: 1,
    spec: { ...create.spec, storageClass: "archive" },
  };
  const updated = await service.importResource(update);
  if (!updated.ok) throw new Error(updated.error.message);
  expect(updated.ok).toBe(true);
  expect(updated.value.resource.metadata.generation).toBe(2);
  expect(updated.value.resource.status?.observedGeneration).toBe(2);
  expect(updated.value.resource.spec).toEqual(update.spec);
  expect(adapter.importInputs).toHaveLength(2);
  expect(adapter.importInputs[1]).toMatchObject({
    nativeId: "provider-object-bucket",
    resourceGeneration: 2,
    stateGeneration: 1,
  });
  expect(await stores.resources.get(RESOURCE_ID)).toMatchObject({
    generation: 2,
    observedGeneration: 2,
    phase: "Ready",
    spec: update.spec,
  });

  const replay = await service.importResource(update);
  expect(replay.ok).toBe(true);
  expect(replay.ok && replay.value.import.summary).toBe(
    "canonical import already completed",
  );
  expect(adapter.importInputs).toHaveLength(2);

  const stale = await service.importResource({
    ...update,
    nativeId: "different-provider-object-bucket",
    spec: { ...update.spec, storageClass: "standard" },
  });
  expect(stale).toEqual({
    ok: false,
    error: {
      code: "resource_version_conflict",
      message: `resource ${RESOURCE_ID} is at generation 2; expected 1`,
    },
  });
  expect(adapter.importInputs).toHaveLength(2);
  expect(await stores.resources.get(RESOURCE_ID)).toMatchObject({
    generation: 2,
    observedGeneration: 2,
    spec: update.spec,
  });

  adapter.failNextImport = true;
  const lifecycleCountBeforeFailure = lifecycle.events.length;
  const failedUpdate = await service.importResource({
    ...update,
    expectedGeneration: 2,
    spec: { ...update.spec, storageClass: "infrequent_access" },
  });
  expect(failedUpdate).toEqual({
    ok: false,
    error: {
      code: "import_failed",
      message: "simulated read-only import failure",
    },
  });
  expect(await stores.resources.get(RESOURCE_ID)).toMatchObject({
    generation: 2,
    observedGeneration: 2,
    phase: "Ready",
    spec: update.spec,
  });
  expect(lifecycle.events).toHaveLength(lifecycleCountBeforeFailure);
});

test("direct-plugin import claim failure terminalizes its newly created unattached Run", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  const stores: ResourceShapeStores = {
    ...baseStores,
    async beginApply() {
      throw new Error("simulated direct import claim outage");
    },
  };
  const adapter = new RecordingAdapter();
  const operationRuns = new InMemoryOpenTofuControlStore();
  const service = new ResourceShapeService({
    stores,
    adapter,
    operationRuns,
    now: () => NOW,
    newOperationNonce: () => "portable-import-claim-nonce",
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
    schemaRegistry: LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    formRegistry: formRegistry(),
    formDesiredStateAdmission: async () => undefined,
  });
  expect(
    (
      await service.putTargetPool(
        "plan-binding-space",
        "default",
        PLUGIN_POOL,
      )
    ).ok,
  ).toBe(true);

  const imported = await service.importResource({
    actor: ACTOR,
    space: "plan-binding-space",
    kind: "ObjectBucket",
    form: FORM,
    name: "plugin-object-bucket",
    expectedGeneration: 0,
    nativeId: "provider-plugin-object-bucket",
    spec: {
      name: "plugin-object-bucket",
      storageClass: "standard",
      interfaces: ["s3_api"],
    },
  });

  expect(imported).toEqual({
    ok: false,
    error: {
      code: "import_failed",
      message: "simulated direct import claim outage",
    },
  });
  expect(adapter.importInputs).toHaveLength(0);
  expect(
    await baseStores.resources.get(
      "tkrn:plan-binding-space:ObjectBucket:plugin-object-bucket",
    ),
  ).toBeUndefined();
  expect(
    await baseStores.locks.get(
      "tkrn:plan-binding-space:ObjectBucket:plugin-object-bucket",
    ),
  ).toBeUndefined();
  expect(
    (await operationRuns.listRunsByWorkspace("plan-binding-space")).filter(
      (run) =>
        "resourceOperation" in run && run.resourceOperation === "import",
    ),
  ).toMatchObject([
    {
      resourceOperation: "import",
      status: "failed",
      createdBy: ACTOR.actorAccountId,
    },
  ]);
  expect(await operationRuns.listRecoverableResourceOperationRuns()).toEqual(
    [],
  );
});
