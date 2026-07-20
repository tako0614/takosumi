import { test, expect } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";
import {
  type RegisterResourceShapeRoutesOptions,
  TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER,
} from "../../../core/api/resource_routes.ts";
import { createInMemoryAppContext } from "../../../core/app_context.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import {
  createInMemoryResourceShapeStores,
  EMPTY_RESOURCE_SHAPE_SCHEMA_REGISTRY,
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  MapResourceShapeModuleRegistry,
  MapResourceShapeSchemaRegistry,
  type ResourceShapeServiceDeps,
  ResourceShapeService,
  StubResourceShapeAdapter,
} from "../../../core/domains/resource-shape/mod.ts";
import { createInMemoryInterfaceStores } from "../../../core/domains/interfaces/mod.ts";
import { InMemoryFormRegistryStore } from "../../../core/domains/service-forms/mod.ts";
import type { AdapterDeleteInput } from "../../../core/domains/resource-shape/mod.ts";
import { ActivityService } from "../../../core/domains/activity/mod.ts";
import {
  portableHostConformanceProof,
  portableStandardHostRunnerReport,
  runPortableFormHostConformance,
} from "../../../core/conformance/portable_form_host.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import {
  type FormDefinition,
  type FormActivation,
  type FormPackage,
  type FormPackageLifecycleStatus,
  type InstalledFormReference,
  type JsonObject,
  type ResourceShapeKind,
  RESOURCE_SHAPE_KINDS,
  type SpacePolicySpec,
  type TargetPoolSpec,
} from "takosumi-contract";

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";

const ROUTE_IMPLEMENTATIONS: NonNullable<
  TargetPoolSpec["targets"][number]["implementations"]
> = [
  {
    shape: "EdgeWorker",
    implementation: "cloudflare_workers",
    nativeResourceType: "cloudflare.workers_script",
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-worker-service",
    moduleInputMappings: {
      appName: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
      artifactPath: { source: "spec", path: "/source/artifactPath" },
      connections: { source: "spec", path: "/connections", default: {} },
    },
    moduleOutputs: [
      { name: "worker_name", type: "string" },
      { name: "url", type: "url" },
      { name: "connections", type: "json" },
    ],
    interfaces: {
      worker_fetch: "native",
      workers_bindings: "native",
      resource_connection: "native",
      runtime_binding: "native",
      grant_read: "native",
    },
  },
  {
    shape: "ObjectBucket",
    implementation: "cloudflare_r2_bucket",
    nativeResourceType: "cloudflare.r2_bucket",
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-r2-bucket",
    moduleImportAddress: "cloudflare_r2_bucket.this",
    moduleInputMappings: {
      bucketName: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
    },
    moduleOutputs: [
      { name: "bucket_name", type: "string" },
      { name: "s3_endpoint", type: "url" },
    ],
    interfaces: {
      object_store: "native",
      s3_api: "native",
      signed_url: "native",
      object_events: "native",
    },
  },
  {
    shape: "KVStore",
    implementation: "cloudflare_kv_namespace",
    nativeResourceType: "cloudflare.kv_namespace",
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-kv-store",
    moduleInputMappings: {
      namespaceTitle: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
    },
    moduleOutputs: [{ name: "namespace_id", type: "string" }],
    interfaces: { kv_store: "native", runtime_binding: "native" },
  },
  {
    shape: "Queue",
    implementation: "cloudflare_queue",
    nativeResourceType: "cloudflare.queue",
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-queue",
    moduleInputMappings: {
      queueName: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
    },
    moduleOutputs: [{ name: "queue_name", type: "string" }],
    interfaces: { queue: "native", publish: "native", consume: "native" },
  },
];

const POOL: TargetPoolSpec = {
  classes: ["edge.object-store"],
  targets: [
    {
      name: "cloudflare-main",
      type: "cloudflare",
      ref: "cf-acct",
      priority: 80,
      implementations: ROUTE_IMPLEMENTATIONS,
    },
    {
      name: "k8s-main",
      type: "kubernetes",
      ref: "cluster-prod",
      priority: 70,
    },
  ],
};

const POLICY: SpacePolicySpec = {
  resolution: { lockAfterCreate: true, allowAutoMigration: false },
};

const ROUTE_MODULE_REGISTRY = new MapResourceShapeModuleRegistry({
  "cloudflare-worker-service": testOperatorModule(),
  "cloudflare-r2-bucket": testOperatorModule(),
  "cloudflare-kv-store": testOperatorModule(),
  "cloudflare-queue": testOperatorModule(),
});

function testOperatorModule() {
  return {
    files: [{ path: "main.tf", text: "terraform {}\n" }],
  };
}

async function buildApp(
  routeOptions?: Partial<RegisterResourceShapeRoutesOptions>,
  formRegistry?: ResourceShapeServiceDeps["formRegistry"],
  serviceOverrides?: Partial<
    Pick<
      ResourceShapeServiceDeps,
      "adapter" | "moduleRegistry" | "schemaRegistry"
    >
  >,
) {
  const stores = createInMemoryResourceShapeStores();
  const activityStore = new InMemoryOpenTofuControlStore();
  const activity = new ActivityService({
    store: activityStore,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const service = new ResourceShapeService({
    stores,
    adapter: serviceOverrides?.adapter ?? new StubResourceShapeAdapter(),
    activity,
    operationRuns: activityStore,
    moduleRegistry: serviceOverrides?.moduleRegistry ?? ROUTE_MODULE_REGISTRY,
    schemaRegistry:
      serviceOverrides?.schemaRegistry ??
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    formRegistry,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  await service.putTargetPool("space_1", "default", POOL);
  await service.putSpacePolicy("space_1", "default", POLICY);
  const enabledResourceShapeKinds =
    routeOptions?.enabledResourceShapeKinds ?? RESOURCE_SHAPE_KINDS;
  const installedResourceShapeKinds =
    routeOptions?.installedResourceShapeKinds ??
    LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY.kinds();
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    resourceShapeRouteOptions: {
      service,
      ...routeOptions,
      enabledResourceShapeKinds,
      installedResourceShapeKinds,
    },
    requestCorrelation: false,
  });
  return { app, service, activityStore };
}

const EXACT_OBJECT_BUCKET_FORM: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"1".repeat(64)}`,
  },
  packageDigest: `sha256:${"2".repeat(64)}`,
};

function exactObjectBucketFormRegistry(
  options: {
    readonly packageStatus?: FormPackageLifecycleStatus;
    readonly packageIncludesDefinition?: boolean;
    readonly activationStatus?: FormActivation["status"];
    readonly eligibleTargetPoolClasses?: readonly string[];
    readonly operations?: FormDefinition["operations"];
    readonly interfaceDescriptors?: FormDefinition["interfaceDescriptors"];
  } = {},
): NonNullable<ResourceShapeServiceDeps["formRegistry"]> {
  const definition: FormDefinition = {
    identity: EXACT_OBJECT_BUCKET_FORM,
    displayName: "Object bucket",
    operations: options.operations ?? [
      "create",
      "read",
      "update",
      "delete",
      "import",
      "refresh",
    ],
    ...(options.interfaceDescriptors
      ? { interfaceDescriptors: options.interfaceDescriptors }
      : {}),
    installedAt: "2026-01-01T00:00:00.000Z",
  };
  const formPackage: FormPackage = {
    packageDigest: EXACT_OBJECT_BUCKET_FORM.packageDigest,
    artifactRef: "oci://forms.example/object-bucket@sha256:exact",
    verifierId: "test-verifier",
    status: options.packageStatus ?? "installed",
    definitionRefs:
      options.packageIncludesDefinition === false
        ? []
        : [EXACT_OBJECT_BUCKET_FORM.formRef],
    installedAt: "2026-01-01T00:00:00.000Z",
    installedBy: "test",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const activation: FormActivation = {
    id: "activation_object_bucket",
    identity: EXACT_OBJECT_BUCKET_FORM,
    scope: { type: "space", id: "space_1" },
    audience: { roles: ["owner"] },
    policy: {},
    eligibleTargetPoolClasses: options.eligibleTargetPoolClasses ?? [
      "edge.object-store",
    ],
    status: options.activationStatus ?? "active",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "test",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "test",
  };
  return {
    getDefinition: async (formRef) =>
      JSON.stringify(formRef) ===
      JSON.stringify(EXACT_OBJECT_BUCKET_FORM.formRef)
        ? definition
        : undefined,
    getPackage: async (packageDigest) =>
      packageDigest === EXACT_OBJECT_BUCKET_FORM.packageDigest
        ? formPackage
        : undefined,
    listDefinitions: async () => ({ items: [definition] }),
    listActivations: async () => ({ items: [activation] }),
  };
}

const JSON_HEADERS = { "content-type": "application/json" };
const AUTH_HEADERS = {
  ...JSON_HEADERS,
  authorization: "Bearer resource-token",
};

function portableFormQuery(identity = EXACT_OBJECT_BUCKET_FORM): string {
  const query = new URLSearchParams({
    apiVersion: identity.formRef.apiVersion,
    kind: identity.formRef.kind,
    definitionVersion: identity.formRef.definitionVersion,
    schemaDigest: identity.formRef.schemaDigest,
    packageDigest: identity.packageDigest,
  });
  return query.toString();
}

type ResourceRouteApp = Awaited<ReturnType<typeof buildApp>>["app"];

async function reviewedResourceApply(
  app: ResourceRouteApp,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<Response> {
  const kind = path.split("/")[3];
  if (!kind) throw new Error(`cannot infer Resource kind from ${path}`);
  const preview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, kind: body.kind ?? kind }),
  });
  if (!preview.ok) return preview;
  const evidence = (await preview.json()) as {
    planDigest: string;
    quote?: { quoteId: string; quoteDigest: string };
  };
  return await app.request(path, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...body,
      review: {
        planDigest: evidence.planDigest,
        ...(evidence.quote
          ? {
              quoteId: evidence.quote.quoteId,
              quoteDigest: evidence.quote.quoteDigest,
            }
          : {}),
      },
    }),
  });
}

class SlowDeleteAdapter extends StubResourceShapeAdapter {
  override async delete(_input: AdapterDeleteInput): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

class CountingPreviewAdapter extends StubResourceShapeAdapter {
  previewCalls = 0;

  override async preview(
    input: Parameters<StubResourceShapeAdapter["preview"]>[0],
  ) {
    this.previewCalls++;
    return await super.preview(input);
  }
}

class DriftableAdapter extends StubResourceShapeAdapter {
  drifted = false;

  override async apply(
    input: Parameters<StubResourceShapeAdapter["apply"]>[0],
  ) {
    const applied = await super.apply(input);
    const name = input.plan.validatedSpec.name;
    if (typeof name !== "string") {
      throw new Error("standard Form test adapter requires a validated name");
    }
    return {
      ...applied,
      outputs: {
        ...applied.outputs,
        id: `${input.plan.shape}/${name}`,
        kind: input.plan.shape,
        name,
        generation: input.stateGeneration + 1,
        portability: "portable",
        ...(input.plan.shape === "SQLDatabase"
          ? { engine: input.plan.validatedSpec.engine ?? "sqlite" }
          : {}),
      },
    };
  }

  override async observe(
    input: Parameters<StubResourceShapeAdapter["observe"]>[0],
  ) {
    const observed = await super.observe(input);
    return this.drifted
      ? { ...observed, status: "drifted" as const, summary: "test drift" }
      : observed;
  }
}

interface StandardFormHostMatrixEntry {
  readonly kind: ResourceShapeKind;
  readonly identity: InstalledFormReference;
  readonly interfaceDescriptors?: FormDefinition["interfaceDescriptors"];
  readonly desired: JsonObject;
  readonly negative: JsonObject;
  readonly desiredDigest: string;
  readonly negativeDigest: string;
}

interface StandardFormHostMatrix {
  readonly format: "takosumi.takoform-standard-host-matrix@v1";
  readonly status: "candidate-only";
  readonly definitionVersion: "1.0.1";
  readonly packageVersion: "1.0.1";
  readonly entries: readonly StandardFormHostMatrixEntry[];
}

const STANDARD_FORM_HOST_MATRIX = (await Bun.file(
  new URL(
    "../../../fixtures/takoform-standard-1.0.1-host-matrix.json",
    import.meta.url,
  ),
).json()) as StandardFormHostMatrix;

const STANDARD_HOST_INTERFACES: Readonly<
  Record<ResourceShapeKind, Readonly<Record<string, "native">>>
> = {
  EdgeWorker: {
    worker_fetch: "native",
    workers: "native",
    resource_connection: "native",
    "object.binding.v1": "native",
    grant_read: "native",
    grant_write: "native",
  },
  ObjectBucket: {
    object_store: "native",
    s3_api: "native",
    signed_url: "native",
  },
  KVStore: { kv_store: "native", runtime_binding: "native" },
  SQLDatabase: { sql: "native", sqlite: "native" },
  Queue: { queue: "native", publish: "native", consume: "native" },
  VectorIndex: {
    vector_index: "native",
    vector_query: "native",
    runtime_binding: "native",
    cosine: "native",
    dot: "native",
  },
  DurableWorkflow: {
    durable_workflow: "native",
    invoke: "native",
    signal: "native",
  },
  ContainerService: { oci_container: "native", public_http: "native" },
  StatefulActorNamespace: {
    stateful_actor_namespace: "native",
    runtime_binding: "native",
    durable_sqlite: "native",
  },
  Schedule: {
    schedule: "native",
    cron: "native",
    invoke: "native",
    resource_connection: "native",
    schedule_trigger: "native",
    grant_invoke: "native",
  },
};

function standardFormHostMatrixRegistry(
  matrix: StandardFormHostMatrix,
): NonNullable<ResourceShapeServiceDeps["formRegistry"]> {
  const definitions: FormDefinition[] = matrix.entries.map((entry) => ({
    identity: entry.identity,
    displayName: `${entry.kind} standard Form candidate`,
    operations: ["create", "read", "update", "delete", "import", "refresh"],
    ...(entry.interfaceDescriptors
      ? { interfaceDescriptors: entry.interfaceDescriptors }
      : {}),
    installedAt: "2026-07-20T00:00:00.000Z",
  }));
  const packages: FormPackage[] = matrix.entries.map((entry) => ({
    packageDigest: entry.identity.packageDigest,
    artifactRef: `test://takoform/${entry.kind}/1.0.1`,
    verifierId: "standard-form-host-matrix",
    status: "installed",
    definitionRefs: [entry.identity.formRef],
    installedAt: "2026-07-20T00:00:00.000Z",
    installedBy: "test",
    updatedAt: "2026-07-20T00:00:00.000Z",
  }));
  const activations: FormActivation[] = matrix.entries.map((entry) => ({
    id: `activation_standard_${entry.kind}`,
    identity: entry.identity,
    scope: { type: "space", id: "space_1" },
    audience: { roles: ["owner"] },
    policy: {},
    eligibleTargetPoolClasses: ["standard-host-matrix"],
    status: "active",
    revision: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    createdBy: "test",
    updatedAt: "2026-07-20T00:00:00.000Z",
    updatedBy: "test",
  }));
  return {
    getDefinition: async (formRef) =>
      definitions.find(
        (definition) =>
          JSON.stringify(definition.identity.formRef) ===
          JSON.stringify(formRef),
      ),
    getPackage: async (packageDigest) =>
      packages.find(
        (formPackage) => formPackage.packageDigest === packageDigest,
      ),
    getActivation: async (id) =>
      activations.find((activation) => activation.id === id),
    listDefinitions: async () => ({ items: definitions }),
    listActivations: async () => ({ items: activations }),
  };
}

