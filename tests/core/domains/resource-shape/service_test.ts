import { test, expect } from "bun:test";
import type {
  ActorContext,
  ResourceDeploymentAdmission,
  ResourceDeploymentCaptureContext,
  ResourceDeploymentQuote,
  ResourceDeploymentQuoteContext,
  ResourceDeploymentReleaseContext,
  ResourceDeploymentReserveContext,
  ResourceDeploymentReservationDecision,
  ResourceDeploymentReview,
  ResourceDeploymentSettlementPendingContext,
} from "takosumi-contract";
import {
  type AdapterApplyInput,
  type AdapterDeleteInput,
  type AdapterObserveResult,
  type AdapterPreviewResult,
  type AdapterRefreshResult,
  createInMemoryResourceShapeStores,
  type AdapterApplyResult,
  type AdapterImportInput,
  type AdapterImportResult,
  type ResourceShapeLifecycleEvent,
  type ResourceShapeLifecycleObserver,
  ResourceAdapterApplyError,
  type ResourceShapeStores,
  ResourceShapeService,
  StubResourceShapeAdapter,
} from "../../../../core/domains/resource-shape/mod.ts";
import type { SpacePolicySpec, TargetPoolSpec } from "takosumi-contract";
import { TEST_RESOURCE_SHAPE_MODULE_REGISTRY } from "../../../helpers/resource-shape/operator-module-registry.ts";

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";

const CLOUDFLARE_IMPLEMENTATIONS: NonNullable<
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
      artifactUrl: { source: "spec", path: "/source/artifactUrl" },
      artifactSha256: { source: "spec", path: "/source/artifactSha256" },
      compatibilityDate: { source: "spec", path: "/compatibilityDate" },
      compatibilityFlags: { source: "spec", path: "/compatibilityFlags" },
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
      grant_write: "native",
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
    moduleOutputs: [
      { name: "namespace_id", type: "string" },
      { name: "namespace_title", type: "string" },
    ],
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
    interfaces: {
      queue: "native",
      publish: "native",
      consume: "native",
      cloudevents: "native",
    },
  },
  {
    shape: "SQLDatabase",
    implementation: "cloudflare_d1_database",
    nativeResourceType: "cloudflare.d1_database",
    providerSource: CLOUDFLARE_PROVIDER,
    moduleTemplate: "cloudflare-sql-database",
    moduleInputMappings: {
      databaseName: { source: "spec", path: "/name", required: true },
      accountId: { source: "target", path: "/ref", required: true },
    },
    moduleOutputs: [
      { name: "database_id", type: "string" },
      { name: "database_name", type: "string" },
    ],
    interfaces: {
      sql: "native",
      sqlite: "native",
      postgres: "shim",
      migrations: "native",
    },
  },
  {
    shape: "ContainerService",
    implementation: "cloudflare_container",
    nativeResourceType: "cloudflare.container",
    plugin: "cloudflare-container-plugin",
    moduleOutputs: [
      { name: "service_name", type: "string" },
      { name: "url", type: "url" },
      { name: "connections", type: "json" },
    ],
    interfaces: {
      oci_container: "native",
      public_http: "native",
      env_projection: "native",
    },
  },
];

const ACTOR: ActorContext = {
  actorAccountId: "acc_1",
  roles: [],
  requestId: "req_1",
};

const NOW = "2026-01-01T00:00:00.000Z";

function makeService() {
  const stores = createInMemoryResourceShapeStores();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  return { stores, service };
}

class PluginSpyAdapter extends StubResourceShapeAdapter {
  previewInputs: AdapterApplyInput[] = [];
  applyInputs: AdapterApplyInput[] = [];
  deleteInputs: AdapterDeleteInput[] = [];
  observeInputs: AdapterApplyInput[] = [];
  refreshInputs: AdapterApplyInput[] = [];
  importInputs: AdapterImportInput[] = [];

  override async preview(
    input: AdapterApplyInput,
  ): Promise<AdapterPreviewResult> {
    this.previewInputs.push(input);
    return super.preview(input);
  }

  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    return super.apply(input);
  }

  override async importResource(
    input: AdapterImportInput,
  ): Promise<AdapterImportResult> {
    this.importInputs.push(input);
    return await super.importResource(input);
  }

  override async delete(input: AdapterDeleteInput): Promise<void> {
    this.deleteInputs.push(input);
    return super.delete(input);
  }

  override async observe(
    input: AdapterApplyInput,
  ): Promise<AdapterObserveResult> {
    this.observeInputs.push(input);
    return super.observe(input);
  }

  override async refresh(
    input: AdapterApplyInput,
  ): Promise<AdapterRefreshResult> {
    this.refreshInputs.push(input);
    return super.refresh(input);
  }
}

class DriftedObserveAdapter extends PluginSpyAdapter {
  override async observe(
    input: AdapterApplyInput,
  ): Promise<AdapterObserveResult> {
    this.observeInputs.push(input);
    return {
      status: "drifted",
      summary: "one native resource changed outside Takosumi",
      runId: "plan_drift_1",
    };
  }
}

class FailingObserveAdapter extends PluginSpyAdapter {
  override async observe(
    input: AdapterApplyInput,
  ): Promise<AdapterObserveResult> {
    this.observeInputs.push(input);
    throw new Error("simulated observation failure");
  }
}

class RefreshingAdapter extends DriftedObserveAdapter {
  override async refresh(
    input: AdapterApplyInput,
  ): Promise<AdapterRefreshResult> {
    this.refreshInputs.push(input);
    return {
      summary: "state and outputs refreshed without provider mutation",
      runId: "apply_refresh_1",
      nativeResources: [{ type: "cloudflare_r2_bucket", id: "backend-assets" }],
      outputs: {
        bucket_name: "assets-renamed-remotely",
        s3_endpoint: "https://s3.refreshed.example.test",
      },
      execution: {
        runId: "apply_refresh_1",
        stateGeneration: input.stateGeneration + 1,
        stateRef: "resource-state://assets/refresh/1",
        stateDigest: `sha256:${"d".repeat(64)}`,
        updatedAt: NOW,
      },
    };
  }
}

class FailingRefreshAdapter extends PluginSpyAdapter {
  override async refresh(
    input: AdapterApplyInput,
  ): Promise<AdapterRefreshResult> {
    this.refreshInputs.push(input);
    throw new Error("simulated refresh failure");
  }
}

class ImportingAdapter extends PluginSpyAdapter {
  override async importResource(
    input: AdapterImportInput,
  ): Promise<AdapterImportResult> {
    this.importInputs.push(input);
    return {
      summary: `imported ${input.nativeId}`,
      runId: "apply_import_1",
      nativeResources: [{ type: "cloudflare_r2_bucket", id: input.nativeId }],
      outputs: {
        bucket_name: "existing-assets",
        s3_endpoint: "https://existing.example.test",
      },
      execution: {
        runId: "apply_import_1",
        stateGeneration: 1,
        stateRef: "resource-state://assets/import/1",
        stateDigest: `sha256:${"a".repeat(64)}`,
        updatedAt: NOW,
      },
    };
  }
}

class FailingImportAdapter extends PluginSpyAdapter {
  override async importResource(
    input: AdapterImportInput,
  ): Promise<AdapterImportResult> {
    this.importInputs.push(input);
    throw new Error("existing resource does not match desired spec");
  }
}

class NativeIdEchoFailingImportAdapter extends PluginSpyAdapter {
  override async importResource(
    input: AdapterImportInput,
  ): Promise<AdapterImportResult> {
    this.importInputs.push(input);
    throw new Error(`provider resource ${input.nativeId} was rejected`);
  }
}

class SlowRefreshAdapter extends RefreshingAdapter {
  readonly started: Promise<void>;
  #startRefresh!: () => void;
  #finishRefresh!: () => void;
  #finishRefreshPromise: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#startRefresh = resolve;
    });
    this.#finishRefreshPromise = new Promise((resolve) => {
      this.#finishRefresh = resolve;
    });
  }

  finishRefresh(): void {
    this.#finishRefresh();
  }

  override async refresh(
    input: AdapterApplyInput,
  ): Promise<AdapterRefreshResult> {
    this.#startRefresh();
    await this.#finishRefreshPromise;
    return await super.refresh(input);
  }
}

class SlowObserveAdapter extends PluginSpyAdapter {
  readonly started: Promise<void>;
  #startObserve!: () => void;
  #finishObserve!: () => void;
  #finishObservePromise: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#startObserve = resolve;
    });
    this.#finishObservePromise = new Promise((resolve) => {
      this.#finishObserve = resolve;
    });
  }

  finishObserve(): void {
    this.#finishObserve();
  }

  override async observe(
    input: AdapterApplyInput,
  ): Promise<AdapterObserveResult> {
    this.observeInputs.push(input);
    this.#startObserve();
    await this.#finishObservePromise;
    return { status: "current", summary: "backend is current" };
  }
}

class FailingApplyAdapter extends PluginSpyAdapter {
  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    throw new ResourceAdapterApplyError("simulated apply failure", {
      mutationOutcome: "none",
    });
  }
}

class UnknownOutcomeApplyAdapter extends PluginSpyAdapter {
  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    throw new Error("simulated transport timeout");
  }
}