async function installStandardFormHostMatrix(
  matrix: StandardFormHostMatrix,
): Promise<InMemoryFormRegistryStore> {
  const store = new InMemoryFormRegistryStore();
  const installedAt = "2026-07-20T00:00:00.000Z";
  for (const entry of matrix.entries) {
    await store.installPackage(
      {
        packageDigest: entry.identity.packageDigest,
        artifactRef: `test://takoform/${entry.kind}/1.0.1`,
        verifierId: "standard-form-host-matrix",
        status: "installed",
        definitionRefs: [entry.identity.formRef],
        installedAt,
        installedBy: "test",
        updatedAt: installedAt,
      },
      [
        {
          identity: entry.identity,
          displayName: `${entry.kind} standard Form candidate`,
          operations: [
            "create",
            "read",
            "update",
            "delete",
            "import",
            "refresh",
          ],
          ...(entry.interfaceDescriptors
            ? { interfaceDescriptors: entry.interfaceDescriptors }
            : {}),
          installedAt,
        },
      ],
    );
    await store.createActivation({
      id: `activation_standard_${entry.kind}`,
      identity: entry.identity,
      scope: { type: "space", id: "space_1" },
      audience: { roles: ["owner"] },
      policy: {},
      eligibleTargetPoolClasses: ["standard-host-matrix"],
      status: "active",
      revision: 1,
      createdAt: installedAt,
      createdBy: "test",
      updatedAt: installedAt,
      updatedBy: "test",
    });
  }
  return store;
}

function updatedStandardDesired(
  entry: StandardFormHostMatrixEntry,
): JsonObject {
  const desired = structuredClone(entry.desired);
  switch (entry.kind) {
    case "EdgeWorker":
      desired.compatibilityDate = "2026-07-21";
      break;
    case "ObjectBucket":
      desired.interfaces = ["s3_api", "signed_url"];
      break;
    case "KVStore":
      desired.consistency = "strong";
      break;
    case "SQLDatabase":
      desired.migrationsPath = "migrations";
      break;
    case "Queue":
      desired.delivery = { maxRetries: 3 };
      break;
    case "VectorIndex":
      desired.metric = "dot";
      break;
    case "DurableWorkflow":
      desired.retry = { initialBackoffSeconds: 5, maxAttempts: 4 };
      break;
    case "ContainerService":
      desired.publicHttp = false;
      break;
    case "StatefulActorNamespace":
      desired.migrationTag = "v2";
      break;
    case "Schedule":
      desired.cron = "5 0 * * *";
      break;
  }
  return desired;
}

test("PUT /v1/resources/EdgeWorker/:name applies a first-class Worker shape", async () => {
  const { app } = await buildApp();
  const res = await reviewedResourceApply(app, "/v1/resources/EdgeWorker/api", {
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
    },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe("tkrn:space_1:EdgeWorker:api");
  expect(body.status.resolution.selectedImplementation).toBe(
    "cloudflare_workers",
  );
  expect(body.status.resolution.target).toBe("cloudflare-main");
  expect(body.status.phase).toBe("Ready");
});

test("public Resource API validates, applies, and returns one exact installed Form identity", async () => {
  const { app } = await buildApp(undefined, exactObjectBucketFormRegistry());
  const path = "/v1/resources/ObjectBucket/form-assets";
  const desired = {
    metadata: { space: "space_1" },
    form: EXACT_OBJECT_BUCKET_FORM,
    spec: { name: "form-assets", interfaces: ["s3_api"] },
  };

  const preview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...desired, kind: "ObjectBucket" }),
  });
  expect(preview.status).toBe(200);
  expect((await preview.json()).resource.form).toEqual(
    EXACT_OBJECT_BUCKET_FORM,
  );

  const applied = await reviewedResourceApply(app, path, desired);
  expect(applied.status).toBe(200);
  expect((await applied.json()).form).toEqual(EXACT_OBJECT_BUCKET_FORM);

  const read = await app.request(`${path}?space=space_1`);
  expect(read.status).toBe(200);
  expect((await read.json()).form).toEqual(EXACT_OBJECT_BUCKET_FORM);

  const omitted = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...desired, kind: "ObjectBucket", form: undefined }),
  });
  expect(omitted.status).toBe(409);
  expect((await omitted.json()).error.code).toBe("form_identity_conflict");
});

test("public Resource API rejects malformed or kind-mismatched exact Form identity", async () => {
  const { app } = await buildApp(undefined, exactObjectBucketFormRegistry());
  const base = {
    kind: "ObjectBucket",
    metadata: { space: "space_1" },
    spec: { name: "invalid-form-assets", interfaces: ["s3_api"] },
  };
  const malformed = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...base,
      form: { ...EXACT_OBJECT_BUCKET_FORM, packageDigest: "latest" },
    }),
  });
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).error.message).toContain(
    "exact InstalledFormReference",
  );

  const mismatch = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...base,
      form: {
        ...EXACT_OBJECT_BUCKET_FORM,
        formRef: { ...EXACT_OBJECT_BUCKET_FORM.formRef, kind: "Queue" },
      },
    }),
  });
  expect(mismatch.status).toBe(400);
  expect((await mismatch.json()).error.code).toBe("invalid_form_ref");
});

test("portable Form host delegates exact lifecycle to the canonical Resource and audit ledger", async () => {
  const { app, service } = await buildApp(
    {
      resolveActor: () => ({
        actorAccountId: "acct_portable",
        roles: ["owner"],
        scopes: ["forms:read", "resources:*"],
        requestId: "req_portable",
      }),
    },
    exactObjectBucketFormRegistry(),
  );
  const base = "/apis/forms.takoform.com/v1alpha1";
  const path = `${base}/resources/ObjectBucket/portable-assets`;
  const desired = {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    form: EXACT_OBJECT_BUCKET_FORM,
    metadata: { name: "portable-assets", space: "space_1" },
    spec: { name: "portable-assets", interfaces: ["s3_api"] },
  };

  const discovery = await app.request("/.well-known/takoform");
  expect(discovery.status).toBe(200);
  expect((await discovery.json()).endpoints.api).toEndWith(base);

  const forms = await app.request(`${base}/forms?space=space_1`);
  expect(forms.status).toBe(200);
  expect((await forms.json()).forms[0].identity).toEqual(
    EXACT_OBJECT_BUCKET_FORM,
  );

  const preview = await app.request(`${base}/resources/preview`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(desired),
  });
  expect(preview.status).toBe(200);
  const previewBody = await preview.json();
  expect(previewBody.resource.form).toEqual(EXACT_OBJECT_BUCKET_FORM);
  expect(JSON.stringify(previewBody)).not.toContain("cloudflare-main");
  expect(JSON.stringify(previewBody)).not.toContain("selectedImplementation");

  const applyBody = {
    ...desired,
    review: { planDigest: previewBody.review.planDigest },
  };
  const applyHeaders = {
    ...JSON_HEADERS,
    "if-none-match": "*",
    "idempotency-key": "portable-create-1",
  };
  const applied = await app.request(path, {
    method: "PUT",
    headers: applyHeaders,
    body: JSON.stringify(applyBody),
  });
  expect(applied.status).toBe(200);
  expect(applied.headers.get("etag")).toBe('"1"');
  const appliedBody = await applied.json();
  expect(appliedBody.metadata.resourceVersion).toBe("1");
  expect(appliedBody.status.phase).toBe("Ready");
  expect(JSON.stringify(appliedBody)).not.toContain("managedBy");
  expect(JSON.stringify(appliedBody)).not.toContain("cloudflare-main");

  const replayed = await app.request(path, {
    method: "PUT",
    headers: applyHeaders,
    body: JSON.stringify(applyBody),
  });
  expect(replayed.status).toBe(200);
  expect((await replayed.json()).metadata.resourceVersion).toBe("1");

  const exactQuery = portableFormQuery();
  const read = await app.request(`${path}?space=space_1&${exactQuery}`);
  expect(read.status).toBe(200);
  expect(read.headers.get("etag")).toBe('"1"');

  const stale = await app.request(path, {
    method: "PUT",
    headers: {
      ...JSON_HEADERS,
      "if-match": '"9"',
      "idempotency-key": "portable-update-1",
    },
    body: JSON.stringify({
      ...applyBody,
      spec: { ...desired.spec, standard: "infrequent" },
    }),
  });
  expect(stale.status).toBe(412);
  expect((await stale.json()).error.code).toBe("resource_version_conflict");

  for (const action of ["observe", "refresh"] as const) {
    const missingMatch = await app.request(
      `${path}/${action}?space=space_1&${exactQuery}`,
      {
        method: "POST",
        headers: { "idempotency-key": `portable-${action}-missing-match` },
      },
    );
    expect(missingMatch.status).toBe(400);
    expect((await missingMatch.json()).error.code).toBe("invalid_argument");

    const staleMatch = await app.request(
      `${path}/${action}?space=space_1&${exactQuery}`,
      {
        method: "POST",
        headers: {
          "if-match": '"9"',
          "idempotency-key": `portable-${action}-stale-match`,
        },
      },
    );
    expect(staleMatch.status).toBe(412);
    expect((await staleMatch.json()).error.code).toBe(
      "resource_version_conflict",
    );
  }

  const observe = await app.request(
    `${path}/observe?space=space_1&${exactQuery}`,
    {
      method: "POST",
      headers: {
        "if-match": '"1"',
        "idempotency-key": "portable-observe-1",
      },
    },
  );
  expect(observe.status).toBe(200);
  expect((await observe.json()).resource.status.phase).toBe("Ready");

  const events = await service.listEvents(
    "space_1",
    "ObjectBucket",
    "portable-assets",
    {},
  );
  expect(events.items.map((event) => event.action)).toContain(
    "resource.apply.succeeded",
  );
  expect(events.items.map((event) => event.action)).toContain(
    "resource.observe.succeeded",
  );

  const deleteWithoutMatch = await app.request(
    `${path}?space=space_1&${exactQuery}`,
    {
      method: "DELETE",
      headers: { "idempotency-key": "portable-delete-missing-match" },
    },
  );
  expect(deleteWithoutMatch.status).toBe(400);
  expect((await deleteWithoutMatch.json()).error.code).toBe("invalid_argument");

  const deleteWithStaleMatch = await app.request(
    `${path}?space=space_1&${exactQuery}`,
    {
      method: "DELETE",
      headers: {
        "if-match": '"9"',
        "idempotency-key": "portable-delete-stale-match",
      },
    },
  );
  expect(deleteWithStaleMatch.status).toBe(412);
  expect((await deleteWithStaleMatch.json()).error.code).toBe(
    "resource_version_conflict",
  );

  const deleted = await app.request(`${path}?space=space_1&${exactQuery}`, {
    method: "DELETE",
    headers: {
      "if-match": '"1"',
      "idempotency-key": "portable-delete-1",
    },
  });
  expect(deleted.status).toBe(204);
  expect(
    (await service.get("space_1", "ObjectBucket", "portable-assets")).ok,
  ).toBe(false);
  const deleteReplay = await app.request(
    `${path}?space=space_1&${exactQuery}`,
    {
      method: "DELETE",
      headers: {
        "if-match": '"1"',
        "idempotency-key": "portable-delete-1",
      },
    },
  );
  expect(deleteReplay.status).toBe(204);
});