class SlowApplyAdapter extends PluginSpyAdapter {
  readonly started: Promise<void>;
  #startApply!: () => void;
  #finishApply!: () => void;
  #finishApplyPromise: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#startApply = resolve;
    });
    this.#finishApplyPromise = new Promise((resolve) => {
      this.#finishApply = resolve;
    });
  }

  finishApply(): void {
    this.#finishApply();
  }

  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    this.#startApply();
    await this.#finishApplyPromise;
    return await new StubResourceShapeAdapter().apply(input);
  }
}

class AdoptionCompletingAdapter extends PluginSpyAdapter {
  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    const result = await new StubResourceShapeAdapter().apply(input);
    return {
      ...result,
      execution: {
        runId: "run_resource_apply_8",
        stateGeneration: 8,
        stateRef:
          "workspaces/space_1/resources/tkrn_space_1_ObjectBucket_assets/environments/default/state-versions/00000008.tfstate.enc",
        stateDigest: `sha256:${"c".repeat(64)}`,
        updatedAt: NOW,
      },
    };
  }
}

class FailingDeleteAdapter extends PluginSpyAdapter {
  override async delete(input: AdapterDeleteInput): Promise<void> {
    this.deleteInputs.push(input);
    throw new Error("simulated delete failure");
  }
}

class ConcurrentlyChangedFailingDeleteAdapter extends PluginSpyAdapter {
  constructor(private readonly stores: ResourceShapeStores) {
    super();
  }

  override async delete(input: AdapterDeleteInput): Promise<void> {
    this.deleteInputs.push(input);
    const current = await this.stores.resources.get(input.resourceId);
    if (!current) throw new Error("expected claimed Resource");
    await this.stores.resources.upsert({
      ...current,
      phase: "Ready",
      conditions: [],
      updatedAt: "2026-01-01T00:00:00.001Z",
    });
    throw new Error("simulated delete failure after concurrent change");
  }
}

class SlowDeleteAdapter extends PluginSpyAdapter {
  readonly started: Promise<void>;
  #startDelete!: () => void;
  #finishDelete!: () => void;
  #finishDeletePromise: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#startDelete = resolve;
    });
    this.#finishDeletePromise = new Promise((resolve) => {
      this.#finishDelete = resolve;
    });
  }

  finishDelete(): void {
    this.#finishDelete();
  }

  override async delete(input: AdapterDeleteInput): Promise<void> {
    this.deleteInputs.push(input);
    this.#startDelete();
    await this.#finishDeletePromise;
  }
}

class LifecycleSpy implements ResourceShapeLifecycleObserver {
  readonly events: ResourceShapeLifecycleEvent[] = [];

  observe(event: ResourceShapeLifecycleEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

class RecordingDeploymentAdmission implements ResourceDeploymentAdmission {
  readonly quoteContexts: ResourceDeploymentQuoteContext[] = [];
  readonly reserveContexts: ResourceDeploymentReserveContext[] = [];
  readonly captureContexts: ResourceDeploymentCaptureContext[] = [];
  readonly settlementPendingContexts: ResourceDeploymentSettlementPendingContext[] =
    [];
  readonly releaseContexts: ResourceDeploymentReleaseContext[] = [];
  lastQuote: ResourceDeploymentQuote | undefined;
  failCapture = false;
  failSettlementPending = false;
  reserveReasons: readonly string[] = [];
  quoteFactory:
    | ((context: ResourceDeploymentQuoteContext) => ResourceDeploymentQuote)
    | undefined;

  async quote(
    context: ResourceDeploymentQuoteContext,
  ): Promise<ResourceDeploymentQuote> {
    this.quoteContexts.push(context);
    const quote = this.quoteFactory?.(context) ?? ratedQuote(context);
    this.lastQuote = quote;
    return quote;
  }

  async reserve(
    context: ResourceDeploymentReserveContext,
  ): Promise<ResourceDeploymentReservationDecision> {
    this.reserveContexts.push(context);
    if (this.reserveReasons.length > 0) {
      return { reasons: this.reserveReasons };
    }
    if (
      !this.lastQuote ||
      context.review.quoteId !== this.lastQuote.quoteId ||
      context.review.quoteDigest !== this.lastQuote.quoteDigest
    ) {
      return { reasons: ["quote review mismatch"] };
    }
    return { reasons: [], reservationId: "reservation_1" };
  }

  async capture(context: ResourceDeploymentCaptureContext): Promise<void> {
    this.captureContexts.push(context);
    if (this.failCapture) throw new Error("simulated capture outage");
  }

  async markSettlementPending(
    context: ResourceDeploymentSettlementPendingContext,
  ): Promise<void> {
    this.settlementPendingContexts.push(context);
    if (this.failSettlementPending) {
      throw new Error("simulated settlement-pending ledger outage");
    }
  }

  async release(context: ResourceDeploymentReleaseContext): Promise<void> {
    this.releaseContexts.push(context);
  }
}

function ratedQuote(
  context: ResourceDeploymentQuoteContext,
): ResourceDeploymentQuote {
  return {
    quoteId: "quote_1",
    quoteDigest: `sha256:${"a".repeat(64)}`,
    planDigest: context.planDigest,
    specDigest: context.specDigest,
    resolutionFingerprint: context.resolutionFingerprint,
    ratingStatus: "rated",
    currency: "USD",
    catalogId: "cloud-standard",
    catalogVersion: "2026-07-14",
    offeringId: "object-bucket.standard",
    offeringVersion: "1",
    region: "global",
    lineItems: [
      {
        sku: "object-bucket.deploy",
        skuVersion: "1",
        chargeKind: "one_time",
        unit: "deployment",
        quantity: 1,
        unitPriceUsdMicros: 100_000,
        amountUsdMicros: 100_000,
      },
    ],
    estimatedTotalUsdMicros: 100_000,
    expiresAt: "2026-01-01T00:05:00.000Z",
  };
}

const POOL: TargetPoolSpec = {
  targets: [
    {
      name: "cloudflare-main",
      type: "cloudflare",
      ref: "cf-acct",
      priority: 80,
      implementations: CLOUDFLARE_IMPLEMENTATIONS,
    },
    {
      name: "k8s-main",
      type: "kubernetes",
      ref: "cluster-prod",
      priority: 70,
      implementations: [
        {
          shape: "ContainerService",
          implementation: "kubernetes_deployment",
          nativeResourceType: "kubernetes_deployment",
          plugin: "kubernetes-container-plugin",
          moduleOutputs: [
            { name: "service_name", type: "string" },
            { name: "url", type: "url" },
            { name: "connections", type: "json" },
          ],
          interfaces: {
            oci_container: "native",
            public_http: "shim",
            env_projection: "native",
          },
        },
      ],
    },
  ],
};

const POLICY: SpacePolicySpec = {
  resolution: { lockAfterCreate: true, allowAutoMigration: false },
};

const PROVIDER_COMPAT_BASE_URL =
  "https://app.takosumi.com/compat/cloudflare/client/v4";

async function seed(service: ResourceShapeService, policy = POLICY) {
  await service.putTargetPool("space_1", "default", POOL);
  await service.putSpacePolicy("space_1", "default", policy);
}

async function reviewedApply(
  service: ResourceShapeService,
  request: Parameters<ResourceShapeService["apply"]>[0],
) {
  const preview = await service.preview(request);
  if (!preview.ok) return preview;
  const review: ResourceDeploymentReview = {
    planDigest: preview.value.planDigest,
    ...(preview.value.quote
      ? {
          quoteId: preview.value.quote.quoteId,
          quoteDigest: preview.value.quote.quoteDigest,
        }
      : {}),
  };
  return service.apply(request, review);
}

const APPLY = {
  actor: ACTOR,
  space: "space_1",
  kind: "ObjectBucket" as const,
  name: "assets",
  spec: {
    name: "assets",
    interfaces: ["s3_api"],
  },
};
const APPLY_ID = "tkrn:space_1:ObjectBucket:assets";

test("apply resolves ObjectBucket to the highest-priority target and locks it", async () => {
  const { service } = makeService();
  await seed(service);

  const result = await reviewedApply(service, APPLY);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const status = result.value.status;
  expect(status?.phase).toBe("Ready");
  expect(status?.resolution?.selectedImplementation).toBe(
    "cloudflare_r2_bucket",
  );
  expect(status?.resolution?.target).toBe("cloudflare-main");
  expect(status?.resolution?.locked).toBe(true);
  expect(status?.observedGeneration).toBe(1);
  expect(status?.outputs?.bucket_name).toContain("ObjectBucket:assets");
});

test("rated preview binds offering and catalog versions and captures only after Ready", async () => {
  const stores = createInMemoryResourceShapeStores();
  const admission = new RecordingDeploymentAdmission();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const preview = await service.preview(APPLY);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  expect(preview.value.quote).toMatchObject({
    offeringId: "object-bucket.standard",
    offeringVersion: "1",
    catalogId: "cloud-standard",
    catalogVersion: "2026-07-14",
  });

  const applied = await service.apply(APPLY, {
    planDigest: preview.value.planDigest,
    quoteId: preview.value.quote?.quoteId,
    quoteDigest: preview.value.quote?.quoteDigest,
  });
  expect(applied.ok).toBe(true);
  expect(admission.reserveContexts).toHaveLength(1);
  expect(admission.captureContexts).toHaveLength(1);
  expect(admission.releaseContexts).toHaveLength(0);
  expect(admission.settlementPendingContexts).toHaveLength(0);
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Ready");
});

test("service apply cannot bypass preview review evidence", async () => {
  const { service } = makeService();
  await seed(service);

  const applied = await service.apply(
    APPLY,
    undefined as unknown as ResourceDeploymentReview,
  );
  expect(applied).toEqual({
    ok: false,
    error: {
      code: "deployment_review_required",
      message: "deployment apply requires preview review evidence",
    },
  });
});

test("stale reviewed plans fail before reservation or backend work", async () => {
  const stores = createInMemoryResourceShapeStores();
  const admission = new RecordingDeploymentAdmission();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  const preview = await service.preview(APPLY);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;

  const applied = await service.apply(
    { ...APPLY, labels: { release: "changed-after-preview" } },
    {
      planDigest: preview.value.planDigest,
      quoteId: preview.value.quote?.quoteId,
      quoteDigest: preview.value.quote?.quoteDigest,
    },
  );
  expect(applied.ok).toBe(false);
  if (!applied.ok) expect(applied.error.code).toBe("deployment_plan_changed");
  expect(admission.reserveContexts).toHaveLength(0);
  expect(adapter.applyInputs).toHaveLength(0);
});

test("concurrent apply loses the Resource claim before creating a second reservation", async () => {
  const stores = createInMemoryResourceShapeStores();
  const admission = new RecordingDeploymentAdmission();
  const adapter = new SlowApplyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  const preview = await service.preview(APPLY);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  const review = {
    planDigest: preview.value.planDigest,
    quoteId: preview.value.quote?.quoteId,
    quoteDigest: preview.value.quote?.quoteDigest,
  };

  const first = service.apply(APPLY, review);
  await adapter.started;
  const second = await service.apply(APPLY, review);
  expect(second.ok).toBe(false);
  if (!second.ok) {
    expect(second.error.code).toBe("deployment_finalize_pending");
  }
  expect(admission.reserveContexts).toHaveLength(1);
  expect(adapter.applyInputs).toHaveLength(1);

  adapter.finishApply();
  expect((await first).ok).toBe(true);
  expect(admission.captureContexts).toHaveLength(1);
  expect(admission.releaseContexts).toHaveLength(0);
});

test("admission denial rolls back the claimed Resource before backend work", async () => {
  const stores = createInMemoryResourceShapeStores();
  const admission = new RecordingDeploymentAdmission();
  admission.reserveReasons = ["payment method required"];
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const denied = await reviewedApply(service, APPLY);
  expect(denied.ok).toBe(false);
  if (!denied.ok) {
    expect(denied.error.code).toBe("deployment_admission_denied");
  }
  expect(admission.reserveContexts).toHaveLength(1);
  expect(adapter.applyInputs).toHaveLength(0);
  expect(await stores.resources.get(APPLY_ID)).toBeUndefined();
  expect(await stores.locks.get(APPLY_ID)).toBeUndefined();
});

test("atomic apply claim failure stops before reservation and adapter dispatch", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  const stores = {
    ...baseStores,
    async beginApply(): ReturnType<typeof baseStores.beginApply> {
      throw new Error("simulated atomic apply claim outage");
    },
  };
  const admission = new RecordingDeploymentAdmission();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const applied = await reviewedApply(service, APPLY);
  expect(applied.ok).toBe(false);
  if (!applied.ok) expect(applied.error.code).toBe("apply_failed");
  expect(admission.reserveContexts).toHaveLength(0);
  expect(admission.releaseContexts).toHaveLength(0);
  expect(adapter.applyInputs).toHaveLength(0);
  expect(await stores.resources.get(APPLY_ID)).toBeUndefined();
  expect(await stores.locks.get(APPLY_ID)).toBeUndefined();
});

test("a proven no-mutation adapter failure releases exactly once", async () => {
  const stores = createInMemoryResourceShapeStores();
  const admission = new RecordingDeploymentAdmission();
  const service = new ResourceShapeService({
    stores,
    adapter: new FailingApplyAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const applied = await reviewedApply(service, APPLY);
  expect(applied.ok).toBe(false);
  if (!applied.ok) expect(applied.error.code).toBe("apply_failed");
  expect(admission.reserveContexts).toHaveLength(1);
  expect(admission.releaseContexts).toHaveLength(1);
  expect(admission.captureContexts).toHaveLength(0);
  expect(admission.settlementPendingContexts).toHaveLength(0);
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Failed");
  expect(await stores.locks.get(APPLY_ID)).toBeUndefined();
});

test("an unknown adapter outcome keeps reservation and retries the same generation", async () => {
  const stores = createInMemoryResourceShapeStores();
  const admission = new RecordingDeploymentAdmission();
  const uncertainService = new ResourceShapeService({
    stores,
    adapter: new UnknownOutcomeApplyAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(uncertainService);

  const uncertain = await reviewedApply(uncertainService, APPLY);
  expect(uncertain.ok).toBe(false);
  if (!uncertain.ok) {
    expect(uncertain.error.code).toBe("deployment_finalize_pending");
  }
  expect(admission.releaseContexts).toHaveLength(0);
  expect(admission.settlementPendingContexts).toContainEqual(
    expect.objectContaining({
      backendOutcome: "unknown",
      reason: "backend_outcome_unknown",
    }),
  );
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Applying");
  expect((await stores.resources.get(APPLY_ID))?.generation).toBe(1);

  const recoveryAdapter = new RefreshingAdapter();
  const recoveryService = new ResourceShapeService({
    stores,
    adapter: recoveryAdapter,
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  const recoveryPreview = await recoveryService.preview(APPLY);
  expect(recoveryPreview.ok).toBe(true);
  if (!recoveryPreview.ok) return;
  const recovered = await recoveryService.recoverApply(APPLY, {
    planDigest: recoveryPreview.value.planDigest,
    quoteId: recoveryPreview.value.quote?.quoteId,
    quoteDigest: recoveryPreview.value.quote?.quoteDigest,
  });
  expect(recovered.ok).toBe(true);
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Ready");
  expect((await stores.resources.get(APPLY_ID))?.generation).toBe(1);
  expect(admission.captureContexts).toHaveLength(1);
  expect(admission.releaseContexts).toHaveLength(0);
  expect(recoveryAdapter.applyInputs).toHaveLength(0);
  expect(recoveryAdapter.refreshInputs).toHaveLength(1);
});

test("reserved state remains the recovery authority when pending annotation fails", async () => {
  const stores = createInMemoryResourceShapeStores();
  const admission = new RecordingDeploymentAdmission();
  admission.failSettlementPending = true;
  const service = new ResourceShapeService({
    stores,
    adapter: new UnknownOutcomeApplyAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const pending = await reviewedApply(service, APPLY);
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("deployment_finalize_pending");
  }
  expect(admission.reserveContexts).toHaveLength(1);
  expect(admission.settlementPendingContexts).toHaveLength(1);
  expect(admission.releaseContexts).toHaveLength(0);
  expect(admission.captureContexts).toHaveLength(0);
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Applying");
});

test("post-backend persistence failure remains Applying and settlement-pending", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  let failReadyWrite = true;
  const stores = {
    ...baseStores,
    async commitApply(
      input: Parameters<typeof baseStores.commitApply>[0],
    ): ReturnType<typeof baseStores.commitApply> {
      if (failReadyWrite) {
        throw new Error("simulated atomic Ready persistence outage");
      }
      return await baseStores.commitApply(input);
    },
  };
  const admission = new RecordingDeploymentAdmission();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const pending = await reviewedApply(service, APPLY);
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("deployment_finalize_pending");
  }
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Applying");
  expect(admission.releaseContexts).toHaveLength(0);
  expect(admission.captureContexts).toHaveLength(0);
  expect(admission.settlementPendingContexts).toContainEqual(
    expect.objectContaining({
      backendOutcome: "succeeded",
      reason: "resource_finalize_failed",
    }),
  );

  failReadyWrite = false;
  const recoveryPreview = await service.preview(APPLY);
  expect(recoveryPreview.ok).toBe(true);
  if (!recoveryPreview.ok) return;
  const recovered = await service.recoverApply(APPLY, {
    planDigest: recoveryPreview.value.planDigest,
    quoteId: recoveryPreview.value.quote?.quoteId,
    quoteDigest: recoveryPreview.value.quote?.quoteDigest,
  });
  expect(recovered.ok).toBe(true);
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Ready");
  expect((await stores.resources.get(APPLY_ID))?.generation).toBe(1);
});

test("capture failure leaves a Ready Resource and durable settlement-pending request", async () => {
  const stores = createInMemoryResourceShapeStores();
  const admission = new RecordingDeploymentAdmission();
  admission.failCapture = true;
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const applied = await reviewedApply(service, APPLY);
  expect(applied.ok).toBe(false);
  if (!applied.ok) {
    expect(applied.error.code).toBe("deployment_billing_finalize_failed");
  }
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Ready");
  expect(admission.releaseContexts).toHaveLength(0);
  expect(admission.settlementPendingContexts).toContainEqual(
    expect.objectContaining({
      backendOutcome: "succeeded",
      reason: "billing_capture_failed",
    }),
  );
});

test("rated quote without an offering version fails closed", async () => {
  const stores = createInMemoryResourceShapeStores();
  const admission = new RecordingDeploymentAdmission();
  admission.quoteFactory = (context) => {
    const { offeringVersion: _offeringVersion, ...quote } = ratedQuote(context);
    return quote;
  };
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const preview = await service.preview(APPLY);
  expect(preview.ok).toBe(false);
  if (!preview.ok) {
    expect(preview.error.code).toBe("deployment_quote_invalid");
    expect(preview.error.message).toContain("offering identity");
  }
});

test("import adopts existing backend identity into Resource-owned state and outputs", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new ImportingAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const result = await service.importResource({
    ...APPLY,
    nativeId: "bucket-backend-123",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.import).toEqual({
    summary: "imported bucket-backend-123",
    runId: "apply_import_1",
  });
  expect(result.value.resource.status).toMatchObject({
    phase: "Ready",
    observedGeneration: 1,
    outputs: { bucket_name: "existing-assets" },
  });
  expect(result.value.resource.status?.conditions).toContainEqual(
    expect.objectContaining({ reason: "Imported", status: "true" }),
  );
  expect((await stores.locks.get(APPLY_ID))?.nativeResources).toEqual([
    { type: "cloudflare_r2_bucket", id: "bucket-backend-123" },
  ]);

  const conflict = await service.importResource({
    ...APPLY,
    nativeId: "bucket-backend-456",
  });
  expect(conflict).toEqual({
    ok: false,
    error: {
      code: "import_conflict",
      message: `resource ${APPLY_ID} already exists`,
    },
  });
  expect(adapter.importInputs).toHaveLength(1);
});

test("import finalization retries only the exact request without exposing nativeId in conditions", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  let failCommit = true;
  const stores: ResourceShapeStores = {
    ...baseStores,
    async commitApply(input) {
      if (failCommit) {
        throw new Error("simulated atomic import finalization outage");
      }
      return await baseStores.commitApply(input);
    },
  };
  const adapter = new ImportingAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  const request = {
    ...APPLY,
    nativeId: "sensitive-provider-id-123",
  } as const;

  const pending = await service.importResource(request);
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("import_failed");
    expect(pending.error.message).toContain("finalization is pending");
  }
  const applying = await stores.resources.get(APPLY_ID);
  expect(applying?.phase).toBe("Applying");
  expect(JSON.stringify(applying?.conditions)).not.toContain(request.nativeId);
  expect(JSON.stringify(applying?.conditions)).toMatch(
    /import-request:sha256:[0-9a-f]{64}/u,
  );
  expect(await stores.locks.get(APPLY_ID)).toBeDefined();

  const differentNativeId = await service.importResource({
    ...request,
    nativeId: "different-provider-id-456",
  });
  expect(differentNativeId).toEqual({
    ok: false,
    error: {
      code: "import_conflict",
      message: `resource ${APPLY_ID} already exists`,
    },
  });
  expect(adapter.importInputs).toHaveLength(1);

  failCommit = false;
  const recovered = await service.importResource(request);
  expect(recovered.ok).toBe(true);
  expect(adapter.importInputs).toHaveLength(2);
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Ready");
  expect((await stores.locks.get(APPLY_ID))?.nativeResources).toEqual([
    { type: "cloudflare_r2_bucket", id: request.nativeId },
  ]);
});

test("failed import remains a ledger-only removable record", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new FailingImportAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const result = await service.importResource({
    ...APPLY,
    nativeId: "bucket-backend-123",
  });
  expect(result).toEqual({
    ok: false,
    error: {
      code: "import_failed",
      message: "existing resource does not match desired spec",
    },
  });
  expect(await stores.resources.get(APPLY_ID)).toMatchObject({
    phase: "Failed",
    managedBy: "import-pending",
    observedGeneration: 0,
  });

  expect(
    (await service.delete("space_1", "ObjectBucket", "assets", ACTOR)).ok,
  ).toBe(true);
  expect(await stores.resources.get(APPLY_ID)).toBeUndefined();
  expect(adapter.deleteInputs).toHaveLength(0);
});

test("failed import conditions redact the provider-native identity", async () => {
  const stores = createInMemoryResourceShapeStores();
  const service = new ResourceShapeService({
    stores,
    adapter: new NativeIdEchoFailingImportAdapter(),
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  const nativeId = "sensitive-provider-id-789";

  expect(
    (
      await service.importResource({
        ...APPLY,
        nativeId,
      })
    ).ok,
  ).toBe(false);
  const failed = await stores.resources.get(APPLY_ID);
  expect(JSON.stringify(failed?.conditions)).not.toContain(nativeId);
  expect(failed?.conditions?.[0]?.message).toBe(
    "provider resource [provider-native-id] was rejected",
  );
});

test("observe uses the pinned backend and records a Drifted condition without changing the revision", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new DriftedObserveAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const observed = await service.observe(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(observed.ok).toBe(true);
  if (!observed.ok) return;
  expect(observed.value.observation).toEqual({
    status: "drifted",
    summary: "one native resource changed outside Takosumi",
    runId: "plan_drift_1",
  });
  expect(observed.value.resource.status?.phase).toBe("Ready");
  expect(observed.value.resource.status?.observedGeneration).toBe(1);
  expect(observed.value.resource.status?.conditions).toContainEqual(
    expect.objectContaining({
      type: "Drifted",
      status: "true",
      reason: "BackendDriftDetected",
    }),
  );
  expect(adapter.observeInputs[0]?.implementation.implementation).toBe(
    "cloudflare_r2_bucket",
  );
  expect(adapter.observeInputs[0]?.target.name).toBe("cloudflare-main");
});

test("observe CAS fence cannot overwrite a concurrent apply", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new SlowObserveAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const observing = service.observe("space_1", "ObjectBucket", "assets", ACTOR);
  await adapter.started;
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);
  adapter.finishObserve();

  const observed = await observing;
  expect(observed).toEqual({
    ok: false,
    error: {
      code: "reconcile_conflict",
      message:
        "resource tkrn:space_1:ObjectBucket:assets changed while backend observation was running",
    },
  });
  expect(
    (await stores.resources.get("tkrn:space_1:ObjectBucket:assets"))
      ?.generation,
  ).toBe(2);
});

test("observe failure retains the pinned Ready revision and records an inconclusive condition", async () => {
  const stores = createInMemoryResourceShapeStores();
  const service = new ResourceShapeService({
    stores,
    adapter: new FailingObserveAdapter(),
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const observed = await service.observe(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(observed).toEqual({
    ok: false,
    error: {
      code: "observe_failed",
      message: "simulated observation failure",
    },
  });
  const retained = await service.get("space_1", "ObjectBucket", "assets");
  expect(retained.ok).toBe(true);
  if (!retained.ok) return;
  expect(retained.value.status?.phase).toBe("Ready");
  expect(retained.value.status?.outputs?.bucket_name).toContain(
    "ObjectBucket:assets",
  );
  expect(retained.value.status?.conditions).toContainEqual(
    expect.objectContaining({
      type: "Reconciling",
      status: "unknown",
      reason: "ObservationFailed",
    }),
  );
});

test("refresh publishes new state and outputs through the pinned backend without changing desired generation", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new RefreshingAdapter();
  const lifecycle = new LifecycleSpy();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    lifecycleObserver: lifecycle,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);
  expect(
    (await service.observe("space_1", "ObjectBucket", "assets", ACTOR)).ok,
  ).toBe(true);

  const refreshed = await service.refresh(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(refreshed.ok).toBe(true);
  if (!refreshed.ok) return;
  expect(refreshed.value.refresh).toEqual({
    summary: "state and outputs refreshed without provider mutation",
    runId: "apply_refresh_1",
  });
  expect(refreshed.value.resource.status?.phase).toBe("Ready");
  expect(refreshed.value.resource.status?.observedGeneration).toBe(1);
  expect(refreshed.value.resource.status?.outputs).toEqual({
    bucket_name: "assets-renamed-remotely",
    s3_endpoint: "https://s3.refreshed.example.test",
  });
  expect(refreshed.value.resource.status?.conditions).toContainEqual(
    expect.objectContaining({
      type: "Drifted",
      status: "false",
      reason: "StateRefreshed",
    }),
  );
  expect(adapter.refreshInputs[0]?.implementation.implementation).toBe(
    "cloudflare_r2_bucket",
  );
  expect(adapter.refreshInputs[0]?.target.name).toBe("cloudflare-main");
  const refreshedRecord = await stores.resources.get(APPLY_ID);
  expect(refreshedRecord?.generation).toBe(1);
  expect(refreshedRecord?.execution).toMatchObject({
    runId: "apply_refresh_1",
    stateGeneration: 1,
  });
  expect((await stores.locks.get(APPLY_ID))?.nativeResources).toEqual([
    { type: "cloudflare_r2_bucket", id: "backend-assets" },
  ]);
  expect(lifecycle.events.at(-1)).toEqual({
    type: "ready",
    spaceId: "space_1",
    resourceId: APPLY_ID,
  });
});

test("refresh failure durably fences Interfaces as Unknown while retaining the last successful outputs", async () => {
  const stores = createInMemoryResourceShapeStores();
  const initial = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(initial);
  expect((await reviewedApply(initial, APPLY)).ok).toBe(true);
  const before = await stores.resources.get(APPLY_ID);
  const lifecycle = new LifecycleSpy();
  const service = new ResourceShapeService({
    stores,
    adapter: new FailingRefreshAdapter(),
    now: () => NOW,
    lifecycleObserver: lifecycle,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });

  const refreshed = await service.refresh(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(refreshed).toEqual({
    ok: false,
    error: {
      code: "refresh_failed",
      message: "simulated refresh failure",
    },
  });
  const retained = await stores.resources.get(APPLY_ID);
  expect(retained?.phase).toBe("Failed");
  expect(retained?.generation).toBe(1);
  expect(retained?.observedGeneration).toBe(1);
  expect(retained?.outputs).toEqual(before?.outputs);
  expect(retained?.conditions).toContainEqual(
    expect.objectContaining({
      type: "Ready",
      status: "unknown",
      reason: "RefreshFailed",
    }),
  );
  expect(lifecycle.events).toEqual([
    {
      type: "unknown",
      spaceId: "space_1",
      resourceId: APPLY_ID,
      operation: "refresh",
    },
  ]);
});

test("refresh CAS fence never resurrects a force-tombstoned Resource", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new SlowRefreshAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const refreshing = service.refresh(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  await adapter.started;
  const normalDelete = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(normalDelete).toEqual({
    ok: false,
    error: {
      code: "delete_blocked",
      message: `resource ${APPLY_ID} is currently applying or refreshing`,
    },
  });
  expect(
    (
      await service.delete("space_1", "ObjectBucket", "assets", ACTOR, {
        force: true,
      })
    ).ok,
  ).toBe(true);
  adapter.finishRefresh();
  expect(await refreshing).toEqual({
    ok: false,
    error: { code: "not_found", message: `resource ${APPLY_ID} not found` },
  });
  expect(await stores.resources.get(APPLY_ID)).toBeUndefined();
  expect(await stores.locks.get(APPLY_ID)).toBeUndefined();
});

test("confirmed legacy state adoption is dispatched at its generation and consumed only by successful Resource apply", async () => {
  const stores = createInMemoryResourceShapeStores();
  const initialService = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(initialService);
  expect((await reviewedApply(initialService, APPLY)).ok).toBe(true);
  const resourceId = "tkrn:space_1:ObjectBucket:assets";
  const current = (await stores.resources.get(resourceId))!;
  const stateAdoption = {
    kind: "legacy_backing_capsule_state" as const,
    sourceWorkspaceId: "space_1",
    sourceCapsuleId: "cap_legacy_resource_assets",
    sourceEnvironment: "resource-shape",
    sourceStateVersionId: "state_legacy_7",
    stateGeneration: 7,
    stateRef:
      "spaces/space_1/installations/cap_legacy_resource_assets/envs/resource-shape/states/00000007.tfstate.enc",
    stateDigest: `sha256:${"a".repeat(64)}`,
    confirmedBy: "operator_1",
    confirmedAt: NOW,
  };
  await stores.resources.upsert({ ...current, stateAdoption });

  const adapter = new AdoptionCompletingAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  const preview = await service.preview(APPLY);
  expect(preview.ok).toBe(true);
  expect(adapter.previewInputs[0]?.stateGeneration).toBe(7);
  expect(adapter.previewInputs[0]?.stateAdoption).toEqual(stateAdoption);
  expect((await stores.resources.get(resourceId))?.stateAdoption).toEqual(
    stateAdoption,
  );

  const applied = await reviewedApply(service, APPLY);
  expect(applied.ok).toBe(true);
  expect(adapter.applyInputs[0]?.stateGeneration).toBe(7);
  expect(adapter.applyInputs[0]?.stateAdoption).toEqual(stateAdoption);
  const migrated = await stores.resources.get(resourceId);
  expect(migrated?.execution?.stateGeneration).toBe(8);
  expect(migrated?.stateAdoption).toBeUndefined();
});

test("Resource lifecycle observer sees durable Ready, Unknown, Terminating, and Retired transitions", async () => {
  const successObserver = new LifecycleSpy();
  const successService = new ResourceShapeService({
    stores: createInMemoryResourceShapeStores(),
    adapter: new StubResourceShapeAdapter(),
    now: () => NOW,
    lifecycleObserver: successObserver,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(successService);
  expect((await reviewedApply(successService, APPLY)).ok).toBe(true);
  expect(
    (await successService.delete("space_1", "ObjectBucket", "assets", ACTOR))
      .ok,
  ).toBe(true);
  expect(successObserver.events.map((event) => event.type)).toEqual([
    "ready",
    "terminating",
    "retired",
  ]);

  const applyFailureObserver = new LifecycleSpy();
  const applyFailureService = new ResourceShapeService({
    stores: createInMemoryResourceShapeStores(),
    adapter: new FailingApplyAdapter(),
    now: () => NOW,
    lifecycleObserver: applyFailureObserver,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(applyFailureService);
  expect((await reviewedApply(applyFailureService, APPLY)).ok).toBe(false);
  expect(applyFailureObserver.events).toEqual([
    {
      type: "unknown",
      spaceId: "space_1",
      resourceId: "tkrn:space_1:ObjectBucket:assets",
      operation: "apply",
    },
  ]);

  const deleteFailureObserver = new LifecycleSpy();
  const deleteFailureService = new ResourceShapeService({
    stores: createInMemoryResourceShapeStores(),
    adapter: new FailingDeleteAdapter(),
    now: () => NOW,
    lifecycleObserver: deleteFailureObserver,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(deleteFailureService);
  expect((await reviewedApply(deleteFailureService, APPLY)).ok).toBe(true);
  expect(
    (
      await deleteFailureService.delete(
        "space_1",
        "ObjectBucket",
        "assets",
        ACTOR,
      )
    ).ok,
  ).toBe(false);
  expect(deleteFailureObserver.events.map((event) => event.type)).toEqual([
    "ready",
    "terminating",
    "unknown",
  ]);
  expect(deleteFailureObserver.events.at(-1)).toMatchObject({
    type: "unknown",
    operation: "delete",
  });
});

test("apply resolves EdgeWorker as a first-class shape", async () => {
  const { service } = makeService();
  await seed(service);

  const result = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker",
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.kind).toBe("EdgeWorker");
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_workers",
  );
  expect(result.value.status?.resolution?.target).toBe("cloudflare-main");
});

test("EdgeWorker connections resolve Ready resources before preview and apply", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const bucket = await reviewedApply(service, APPLY);
  expect(bucket.ok).toBe(true);

  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker" as const,
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
      connections: {
        ASSETS: {
          resource: "tkrn:space_1:ObjectBucket:assets",
          permissions: ["read", "write"] as const,
          projection: "runtime_binding" as const,
        },
      },
    },
  };

  const preview = await service.preview(request);
  expect(preview.ok).toBe(true);
  const previewConnection =
    adapter.previewInputs.at(-1)?.resolvedConnections?.ASSETS;
  expect(previewConnection).toMatchObject({
    resourceId: "tkrn:space_1:ObjectBucket:assets",
    kind: "ObjectBucket",
    permissions: ["read", "write"],
    projection: "runtime_binding",
    target: "cloudflare-main",
  });
  expect(previewConnection?.nativeResources).not.toHaveLength(0);
  expect(typeof previewConnection?.outputs.bucket_name).toBe("string");

  const applied = await reviewedApply(service, request);
  expect(applied.ok).toBe(true);
  expect(adapter.applyInputs.at(-1)?.resolvedConnections?.ASSETS).toEqual(
    previewConnection,
  );
});

test("connection references fail closed when missing, cross-Space, or not Ready", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const edgeRequest = (resource: string) => ({
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker" as const,
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      connections: {
        ASSETS: {
          resource,
          permissions: ["read"] as const,
          projection: "runtime_binding" as const,
        },
      },
    },
  });

  const missing = await reviewedApply(
    service,
    edgeRequest("tkrn:space_1:ObjectBucket:missing"),
  );
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.code).toBe("connection_not_found");
  expect(adapter.applyInputs).toHaveLength(0);

  await service.putTargetPool("space_2", "default", POOL);
  await service.putSpacePolicy("space_2", "default", POLICY);
  const crossSpaceBucket = await reviewedApply(service, {
    ...APPLY,
    space: "space_2",
  });
  expect(crossSpaceBucket.ok).toBe(true);
  const crossSpace = await reviewedApply(
    service,
    edgeRequest("tkrn:space_2:ObjectBucket:assets"),
  );
  expect(crossSpace.ok).toBe(false);
  if (!crossSpace.ok)
    expect(crossSpace.error.code).toBe("connection_not_found");

  await stores.resources.upsert({
    id: "tkrn:space_1:ObjectBucket:pending",
    spaceId: "space_1",
    kind: "ObjectBucket",
    name: "pending",
    managedBy: "opentofu",
    spec: { name: "pending" },
    phase: "Applying",
    generation: 1,
    observedGeneration: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const pending = await reviewedApply(
    service,
    edgeRequest("tkrn:space_1:ObjectBucket:pending"),
  );
  expect(pending.ok).toBe(false);
  if (!pending.ok) expect(pending.error.code).toBe("connection_not_ready");
});

test("referenced resources cannot be deleted before their consumers", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  expect((await reviewedApply(service, APPLY)).ok).toBe(true);
  expect(
    (
      await reviewedApply(service, {
        actor: ACTOR,
        space: "space_1",
        kind: "EdgeWorker",
        name: "api",
        spec: {
          name: "api",
          source: { artifactPath: "/work/dist/worker.js" },
          connections: {
            ASSETS: {
              resource: "tkrn:space_1:ObjectBucket:assets",
              permissions: ["read", "write"],
              projection: "runtime_binding",
            },
          },
        },
      })
    ).ok,
  ).toBe(true);

  const blocked = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) {
    expect(blocked.error.code).toBe("delete_blocked");
    expect(blocked.error.message).toContain("tkrn:space_1:EdgeWorker:api");
  }
  expect(adapter.deleteInputs).toHaveLength(0);

  expect((await service.delete("space_1", "EdgeWorker", "api", ACTOR)).ok).toBe(
    true,
  );
  expect(
    (await service.delete("space_1", "ObjectBucket", "assets", ACTOR)).ok,
  ).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(2);
});

test("Resource connections reject dependency cycles on update", async () => {
  const { service } = makeService();
  await seed(service);

  const edgeRequest = (
    name: string,
    connection?: { name: string; resource: string },
  ) => ({
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker" as const,
    name,
    spec: {
      name,
      source: { artifactPath: `/work/dist/${name}.js` },
      ...(connection
        ? {
            connections: {
              [connection.name]: {
                resource: connection.resource,
                permissions: ["read"] as const,
                projection: "runtime_binding" as const,
              },
            },
          }
        : {}),
    },
  });

  expect((await reviewedApply(service, edgeRequest("first"))).ok).toBe(true);
  expect(
    (
      await reviewedApply(
        service,
        edgeRequest("second", {
          name: "FIRST",
          resource: "tkrn:space_1:EdgeWorker:first",
        }),
      )
    ).ok,
  ).toBe(true);

  const cycle = await reviewedApply(
    service,
    edgeRequest("first", {
      name: "SECOND",
      resource: "tkrn:space_1:EdgeWorker:second",
    }),
  );
  expect(cycle.ok).toBe(false);
  if (!cycle.ok) {
    expect(cycle.error.code).toBe("invalid_connections");
    expect(cycle.error.message).toContain("dependency cycle");
  }
});

test("apply resolves Queue and SQLDatabase as concrete Cloudflare-backed shapes", async () => {
  const { service } = makeService();
  await seed(service);

  const queue = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "Queue",
    name: "delivery",
    spec: { name: "delivery", delivery: { maxRetries: 5 } },
  });
  expect(queue.ok).toBe(true);
  if (!queue.ok) return;
  expect(queue.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_queue",
  );

  const db = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "SQLDatabase",
    name: "main",
    spec: { name: "main", engine: "sqlite", migrationsPath: "migrations" },
  });
  expect(db.ok).toBe(true);
  if (!db.ok) return;
  expect(db.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_d1_database",
  );
});