test("portable Form import replay consumes pinned admission after availability changes", async () => {
  let active = true;
  const installed = exactObjectBucketFormRegistry();
  const registry: NonNullable<ResourceShapeServiceDeps["formRegistry"]> = {
    ...installed,
    listActivations: async () =>
      active ? await installed.listActivations() : { items: [] },
  };
  const { app } = await buildApp(
    {
      resolveActor: () => ({
        actorAccountId: "acct_import_replay",
        roles: ["owner"],
        scopes: ["forms:read", "resources:*"],
        requestId: "req_import_replay",
      }),
    },
    registry,
  );
  const base = "/apis/forms.takoform.com/v1alpha1";
  const desired = {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    form: EXACT_OBJECT_BUCKET_FORM,
    metadata: { name: "imported-assets", space: "space_1" },
    spec: { name: "imported-assets", interfaces: ["s3_api"] },
    nativeId: "native-imported-assets",
  };
  const headers = {
    ...JSON_HEADERS,
    "if-none-match": "*",
    "idempotency-key": "portable-import-replay-1",
  };
  const imported = await app.request(
    `${base}/resources/ObjectBucket/imported-assets/import`,
    { method: "POST", headers, body: JSON.stringify(desired) },
  );
  expect(imported.status).toBe(200);

  active = false;
  const replayed = await app.request(
    `${base}/resources/ObjectBucket/imported-assets/import`,
    { method: "POST", headers, body: JSON.stringify(desired) },
  );
  expect(replayed.status).toBe(200);
  expect((await replayed.json()).resource.metadata.resourceVersion).toBe("1");

  const rejectedNewImport = await app.request(
    `${base}/resources/ObjectBucket/unavailable-assets/import`,
    {
      method: "POST",
      headers: { ...headers, "idempotency-key": "portable-import-new-2" },
      body: JSON.stringify({
        ...desired,
        metadata: { name: "unavailable-assets", space: "space_1" },
        spec: { ...desired.spec, name: "unavailable-assets" },
        nativeId: "native-unavailable-assets",
      }),
    },
  );
  expect(rejectedNewImport.status).toBe(409);
  expect((await rejectedNewImport.json()).error.code).toBe("form_unavailable");
});

test("portable Form host rejects invalid label values instead of dropping them", async () => {
  const { app } = await buildApp(undefined, exactObjectBucketFormRegistry());
  const response = await app.request(
    "/apis/forms.takoform.com/v1alpha1/resources/preview",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        apiVersion: "forms.takoform.com/v1alpha1",
        kind: "ObjectBucket",
        form: EXACT_OBJECT_BUCKET_FORM,
        metadata: {
          name: "invalid-labels",
          space: "space_1",
          labels: { valid: "label", invalid: 42 },
        },
        spec: { name: "invalid-labels", interfaces: ["s3_api"] },
      }),
    },
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatchObject({
    code: "invalid_argument",
    message: "metadata.labels must be an object whose values are strings",
  });
});

test("portable Form host rejects incomplete and substituted exact identities", async () => {
  const { app } = await buildApp(undefined, exactObjectBucketFormRegistry());
  const base = "/apis/forms.takoform.com/v1alpha1";
  const incomplete = await app.request(
    `${base}/resources/ObjectBucket/missing?space=space_1&kind=ObjectBucket`,
  );
  expect(incomplete.status).toBe(400);

  const substitutedForm = {
    ...EXACT_OBJECT_BUCKET_FORM,
    formRef: {
      ...EXACT_OBJECT_BUCKET_FORM.formRef,
      schemaDigest: `sha256:${"f".repeat(64)}`,
    },
  };
  const substituted = await app.request(`${base}/resources/preview`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      apiVersion: "forms.takoform.com/v1alpha1",
      kind: "ObjectBucket",
      form: substitutedForm,
      metadata: { name: "substituted", space: "space_1" },
      spec: { name: "substituted", interfaces: ["s3_api"] },
    }),
  });
  expect(substituted.status).toBe(404);
  expect((await substituted.json()).error.code).toBe("form_unknown");
});

test("portable Form host enforces the exact definition lifecycle operations", async () => {
  const { app } = await buildApp(
    undefined,
    exactObjectBucketFormRegistry({ operations: ["read"] }),
  );
  const preview = await app.request(
    "/apis/forms.takoform.com/v1alpha1/resources/preview",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        apiVersion: "forms.takoform.com/v1alpha1",
        kind: "ObjectBucket",
        form: EXACT_OBJECT_BUCKET_FORM,
        metadata: { name: "read-only", space: "space_1" },
        spec: { name: "read-only", interfaces: ["s3_api"] },
      }),
    },
  );
  expect(preview.status).toBe(409);
  expect((await preview.json()).error).toMatchObject({
    code: "form_unavailable",
    message: "exact form does not support create",
  });
});

test("portable Form host black-box runner proves canonical lifecycle parity", async () => {
  const adapter = new DriftableAdapter();
  const { app } = await buildApp(undefined, exactObjectBucketFormRegistry(), {
    adapter,
  });
  const report = await runPortableFormHostConformance({
    endpoint: "https://host.example.test",
    space: "space_1",
    name: "runner-assets",
    identity: EXACT_OBJECT_BUCKET_FORM,
    desired: { name: "runner-assets", interfaces: ["s3_api"] },
    updatedDesired: {
      name: "runner-assets",
      interfaces: ["s3_api", "signed_url"],
    },
    positiveFixtureName: "basic",
    positivePackageFixtureDigest: `sha256:${"a".repeat(64)}`,
    negativeFixtures: [
      {
        name: "invalid-interfaces",
        stage: "desired",
        input: {
          name: "runner-assets-negative-1",
          interfaces: [7],
        },
        expectedErrorCode: "invalid_argument",
      },
    ],
    negativePackageFixtureDigests: {
      "invalid-interfaces": `sha256:${"b".repeat(64)}`,
    },
    importNativeId: "provider-native-runner-assets",
    expectDrift: true,
    beforeDriftObserve: () => {
      adapter.drifted = true;
    },
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      app.request(input.toString(), init)) as typeof fetch,
  });
  expect(report.status).toBe("passed");
  expect(report.checks).toContain("canonical-resource-parity");
  expect(report.checks).toContain("canonical-audit-parity");
  expect(report.checks).toContain("import-idempotency");
  expect(report.checks).toContain("update");
  expect(report.checks).toContain("drift");
  expect(report.checks).toContain("negative-fixtures");
  expect(report.fixtures.positive).toEqual([
    {
      name: "basic",
      inputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      packageFixtureDigest: `sha256:${"a".repeat(64)}`,
    },
  ]);
  expect(report.fixtures.negative).toEqual([
    {
      name: "invalid-interfaces",
      stage: "desired",
      inputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      packageFixtureDigest: `sha256:${"b".repeat(64)}`,
      httpStatus: 400,
      errorCode: "invalid_argument",
    },
  ]);
  expect(report.fixtures.positive[0]?.inputDigest).not.toBe(
    report.fixtures.negative[0]?.inputDigest,
  );
  expect(report.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(portableHostConformanceProof(report)).toMatchObject({
    subject: "host:https://host.example.test",
    identity: EXACT_OBJECT_BUCKET_FORM,
    status: "passed",
    positiveFixtures: ["basic"],
    negativeFixtures: ["invalid-interfaces"],
  });
  const standard = await portableStandardHostRunnerReport(report);
  expect(JSON.parse(standard.canonical)).toEqual(standard.report);
  expect(standard.report).toMatchObject({
    format: "takoform.standard-runner-report@v1",
    role: "host-report",
    subject: "host:https://host.example.test",
    identity: EXACT_OBJECT_BUCKET_FORM,
    status: "passed",
    executionEvidenceDigest: report.evidenceDigest,
    lifecycle: {
      create: true,
      read: true,
      update: true,
      delete: true,
      import: true,
      observe: true,
      refresh: true,
      drift: true,
    },
    positiveFixtures: [
      {
        name: "basic",
        packageFixtureDigest: `sha256:${"a".repeat(64)}`,
        effectiveInputDigest: report.fixtures.positive[0]?.inputDigest,
        passed: true,
      },
    ],
  });
  expect(standard.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(standard.proof.evidenceDigest).toBe(standard.evidenceDigest);
  await expect(
    portableStandardHostRunnerReport({
      ...report,
      fixtures: {
        ...report.fixtures,
        negative: report.fixtures.negative.map((fixture) => ({
          ...fixture,
          errorCode: "policy_denied",
        })),
      },
    }),
  ).rejects.toThrow(
    "negative fixture invalid-interfaces returned policy_denied instead of invalid_argument",
  );
});

test("portable Form host proves the exact ten-Form 1.0.1 successor matrix", async () => {
  expect(STANDARD_FORM_HOST_MATRIX).toMatchObject({
    format: "takosumi.takoform-standard-host-matrix@v1",
    status: "candidate-only",
    definitionVersion: "1.0.1",
    packageVersion: "1.0.1",
  });
  expect(STANDARD_FORM_HOST_MATRIX.entries).toHaveLength(10);
  expect(
    STANDARD_FORM_HOST_MATRIX.entries.map(({ kind }) => kind).sort(),
  ).toEqual([...RESOURCE_SHAPE_KINDS].sort());

  const adapter = new DriftableAdapter();
  const { app, service } = await buildApp(
    undefined,
    standardFormHostMatrixRegistry(STANDARD_FORM_HOST_MATRIX),
    { adapter },
  );
  await service.putTargetPool("space_1", "default", {
    classes: ["standard-host-matrix"],
    targets: [
      {
        name: "standard-host-matrix",
        type: "test",
        ref: "standard-host-matrix",
        priority: 100,
        implementations: STANDARD_FORM_HOST_MATRIX.entries.map((entry) => ({
          shape: entry.kind,
          implementation: `test_${entry.kind.toLowerCase()}`,
          nativeResourceType: `test.${entry.kind.toLowerCase()}`,
          providerSource: CLOUDFLARE_PROVIDER,
          moduleTemplate: "cloudflare-worker-service",
          moduleImportAddress: "test_resource.this",
          moduleOutputs: [
            { name: "id", type: "string" },
            { name: "name", type: "string" },
            ...(entry.kind === "SQLDatabase"
              ? [{ name: "engine" as const, type: "string" as const }]
              : []),
          ],
          interfaces: STANDARD_HOST_INTERFACES[entry.kind],
        })),
      },
    ],
  });

  const edgeBucket = STANDARD_FORM_HOST_MATRIX.entries.find(
    ({ kind }) => kind === "ObjectBucket",
  );
  if (!edgeBucket) throw new Error("matrix omitted ObjectBucket");
  const edgeBucketDependency = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/edge-assets",
    {
      metadata: { space: "space_1" },
      form: edgeBucket.identity,
      spec: { ...edgeBucket.desired, name: "edge-assets" },
    },
  );
  expect(edgeBucketDependency.status).toBe(200);

  const reports = [];
  for (const entry of STANDARD_FORM_HOST_MATRIX.entries) {
    adapter.drifted = false;
    if (entry.kind === "Schedule") {
      const workflow = STANDARD_FORM_HOST_MATRIX.entries.find(
        ({ kind }) => kind === "DurableWorkflow",
      );
      if (!workflow) throw new Error("matrix omitted DurableWorkflow");
      const dependency = await reviewedResourceApply(
        app,
        `/v1/resources/DurableWorkflow/${workflow.desired.name as string}`,
        {
          metadata: { space: "space_1" },
          form: workflow.identity,
          spec: workflow.desired,
        },
      );
      expect(dependency.status).toBe(200);
    }

    const report = await runPortableFormHostConformance({
      endpoint: "https://host.example.test",
      space: "space_1",
      name: entry.desired.name as string,
      identity: entry.identity,
      desired: entry.desired,
      updatedDesired: updatedStandardDesired(entry),
      positiveFixtureName: "desired",
      positivePackageFixtureDigest: entry.desiredDigest,
      negativeFixtures: [
        {
          name: "negative",
          stage: "desired",
          input: entry.negative,
          expectedErrorCode: "invalid_argument",
        },
      ],
      negativePackageFixtureDigests: { negative: entry.negativeDigest },
      importNativeId: `provider-native-${entry.kind.toLowerCase()}`,
      expectDrift: true,
      beforeDriftObserve: () => {
        adapter.drifted = true;
      },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        app.request(input.toString(), init)) as typeof fetch,
    });
    expect(report.status).toBe("passed");
    expect(report.identity).toEqual(entry.identity);
    expect(report.fixtures.positive[0]?.packageFixtureDigest).toBe(
      entry.desiredDigest,
    );
    expect(report.fixtures.negative[0]?.packageFixtureDigest).toBe(
      entry.negativeDigest,
    );
    const standard = await portableStandardHostRunnerReport(report);
    expect(standard.report.identity).toEqual(entry.identity);
    expect(standard.report.status).toBe("passed");
    expect(standard.report.positiveFixtures[0]?.packageFixtureDigest).toBe(
      entry.desiredDigest,
    );
    expect(standard.report.negativeFixtures[0]?.packageFixtureDigest).toBe(
      entry.negativeDigest,
    );
    reports.push(standard.report);
  }

  expect(reports).toHaveLength(10);
});