test("apply resolves ContainerService with admin-declared implementation", async () => {
  const { service } = makeService();
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "custom-main",
        type: "kubernetes",
        ref: "cluster-prod",
        priority: 90,
        implementations: [
          {
            shape: "ContainerService",
            implementation: "custom_container_runtime",
            nativeResourceType: "custom.container_service",
            plugin: "custom-container-plugin",
            moduleOutputs: [{ name: "service_name", type: "string" }],
            interfaces: {
              oci_container: "native",
              public_http: "native",
            },
          },
        ],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const result = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent",
    spec: {
      name: "agent",
      image: "ghcr.io/example/agent:1.0.0",
      publicHttp: true,
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "custom_container_runtime",
  );
  expect(result.value.status?.resolution?.target).toBe("custom-main");
  expect(result.value.status?.outputs?.service_name).toContain(
    "ContainerService:agent",
  );
});

test("an explicit plugin descriptor is dispatched to an injected test adapter", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await seed(service);

  const result = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent",
    spec: { name: "agent", image: "ghcr.io/example/agent:1.0.0" },
  });
  expect(result.ok).toBe(true);
  expect(adapter.applyInputs).toHaveLength(1);
  expect(adapter.applyInputs[0]?.implementation.plugin).toBe(
    "cloudflare-container-plugin",
  );
});

test("apply passes selected implementation plugin metadata to the adapter", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    allowedProviderBaseUrls: [PROVIDER_COMPAT_BASE_URL],
  });
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "custom-main",
        type: "kubernetes",
        ref: "cluster-prod",
        priority: 90,
        implementations: [
          {
            shape: "ContainerService",
            implementation: "custom_container_runtime",
            nativeResourceType: "custom.container_service",
            plugin: "takosumi-container-plugin",
            options: { runtimeClass: "edge", timeoutMs: 30000 },
            interfaces: {
              oci_container: "native",
            },
          },
        ],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const result = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent",
    spec: { name: "agent", image: "ghcr.io/example/agent:1.0.0" },
  });
  expect(result.ok).toBe(true);
  expect(adapter.applyInputs).toHaveLength(1);
  expect(adapter.applyInputs[0]?.implementation.plugin).toBe(
    "takosumi-container-plugin",
  );
  expect(adapter.applyInputs[0]?.implementation.options).toEqual({
    runtimeClass: "edge",
    timeoutMs: 30000,
  });
  expect(adapter.applyInputs[0]?.plan.validatedSpec).toEqual({
    name: "agent",
    image: "ghcr.io/example/agent:1.0.0",
  });
});

test("plugin-backed EdgeWorker dispatches before first-party lookup with the full validated spec", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "edge-main",
        type: "custom-edge",
        priority: 90,
        implementations: [
          {
            shape: "EdgeWorker",
            implementation: "custom_edge_runtime",
            plugin: "custom-edge-plugin",
            interfaces: {
              worker_fetch: "native",
              "runtime.custom": "native",
            },
          },
        ],
      },
    ],
  });

  const result = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker",
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["runtime.custom"],
      compatibilityDate: "2026-07-13",
      compatibilityFlags: ["nodejs_compat"],
    },
  });

  expect(result.ok).toBe(true);
  expect(adapter.applyInputs[0]?.implementation.plugin).toBe(
    "custom-edge-plugin",
  );
  expect(adapter.applyInputs[0]?.plan.executionId).toBe(
    "adapter-plugin:custom-edge-plugin",
  );
  expect(adapter.applyInputs[0]?.plan.validatedSpec).toEqual({
    name: "api",
    source: { artifactPath: "/work/dist/worker.js" },
    compatibilityDate: "2026-07-13",
    compatibilityFlags: ["nodejs_compat"],
    profiles: ["runtime.custom"],
  });
});