test("exact 1.0.1 runtime descriptors materialize as portable host-owned Interfaces", async () => {
  const formRegistryStore = await installStandardFormHostMatrix(
    STANDARD_FORM_HOST_MATRIX,
  );
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    formRegistryStore,
    resourceShapeAdapter: new DriftableAdapter(),
    resourceShapeSchemaRegistry:
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    enabledResourceShapeKinds: RESOURCE_SHAPE_KINDS,
    resourceShapeModuleRegistry: ROUTE_MODULE_REGISTRY,
    resolveResourceInterfaceWorkspace: async ({ resourceSpaceId }) =>
      resourceSpaceId === "space_1" ? "workspace_1" : undefined,
  });
  const implementations = STANDARD_FORM_HOST_MATRIX.entries.map((entry) => ({
    shape: entry.kind,
    implementation: `test_${entry.kind.toLowerCase()}`,
    nativeResourceType: `test.${entry.kind.toLowerCase()}`,
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-worker-service",
    moduleImportAddress: "test_resource.this",
    moduleOutputs: [
      { name: "id", type: "string" as const },
      { name: "name", type: "string" as const },
      ...(entry.kind === "SQLDatabase"
        ? [{ name: "engine", type: "string" as const }]
        : []),
    ],
    interfaces: STANDARD_HOST_INTERFACES[entry.kind],
  }));
  expect(
    (
      await app.request("/v1/target-pools/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          space: "space_1",
          spec: {
            classes: ["standard-host-matrix"],
            targets: [
              {
                name: "standard-host-matrix",
                type: "test",
                ref: "standard-host-matrix",
                priority: 100,
                implementations,
              },
            ],
          },
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/v1/space-policies/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POLICY }),
      })
    ).status,
  ).toBe(200);

  const bucket = STANDARD_FORM_HOST_MATRIX.entries.find(
    ({ kind }) => kind === "ObjectBucket",
  );
  if (!bucket) throw new Error("matrix omitted ObjectBucket");
  expect(
    (
      await reviewedResourceApply(
        app,
        "/v1/resources/ObjectBucket/edge-assets",
        {
          metadata: { space: "space_1" },
          form: bucket.identity,
          spec: { ...bucket.desired, name: "edge-assets" },
        },
      )
    ).status,
  ).toBe(200);

  let descriptorCount = 0;
  for (const entry of STANDARD_FORM_HOST_MATRIX.entries) {
    const name = entry.desired.name as string;
    const applied = await reviewedResourceApply(
      app,
      `/v1/resources/${entry.kind}/${name}`,
      {
        metadata: { space: "space_1" },
        form: entry.identity,
        spec: entry.desired,
      },
    );
    expect(applied.status).toBe(200);
    expect((await applied.json()).status.phase).toBe("Ready");

    const resourceId = `tkrn:space_1:${entry.kind}:${name}`;
    const materialized = await operations.interfaces.list({
      workspaceId: "workspace_1",
      ownerKind: "Resource",
      ownerId: resourceId,
      includeRetired: false,
    });
    const descriptors = entry.interfaceDescriptors ?? [];
    expect(materialized).toHaveLength(descriptors.length);
    if (descriptors.length === 0) {
      expect(entry.kind).toBe("Schedule");
      continue;
    }
    descriptorCount += descriptors.length;
    expect(JSON.stringify(descriptors)).not.toContain("takosumi.cloud");
    const descriptor = descriptors[0]!;
    const iface = materialized[0]!;
    expect(iface.status.phase).toBe("Resolved");
    expect(iface.spec).toMatchObject({
      type: descriptor.name,
      version: descriptor.version,
      document: descriptor.document,
      access: { visibility: "workspace" },
    });
    expect(iface.metadata.materializedFrom).toMatchObject({
      source: "form_descriptor",
      descriptorName: descriptor.name,
      descriptorVersion: descriptor.version,
      formSchemaDigest: entry.identity.formRef.schemaDigest,
    });
    expect(iface.status.resolvedInputs).toMatchObject({
      resource: `${entry.kind}/${name}`,
      name,
      ...(entry.kind === "SQLDatabase" ? { engine: "sqlite" } : {}),
    });
  }
  expect(descriptorCount).toBe(9);
});

test("portable Form host refuses to serialize partial runs as standard admission evidence", async () => {
  const { app } = await buildApp(undefined, exactObjectBucketFormRegistry());
  const report = await runPortableFormHostConformance({
    endpoint: "https://host.example.test",
    space: "space_1",
    name: "partial-runner-assets",
    identity: EXACT_OBJECT_BUCKET_FORM,
    desired: { name: "partial-runner-assets", interfaces: ["s3_api"] },
    positiveFixtureName: "basic",
    negativeFixtures: [
      {
        name: "invalid-interfaces",
        stage: "desired",
        input: {
          name: "partial-runner-assets-negative-1",
          interfaces: [7],
        },
        expectedErrorCode: "invalid_argument",
      },
    ],
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      app.request(input.toString(), init)) as typeof fetch,
  });
  await expect(portableStandardHostRunnerReport(report)).rejects.toThrow(
    "missing update, import-idempotency, drift",
  );
});

test("Form availability derives exact principal-safe executable truth", async () => {
  const { app } = await buildApp(
    {
      resolveActor: () => ({
        actorAccountId: "acct_owner",
        workspaceId: "workspace_1",
        roles: ["owner"],
        scopes: ["forms:read"],
        requestId: "req_availability",
      }),
    },
    exactObjectBucketFormRegistry(),
  );
  const response = await app.request("/v1/form-availability?space=space_1");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { forms: Record<string, unknown>[] };
  expect(body.forms).toHaveLength(1);
  expect(body.forms[0]).toMatchObject({
    identity: EXACT_OBJECT_BUCKET_FORM,
    definitionKnown: true,
    installed: true,
    executable: true,
    activated: true,
    availableToPrincipal: true,
    compatibleAdapterIds: ["stub"],
    eligibleTargetPoolClasses: ["edge.object-store"],
    deprecated: false,
  });
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("cloudflare-main");
  expect(serialized).not.toContain("cloudflare_r2_bucket");
  expect(serialized).not.toContain("cf-acct");
  expect(serialized).not.toContain("credentialRef");
  expect(serialized).not.toContain("price");
  expect(serialized).not.toContain("sku");
  expect(serialized).not.toContain("capacity");

  const capabilities = await app.request("/v1/capabilities?space=space_1");
  expect(capabilities.status).toBe(200);
  const projected = (await capabilities.json()) as {
    resources: Record<string, boolean>;
    formAvailability: { forms: unknown[] };
  };
  expect(projected.formAvailability.forms).toEqual(body.forms);
  expect(projected.resources.ObjectBucket).toBe(true);
  expect(projected.resources.EdgeWorker).toBe(false);
});

test("required host-namespaced Interface input fails availability and admission before adapter execution", async () => {
  const adapter = new CountingPreviewAdapter();
  const registry = exactObjectBucketFormRegistry({
    interfaceDescriptors: [
      {
        name: "storage.object",
        version: "v1",
        required: true,
        inputs: [
          {
            name: "session",
            source: "example.host.session",
          },
        ],
      },
    ],
  });
  const { app } = await buildApp(
    {
      resolveActor: () => ({
        actorAccountId: "acct_owner",
        workspaceId: "workspace_1",
        roles: ["owner"],
        scopes: ["forms:read", "resources:read", "resources:write"],
        requestId: "req_interface_capability",
      }),
    },
    registry,
    { adapter },
  );

  const availability = await app.request("/v1/form-availability?space=space_1");
  expect(availability.status).toBe(200);
  expect((await availability.json()).forms[0]).toMatchObject({
    executable: false,
    executableReason: "interface_capability_missing",
    availableToPrincipal: false,
    availabilityReason: "interface_capability_missing",
  });

  const preview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "ObjectBucket",
      metadata: { space: "space_1" },
      form: EXACT_OBJECT_BUCKET_FORM,
      spec: { name: "blocked-assets", interfaces: ["s3_api"] },
    }),
  });
  expect(preview.status).toBe(409);
  expect(await preview.json()).toMatchObject({
    error: {
      code: "capability_missing",
      message: expect.stringContaining("example.host.session"),
    },
  });
  expect(adapter.previewCalls).toBe(0);
});

test("Form availability fails closed for audience, scope, and unknown exact identity", async () => {
  const { app } = await buildApp(
    {
      resolveActor: () => ({
        actorAccountId: "acct_viewer",
        roles: ["viewer"],
        scopes: ["resources:read"],
        requestId: "req_viewer",
      }),
    },
    exactObjectBucketFormRegistry(),
  );
  const denied = await app.request("/v1/form-availability?space=space_1");
  expect(denied.status).toBe(200);
  expect((await denied.json()).forms[0]).toMatchObject({
    executable: true,
    activated: true,
    availableToPrincipal: false,
    availabilityReason: "principal_not_allowed",
  });

  const unknown = {
    ...EXACT_OBJECT_BUCKET_FORM,
    formRef: {
      ...EXACT_OBJECT_BUCKET_FORM.formRef,
      schemaDigest: `sha256:${"9".repeat(64)}`,
    },
  };
  const query = new URLSearchParams({
    space: "space_1",
    apiVersion: unknown.formRef.apiVersion,
    kind: unknown.formRef.kind,
    definitionVersion: unknown.formRef.definitionVersion,
    schemaDigest: unknown.formRef.schemaDigest,
    packageDigest: unknown.packageDigest,
  });
  const missing = await app.request(`/v1/form-availability?${query}`);
  expect(missing.status).toBe(200);
  expect((await missing.json()).forms[0]).toMatchObject({
    identity: unknown,
    definitionKnown: false,
    installed: false,
    executable: false,
    executableReason: "definition_unknown",
    activated: false,
    availableToPrincipal: false,
    availabilityReason: "definition_unknown",
  });

  const { app: insufficientScope } = await buildApp(
    {
      resolveActor: () => ({
        actorAccountId: "acct_viewer",
        roles: ["viewer"],
        scopes: ["resources:write"],
        requestId: "req_denied",
      }),
    },
    exactObjectBucketFormRegistry(),
  );
  expect(
    (await insufficientScope.request("/v1/form-availability?space=space_1"))
      .status,
  ).toBe(403);
});