test("apply and delete pass allowlisted provider transport without a plugin", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    allowedProviderBaseUrls: [PROVIDER_COMPAT_BASE_URL],
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "cloud-managed-edge",
        type: "cloudflare",
        ref: "ts_virtual_account",
        credentialRef: "conn_takosumi_cloud_edge",
        priority: 90,
        implementations: [
          {
            shape: "EdgeWorker",
            implementation: "cloudflare_workers",
            providerSource: CLOUDFLARE_PROVIDER,
            moduleTemplate: "cloudflare-worker-service",
            providerConfig: { base_url: PROVIDER_COMPAT_BASE_URL },
            moduleInputMappings: {
              appName: { source: "spec", path: "/name", required: true },
              accountId: { source: "target", path: "/ref", required: true },
              artifactPath: {
                source: "spec",
                path: "/source/artifactPath",
              },
            },
            moduleOutputs: [{ name: "worker_name", type: "string" }],
            interfaces: {
              worker_fetch: "native",
              workers_bindings: "native",
            },
          },
        ],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const created = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker",
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
      profiles: ["workers_bindings"],
    },
  });
  expect(created.ok).toBe(true);
  expect(adapter.applyInputs[0]?.implementation.providerConfig).toEqual({
    base_url: PROVIDER_COMPAT_BASE_URL,
  });
  expect(adapter.applyInputs[0]?.implementation.plugin).toBeUndefined();

  const deleted = await service.delete("space_1", "EdgeWorker", "api", ACTOR);
  expect(deleted.ok).toBe(true);
  expect(adapter.deleteInputs[0]?.implementation.providerConfig).toEqual({
    base_url: PROVIDER_COMPAT_BASE_URL,
  });
  expect(adapter.deleteInputs[0]?.implementation.plugin).toBeUndefined();
  expect(adapter.deleteInputs[0]?.credentialRef).toBe(
    "conn_takosumi_cloud_edge",
  );
});