test("Form availability fails closed when schema, module, lifecycle, or placement evidence is missing", async () => {
  const routeOptions = {
    resolveActor: () => ({
      actorAccountId: "acct_owner",
      roles: ["owner"],
      scopes: ["forms:read"],
      requestId: "req_fail_closed",
    }),
  } satisfies Partial<RegisterResourceShapeRoutesOptions>;
  const readForm = async (
    app: Awaited<ReturnType<typeof buildApp>>["app"],
  ): Promise<Record<string, unknown>> => {
    const response = await app.request("/v1/form-availability?space=space_1");
    expect(response.status).toBe(200);
    return (await response.json()).forms[0] as Record<string, unknown>;
  };

  const zeroFormHost = await buildApp(routeOptions);
  const exactQuery = new URLSearchParams({
    space: "space_1",
    apiVersion: EXACT_OBJECT_BUCKET_FORM.formRef.apiVersion,
    kind: EXACT_OBJECT_BUCKET_FORM.formRef.kind,
    definitionVersion: EXACT_OBJECT_BUCKET_FORM.formRef.definitionVersion,
    schemaDigest: EXACT_OBJECT_BUCKET_FORM.formRef.schemaDigest,
    packageDigest: EXACT_OBJECT_BUCKET_FORM.packageDigest,
  });
  const zeroFormResponse = await zeroFormHost.app.request(
    `/v1/form-availability?${exactQuery}`,
  );
  expect(zeroFormResponse.status).toBe(200);
  expect((await zeroFormResponse.json()).forms[0]).toMatchObject({
    identity: EXACT_OBJECT_BUCKET_FORM,
    definitionKnown: false,
    installed: false,
    executable: false,
    executableReason: "definition_unknown",
    availableToPrincipal: false,
  });

  const schemaMissing = await buildApp(
    routeOptions,
    exactObjectBucketFormRegistry(),
    { schemaRegistry: EMPTY_RESOURCE_SHAPE_SCHEMA_REGISTRY },
  );
  expect(await readForm(schemaMissing.app)).toMatchObject({
    installed: true,
    executable: false,
    executableReason: "schema_unavailable",
    availableToPrincipal: false,
    availabilityReason: "schema_unavailable",
  });

  const moduleMissing = await buildApp(
    routeOptions,
    exactObjectBucketFormRegistry(),
    { moduleRegistry: new MapResourceShapeModuleRegistry({}) },
  );
  expect(await readForm(moduleMissing.app)).toMatchObject({
    executable: false,
    executableReason: "implementation_unavailable",
    compatibleAdapterIds: [],
    availableToPrincipal: false,
  });

  const packageMismatch = await buildApp(
    routeOptions,
    exactObjectBucketFormRegistry({ packageIncludesDefinition: false }),
  );
  expect(await readForm(packageMismatch.app)).toMatchObject({
    definitionKnown: true,
    installed: false,
    executable: false,
    executableReason: "package_not_installed",
    availableToPrincipal: false,
  });

  const deprecated = await buildApp(
    routeOptions,
    exactObjectBucketFormRegistry({ packageStatus: "deprecated" }),
  );
  expect(await readForm(deprecated.app)).toMatchObject({
    installed: true,
    deprecated: true,
    executable: false,
    executableReason: "package_deprecated",
    availableToPrincipal: false,
  });

  const classMismatch = await buildApp(
    routeOptions,
    exactObjectBucketFormRegistry({
      eligibleTargetPoolClasses: ["private.unavailable"],
    }),
  );
  expect(await readForm(classMismatch.app)).toMatchObject({
    executable: true,
    activated: true,
    availableToPrincipal: false,
    availabilityReason: "target_pool_class_unavailable",
    eligibleTargetPoolClasses: [],
  });
});

test("PUT /v1/resources preserves the caller-declared Resource manager", async () => {
  const { app } = await buildApp();
  const res = await reviewedResourceApply(app, "/v1/resources/KVStore/cache", {
    metadata: {
      space: "space_1",
      managedBy: "compatibility:example",
    },
    spec: { name: "cache", consistency: "eventual" },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.metadata.managedBy).toBe("compatibility:example");
});

test("Resource API atomically rejects managedBy takeover and wrong-manager delete", async () => {
  const { app } = await buildApp();
  const path = "/v1/resources/KVStore/owned-cache";
  const desired = {
    metadata: { space: "space_1", managedBy: "takosumi.resource-api.v1" },
    spec: { name: "owned-cache", consistency: "eventual" },
  };
  expect((await reviewedResourceApply(app, path, desired)).status).toBe(200);

  const takeover = await reviewedResourceApply(app, path, {
    ...desired,
    metadata: {
      space: "space_1",
      managedBy: "compat.example.v1",
    },
  });
  expect(takeover.status).toBe(409);
  expect(await takeover.json()).toMatchObject({
    error: { code: "ownership_conflict" },
  });

  const wrongDelete = await app.request(
    `${path}?space=space_1&managedBy=compat.example.v1`,
    { method: "DELETE" },
  );
  expect(wrongDelete.status).toBe(409);
  expect(await wrongDelete.json()).toMatchObject({
    error: { code: "ownership_conflict" },
  });
  expect(
    (
      await app.request(
        `${path}?space=space_1&managedBy=takosumi.resource-api.v1`,
        { method: "DELETE" },
      )
    ).status,
  ).toBe(204);
});

test("trusted Resource authoring surface rejects caller-controlled managedBy spoofing", async () => {
  const { app } = await buildApp();
  const trustedHeaders = {
    ...JSON_HEADERS,
    [TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER]: "takosumi.resource-api.v1",
  };
  const spoofed = await reviewedResourceApply(
    app,
    "/v1/resources/KVStore/spoofed-cache",
    {
      metadata: {
        space: "space_1",
        managedBy: "compat.example.v1",
      },
      spec: { name: "spoofed-cache", consistency: "eventual" },
    },
    trustedHeaders,
  );
  expect(spoofed.status).toBe(403);

  const created = await reviewedResourceApply(
    app,
    "/v1/resources/KVStore/trusted-cache",
    {
      metadata: { space: "space_1" },
      spec: { name: "trusted-cache", consistency: "eventual" },
    },
    trustedHeaders,
  );
  expect(created.status).toBe(200);
  expect((await created.json()).metadata.managedBy).toBe(
    "takosumi.resource-api.v1",
  );

  const spoofedDelete = await app.request(
    "/v1/resources/KVStore/trusted-cache?space=space_1&managedBy=compat.example.v1",
    {
      method: "DELETE",
      headers: {
        [TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER]:
          "takosumi.resource-api.v1",
      },
    },
  );
  expect(spoofedDelete.status).toBe(403);
});

test("PUT /v1/resources/:kind/:name requires exact preview evidence", async () => {
  const { app } = await buildApp();
  const desired = {
    kind: "EdgeWorker",
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
  };

  const missing = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(desired),
  });
  expect(missing.status).toBe(400);
  expect((await missing.json()).error.message).toContain(
    "deployment review from POST /v1/resources/preview is required",
  );

  const preview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(desired),
  });
  expect(preview.status).toBe(200);
  const evidence = (await preview.json()) as { planDigest: string };

  const changed = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...desired,
      spec: {
        ...desired.spec,
        source: { artifactPath: "/work/dist/worker-v2.js" },
      },
      review: { planDigest: evidence.planDigest },
    }),
  });
  expect(changed.status).toBe(409);
  expect((await changed.json()).error.code).toBe("deployment_plan_changed");
});

test("POST /v1/resources/:kind/:name/observe updates drift conditions through the pinned adapter", async () => {
  const { app } = await buildApp();
  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/assets",
    {
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
  );
  expect(applied.status).toBe(200);

  const observed = await app.request(
    "/v1/resources/ObjectBucket/assets/observe?space=space_1",
    { method: "POST", headers: JSON_HEADERS },
  );
  expect(observed.status).toBe(200);
  const body = await observed.json();
  expect(body.id).toBe("tkrn:space_1:ObjectBucket:assets");
  expect(body.observation.status).toBe("current");
  expect(body.status.conditions).toContainEqual(
    expect.objectContaining({
      type: "Drifted",
      status: "false",
      reason: "BackendInSync",
    }),
  );
});

test("POST /v1/resources/:kind/:name/import adopts an existing native resource with an explicit spec", async () => {
  const { app } = await buildApp();
  const imported = await app.request(
    "/v1/resources/ObjectBucket/assets/import",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        metadata: { space: "space_1" },
        nativeId: "bucket-native-123",
        spec: { name: "assets", interfaces: ["s3_api"] },
      }),
    },
  );
  expect(imported.status).toBe(200);
  const body = await imported.json();
  expect(body.id).toBe("tkrn:space_1:ObjectBucket:assets");
  expect(body.metadata.managedBy).toBe("opentofu");
  expect(body.import.summary).toContain("bucket-native-123");
  expect(body.status).toMatchObject({
    phase: "Ready",
    observedGeneration: 1,
  });
  expect(body.status.conditions).toContainEqual(
    expect.objectContaining({ reason: "Imported", status: "true" }),
  );
});

test("POST /v1/resources/:kind/:name/refresh republishes Resource outputs without changing desired generation", async () => {
  const { app } = await buildApp();
  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/assets",
    {
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
  );
  expect(applied.status).toBe(200);

  const refreshed = await app.request(
    "/v1/resources/ObjectBucket/assets/refresh?space=space_1",
    { method: "POST", headers: JSON_HEADERS },
  );
  expect(refreshed.status).toBe(200);
  const body = await refreshed.json();
  expect(body.id).toBe("tkrn:space_1:ObjectBucket:assets");
  expect(body.refresh.summary).toContain("refreshed");
  expect(body.status.phase).toBe("Ready");
  expect(body.status.observedGeneration).toBe(1);
  expect(body.status.conditions).toContainEqual(
    expect.objectContaining({
      type: "Drifted",
      status: "false",
      reason: "StateRefreshed",
    }),
  );
});

test("TargetPool mutation returns 409 while a ResolutionLock references it", async () => {
  const { app } = await buildApp();
  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
  );
  expect(applied.status).toBe(200);

  const updated = await app.request("/v1/target-pools/default", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        targets: POOL.targets.map((target) => ({
          ...target,
          priority: target.priority + 1,
        })),
      },
    }),
  });
  expect(updated.status).toBe(409);
  expect((await updated.json()).error.code).toBe("target_pool_in_use");

  const deleted = await app.request("/v1/target-pools/default?space=space_1", {
    method: "DELETE",
  });
  expect(deleted.status).toBe(409);
  expect((await deleted.json()).error.code).toBe("target_pool_in_use");
});

test("Resource Shape API returns 404 for an unresolved same-Space connection", async () => {
  const { app, service } = await buildApp();
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "cloudflare-main",
        type: "cloudflare",
        ref: "cf-acct",
        priority: 100,
        implementations: [
          {
            shape: "EdgeWorker",
            implementation: "cloudflare_workers",
            nativeResourceType: "cloudflare_workers_script",
            interfaces: {
              worker_fetch: "native",
              resource_connection: "native",
              runtime_binding: "native",
              grant_read: "native",
            },
          },
        ],
      },
    ],
  });

  const response = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
        connections: {
          ASSETS: {
            resource: "tkrn:space_1:ObjectBucket:missing",
            permissions: ["read"],
            projection: "runtime_binding",
          },
        },
      },
    },
  );

  expect(response.status).toBe(404);
  expect((await response.json()).error.code).toBe("connection_not_found");
});

test("Resource Shape API requires bearer when a token is configured", async () => {
  const { app } = await buildApp({
    getResourceShapeBearerToken: () => "resource-token",
  });

  const unauthenticated = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(unauthenticated.status).toBe(401);

  const wrong = await app.request("/v1/resources?space=space_1", {
    headers: { authorization: "Bearer wrong-token" },
  });
  expect(wrong.status).toBe(401);

  const authorized = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
    AUTH_HEADERS,
  );
  expect(authorized.status).toBe(200);

  const listed = await app.request("/v1/resources?space=space_1", {
    headers: { authorization: "Bearer resource-token" },
  });
  expect(listed.status).toBe(200);
  expect((await listed.json()).resources).toHaveLength(1);
});