test("apply passes TargetPool credentialRef separately from target ref", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await service.putTargetPool("space_1", "default", {
    targets: [
      {
        name: "cloudflare-main",
        type: "cloudflare",
        ref: "cf-account-id",
        credentialRef: "conn_cf_main",
        priority: 90,
        implementations: [CLOUDFLARE_IMPLEMENTATIONS[0]!],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const result = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "EdgeWorker",
    name: "api",
    spec: {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
  });

  expect(result.ok).toBe(true);
  expect(adapter.applyInputs).toHaveLength(1);
  expect(adapter.applyInputs[0]?.target.ref).toBe("cf-account-id");
  expect(adapter.applyInputs[0]?.credentialRef).toBe("conn_cf_main");
});

test("putTargetPool rejects malformed capability evidence and secret-like options", async () => {
  const { service } = makeService();

  const empty = await service.putTargetPool("space_1", "empty", {
    targets: [],
  });
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error.code).toBe("invalid_target_pool");

  const badShape = await service.putTargetPool("space_1", "bad-shape", {
    targets: [
      {
        name: "plugin-main",
        type: "kubernetes",
        priority: 90,
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
  } as TargetPoolSpec);
  expect(badShape.ok).toBe(false);
  if (!badShape.ok) expect(badShape.error.code).toBe("invalid_target_pool");

  const secretOptions = await service.putTargetPool("space_1", "secret", {
    targets: [
      {
        name: "plugin-main",
        type: "kubernetes",
        priority: 90,
        implementations: [
          {
            shape: "ContainerService",
            implementation: "custom_container_runtime",
            plugin: "test-container-plugin",
            interfaces: { oci_container: "native" },
            options: { apiToken: "sk-secret-should-not-live-here" },
          },
        ],
      },
    ],
  });
  expect(secretOptions.ok).toBe(false);
  if (!secretOptions.ok)
    expect(secretOptions.error.message).toContain("secret-looking");

  const invalidImportAddress = await service.putTargetPool(
    "space_1",
    "invalid-import-address",
    {
      targets: [
        {
          name: "cloudflare-main",
          type: "cloudflare",
          priority: 90,
          implementations: [
            {
              ...CLOUDFLARE_IMPLEMENTATIONS[1]!,
              moduleImportAddress: "module.child.cloud_bucket.this",
            },
          ],
        },
      ],
    },
  );
  expect(invalidImportAddress.ok).toBe(false);
  if (!invalidImportAddress.ok) {
    expect(invalidImportAddress.error.message).toContain("moduleImportAddress");
  }

  const pluginImportAddress = await service.putTargetPool(
    "space_1",
    "plugin-import-address",
    {
      targets: [
        {
          name: "plugin-main",
          type: "cloudflare",
          priority: 90,
          implementations: [
            {
              shape: "ObjectBucket",
              implementation: "managed_bucket",
              plugin: "managed-bucket-plugin",
              moduleImportAddress: "cloudflare_r2_bucket.this",
              interfaces: { object_store: "native" },
            },
          ],
        },
      ],
    },
  );
  expect(pluginImportAddress.ok).toBe(false);
  if (!pluginImportAddress.ok) {
    expect(pluginImportAddress.error.message).toContain(
      "plugin execution cannot declare moduleImportAddress",
    );
  }

  const opaqueProviderConfig = await service.putTargetPool(
    "space_1",
    "opaque-provider-config",
    {
      targets: [
        {
          name: "plugin-main",
          type: "cloudflare",
          priority: 90,
          implementations: [
            {
              ...CLOUDFLARE_IMPLEMENTATIONS[0]!,
              providerConfig: {
                base_url: "not-a-url",
                callback_uri: "runtime-local-alias",
              },
            },
          ],
        },
      ],
    },
  );
  expect(opaqueProviderConfig.ok).toBe(true);

  const unallowedProviderBaseUrl = await service.putTargetPool(
    "space_1",
    "unallowed-provider-base-url",
    {
      targets: [
        {
          name: "plugin-main",
          type: "cloudflare",
          priority: 90,
          implementations: [
            {
              ...CLOUDFLARE_IMPLEMENTATIONS[0]!,
              providerConfig: { base_url: PROVIDER_COMPAT_BASE_URL },
            },
          ],
        },
      ],
    },
  );
  expect(unallowedProviderBaseUrl.ok).toBe(false);
  if (!unallowedProviderBaseUrl.ok) {
    expect(unallowedProviderBaseUrl.error.message).toContain("base_url URL");
  }

  const serviceWithAllowlist = new ResourceShapeService({
    stores: createInMemoryResourceShapeStores(),
    adapter: new StubResourceShapeAdapter(),
    now: () => NOW,
    allowedProviderBaseUrls: [PROVIDER_COMPAT_BASE_URL],
  });
  const allowlistedProviderBaseUrl = await serviceWithAllowlist.putTargetPool(
    "space_1",
    "allowlisted-provider-base-url",
    {
      targets: [
        {
          name: "plugin-main",
          type: "cloudflare",
          priority: 90,
          implementations: [
            {
              ...CLOUDFLARE_IMPLEMENTATIONS[0]!,
              providerConfig: { base_url: PROVIDER_COMPAT_BASE_URL },
            },
          ],
        },
      ],
    },
  );
  expect(allowlistedProviderBaseUrl.ok).toBe(true);
});

test("delete resolves native target from the non-default TargetPool that created the lock", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
  });
  await service.putTargetPool("space_1", "storage", {
    targets: [
      {
        name: "native-main",
        type: "takosumi_native",
        ref: "native-prod",
        credentialRef: "conn_native",
        priority: 90,
        implementations: [
          {
            shape: "ObjectBucket",
            implementation: "takosumi_object_bucket",
            nativeResourceType: "takosumi_object_bucket",
            plugin: "native-object-store-plugin",
            interfaces: {
              object_store: "native",
              s3_api: "native",
            },
          },
        ],
      },
    ],
  });
  await service.putSpacePolicy("space_1", "default", POLICY);

  const created = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "ObjectBucket",
    name: "assets",
    targetPoolName: "storage",
    spec: {
      name: "assets",
      interfaces: ["s3_api"],
    },
  });
  expect(created.ok).toBe(true);

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(1);
  expect(adapter.deleteInputs[0]?.target.name).toBe("native-main");
  expect(adapter.deleteInputs[0]?.credentialRef).toBe("conn_native");
  expect(adapter.deleteInputs[0]?.plan?.executionId).toBe(
    "adapter-plugin:native-object-store-plugin",
  );
  expect(adapter.deleteInputs[0]?.plan?.inputs).toEqual({});
  expect(adapter.deleteInputs[0]?.nativeResources).toEqual([
    { type: "takosumi_object_bucket", id: "assets" },
  ]);
});

test("referenced TargetPool updates and deletes are rejected until the Resource is removed", async () => {
  const { service } = makeService();
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  // Provider refreshes may replay the identical declaration without creating
  // drift or forcing a migration.
  expect((await service.putTargetPool("space_1", "default", POOL)).ok).toBe(
    true,
  );

  const updated = await service.putTargetPool("space_1", "default", {
    ...POOL,
    targets: POOL.targets.map((target) => ({
      ...target,
      priority: target.priority + 1,
    })),
  });
  expect(updated.ok).toBe(false);
  if (!updated.ok) expect(updated.error.code).toBe("target_pool_in_use");

  const deleted = await service.deleteTargetPool("space_1", "default");
  expect(deleted.ok).toBe(false);
  if (!deleted.ok) expect(deleted.error.code).toBe("target_pool_in_use");
  expect(await service.getTargetPool("space_1", "default")).toBeDefined();

  expect(
    (await service.delete("space_1", "ObjectBucket", "assets", ACTOR)).ok,
  ).toBe(true);
  expect((await service.deleteTargetPool("space_1", "default")).ok).toBe(true);
});

test("re-apply dispatches the pinned Target snapshot, plugin, and options even if storage drifts", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  const originalSpec: TargetPoolSpec = {
    targets: [
      {
        name: "native-main",
        type: "takosumi_native",
        ref: "target-v1",
        priority: 90,
        implementations: [
          {
            shape: "ObjectBucket",
            implementation: "custom_object_bucket",
            plugin: "plugin-v1",
            options: { revision: 1 },
            interfaces: { object_store: "native", s3_api: "native" },
          },
        ],
      },
    ],
  };
  await service.putTargetPool("space_1", "default", originalSpec);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const pool = await stores.targetPools.getByName("space_1", "default");
  if (!pool) throw new Error("expected TargetPool");
  await stores.targetPools.upsert({
    ...pool,
    spec: {
      targets: [
        {
          ...originalSpec.targets[0],
          ref: "target-v2",
          implementations: [
            {
              ...originalSpec.targets[0]!.implementations![0]!,
              plugin: "plugin-v2",
              options: { revision: 2 },
            },
          ],
        },
      ],
    },
  });

  const rePreview = await service.preview(APPLY);
  expect(rePreview.ok).toBe(true);
  if (!rePreview.ok) return;
  const repeatedPreview = await service.preview(APPLY);
  expect(repeatedPreview.ok).toBe(true);
  if (!repeatedPreview.ok) return;
  expect(repeatedPreview.value.planDigest).toBe(rePreview.value.planDigest);
  const reapplied = await service.apply(APPLY, {
    planDigest: rePreview.value.planDigest,
  });
  expect(reapplied).toMatchObject({ ok: true });
  expect(adapter.applyInputs).toHaveLength(2);
  expect(adapter.applyInputs[1]?.target.ref).toBe("target-v1");
  expect(adapter.applyInputs[1]?.implementation.plugin).toBe("plugin-v1");
  expect(adapter.applyInputs[1]?.implementation.options).toEqual({
    revision: 1,
  });
});

test("delete does not call the backend or erase the ledger when a legacy lock Target is unknown", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const resourceId = "tkrn:space_1:ObjectBucket:assets";
  const lock = await stores.locks.get(resourceId);
  const pool = await stores.targetPools.getByName("space_1", "default");
  if (!lock || !pool) throw new Error("expected lock and TargetPool");
  await stores.locks.put({
    resourceId: lock.resourceId,
    selectedImplementation: lock.selectedImplementation,
    target: "missing-target",
    locked: true,
    reason: lock.reason,
    portability: lock.portability,
    nativeResources: lock.nativeResources,
    lockedAt: lock.lockedAt,
    updatedAt: lock.updatedAt,
  });
  await stores.targetPools.delete(pool.id);

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(false);
  if (!deleted.ok) expect(deleted.error.code).toBe("delete_blocked");
  expect(adapter.deleteInputs).toHaveLength(0);
  expect(await stores.resources.get(resourceId)).toBeDefined();
  expect(await stores.locks.get(resourceId)).toBeDefined();
});

test("concurrent delete retries replay the idempotent backend and finalize once", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new SlowDeleteAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const created = await reviewedApply(service, APPLY);
  expect(created.ok).toBe(true);

  const firstDelete = service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  await adapter.started;

  const deleting = await service.get("space_1", "ObjectBucket", "assets");
  expect(deleting.ok).toBe(true);
  if (deleting.ok) expect(deleting.value.status?.phase).toBe("Deleting");

  const secondDelete = service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );

  const updateWhileDeleting = await reviewedApply(service, APPLY);
  expect(updateWhileDeleting.ok).toBe(false);
  if (!updateWhileDeleting.ok) {
    expect(updateWhileDeleting.error.code).toBe("delete_blocked");
  }

  adapter.finishDelete();
  const [firstCompleted, secondCompleted] = await Promise.all([
    firstDelete,
    secondDelete,
  ]);
  expect(firstCompleted.ok).toBe(true);
  expect(secondCompleted.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(2);

  const remaining = await service.get("space_1", "ObjectBucket", "assets");
  expect(remaining.ok).toBe(false);
});

test("a Deleting Resource retries backend cleanup after atomic finalization recovers", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  let failRemove = true;
  const stores: ResourceShapeStores = {
    ...baseStores,
    async removeResource(input) {
      if (failRemove) {
        throw new Error("simulated atomic delete finalization outage");
      }
      return await baseStores.removeResource(input);
    },
  };
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const pending = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("delete_failed");
    expect(pending.error.message).toContain("atomic finalization is pending");
  }
  expect((await stores.resources.get(APPLY_ID))?.phase).toBe("Deleting");
  expect(await stores.locks.get(APPLY_ID)).toBeDefined();
  expect(adapter.deleteInputs).toHaveLength(1);

  failRemove = false;
  const recovered = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(recovered.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(2);
  expect(await stores.resources.get(APPLY_ID)).toBeUndefined();
  expect(await stores.locks.get(APPLY_ID)).toBeUndefined();
});

test("delete failure CAS cannot overwrite a concurrently changed Resource", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new ConcurrentlyChangedFailingDeleteAdapter(stores);
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(false);
  if (!deleted.ok) expect(deleted.error.code).toBe("reconcile_conflict");
  expect(await stores.resources.get(APPLY_ID)).toMatchObject({
    phase: "Ready",
    updatedAt: "2026-01-01T00:00:00.001Z",
  });
});

test("delete timeout marks the resource failed instead of leaving it deleting forever", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new SlowDeleteAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    deleteTimeoutMs: 5,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const created = await reviewedApply(service, APPLY);
  expect(created.ok).toBe(true);

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(false);
  if (!deleted.ok) {
    expect(deleted.error.code).toBe("delete_failed");
    expect(deleted.error.message).toContain("did not complete within 5ms");
  }

  const failed = await service.get("space_1", "ObjectBucket", "assets");
  expect(failed.ok).toBe(true);
  if (failed.ok) {
    expect(failed.value.status?.phase).toBe("Failed");
    expect(failed.value.status?.conditions[0]?.type).toBe("Ready");
    expect(failed.value.status?.conditions[0]?.reason).toBe("DeleteFailed");
  }
  expect(adapter.deleteInputs).toHaveLength(1);

  adapter.finishDelete();
});

test("force delete tombstones a failed resource without re-entering the adapter", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new FailingDeleteAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const created = await reviewedApply(service, APPLY);
  expect(created.ok).toBe(true);

  const firstDelete = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(firstDelete.ok).toBe(false);
  if (!firstDelete.ok) {
    expect(firstDelete.error.code).toBe("delete_failed");
    expect(firstDelete.error.message).toContain("simulated delete failure");
  }
  expect(adapter.deleteInputs).toHaveLength(1);

  const failed = await service.get("space_1", "ObjectBucket", "assets");
  expect(failed.ok).toBe(true);
  if (failed.ok) expect(failed.value.status?.phase).toBe("Failed");

  const forced = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
    { force: true },
  );
  expect(forced.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(1);
  expect(await stores.locks.get("tkrn:space_1:ObjectBucket:assets")).toBe(
    undefined,
  );

  const remaining = await service.get("space_1", "ObjectBucket", "assets");
  expect(remaining.ok).toBe(false);
});

test("a failed first apply without a durable lock requires explicit force tombstone", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new FailingApplyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const created = await reviewedApply(service, APPLY);
  expect(created.ok).toBe(false);

  const lock = await stores.locks.get("tkrn:space_1:ObjectBucket:assets");
  expect(lock).toBeUndefined();

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(false);
  if (!deleted.ok) {
    expect(deleted.error.code).toBe("delete_blocked");
    expect(deleted.error.message).toContain("force delete");
  }
  expect(adapter.deleteInputs).toHaveLength(0);

  const forced = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
    { force: true },
  );
  expect(forced.ok).toBe(true);

  const remaining = await service.get("space_1", "ObjectBucket", "assets");
  expect(remaining.ok).toBe(false);
});

test("get returns the applied resource with resolution status", async () => {
  const { service } = makeService();
  await seed(service);
  await reviewedApply(service, APPLY);

  const got = await service.get("space_1", "ObjectBucket", "assets");
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(got.value.metadata.name).toBe("assets");
  expect(got.value.status?.resolution?.target).toBe("cloudflare-main");
});

test("a locked resolution is not silently re-targeted on re-apply", async () => {
  const { service } = makeService();
  await seed(service);
  await reviewedApply(service, APPLY);

  const reResult = await reviewedApply(service, APPLY);
  expect(reResult.ok).toBe(true);
  if (!reResult.ok) return;
  expect(reResult.value.status?.resolution?.selectedImplementation).toBe(
    "cloudflare_r2_bucket",
  );
  expect(reResult.value.status?.observedGeneration).toBe(2);
});

test("SpacePolicy deniedTargets steers ContainerService to the allowed target", async () => {
  const { service } = makeService();
  await service.putTargetPool("space_1", "default", POOL);
  await service.putSpacePolicy("space_1", "default", {
    deniedTargets: ["cloudflare"],
    resolution: { lockAfterCreate: false, allowAutoMigration: true },
  });

  const result = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent",
    spec: {
      name: "agent",
      image: "ghcr.io/example/agent:1.0.0",
      publicHttp: true,
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.status?.resolution?.selectedImplementation).toBe(
    "kubernetes_deployment",
  );
  expect(result.value.status?.resolution?.target).toBe("k8s-main");
});

test("preview resolves without persisting", async () => {
  const { service, stores } = makeService();
  await seed(service);

  const preview = await service.preview(APPLY);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  expect(preview.value.selectedImplementation).toBe("cloudflare_r2_bucket");
  expect(preview.value.nativeResourcePlan.length).toBeGreaterThan(0);
  const stored = await stores.resources.get("tkrn:space_1:ObjectBucket:assets");
  expect(stored).toBeUndefined();
});

test("apply without a target pool returns target_pool_not_found", async () => {
  const { service } = makeService();
  const result = await reviewedApply(service, APPLY);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("target_pool_not_found");
});

test("invalid spec is rejected before resolution", async () => {
  const { service } = makeService();
  await seed(service);
  const result = await reviewedApply(service, {
    ...APPLY,
    spec: { name: "assets", interfaces: ["bad interface"] },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("invalid_interface");
});

test("delete respects lifecyclePolicy.delete=block", async () => {
  const { service } = makeService();
  await seed(service);
  const created = await reviewedApply(service, {
    ...APPLY,
    spec: {
      name: "assets",
      interfaces: ["s3_api"],
      lifecyclePolicy: { delete: "block" },
    },
  });
  expect(created.ok).toBe(true);

  const deleted = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(deleted.ok).toBe(false);
  if (deleted.ok) return;
  expect(deleted.error.code).toBe("delete_blocked");

  const stillThere = await service.get("space_1", "ObjectBucket", "assets");
  expect(stillThere.ok).toBe(true);
});