test("Resource, TargetPool, and SpacePolicy lists use bounded opaque cursor pagination", async () => {
  const { app, service } = await buildApp();
  const resources = [
    {
      kind: "EdgeWorker",
      name: "api",
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
    {
      kind: "ObjectBucket",
      name: "assets",
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
    {
      kind: "KVStore",
      name: "cache",
      spec: { name: "cache", consistency: "eventual" },
    },
  ] as const;
  for (const resource of resources) {
    const response = await reviewedResourceApply(
      app,
      `/v1/resources/${resource.kind}/${resource.name}`,
      {
        metadata: { space: "space_1" },
        spec: resource.spec,
      },
    );
    expect(response.status).toBe(200);
  }

  const firstResources = await app.request(
    "/v1/resources?space=space_1&limit=2",
  );
  expect(firstResources.status).toBe(200);
  const firstResourcePage = (await firstResources.json()) as {
    resources: readonly { metadata: { name: string } }[];
    nextCursor?: string;
  };
  expect(firstResourcePage.resources).toHaveLength(2);
  expect(firstResourcePage.nextCursor).toBeDefined();

  const secondResources = await app.request(
    `/v1/resources?space=space_1&limit=2&cursor=${encodeURIComponent(firstResourcePage.nextCursor!)}`,
  );
  expect(secondResources.status).toBe(200);
  const secondResourcePage = (await secondResources.json()) as {
    resources: readonly { metadata: { name: string } }[];
    nextCursor?: string;
  };
  expect(secondResourcePage.resources).toHaveLength(1);
  expect(secondResourcePage.nextCursor).toBeUndefined();
  expect(
    [...firstResourcePage.resources, ...secondResourcePage.resources]
      .map((resource) => resource.metadata.name)
      .sort(),
  ).toEqual(["api", "assets", "cache"]);

  await service.putTargetPool("space_1", "secondary", POOL);
  await service.putTargetPool("space_1", "tertiary", POOL);
  const firstPools = await app.request(
    "/v1/target-pools?space=space_1&limit=2",
  );
  expect(firstPools.status).toBe(200);
  const firstPoolPage = (await firstPools.json()) as {
    targetPools: readonly { name: string }[];
    nextCursor?: string;
  };
  expect(firstPoolPage.targetPools).toHaveLength(2);
  expect(firstPoolPage.nextCursor).toBeDefined();
  const secondPools = await app.request(
    `/v1/target-pools?space=space_1&limit=2&cursor=${encodeURIComponent(firstPoolPage.nextCursor!)}`,
  );
  const secondPoolPage = (await secondPools.json()) as {
    targetPools: readonly { name: string }[];
    nextCursor?: string;
  };
  expect(secondPoolPage.targetPools).toHaveLength(1);
  expect(secondPoolPage.nextCursor).toBeUndefined();

  await service.putSpacePolicy("space_1", "secondary", POLICY);
  await service.putSpacePolicy("space_1", "strict", POLICY);
  const firstPolicies = await app.request(
    "/v1/space-policies?space=space_1&limit=2",
  );
  expect(firstPolicies.status).toBe(200);
  const firstPolicyPage = (await firstPolicies.json()) as {
    spacePolicies: readonly { name: string }[];
    nextCursor?: string;
  };
  expect(firstPolicyPage.spacePolicies).toHaveLength(2);
  expect(firstPolicyPage.nextCursor).toBeDefined();
  const secondPolicies = await app.request(
    `/v1/space-policies?space=space_1&limit=2&cursor=${encodeURIComponent(firstPolicyPage.nextCursor!)}`,
  );
  const secondPolicyPage = (await secondPolicies.json()) as {
    spacePolicies: readonly { name: string }[];
    nextCursor?: string;
  };
  expect(secondPolicyPage.spacePolicies).toHaveLength(1);
  expect(secondPolicyPage.nextCursor).toBeUndefined();

  for (const path of [
    "/v1/resources?space=space_1&limit=0",
    "/v1/resources?space=space_1&cursor=not-a-cursor",
    "/v1/target-pools?space=space_1&limit=NaN",
    "/v1/space-policies?space=space_1&cursor=not-a-cursor",
  ]) {
    const rejected = await app.request(path);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("invalid_argument");
  }
});

test("SpacePolicy API supports scoped create, read, list, and idempotent delete", async () => {
  const { app } = await buildApp();
  const put = await app.request("/v1/space-policies/strict", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        deniedTargets: ["public"],
        approvals: { requireForApply: true, requireForDestroy: true },
      },
    }),
  });
  expect(put.status).toBe(200);

  const get = await app.request("/v1/space-policies/strict?space=space_1");
  expect(get.status).toBe(200);
  expect((await get.json()).spec.deniedTargets).toEqual(["public"]);

  const listed = await app.request("/v1/space-policies?space=space_1");
  expect(listed.status).toBe(200);
  expect(
    ((await listed.json()).spacePolicies as readonly { name: string }[]).map(
      (policy) => policy.name,
    ),
  ).toContain("strict");

  expect(
    (
      await app.request("/v1/space-policies/strict?space=space_1", {
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await app.request("/v1/space-policies/strict?space=space_1", {
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
  expect(
    (await app.request("/v1/space-policies/strict?space=space_1")).status,
  ).toBe(404);
});

test("Resource events are target-scoped, cursor-paged, and remain readable after deletion", async () => {
  const { app } = await buildApp();
  for (const resource of [
    {
      kind: "ObjectBucket",
      name: "assets",
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
    {
      kind: "KVStore",
      name: "cache",
      spec: { name: "cache", consistency: "eventual" },
    },
  ] as const) {
    const applied = await reviewedResourceApply(
      app,
      `/v1/resources/${resource.kind}/${resource.name}`,
      {
        metadata: { space: "space_1" },
        spec: resource.spec,
      },
    );
    expect(applied.status).toBe(200);
  }

  const observed = await app.request(
    "/v1/resources/ObjectBucket/assets/observe?space=space_1",
    { method: "POST", headers: JSON_HEADERS },
  );
  expect(observed.status).toBe(200);
  const refreshed = await app.request(
    "/v1/resources/ObjectBucket/assets/refresh?space=space_1",
    { method: "POST", headers: JSON_HEADERS },
  );
  expect(refreshed.status).toBe(200);

  type EventPage = {
    events: Array<{
      id: string;
      space: string;
      resourceId: string;
      action: string;
      metadata: Record<string, unknown>;
      createdAt: string;
    }>;
    nextCursor?: string;
  };
  const allEvents: EventPage["events"] = [];
  let cursor: string | undefined;
  for (;;) {
    const pageResponse = await app.request(
      `/v1/resources/ObjectBucket/assets/events?space=space_1&limit=2${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    expect(pageResponse.status).toBe(200);
    const page = (await pageResponse.json()) as EventPage;
    expect(page.events.length).toBeLessThanOrEqual(2);
    allEvents.push(...page.events);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  expect(allEvents.map((event) => event.action)).toEqual([
    "resource.refresh.succeeded",
    "resource.refresh.started",
    "resource.observe.succeeded",
    "resource.observe.started",
    "resource.apply.succeeded",
    "resource.apply.started",
  ]);
  expect(new Set(allEvents.map((event) => event.id)).size).toBe(
    allEvents.length,
  );
  expect(
    allEvents.every(
      (event) =>
        event.space === "space_1" &&
        event.resourceId === "tkrn:space_1:ObjectBucket:assets",
    ),
  ).toBe(true);
  expect(JSON.stringify(allEvents)).not.toContain("tkrn:space_1:KVStore:cache");
  expect(JSON.stringify(allEvents)).not.toContain("stub://");

  const deleted = await app.request(
    "/v1/resources/ObjectBucket/assets?space=space_1",
    { method: "DELETE", headers: JSON_HEADERS },
  );
  expect(deleted.status).toBe(204);
  const afterDelete = await app.request(
    "/v1/resources/ObjectBucket/assets/events?space=space_1&limit=2",
  );
  expect(afterDelete.status).toBe(200);
  expect(
    ((await afterDelete.json()) as EventPage).events.map(
      (event) => event.action,
    ),
  ).toEqual(["resource.delete.succeeded", "resource.delete.started"]);

  for (const path of [
    "/v1/resources/ObjectBucket/assets/events?space=space_1&limit=0",
    "/v1/resources/ObjectBucket/assets/events?space=space_1&cursor=bad",
  ]) {
    const rejected = await app.request(path);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("invalid_argument");
  }
});

test("Resource Shape routes reject shape kinds outside the host allowlist", async () => {
  const { app } = await buildApp({
    enabledResourceShapeKinds: ["EdgeWorker"],
  });

  const accepted = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
  );
  expect(accepted.status).toBe(200);

  const rejectedPath = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/assets",
    {
      metadata: { space: "space_1" },
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
  );
  expect(rejectedPath.status).toBe(400);
  expect((await rejectedPath.json()).error.message).toContain(
    "resource kind is not enabled: ObjectBucket",
  );

  const rejectedPreview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "Queue",
      metadata: { space: "space_1" },
      spec: { name: "jobs" },
    }),
  });
  expect(rejectedPreview.status).toBe(400);
  expect((await rejectedPreview.json()).error.message).toContain(
    "resource kind is not enabled: Queue",
  );
});

test("disabled creation retains installed state read, events, observe, and delete compatibility", async () => {
  const { app: enabledApp, service } = await buildApp();
  const path = "/v1/resources/ObjectBucket/retained";
  const applied = await reviewedResourceApply(enabledApp, path, {
    metadata: { space: "space_1" },
    spec: { name: "retained", interfaces: ["s3_api"] },
  });
  expect(applied.status).toBe(200);

  const retainedApp = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    resourceShapeRouteOptions: {
      service,
      enabledResourceShapeKinds: [],
      installedResourceShapeKinds:
        LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY.kinds(),
    },
    requestCorrelation: false,
  });

  const rejectedCreate = await retainedApp.request(path, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: { name: "retained", interfaces: ["s3_api"] },
    }),
  });
  expect(rejectedCreate.status).toBe(400);
  expect((await rejectedCreate.json()).error.message).toContain(
    "resource kind is not enabled",
  );

  for (const [requestPath, body] of [
    [
      "/v1/resources/preview",
      {
        kind: "ObjectBucket",
        metadata: { space: "space_1", name: "retained" },
        spec: { name: "retained", interfaces: ["s3_api"] },
      },
    ],
    [
      `${path}/import`,
      {
        metadata: { space: "space_1" },
        nativeId: "retained-native-id",
        spec: { name: "retained", interfaces: ["s3_api"] },
      },
    ],
  ] as const) {
    const rejectedWrite = await retainedApp.request(requestPath, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(rejectedWrite.status).toBe(400);
    expect((await rejectedWrite.json()).error.message).toContain(
      "resource kind is not enabled",
    );
  }

  const rejectedRefresh = await retainedApp.request(
    `${path}/refresh?space=space_1`,
    { method: "POST" },
  );
  expect(rejectedRefresh.status).toBe(400);
  expect((await rejectedRefresh.json()).error.message).toContain(
    "resource kind is not enabled",
  );

  expect((await retainedApp.request(`${path}?space=space_1`)).status).toBe(200);
  expect(
    (await retainedApp.request(`${path}/events?space=space_1`)).status,
  ).toBe(200);
  expect(
    (
      await retainedApp.request(`${path}/observe?space=space_1`, {
        method: "POST",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await retainedApp.request(`${path}?space=space_1`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
});

test("Resource API defaults to zero-form discovery and desired-state authority", async () => {
  const { app } = await buildApp({
    enabledResourceShapeKinds: [],
    installedResourceShapeKinds: [],
  });
  const capabilities = await app.request("/v1/capabilities");
  expect(capabilities.status).toBe(200);
  expect((await capabilities.json()).resources.EdgeWorker).toBe(false);

  const rejected = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(rejected.status).toBe(400);
  expect((await rejected.json()).error.message).toContain(
    "resource kind is not enabled",
  );
});

test("Resource API rejects enabled kinds without installed schema authority", async () => {
  const stores = createInMemoryResourceShapeStores();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    schemaRegistry: EMPTY_RESOURCE_SHAPE_SCHEMA_REGISTRY,
    moduleRegistry: ROUTE_MODULE_REGISTRY,
  });

  await expect(
    createApiApp({
      role: "takosumi-api",
      registerOpenApiRoute: false,
      registerDeployControlInternalRoutes: false,
      resourceShapeRouteOptions: {
        service,
        enabledResourceShapeKinds: ["EdgeWorker"],
        installedResourceShapeKinds: [],
      },
      requestCorrelation: false,
    }),
  ).rejects.toThrow(
    "enabled Resource Shape kind is not backed by an installed compatibility schema: EdgeWorker",
  );
});

test("registered operator shape tokens traverse the API, resolver, and plugin plan", async () => {
  const schemas = new MapResourceShapeSchemaRegistry({
    CacheCluster: (raw) => {
      const candidate = raw as Record<string, unknown>;
      if (typeof candidate?.name !== "string") {
        return {
          ok: false as const,
          error: { code: "invalid_name", message: "name is required" },
        };
      }
      return {
        ok: true as const,
        value: {
          spec: {
            name: candidate.name,
            replicas:
              typeof candidate.replicas === "number" ? candidate.replicas : 1,
          },
          interfaces: ["cache.protocol.v1"],
        },
      };
    },
  });
  const stores = createInMemoryResourceShapeStores();
  const operationRuns = new InMemoryOpenTofuControlStore();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    operationRuns,
    activity: new ActivityService({
      store: operationRuns,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    }),
    schemaRegistry: schemas,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "operator-cache",
        type: "operator.example/cache",
        priority: 100,
        implementations: [
          {
            shape: "CacheCluster",
            implementation: "operator.cache.v1",
            plugin: "operator-cache-plugin",
            nativeResourceType: "operator.cache_cluster",
            interfaces: { "cache.protocol.v1": "native" },
            moduleOutputs: [{ name: "endpoint", type: "url" }],
          },
        ],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    resourceShapeRouteOptions: {
      service,
      enabledResourceShapeKinds: schemas.kinds(),
      installedResourceShapeKinds: schemas.kinds(),
    },
    requestCorrelation: false,
  });

  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/CacheCluster/sessions",
    {
      metadata: { space: "space_1" },
      spec: { name: "sessions", replicas: 3 },
    },
  );
  expect(applied.status).toBe(200);
  expect((await applied.json()).kind).toBe("CacheCluster");

  const capabilities = await app.request("/v1/capabilities");
  expect(capabilities.status).toBe(200);
  const body = await capabilities.json();
  expect(body.resources.CacheCluster).toBe(true);
  expect(body.resources.EdgeWorker).toBe(false);
});

test("bootstrap fails closed when strict runtime exposes Resource Shape API without bearer", async () => {
  const context = createInMemoryAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: { environment: "production" },
      context,
      resourceShapeAdapter: new StubResourceShapeAdapter(),
    }),
  ).rejects.toThrow(
    "production runtime exposes the Resource Shape API but no TAKOSUMI_DEPLOY_CONTROL_TOKEN or scoped Resource Shape actor resolver is configured",
  );
});

test("bootstrap wires Resource Shape API bearer from deploy-control token", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    },
    resourceShapeAdapter: new StubResourceShapeAdapter(),
    resourceShapeSchemaRegistry:
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    enabledResourceShapeKinds: RESOURCE_SHAPE_KINDS,
  });

  const rejected = await app.request("/v1/resources?space=space_1");
  expect(rejected.status).toBe(401);

  const accepted = await app.request("/v1/capabilities");
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).resources.EdgeWorker).toBe(true);
});

test("bootstrap passes Resource Shape delete timeout to the service", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    resourceShapeAdapter: new SlowDeleteAdapter(),
    resourceShapeSchemaRegistry:
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    enabledResourceShapeKinds: RESOURCE_SHAPE_KINDS,
    resourceShapeModuleRegistry: ROUTE_MODULE_REGISTRY,
    resourceShapeDeleteTimeoutMs: 100,
  });

  const pool = await app.request("/v1/target-pools/default", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ space: "space_1", spec: POOL }),
  });
  expect(pool.status).toBe(200);
  const policy = await app.request("/v1/space-policies/default", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ space: "space_1", spec: POLICY }),
  });
  expect(policy.status).toBe(200);

  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/EdgeWorker/api",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    },
  );
  expect(applied.status).toBe(200);

  const deleted = await app.request(
    "/v1/resources/EdgeWorker/api?space=space_1",
    {
      method: "DELETE",
    },
  );
  expect(deleted.status).toBe(204);
});

test("bootstrap projects Resource apply and delete lifecycle into Interfaces", async () => {
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    resourceShapeAdapter: new StubResourceShapeAdapter(),
    resourceShapeSchemaRegistry:
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    enabledResourceShapeKinds: RESOURCE_SHAPE_KINDS,
    resourceShapeModuleRegistry: ROUTE_MODULE_REGISTRY,
    resolveResourceInterfaceWorkspace: async ({
      resourceSpaceId,
      resourceId: id,
    }) =>
      resourceSpaceId === "space_1" && id === "tkrn:space_1:ObjectBucket:assets"
        ? "workspace_1"
        : undefined,
  });
  const resourceId = "tkrn:space_1:ObjectBucket:assets";
  expect(
    (
      await app.request("/v1/target-pools/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POOL }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/v1/space-policies/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POLICY }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await reviewedResourceApply(app, "/v1/resources/ObjectBucket/assets", {
        metadata: { space: "space_1" },
        spec: { name: "assets", interfaces: ["s3_api"] },
      })
    ).status,
  ).toBe(200);

  const iface = await operations.interfaces.create({
    workspaceId: "workspace_1",
    name: "assets-runtime",
    ownerRef: { kind: "Resource", id: resourceId },
    spec: {
      type: "storage.object",
      version: "v1",
      document: { protocol: "https" },
      inputs: {
        bucketName: {
          source: "resource_output",
          resourceId,
          outputName: "bucket_name",
        },
      },
      access: { visibility: "workspace" },
    },
  });
  expect(iface.status.phase).toBe("Resolved");

  const resolved = await operations.interfaces.get(iface.metadata.id);
  expect(resolved.status.phase).toBe("Resolved");
  expect(resolved.status.resolvedInputs?.bucketName).toContain(
    "ObjectBucket:assets",
  );

  expect(
    (
      await app.request("/v1/resources/ObjectBucket/assets?space=space_1", {
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("Retired");
});

test("a required portable Interface that cannot resolve leaves the Form-backed Resource Degraded", async () => {
  const formRegistryStore = new InMemoryFormRegistryStore();
  const installedAt = "2026-01-01T00:00:00.000Z";
  await formRegistryStore.installPackage(
    {
      packageDigest: EXACT_OBJECT_BUCKET_FORM.packageDigest,
      artifactRef: "oci://forms.example/object-bucket@sha256:exact",
      verifierId: "test-verifier",
      status: "installed",
      definitionRefs: [EXACT_OBJECT_BUCKET_FORM.formRef],
      installedAt,
      installedBy: "test",
      updatedAt: installedAt,
    },
    [
      {
        identity: EXACT_OBJECT_BUCKET_FORM,
        displayName: "Object bucket with required Interface",
        operations: ["create", "read", "update", "delete", "import", "refresh"],
        interfaceDescriptors: [
          {
            name: "storage.object",
            version: "1",
            required: true,
            document: { title: "Required storage Interface" },
            inputs: [
              {
                name: "missing",
                source: "output",
                pointer: "/not_published",
              },
            ],
          },
        ],
        installedAt,
      },
    ],
  );
  await formRegistryStore.createActivation({
    id: "activation_required_interface",
    identity: EXACT_OBJECT_BUCKET_FORM,
    scope: { type: "space", id: "space_1" },
    audience: { roles: ["owner"] },
    policy: {},
    eligibleTargetPoolClasses: ["edge.object-store"],
    status: "active",
    revision: 1,
    createdAt: installedAt,
    createdBy: "test",
    updatedAt: installedAt,
    updatedBy: "test",
  });
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    formRegistryStore,
    resourceShapeAdapter: new StubResourceShapeAdapter(),
    resourceShapeSchemaRegistry:
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    enabledResourceShapeKinds: RESOURCE_SHAPE_KINDS,
    resourceShapeModuleRegistry: ROUTE_MODULE_REGISTRY,
    resolveResourceInterfaceWorkspace: async ({ resourceSpaceId }) =>
      resourceSpaceId === "space_1" ? "workspace_1" : undefined,
  });
  expect(
    (
      await app.request("/v1/target-pools/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POOL }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/v1/space-policies/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POLICY }),
      })
    ).status,
  ).toBe(200);

  const applied = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/required-assets",
    {
      metadata: { space: "space_1" },
      form: EXACT_OBJECT_BUCKET_FORM,
      spec: { name: "required-assets", interfaces: ["s3_api"] },
    },
  );
  expect(applied.status).toBe(200);
  const body = await applied.json();
  expect(body.status.phase).toBe("Degraded");
  expect(body.status.conditions).toContainEqual(
    expect.objectContaining({
      type: "Ready",
      status: "false",
      reason: "RequiredInterfaceNotReady",
    }),
  );

  const resourceId = "tkrn:space_1:ObjectBucket:required-assets";
  const materialized = await operations.interfaces.list({
    workspaceId: "workspace_1",
    ownerKind: "Resource",
    ownerId: resourceId,
    includeRetired: false,
  });
  expect(materialized).toHaveLength(1);
  expect(materialized[0]?.status.phase).toBe("Unknown");
  expect(materialized[0]?.metadata.materializedFrom).toMatchObject({
    source: "form_descriptor",
    descriptorName: "storage.object",
    descriptorVersion: "1",
  });

  const portable = await app.request(
    "/apis/forms.takoform.com/v1alpha1/interfaces?space=space_1",
  );
  expect(portable.status).toBe(200);
  expect((await portable.json()).interfaces).toEqual([]);
});

test("bootstrap rejects a required portable Interface before backend work when the Resource Workspace bridge is absent", async () => {
  const formRegistryStore = new InMemoryFormRegistryStore();
  const installedAt = "2026-01-01T00:00:00.000Z";
  await formRegistryStore.installPackage(
    {
      packageDigest: EXACT_OBJECT_BUCKET_FORM.packageDigest,
      artifactRef: "oci://forms.example/object-bucket@sha256:exact",
      verifierId: "test-verifier",
      status: "installed",
      definitionRefs: [EXACT_OBJECT_BUCKET_FORM.formRef],
      installedAt,
      installedBy: "test",
      updatedAt: installedAt,
    },
    [
      {
        identity: EXACT_OBJECT_BUCKET_FORM,
        displayName: "Object bucket with required Interface",
        operations: ["create", "read", "update", "delete"],
        interfaceDescriptors: [
          {
            name: "storage.object",
            version: "v1",
            required: true,
            inputs: [{ name: "protocol", source: "literal", value: "https" }],
          },
        ],
        installedAt,
      },
    ],
  );
  await formRegistryStore.createActivation({
    id: "activation_required_bridge",
    identity: EXACT_OBJECT_BUCKET_FORM,
    scope: { type: "space", id: "space_1" },
    audience: { roles: ["owner"] },
    policy: {},
    eligibleTargetPoolClasses: ["edge.object-store"],
    status: "active",
    revision: 1,
    createdAt: installedAt,
    createdBy: "test",
    updatedAt: installedAt,
    updatedBy: "test",
  });
  const adapter = new CountingPreviewAdapter();
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    formRegistryStore,
    resourceShapeAdapter: adapter,
    resourceShapeSchemaRegistry:
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    enabledResourceShapeKinds: RESOURCE_SHAPE_KINDS,
    resourceShapeModuleRegistry: ROUTE_MODULE_REGISTRY,
  });
  expect(
    (
      await app.request("/v1/target-pools/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POOL }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/v1/space-policies/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POLICY }),
      })
    ).status,
  ).toBe(200);

  const preview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "ObjectBucket",
      metadata: { space: "space_1" },
      form: EXACT_OBJECT_BUCKET_FORM,
      spec: { name: "bridge-less", interfaces: ["s3_api"] },
    }),
  });
  expect(preview.status).toBe(409);
  expect(await preview.json()).toMatchObject({
    error: {
      code: "capability_missing",
      message: expect.stringContaining("Resource-to-Workspace bridge"),
    },
  });
  expect(adapter.previewCalls).toBe(0);
});

test("runtime discovery repairs a missed Resource lifecycle observer from the durable ledger", async () => {
  const baseInterfaceStores = createInMemoryInterfaceStores();
  let rejectLifecycleWrites = false;
  const interfaceStores = {
    persistence: baseInterfaceStores.persistence,
    interfaces: {
      create: (
        record: Parameters<typeof baseInterfaceStores.interfaces.create>[0],
      ) => baseInterfaceStores.interfaces.create(record),
      get: (id: string) => baseInterfaceStores.interfaces.get(id),
      getByName: (
        input: Parameters<typeof baseInterfaceStores.interfaces.getByName>[0],
      ) => baseInterfaceStores.interfaces.getByName(input),
      list: (
        filter: Parameters<typeof baseInterfaceStores.interfaces.list>[0],
      ) => baseInterfaceStores.interfaces.list(filter),
      compareAndSet: (
        record: Parameters<
          typeof baseInterfaceStores.interfaces.compareAndSet
        >[0],
        expected: Parameters<
          typeof baseInterfaceStores.interfaces.compareAndSet
        >[1],
      ) => {
        if (rejectLifecycleWrites) {
          throw new Error("simulated Interface lifecycle persistence outage");
        }
        return baseInterfaceStores.interfaces.compareAndSet(record, expected);
      },
    },
    bindings: baseInterfaceStores.bindings,
  };
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    resourceShapeAdapter: new StubResourceShapeAdapter(),
    resourceShapeSchemaRegistry:
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    enabledResourceShapeKinds: RESOURCE_SHAPE_KINDS,
    resourceShapeModuleRegistry: ROUTE_MODULE_REGISTRY,
    interfaceStores,
    resolveResourceInterfaceWorkspace: async ({ resourceSpaceId }) =>
      resourceSpaceId === "space_1" ? "workspace_1" : undefined,
  });
  const resourceId = "tkrn:space_1:ObjectBucket:assets";
  expect(
    (
      await app.request("/v1/target-pools/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POOL }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/v1/space-policies/default", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ space: "space_1", spec: POLICY }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await reviewedResourceApply(app, "/v1/resources/ObjectBucket/assets", {
        metadata: { space: "space_1" },
        spec: { name: "assets", interfaces: ["s3_api"] },
      })
    ).status,
  ).toBe(200);

  const iface = await operations.interfaces.create({
    workspaceId: "workspace_1",
    name: "repairable-assets-runtime",
    ownerRef: { kind: "Resource", id: resourceId },
    spec: {
      type: "storage.object",
      version: "v1",
      document: { protocol: "https" },
      inputs: {
        bucketName: {
          source: "resource_output",
          resourceId,
          outputName: "bucket_name",
        },
      },
      access: { visibility: "workspace" },
    },
  });
  const binding = await operations.interfaces.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "principal_1" },
    permissions: ["storage.read"],
    delivery: { type: "none" },
  });
  expect(binding.status.phase).toBe("Ready");

  rejectLifecycleWrites = true;
  expect(
    (
      await app.request("/v1/resources/ObjectBucket/assets?space=space_1", {
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("Resolved");

  rejectLifecycleWrites = false;
  expect(
    await operations.interfaces.listAuthorizedForPrincipal(
      { workspaceId: "workspace_1" },
      "principal_1",
      "storage.read",
    ),
  ).toEqual([]);
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("Retired");
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("Revoked");
});

test("PUT /v1/resources/ObjectBucket/:name applies a provider-neutral bucket shape", async () => {
  const { app } = await buildApp();
  const res = await reviewedResourceApply(
    app,
    "/v1/resources/ObjectBucket/assets",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "assets",
        interfaces: ["s3_api", "signed_url"],
      },
    },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe("tkrn:space_1:ObjectBucket:assets");
  expect(body.status.resolution.selectedImplementation).toBe(
    "cloudflare_r2_bucket",
  );
  expect(body.status.outputs.bucket_name).toContain("ObjectBucket:assets");
});

test("PUT /v1/resources/KVStore/:name applies a provider-neutral KV shape", async () => {
  const { app } = await buildApp();
  const res = await reviewedResourceApply(app, "/v1/resources/KVStore/cache", {
    metadata: { space: "space_1" },
    spec: {
      name: "cache",
      consistency: "eventual",
    },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe("tkrn:space_1:KVStore:cache");
  expect(body.status.resolution.selectedImplementation).toBe(
    "cloudflare_kv_namespace",
  );
  expect(body.status.outputs.namespace_id).toContain("KVStore:cache");
});

test("PUT /v1/resources/ContainerService/:name accepts admin-defined implementation capabilities", async () => {
  const { app, service } = await buildApp();
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "containers-main",
        type: "kubernetes",
        ref: "cluster-prod",
        priority: 90,
        implementations: [
          {
            shape: "ContainerService",
            implementation: "custom_container_runtime",
            nativeResourceType: "custom.container_service",
            plugin: "custom-container-plugin",
            interfaces: {
              oci_container: "native",
              public_http: "native",
            },
          },
        ],
      },
    ],
  });
  const res = await reviewedResourceApply(
    app,
    "/v1/resources/ContainerService/agent",
    {
      metadata: { space: "space_1" },
      spec: {
        name: "agent",
        image: "ghcr.io/example/agent:1.0.0",
        publicHttp: true,
      },
    },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status.resolution.selectedImplementation).toBe(
    "custom_container_runtime",
  );
  expect(body.status.resolution.target).toBe("containers-main");
});

test("TargetPool API persists admin-defined capability evidence", async () => {
  const { app } = await buildApp();
  const put = await app.request("/v1/target-pools/containers", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        targets: [
          {
            name: "containers-main",
            type: "kubernetes",
            ref: "cluster-prod",
            priority: 80,
            implementations: [
              {
                shape: "ContainerService",
                implementation: "custom_container_runtime",
                nativeResourceType: "custom.container_service",
                plugin: "custom-container-plugin",
                interfaces: {
                  oci_container: "native",
                  public_http: "shim",
                  "custom.mesh": "native",
                },
              },
            ],
          },
        ],
      },
    }),
  });
  expect(put.status).toBe(200);
  const saved = await put.json();
  expect(saved.id).toBe("tkrn:space_1:TargetPool:containers");

  const get = await app.request("/v1/target-pools/containers?space=space_1");
  expect(get.status).toBe(200);
  const body = await get.json();
  expect(body.spec.targets[0].type).toBe("kubernetes");
  expect(body.spec.targets[0].implementations[0].implementation).toBe(
    "custom_container_runtime",
  );
  expect(
    body.spec.targets[0].implementations[0].interfaces["custom.mesh"],
  ).toBe("native");

  const del = await app.request("/v1/target-pools/containers?space=space_1", {
    method: "DELETE",
  });
  expect(del.status).toBe(204);
  const missing = await app.request(
    "/v1/target-pools/containers?space=space_1",
  );
  expect(missing.status).toBe(404);
});

test("TargetPool PUT If-None-Match star atomically creates and never overwrites", async () => {
  const { app } = await buildApp();
  const url = "/v1/target-pools/create-only";
  const original = {
    space: "space_1",
    spec: {
      targets: [
        {
          name: "operator-main",
          type: "operator",
          priority: 100,
          implementations: [ROUTE_IMPLEMENTATIONS[1]],
        },
      ],
    },
  };
  const created = await app.request(url, {
    method: "PUT",
    headers: { ...JSON_HEADERS, "if-none-match": "*" },
    body: JSON.stringify(original),
  });
  expect(created.status).toBe(201);

  const conflict = await app.request(url, {
    method: "PUT",
    headers: { ...JSON_HEADERS, "if-none-match": "*" },
    body: JSON.stringify({
      ...original,
      spec: {
        targets: original.spec.targets.map((target) => ({
          ...target,
          priority: 1,
        })),
      },
    }),
  });
  expect(conflict.status).toBe(412);
  expect((await conflict.json()).error.code).toBe("target_pool_exists");

  const saved = await app.request(`${url}?space=space_1`);
  expect(saved.status).toBe(200);
  expect((await saved.json()).spec).toEqual(original.spec);

  // No header keeps the existing unconditional, reviewed update behavior.
  const updated = await app.request(url, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...original,
      spec: {
        targets: original.spec.targets.map((target) => ({
          ...target,
          priority: 90,
        })),
      },
    }),
  });
  expect(updated.status).toBe(200);
  expect((await updated.json()).spec.targets[0].priority).toBe(90);
});

test("TargetPool API rejects invalid capability evidence and secret-looking options", async () => {
  const { app } = await buildApp();
  const badShape = await app.request("/v1/target-pools/bad-shape", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        targets: [
          {
            name: "plugin-main",
            type: "kubernetes",
            priority: 80,
            implementations: [
              {
                shape: "AI Gateway",
                implementation: "custom_ai_gateway",
                plugin: "custom-ai-gateway-plugin",
                interfaces: { api: "native" },
              },
            ],
          },
        ],
      },
    }),
  });
  expect(badShape.status).toBe(400);
  expect((await badShape.json()).error.code).toBe("invalid_target_pool");

  const secretOptions = await app.request("/v1/target-pools/secret", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space: "space_1",
      spec: {
        targets: [
          {
            name: "plugin-main",
            type: "kubernetes",
            priority: 80,
            implementations: [
              {
                shape: "ContainerService",
                implementation: "custom_container_runtime",
                plugin: "custom-container-plugin",
                interfaces: { oci_container: "native" },
                options: { clientSecret: "plain-value" },
              },
            ],
          },
        ],
      },
    }),
  });
  expect(secretOptions.status).toBe(400);
  const body = await secretOptions.json();
  expect(body.error.code).toBe("invalid_target_pool");
  expect(body.error.message).toContain("secret-looking");
});

test("GET /v1/resources/EdgeWorker/:name returns the applied resource", async () => {
  const { app } = await buildApp();
  await reviewedResourceApply(app, "/v1/resources/EdgeWorker/api", {
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
  });
  const res = await app.request("/v1/resources/EdgeWorker/api?space=space_1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.metadata.name).toBe("api");
  expect(body.status.resolution.target).toBe("cloudflare-main");
});

test("DELETE /v1/resources/:kind/:name rejects force delete without break-glass hook", async () => {
  const { app } = await buildApp();
  await reviewedResourceApply(app, "/v1/resources/EdgeWorker/api", {
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
  });

  const rejected = await app.request(
    "/v1/resources/EdgeWorker/api?space=space_1&force=true",
    { method: "DELETE" },
  );
  expect(rejected.status).toBe(403);
  expect((await rejected.json()).error.message).toContain(
    "force delete requires operator break-glass authorization",
  );
});

test("DELETE /v1/resources/:kind/:name allows force delete through explicit break-glass hook", async () => {
  const { app } = await buildApp({
    authorizeResourceShapeForceDelete: ({ actor, kind, name, space }) =>
      actor.actorAccountId === "self-host" &&
      space === "space_1" &&
      kind === "EdgeWorker" &&
      name === "api",
  });
  await reviewedResourceApply(app, "/v1/resources/EdgeWorker/api", {
    metadata: { space: "space_1" },
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
  });

  const accepted = await app.request(
    "/v1/resources/EdgeWorker/api?space=space_1&force=true",
    { method: "DELETE" },
  );
  expect(accepted.status).toBe(204);
  const missing = await app.request(
    "/v1/resources/EdgeWorker/api?space=space_1",
  );
  expect(missing.status).toBe(404);
});

test("POST /v1/resources/preview resolves without persisting", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "Queue",
      metadata: { space: "space_1", name: "delivery" },
      spec: {
        name: "delivery",
        delivery: { maxRetries: 5 },
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.selectedImplementation).toBe("cloudflare_queue");
});

test("POST /v1/resources/preview requires an explicit shape kind", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1", name: "api" },
      spec: { name: "api" },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("PUT /v1/resources/:kind/:name rejects body kind mismatch", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind: "ObjectBucket",
      metadata: { space: "space_1" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("PUT /v1/resources/:kind/:name rejects name mismatch", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1", name: "other" },
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("an unregistered Resource Shape kind is not enabled", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/Machine/box", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: { name: "box" },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
});

test("AI Gateway is intentionally not a Resource Shape", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/AIGateway/ai", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      metadata: { space: "space_1" },
      spec: { name: "ai" },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.message).toContain("resource kind is not enabled");

  const caps = await app.request("/v1/capabilities");
  expect(caps.status).toBe(200);
  expect((await caps.json()).resources.AIGateway).toBeUndefined();
});

test("missing space yields a 400 nested error envelope", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/resources/EdgeWorker/api", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      spec: {
        name: "api",
        source: { artifactPath: "/work/dist/worker.js" },
      },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("invalid_argument");
  expect(typeof body.error.requestId).toBe("string");
});

test("GET /v1/capabilities advertises enabled Resource Shapes", async () => {
  const { app } = await buildApp();
  const res = await app.request("/v1/capabilities");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.resources.EdgeWorker).toBe(true);
  expect(body.resources.ObjectBucket).toBe(true);
  expect(body.resources.KVStore).toBe(true);
  expect(body.resources.Queue).toBe(true);
  expect(body.resources.SQLDatabase).toBe(true);
  expect(body.resources.ContainerService).toBe(true);
  expect(body.resources.VectorIndex).toBe(true);
  expect(body.resources.DurableWorkflow).toBe(true);
  expect(body.resources.StatefulActorNamespace).toBe(true);
  expect(body.resources.Schedule).toBe(true);
  expect(body.adapters.opentofu).toBe(true);
  expect(body.adapters.cloudflare).toBeUndefined();
  expect(body.adapters.takosumi_native).toBeUndefined();
  expect(Object.keys(body.resources).sort()).toEqual([
    "ContainerService",
    "DurableWorkflow",
    "EdgeWorker",
    "KVStore",
    "ObjectBucket",
    "Queue",
    "SQLDatabase",
    "Schedule",
    "Stack",
    "StatefulActorNamespace",
    "VectorIndex",
  ]);
});
