import { test, expect } from "bun:test";
import type {
  ActorContext,
  FormDefinition,
  FormPackage,
  InstalledFormReference,
  ResourceDeploymentAdmission,
  ResourceDeploymentAdmissionDecision,
  ResourceDeploymentCaptureContext,
  ResourceDeploymentImportContext,
  ResourceDeploymentQuote,
  ResourceDeploymentQuoteContext,
  ResourceDeploymentReleaseContext,
  ResourceDeploymentReserveContext,
  ResourceDeploymentReservationDecision,
  ResourceDeploymentRetireContext,
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
  type ImportResourceRequest,
  type ResourceShapeLifecycleEvent,
  type ResourceShapeLifecycleObserver,
  ResourceAdapterApplyError,
  type ResourceShapeStores,
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  ResourceShapeService as CoreResourceShapeService,
  type ResourceShapeServiceDeps,
  StubResourceShapeAdapter,
} from "../../../../core/domains/resource-shape/mod.ts";
import type { SpacePolicySpec, TargetPoolSpec } from "takosumi-contract";
import { TEST_RESOURCE_SHAPE_MODULE_REGISTRY } from "../../../helpers/resource-shape/operator-module-registry.ts";
import {
  InMemoryOpenTofuControlStore,
  type ResourceOperationRun,
} from "../../../../core/domains/deploy-control/store.ts";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";

class ResourceShapeService extends CoreResourceShapeService {
  constructor(deps: ResourceShapeServiceDeps) {
    super({
      schemaRegistry: LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
      ...deps,
    });
  }
}

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
  {
    shape: "VectorIndex",
    implementation: "operator_vector_index",
    nativeResourceType: "operator.vector_index",
    plugin: "operator-vector-plugin",
    moduleOutputs: [{ name: "index_id", type: "string" }],
    interfaces: {
      vector_index: "native",
      vector_query: "native",
      runtime_binding: "native",
      cosine: "native",
    },
  },
  {
    shape: "DurableWorkflow",
    implementation: "operator_durable_workflow",
    nativeResourceType: "operator.durable_workflow",
    plugin: "operator-workflow-plugin",
    moduleOutputs: [{ name: "workflow_id", type: "string" }],
    interfaces: {
      durable_workflow: "native",
      invoke: "native",
      signal: "native",
    },
  },
  {
    shape: "StatefulActorNamespace",
    implementation: "operator_actor_namespace",
    nativeResourceType: "operator.actor_namespace",
    plugin: "operator-actor-plugin",
    moduleOutputs: [{ name: "namespace_id", type: "string" }],
    interfaces: {
      stateful_actor_namespace: "native",
      runtime_binding: "native",
      durable_sqlite: "native",
    },
  },
  {
    shape: "Schedule",
    implementation: "operator_schedule",
    nativeResourceType: "operator.schedule",
    plugin: "operator-schedule-plugin",
    moduleOutputs: [{ name: "schedule_id", type: "string" }],
    interfaces: {
      schedule: "native",
      cron: "native",
      invoke: "native",
      resource_connection: "native",
      schedule_trigger: "native",
      grant_invoke: "native",
    },
  },
];

const ACTOR: ActorContext = {
  actorAccountId: "acc_1",
  roles: [],
  requestId: "req_1",
};

const RECOVERY_ACTOR: ActorContext = {
  actorAccountId: "takosumi-cloud:system-reconcile",
  roles: ["operator"],
  requestId: "req_recovery_1",
};

const NOW = "2026-01-01T00:00:00.000Z";

function directOperationLedger() {
  const store = new InMemoryOpenTofuControlStore();
  return {
    operationRuns: store,
    activity: new ActivityService({
      store,
      now: () => new Date(NOW),
    }),
  };
}

function makeService(formRegistry?: ResourceShapeServiceDeps["formRegistry"]) {
  const stores = createInMemoryResourceShapeStores();
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    ...directOperationLedger(),
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
    ...(formRegistry ? { formRegistry } : {}),
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
    const result = await super.importResource(input);
    if (!input.implementation.plugin) return result;
    const { execution: _resourceOwnedExecution, ...directResult } = result;
    return directResult;
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

class DirectReadOnlyRecoveryAdapter extends PluginSpyAdapter {
  override async refresh(
    input: AdapterApplyInput,
  ): Promise<AdapterRefreshResult> {
    this.refreshInputs.push(input);
    return {
      summary: "read-only backend recovery",
      nativeResources: input.nativeResources ?? [],
      outputs: {
        service_name: input.resourceId,
        url: "https://recovered.example.test",
        connections: {},
      },
    };
  }
}

interface StableApplyBackend {
  exists: boolean;
  creations: number;
  operationKeys: string[];
}

class LostApplyResponseAdapter extends PluginSpyAdapter {
  constructor(
    private readonly backend: StableApplyBackend,
    private readonly mutationReachedProvider: boolean,
  ) {
    super();
  }

  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    if (!input.operationKey) throw new Error("missing stable operation key");
    this.backend.operationKeys.push(input.operationKey);
    if (this.mutationReachedProvider && !this.backend.exists) {
      this.backend.exists = true;
      this.backend.creations += 1;
    }
    throw new Error("simulated lost apply response");
  }
}

class StableNameApplyRecoveryAdapter extends PluginSpyAdapter {
  constructor(private readonly backend: StableApplyBackend) {
    super();
  }

  override async observe(
    input: AdapterApplyInput,
  ): Promise<AdapterObserveResult> {
    this.observeInputs.push(input);
    return {
      status: this.backend.exists ? "current" : "missing",
      summary: this.backend.exists
        ? "stable backend object exists"
        : "stable backend object is missing",
    };
  }

  override async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    this.applyInputs.push(input);
    if (!input.operationKey) throw new Error("missing stable operation key");
    this.backend.operationKeys.push(input.operationKey);
    if (!this.backend.exists) {
      this.backend.exists = true;
      this.backend.creations += 1;
    }
    return await new StubResourceShapeAdapter().apply(input);
  }

  override async refresh(
    input: AdapterApplyInput,
  ): Promise<AdapterRefreshResult> {
    this.refreshInputs.push(input);
    if (!this.backend.exists) throw new Error("backend object is missing");
    return {
      ...(await new StubResourceShapeAdapter().apply(input)),
      summary: "read-only stable backend recovery",
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

class PortableServiceLifecycleAdapter extends PluginSpyAdapter {
  override async importResource(
    input: AdapterImportInput,
  ): Promise<AdapterImportResult> {
    this.importInputs.push(input);
    const applied = await super.apply(input);
    return {
      ...applied,
      nativeResources:
        applied.nativeResources.length > 0
          ? applied.nativeResources.map((resource, index) =>
              index === 0 ? { ...resource, id: input.nativeId } : resource,
            )
          : [{ type: input.plan.shape, id: input.nativeId }],
      summary: `imported ${input.nativeId}`,
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

interface StableDeleteBackend {
  exists: boolean;
  observedStatus: "current" | "drifted";
  deleteMutations: number;
  operationKeys: string[];
  loseBeforeMutation: boolean;
  loseAfterMutation: boolean;
}

class StableNameDeleteAdapter extends PluginSpyAdapter {
  constructor(private readonly backend: StableDeleteBackend) {
    super();
  }

  override async observe(
    input: AdapterApplyInput,
  ): Promise<AdapterObserveResult> {
    this.observeInputs.push(input);
    return {
      status: this.backend.exists ? this.backend.observedStatus : "missing",
      summary: this.backend.exists
        ? "stable backend object exists"
        : "stable backend object is missing",
    };
  }

  override async delete(input: AdapterDeleteInput): Promise<void> {
    this.deleteInputs.push(input);
    if (!input.operationKey) throw new Error("missing stable operation key");
    this.backend.operationKeys.push(input.operationKey);
    if (this.backend.loseBeforeMutation) {
      this.backend.loseBeforeMutation = false;
      throw new Error(
        "simulated delete response loss before provider mutation",
      );
    }
    if (this.backend.exists) {
      this.backend.exists = false;
      this.backend.deleteMutations += 1;
    }
    if (this.backend.loseAfterMutation) {
      this.backend.loseAfterMutation = false;
      throw new Error("simulated delete response loss after provider mutation");
    }
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
  readonly importContexts: ResourceDeploymentImportContext[] = [];
  readonly retireContexts: ResourceDeploymentRetireContext[] = [];
  lastQuote: ResourceDeploymentQuote | undefined;
  failCapture = false;
  failSettlementPending = false;
  failRetire = false;
  failRetireReason: ResourceDeploymentRetireContext["reason"] | undefined;
  reserveReasons: readonly string[] = [];
  importReasons: readonly string[] = [];
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

  async admitImport(
    context: ResourceDeploymentImportContext,
  ): Promise<ResourceDeploymentAdmissionDecision> {
    this.importContexts.push(context);
    return { reasons: this.importReasons };
  }

  async retire(context: ResourceDeploymentRetireContext): Promise<void> {
    this.retireContexts.push(context);
    if (this.failRetire || this.failRetireReason === context.reason) {
      throw new Error("simulated retirement outage");
    }
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

const EXACT_FORM: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"1".repeat(64)}`,
  },
  packageDigest: `sha256:${"2".repeat(64)}`,
};

const EXACT_CONTAINER_FORM: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ContainerService",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"4".repeat(64)}`,
  },
  packageDigest: `sha256:${"5".repeat(64)}`,
};

function exactFormRegistry(
  identity: InstalledFormReference = EXACT_FORM,
): NonNullable<ResourceShapeServiceDeps["formRegistry"]> {
  const definition: FormDefinition = {
    identity,
    displayName: identity.formRef.kind,
    operations: ["create", "read", "update", "delete", "import", "refresh"],
    installedAt: NOW,
  };
  const formPackage: FormPackage = {
    packageDigest: identity.packageDigest,
    artifactRef: `oci://forms.example/${identity.formRef.kind}@sha256:exact`,
    verifierId: "test-verifier",
    status: "installed",
    definitionRefs: [identity.formRef],
    installedAt: NOW,
    installedBy: "test",
    updatedAt: NOW,
  };
  return {
    getDefinition: async (formRef) =>
      JSON.stringify(formRef) === JSON.stringify(identity.formRef)
        ? definition
        : undefined,
    getPackage: async (packageDigest) =>
      packageDigest === identity.packageDigest ? formPackage : undefined,
  };
}

test("exact Form path requires installed authority and explicitly backfills legacy rows", async () => {
  const unavailable = makeService();
  await seed(unavailable.service);
  const rejected = await unavailable.service.preview({
    ...APPLY,
    form: EXACT_FORM,
  });
  expect(rejected).toEqual({
    ok: false,
    error: {
      code: "form_registry_unavailable",
      message: "this host has no exact Form registry authority",
    },
  });

  const { service, stores } = makeService(exactFormRegistry());
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);
  expect((await stores.resources.get(APPLY_ID))?.form).toBeUndefined();
  expect((await stores.locks.get(APPLY_ID))?.form).toBeUndefined();

  const exactPreview = await service.preview({ ...APPLY, form: EXACT_FORM });
  expect(exactPreview.ok).toBe(true);
  if (!exactPreview.ok) throw new Error(exactPreview.error.message);
  const legacyComparison = makeService();
  await seed(legacyComparison.service);
  const legacyPreview = await legacyComparison.service.preview(APPLY);
  expect(legacyPreview.ok).toBe(true);
  // The exact definition is part of immutable review evidence.
  expect(exactPreview.value.planDigest).not.toBe(
    legacyPreview.ok ? legacyPreview.value.planDigest : "",
  );
  expect(
    (
      await service.apply(
        { ...APPLY, form: EXACT_FORM },
        { planDigest: exactPreview.value.planDigest },
      )
    ).ok,
  ).toBe(true);
  expect((await stores.resources.get(APPLY_ID))?.form).toEqual(EXACT_FORM);
  expect((await stores.locks.get(APPLY_ID))?.form).toEqual(EXACT_FORM);

  const omitted = await service.preview(APPLY);
  expect(omitted.ok).toBe(false);
  if (!omitted.ok) expect(omitted.error.code).toBe("form_identity_conflict");
  const changed = await service.preview({
    ...APPLY,
    form: {
      ...EXACT_FORM,
      packageDigest: `sha256:${"3".repeat(64)}`,
    },
  });
  expect(changed.ok).toBe(false);
  if (!changed.ok) expect(changed.error.code).toBe("form_identity_conflict");
});

test("exact direct-plugin lifecycle propagates one immutable Form through Runs, adapter inputs, and NativeResource evidence", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const ledger = new InMemoryOpenTofuControlStore();
  const service = new ResourceShapeService({
    stores,
    adapter,
    operationRuns: ledger,
    activity: new ActivityService({ store: ledger, now: () => new Date(NOW) }),
    formRegistry: exactFormRegistry(EXACT_CONTAINER_FORM),
    now: () => NOW,
  });
  await seed(service);
  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService" as const,
    form: EXACT_CONTAINER_FORM,
    name: "agent-exact",
    spec: {
      name: "agent-exact",
      image: "ghcr.io/example/agent:1.0.0",
    },
  };
  const id = "tkrn:space_1:ContainerService:agent-exact";

  const preview = await service.preview(request);
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error(preview.error.message);
  expect(preview.value.nativeResourcePlan).toEqual([
    {
      type: "cloudflare.container",
      id: "agent-exact",
      ownership: "planned",
      form: EXACT_CONTAINER_FORM,
    },
  ]);

  const applied = await service.apply(request, {
    planDigest: preview.value.planDigest,
  });
  expect(applied.ok).toBe(true);
  expect(adapter.applyInputs[0]).toMatchObject({
    form: EXACT_CONTAINER_FORM,
    nativeResources: [{ form: EXACT_CONTAINER_FORM }],
  });
  expect(await stores.resources.get(id)).toMatchObject({
    form: EXACT_CONTAINER_FORM,
    phase: "Ready",
  });
  expect(await stores.locks.get(id)).toMatchObject({
    form: EXACT_CONTAINER_FORM,
    nativeResources: [{ form: EXACT_CONTAINER_FORM }],
  });

  expect(
    (await service.observe("space_1", "ContainerService", "agent-exact", ACTOR))
      .ok,
  ).toBe(true);
  expect(
    (await service.refresh("space_1", "ContainerService", "agent-exact", ACTOR))
      .ok,
  ).toBe(true);
  expect(adapter.observeInputs.at(-1)).toMatchObject({
    form: EXACT_CONTAINER_FORM,
    nativeResources: [{ form: EXACT_CONTAINER_FORM }],
  });
  expect(adapter.refreshInputs.at(-1)).toMatchObject({
    form: EXACT_CONTAINER_FORM,
    nativeResources: [{ form: EXACT_CONTAINER_FORM }],
  });

  const imported = await service.importResource({
    ...request,
    name: "agent-import-exact",
    spec: {
      name: "agent-import-exact",
      image: "ghcr.io/example/agent:1.0.0",
    },
    nativeId: "provider-agent-exact",
  });
  expect(imported.ok).toBe(true);
  expect(adapter.importInputs.at(-1)).toMatchObject({
    form: EXACT_CONTAINER_FORM,
    nativeResources: [{ form: EXACT_CONTAINER_FORM }],
  });
  expect(
    await stores.locks.get("tkrn:space_1:ContainerService:agent-import-exact"),
  ).toMatchObject({
    form: EXACT_CONTAINER_FORM,
    nativeResources: [{ form: EXACT_CONTAINER_FORM }],
  });

  const runsBeforeDelete = await ledger.listRunsByWorkspace("space_1");
  for (const run of runsBeforeDelete.filter(
    (candidate) => "resourceOperation" in candidate,
  )) {
    const direct = await ledger.getResourceOperationRun(run.id);
    expect(direct?.resourceForm).toEqual(EXACT_CONTAINER_FORM);
    expect(direct?.resourceOperationResult?.resourceForm).toEqual(
      EXACT_CONTAINER_FORM,
    );
    for (const native of direct?.resourceOperationResult?.nativeResources ??
      []) {
      expect(native.form).toEqual(EXACT_CONTAINER_FORM);
    }
  }
  const observeRun = runsBeforeDelete.find(
    (run) => "resourceOperation" in run && run.resourceOperation === "observe",
  );
  expect(
    (await ledger.getResourceOperationRun(observeRun?.id ?? "missing"))
      ?.resourceOperationResult?.nativeResources,
  ).toMatchObject([{ form: EXACT_CONTAINER_FORM }]);

  expect(
    (await service.delete("space_1", "ContainerService", "agent-exact", ACTOR))
      .ok,
  ).toBe(true);
  expect(adapter.deleteInputs.at(-1)).toMatchObject({
    form: EXACT_CONTAINER_FORM,
    nativeResources: [{ form: EXACT_CONTAINER_FORM }],
  });
  const deleteRun = (await ledger.listRunsByWorkspace("space_1")).find(
    (run) => "resourceOperation" in run && run.resourceOperation === "delete",
  );
  const internalDeleteRun = await ledger.getResourceOperationRun(
    deleteRun?.id ?? "missing",
  );
  expect(internalDeleteRun?.resourceForm).toEqual(EXACT_CONTAINER_FORM);
  expect(internalDeleteRun?.resourceOperationResult?.resourceForm).toEqual(
    EXACT_CONTAINER_FORM,
  );
});

test("exact direct-plugin preview rejects adapter NativeResource Form substitution", async () => {
  class SubstitutingPreviewAdapter extends PluginSpyAdapter {
    override async preview(
      input: AdapterApplyInput,
    ): Promise<AdapterPreviewResult> {
      const preview = await super.preview(input);
      return {
        ...preview,
        nativeResources: preview.nativeResources.map((native) => ({
          ...native,
          form: {
            ...EXACT_CONTAINER_FORM,
            packageDigest: `sha256:${"9".repeat(64)}`,
          },
        })),
      };
    }
  }
  const stores = createInMemoryResourceShapeStores();
  const adapter = new SubstitutingPreviewAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    ...directOperationLedger(),
    formRegistry: exactFormRegistry(EXACT_CONTAINER_FORM),
    now: () => NOW,
  });
  await seed(service);
  const preview = await service.preview({
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    form: EXACT_CONTAINER_FORM,
    name: "agent-substituted-form",
    spec: {
      name: "agent-substituted-form",
      image: "ghcr.io/example/agent:1.0.0",
    },
  });
  expect(preview.ok).toBe(false);
  if (!preview.ok) {
    expect(preview.error.code).toBe("apply_failed");
    expect(preview.error.message).toContain("substitutes the Resource Form");
  }
  expect(adapter.previewInputs).toHaveLength(1);
});

test("exact direct-plugin recovery fails closed when persisted Run result omits Form evidence", async () => {
  const stores = createInMemoryResourceShapeStores();
  const ledger = new InMemoryOpenTofuControlStore();
  const initial: ResourceOperationRun = {
    id: "run_resource_exact_preview_missing_form",
    workspaceId: "space_1",
    subject: {
      kind: "resource",
      id: "tkrn:space_1:ContainerService:missing-form",
    },
    resourceOperation: "preview",
    resourceForm: EXACT_CONTAINER_FORM,
    resourceOperationKey: `sha256:${"7".repeat(64)}`,
    resourceOperationVersion: 1,
    type: "plan",
    status: "running",
    createdBy: ACTOR.actorAccountId,
    createdAt: NOW,
    startedAt: NOW,
  };
  await ledger.beginResourceOperationRun(initial);
  const incomplete: ResourceOperationRun = {
    ...initial,
    resourceOperationVersion: 2,
    resourceOperationResult: {
      summary: "previewed without exact evidence",
      nativeResources: [{ type: "cloudflare.container", id: "missing-form" }],
    },
  };
  expect(
    (
      await ledger.transitionResourceOperationRun({
        id: initial.id,
        operationKey: initial.resourceOperationKey,
        expectedVersion: 1,
        expectFrom: ["running"],
        run: incomplete,
      })
    ).won,
  ).toBe(true);
  const service = new ResourceShapeService({
    stores,
    adapter: new PluginSpyAdapter(),
    operationRuns: ledger,
    formRegistry: exactFormRegistry(EXACT_CONTAINER_FORM),
    now: () => NOW,
  });
  expect(await service.repairResourceOperationRuns()).toEqual({
    scanned: 1,
    completed: 0,
    auditsRepaired: 0,
    pending: 1,
  });
  expect((await ledger.getResourceOperationRun(initial.id))?.status).toBe(
    "running",
  );
});

test("pinned Resource operations reject missing NativeResource Form evidence before adapter replay", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    ...directOperationLedger(),
    formRegistry: exactFormRegistry(EXACT_CONTAINER_FORM),
    now: () => NOW,
  });
  await seed(service);
  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService" as const,
    form: EXACT_CONTAINER_FORM,
    name: "agent-corrupt-evidence",
    spec: {
      name: "agent-corrupt-evidence",
      image: "ghcr.io/example/agent:1.0.0",
    },
  };
  expect((await reviewedApply(service, request)).ok).toBe(true);
  const id = "tkrn:space_1:ContainerService:agent-corrupt-evidence";
  const lock = await stores.locks.get(id);
  if (!lock) throw new Error("missing exact lock");
  await stores.locks.put({
    ...lock,
    nativeResources: lock.nativeResources?.map(
      ({ form: _form, ...native }) => native,
    ),
  });

  const observeCount = adapter.observeInputs.length;
  const refreshCount = adapter.refreshInputs.length;
  const deleteCount = adapter.deleteInputs.length;
  const observed = await service.observe(
    "space_1",
    "ContainerService",
    "agent-corrupt-evidence",
    ACTOR,
  );
  const refreshed = await service.refresh(
    "space_1",
    "ContainerService",
    "agent-corrupt-evidence",
    ACTOR,
  );
  const deleted = await service.delete(
    "space_1",
    "ContainerService",
    "agent-corrupt-evidence",
    ACTOR,
  );
  for (const result of [observed, refreshed, deleted]) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("form_identity_conflict");
  }
  expect(adapter.observeInputs).toHaveLength(observeCount);
  expect(adapter.refreshInputs).toHaveLength(refreshCount);
  expect(adapter.deleteInputs).toHaveLength(deleteCount);
});

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

test("managedBy ownership blocks takeover and normal delete before admission or adapter work", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const admission = new RecordingDeploymentAdmission();
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  const owned = { ...APPLY, managedBy: "takosumi.resource-api.v1" };
  expect((await reviewedApply(service, owned)).ok).toBe(true);
  const before = {
    previews: adapter.previewInputs.length,
    applies: adapter.applyInputs.length,
    deletes: adapter.deleteInputs.length,
    reserves: admission.reserveContexts.length,
    retires: admission.retireContexts.length,
  };

  const takeover = await service.apply(
    { ...APPLY, managedBy: "compat.cloudflare.workers.v1" },
    { planDigest: `sha256:${"f".repeat(64)}` },
  );
  expect(takeover).toEqual({
    ok: false,
    error: {
      code: "ownership_conflict",
      message: `resource ${APPLY_ID} is managed by takosumi.resource-api.v1; apply from compat.cloudflare.workers.v1 is not allowed`,
    },
  });

  const wrongDelete = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
    { expectedManagedBy: "compat.cloudflare.workers.v1" },
  );
  expect(wrongDelete.ok).toBe(false);
  if (!wrongDelete.ok)
    expect(wrongDelete.error.code).toBe("ownership_conflict");
  expect({
    previews: adapter.previewInputs.length,
    applies: adapter.applyInputs.length,
    deletes: adapter.deleteInputs.length,
    reserves: admission.reserveContexts.length,
    retires: admission.retireContexts.length,
  }).toEqual(before);
  expect(await stores.resources.get(APPLY_ID)).toMatchObject({
    managedBy: "takosumi.resource-api.v1",
    phase: "Ready",
  });

  const forced = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
    {
      force: true,
      expectedManagedBy: "compat.cloudflare.workers.v1",
    },
  );
  expect(forced.ok).toBe(true);
  expect(await stores.resources.get(APPLY_ID)).toBeUndefined();
});

test("late managedBy apply conflict terminalizes its distinct direct-plugin Run", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  const stores: ResourceShapeStores = {
    ...baseStores,
    async beginApply(input) {
      return {
        status: "ownership_conflict",
        record: {
          ...input.applyingRecord,
          managedBy: "takosumi.resource-api.v1",
          phase: "Ready",
        },
      };
    },
  };
  const adapter = new PluginSpyAdapter();
  const admission = new RecordingDeploymentAdmission();
  const ledger = new InMemoryOpenTofuControlStore();
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
    operationRuns: ledger,
    activity: new ActivityService({ store: ledger, now: () => new Date(NOW) }),
    now: () => NOW,
  });
  await seed(service);
  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService" as const,
    name: "agent-owner-race",
    managedBy: "compat.cloudflare.workers.v1",
    spec: {
      name: "agent-owner-race",
      image: "ghcr.io/example/agent:1.0.0",
    },
  };
  const preview = await service.preview(request);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;

  const applied = await service.apply(request, {
    planDigest: preview.value.planDigest,
  });
  expect(applied.ok).toBe(false);
  if (!applied.ok) expect(applied.error.code).toBe("ownership_conflict");
  expect(adapter.applyInputs).toHaveLength(0);
  expect(admission.reserveContexts).toHaveLength(0);
  expect(
    (await ledger.listRunsByWorkspace("space_1")).filter(
      (run) => "resourceOperation" in run && run.resourceOperation === "apply",
    ),
  ).toMatchObject([
    {
      resourceOperation: "apply",
      status: "failed",
      createdBy: ACTOR.actorAccountId,
    },
  ]);
  expect(await ledger.listRecoverableResourceOperationRuns()).toEqual([]);
});

for (const claimStatus of ["conflict", "not_found"] as const) {
  test(`direct-plugin ${claimStatus} apply claim terminalizes only its newly created Run`, async () => {
    const baseStores = createInMemoryResourceShapeStores();
    const stores: ResourceShapeStores = {
      ...baseStores,
      async beginApply(input): ReturnType<typeof baseStores.beginApply> {
        return claimStatus === "conflict"
          ? { status: "conflict", record: input.applyingRecord }
          : { status: "not_found" };
      },
    };
    const adapter = new PluginSpyAdapter();
    const ledger = new InMemoryOpenTofuControlStore();
    const service = new ResourceShapeService({
      stores,
      adapter,
      operationRuns: ledger,
      activity: new ActivityService({
        store: ledger,
        now: () => new Date(NOW),
      }),
      now: () => NOW,
    });
    await seed(service);
    const request = {
      actor: ACTOR,
      space: "space_1",
      kind: "ContainerService" as const,
      name: `agent-${claimStatus}`,
      spec: {
        name: `agent-${claimStatus}`,
        image: "ghcr.io/example/agent:1.0.0",
      },
    };

    const applied = await reviewedApply(service, request);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error.code).toBe("reconcile_conflict");
    expect(adapter.applyInputs).toHaveLength(0);
    const applyRuns = (await ledger.listRunsByWorkspace("space_1")).filter(
      (run) => "resourceOperation" in run && run.resourceOperation === "apply",
    );
    expect(applyRuns).toMatchObject([
      { resourceOperation: "apply", status: "failed" },
    ]);
    expect(await ledger.listRecoverableResourceOperationRuns()).toEqual([]);
  });
}

test("a shared existing direct-plugin Run is not failed by a losing apply claim", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  const stores: ResourceShapeStores = {
    ...baseStores,
    async beginApply(input) {
      return { status: "conflict", record: input.applyingRecord };
    },
  };
  const ledger = new InMemoryOpenTofuControlStore();
  let failedApplyTransitions = 0;
  const operationRuns = {
    async beginResourceOperationRun(
      run: Parameters<
        InMemoryOpenTofuControlStore["beginResourceOperationRun"]
      >[0],
    ) {
      if (run.resourceOperation !== "apply") {
        return await ledger.beginResourceOperationRun(run);
      }
      const seeded = await ledger.beginResourceOperationRun(run);
      if (seeded.status === "conflict") return seeded;
      return { status: "existing" as const, run: seeded.run };
    },
    getResourceOperationRun: ledger.getResourceOperationRun.bind(ledger),
    listRecoverableResourceOperationRuns:
      ledger.listRecoverableResourceOperationRuns.bind(ledger),
    async transitionResourceOperationRun(
      input: Parameters<
        InMemoryOpenTofuControlStore["transitionResourceOperationRun"]
      >[0],
    ) {
      if (
        input.run.resourceOperation === "apply" &&
        input.run.status === "failed"
      ) {
        failedApplyTransitions += 1;
      }
      return await ledger.transitionResourceOperationRun(input);
    },
  };
  const service = new ResourceShapeService({
    stores,
    adapter: new PluginSpyAdapter(),
    operationRuns,
    activity: new ActivityService({ store: ledger, now: () => new Date(NOW) }),
    now: () => NOW,
  });
  await seed(service);
  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService" as const,
    name: "agent-shared-run",
    spec: {
      name: "agent-shared-run",
      image: "ghcr.io/example/agent:1.0.0",
    },
  };

  const applied = await reviewedApply(service, request);
  expect(applied.ok).toBe(false);
  if (!applied.ok) expect(applied.error.code).toBe("reconcile_conflict");
  expect(failedApplyTransitions).toBe(0);
  const applyRun = (await ledger.listRunsByWorkspace("space_1")).find(
    (run) => "resourceOperation" in run && run.resourceOperation === "apply",
  );
  expect(applyRun?.status).toBe("running");
});

test("direct-plugin apply claim failure before mutation fails its new Run", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  const stores: ResourceShapeStores = {
    ...baseStores,
    async beginApply() {
      throw new Error("simulated direct apply claim outage");
    },
  };
  const ledger = new InMemoryOpenTofuControlStore();
  const service = new ResourceShapeService({
    stores,
    adapter: new PluginSpyAdapter(),
    operationRuns: ledger,
    activity: new ActivityService({ store: ledger, now: () => new Date(NOW) }),
    now: () => NOW,
  });
  await seed(service);

  const applied = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent-claim-failed",
    spec: {
      name: "agent-claim-failed",
      image: "ghcr.io/example/agent:1.0.0",
    },
  });
  expect(applied.ok).toBe(false);
  if (!applied.ok) expect(applied.error.code).toBe("apply_failed");
  expect(
    await baseStores.resources.get(
      "tkrn:space_1:ContainerService:agent-claim-failed",
    ),
  ).toBeUndefined();
  const applyRun = (await ledger.listRunsByWorkspace("space_1")).find(
    (run) => "resourceOperation" in run && run.resourceOperation === "apply",
  );
  expect(applyRun?.status).toBe("failed");
});

test("direct-plugin apply claim acknowledgement loss preserves its Run for recovery", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  const stores: ResourceShapeStores = {
    ...baseStores,
    async beginApply(input) {
      await baseStores.beginApply(input);
      throw new Error("simulated direct apply claim acknowledgement loss");
    },
  };
  const ledger = new InMemoryOpenTofuControlStore();
  const firstAdapter = new PluginSpyAdapter();
  const first = new ResourceShapeService({
    stores,
    adapter: firstAdapter,
    operationRuns: ledger,
    activity: new ActivityService({ store: ledger, now: () => new Date(NOW) }),
    now: () => NOW,
  });
  await seed(first);
  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService" as const,
    name: "agent-claim-ack-loss",
    spec: {
      name: "agent-claim-ack-loss",
      image: "ghcr.io/example/agent:1.0.0",
    },
  };

  const pending = await reviewedApply(first, request);
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("deployment_finalize_pending");
  }
  expect(firstAdapter.applyInputs).toHaveLength(0);
  const applying = await baseStores.resources.get(
    "tkrn:space_1:ContainerService:agent-claim-ack-loss",
  );
  expect(applying?.phase).toBe("Applying");
  const pendingRun = await ledger.getResourceOperationRun(
    applying?.pendingOperation?.runId ?? "missing",
  );
  expect(pendingRun?.status).toBe("running");

  const recoveryAdapter = new DirectReadOnlyRecoveryAdapter();
  const restarted = new ResourceShapeService({
    stores: baseStores,
    adapter: recoveryAdapter,
    operationRuns: ledger,
    activity: new ActivityService({ store: ledger, now: () => new Date(NOW) }),
    now: () => NOW,
  });
  const preview = await restarted.preview(request);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  const recovered = await restarted.recoverApply(request, {
    planDigest: preview.value.planDigest,
  });
  expect(recovered.ok).toBe(true);
  expect(recoveryAdapter.applyInputs).toHaveLength(0);
  expect(recoveryAdapter.observeInputs).toHaveLength(1);
  expect(recoveryAdapter.refreshInputs).toHaveLength(1);
  const ready = await baseStores.resources.get(
    "tkrn:space_1:ContainerService:agent-claim-ack-loss",
  );
  expect(ready?.phase).toBe("Ready");
  const completedRun = await ledger.getResourceOperationRun(
    ready?.lastOperationRunId ?? "missing",
  );
  expect(completedRun?.status).toBe("succeeded");
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

test("deployment admission keeps create/update intent stable across preview and apply", async () => {
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

  expect((await reviewedApply(service, APPLY)).ok).toBe(true);
  const updatedRequest = { ...APPLY, labels: { release: "2" } };
  expect((await reviewedApply(service, updatedRequest)).ok).toBe(true);

  expect(admission.quoteContexts.map((context) => context.operation)).toEqual([
    "create",
    "update",
  ]);
  expect(admission.reserveContexts.map((context) => context.operation)).toEqual(
    ["create", "update"],
  );
  expect(admission.captureContexts.map((context) => context.operation)).toEqual(
    ["create", "update"],
  );
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
  expect(admission.quoteContexts.map((context) => context.operation)).toEqual([
    "create",
    "create",
  ]);
  expect(admission.reserveContexts.map((context) => context.operation)).toEqual(
    ["create", "create"],
  );
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

test("import admission can fail closed before adapter or lifecycle writes", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new ImportingAdapter();
  const admission = new RecordingDeploymentAdmission();
  admission.importReasons = ["Resource import is not enabled by this host"];
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const denied = await service.importResource({
    ...APPLY,
    nativeId: "bucket-backend-123",
  });
  expect(denied).toEqual({
    ok: false,
    error: {
      code: "deployment_admission_denied",
      message: "Resource import is not enabled by this host",
    },
  });
  expect(admission.importContexts).toEqual([
    {
      space: "space_1",
      resourceId: APPLY_ID,
      kind: "ObjectBucket",
      name: "assets",
      spec: APPLY.spec,
      nativeId: "bucket-backend-123",
      actor: ACTOR,
      now: NOW,
    },
  ]);
  expect(adapter.importInputs).toHaveLength(0);
  expect(await stores.resources.get(APPLY_ID)).toBeUndefined();
  expect(await stores.locks.get(APPLY_ID)).toBeUndefined();
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
  const admission = new RecordingDeploymentAdmission();
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
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
    managedBy: "opentofu",
    observedGeneration: 0,
  });

  expect(
    (await service.delete("space_1", "ObjectBucket", "assets", ACTOR)).ok,
  ).toBe(true);
  expect(await stores.resources.get(APPLY_ID)).toBeUndefined();
  expect(adapter.deleteInputs).toHaveLength(0);
  expect(admission.retireContexts).toEqual([
    {
      space: "space_1",
      resourceId: APPLY_ID,
      kind: "ObjectBucket",
      name: "assets",
      reason: "canonical_delete",
      now: NOW,
    },
  ]);
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

test("portable service shapes resolve, apply, and carry Schedule connections", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    ...directOperationLedger(),
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const vector = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "VectorIndex",
    name: "embeddings",
    spec: { name: "embeddings", dimensions: 1536 },
  });
  if (!vector.ok) throw new Error(JSON.stringify(vector.error));
  expect(
    (
      await reviewedApply(service, {
        actor: ACTOR,
        space: "space_1",
        kind: "StatefulActorNamespace",
        name: "rooms",
        spec: { name: "rooms", className: "RoomActor" },
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await reviewedApply(service, {
        actor: ACTOR,
        space: "space_1",
        kind: "DurableWorkflow",
        name: "ingest",
        spec: {
          name: "ingest",
          source: { artifactPath: "/work/dist/workflow.js" },
          entrypoint: "IngestWorkflow",
        },
      })
    ).ok,
  ).toBe(true);

  const scheduleRequest = {
    actor: ACTOR,
    space: "space_1",
    kind: "Schedule" as const,
    name: "nightly",
    spec: {
      name: "nightly",
      cron: "0 0 * * *",
      connections: {
        workflow: {
          resource: "tkrn:space_1:DurableWorkflow:ingest",
          permissions: ["invoke"] as const,
          projection: "schedule_trigger" as const,
        },
      },
    },
  };
  const preview = await service.preview(scheduleRequest);
  expect(preview.ok).toBe(true);
  expect(
    adapter.previewInputs.at(-1)?.resolvedConnections?.workflow,
  ).toMatchObject({
    resourceId: "tkrn:space_1:DurableWorkflow:ingest",
    kind: "DurableWorkflow",
    permissions: ["invoke"],
    projection: "schedule_trigger",
  });
  expect((await reviewedApply(service, scheduleRequest)).ok).toBe(true);
});

test("portable service shapes share import, observe, refresh, and public-output lifecycle", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PortableServiceLifecycleAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    ...directOperationLedger(),
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);

  const requests: ImportResourceRequest[] = [
    {
      actor: ACTOR,
      space: "space_1",
      kind: "VectorIndex",
      name: "embeddings-import",
      nativeId: "native-vector",
      spec: { name: "embeddings-import", dimensions: 1536 },
    },
    {
      actor: ACTOR,
      space: "space_1",
      kind: "StatefulActorNamespace",
      name: "rooms-import",
      nativeId: "native-namespace",
      spec: { name: "rooms-import", className: "RoomActor" },
    },
    {
      actor: ACTOR,
      space: "space_1",
      kind: "DurableWorkflow",
      name: "ingest-import",
      nativeId: "native-workflow",
      spec: {
        name: "ingest-import",
        source: { artifactPath: "/work/dist/workflow.js" },
        entrypoint: "IngestWorkflow",
      },
    },
    {
      actor: ACTOR,
      space: "space_1",
      kind: "Schedule",
      name: "nightly-import",
      nativeId: "native-schedule",
      spec: {
        name: "nightly-import",
        cron: "0 0 * * *",
        connections: {
          workflow: {
            resource: "tkrn:space_1:DurableWorkflow:ingest-import",
            permissions: ["invoke"],
            projection: "schedule_trigger",
          },
        },
      },
    },
  ];

  for (const request of requests) {
    const imported = await service.importResource(request);
    if (!imported.ok) throw new Error(JSON.stringify(imported.error));
    expect(imported.value.resource.status?.phase).toBe("Ready");
    expect(
      Object.keys(imported.value.resource.status?.outputs ?? {}).length,
    ).toBeGreaterThan(0);
    expect(
      (await service.observe(request.space, request.kind, request.name, ACTOR))
        .ok,
    ).toBe(true);
    const refreshed = await service.refresh(
      request.space,
      request.kind,
      request.name,
      ACTOR,
    );
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) {
      expect(
        Object.keys(refreshed.value.resource.status?.outputs ?? {}).length,
      ).toBeGreaterThan(0);
    }
  }
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
    ...directOperationLedger(),
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

test("scheduled repair terminalizes a direct-plugin Run after Resource commit wins", async () => {
  const stores = createInMemoryResourceShapeStores();
  const ledger = new InMemoryOpenTofuControlStore();
  let loseFirstApplyTerminalTransition = true;
  const operationRuns = {
    beginResourceOperationRun: ledger.beginResourceOperationRun.bind(ledger),
    getResourceOperationRun: ledger.getResourceOperationRun.bind(ledger),
    listRecoverableResourceOperationRuns:
      ledger.listRecoverableResourceOperationRuns.bind(ledger),
    transitionResourceOperationRun: async (
      input: Parameters<
        InMemoryOpenTofuControlStore["transitionResourceOperationRun"]
      >[0],
    ) => {
      if (
        loseFirstApplyTerminalTransition &&
        input.run.resourceOperation === "apply" &&
        input.run.status === "succeeded"
      ) {
        loseFirstApplyTerminalTransition = false;
        throw new Error("simulated process loss after Resource commit");
      }
      return await ledger.transitionResourceOperationRun(input);
    },
  };
  const service = new ResourceShapeService({
    stores,
    adapter: new PluginSpyAdapter(),
    operationRuns,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  await seed(service);

  const applied = await reviewedApply(service, {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService",
    name: "agent",
    spec: { name: "agent", image: "ghcr.io/example/agent:1.0.0" },
  });
  expect(applied.ok).toBe(false);
  if (!applied.ok) {
    expect(applied.error.code).toBe("deployment_finalize_pending");
  }

  const restarted = new ResourceShapeService({
    stores,
    adapter: new PluginSpyAdapter(),
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  const repaired = await restarted.repairResourceOperationRuns({ limit: 10 });
  expect(repaired).toEqual({
    scanned: 1,
    completed: 1,
    auditsRepaired: 1,
    pending: 0,
  });
  const resource = await restarted.get("space_1", "ContainerService", "agent");
  expect(resource.ok).toBe(true);
  const internal = await stores.resources.get(
    "tkrn:space_1:ContainerService:agent",
  );
  expect(internal?.lastOperationRunId).toStartWith("run_resource_");
  const run = await ledger.getResourceOperationRun(
    internal?.lastOperationRunId ?? "missing",
  );
  expect(run?.resourceOperation).toBe("apply");
  expect(run?.status).toBe("succeeded");
  expect(run?.resourceOperationAudit?.status).toBe("completed");
  const successEvents = (await ledger.listActivityEvents("space_1")).filter(
    (event) => event.action === "resource.apply.succeeded",
  );
  expect(successEvents).toHaveLength(1);
  expect(successEvents[0]?.id).toBe(`act_${run?.id}`);
  expect(successEvents[0]?.runId).toBe(run?.id);
  expect(await restarted.repairResourceOperationRuns({ limit: 10 })).toEqual({
    scanned: 0,
    completed: 0,
    auditsRepaired: 0,
    pending: 0,
  });
  expect(
    (await ledger.listActivityEvents("space_1")).filter(
      (event) => event.action === "resource.apply.succeeded",
    ),
  ).toHaveLength(1);
});

test("direct-plugin apply recovers a persisted backend result after restart without redispatch", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  let failReadyCommit = true;
  const stores: ResourceShapeStores = {
    ...baseStores,
    async commitApply(input) {
      if (failReadyCommit) {
        throw new Error("simulated direct Resource finalization outage");
      }
      return await baseStores.commitApply(input);
    },
  };
  const ledger = new InMemoryOpenTofuControlStore();
  const firstAdapter = new PluginSpyAdapter();
  const first = new ResourceShapeService({
    stores,
    adapter: firstAdapter,
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  await seed(first);
  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService" as const,
    name: "agent-recovery",
    spec: {
      name: "agent-recovery",
      image: "ghcr.io/example/agent:1.0.0",
      publicHttp: true,
    },
  };

  const pending = await reviewedApply(first, request);
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("deployment_finalize_pending");
  }
  expect(firstAdapter.applyInputs).toHaveLength(1);
  const applying = await stores.resources.get(
    "tkrn:space_1:ContainerService:agent-recovery",
  );
  expect(applying?.phase).toBe("Applying");
  const pendingRun = await ledger.getResourceOperationRun(
    applying?.pendingOperation?.runId ?? "missing",
  );
  expect(pendingRun?.resourceOperationResult?.outputs).toBeDefined();
  expect(pendingRun?.resourceOperationAudit?.status).toBe("pending");

  failReadyCommit = false;
  const recoveryAdapter = new DirectReadOnlyRecoveryAdapter();
  const restarted = new ResourceShapeService({
    stores,
    adapter: recoveryAdapter,
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  const preview = await restarted.preview(request);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  const recovered = await restarted.recoverApply(request, {
    planDigest: preview.value.planDigest,
  });
  expect(recovered.ok).toBe(true);
  expect(recoveryAdapter.applyInputs).toHaveLength(0);
  expect(recoveryAdapter.refreshInputs).toHaveLength(0);
  const ready = await stores.resources.get(
    "tkrn:space_1:ContainerService:agent-recovery",
  );
  expect(ready?.phase).toBe("Ready");
  const completedRun = await ledger.getResourceOperationRun(
    ready?.lastOperationRunId ?? "missing",
  );
  expect(completedRun?.status).toBe("succeeded");
  expect(completedRun?.resourceOperationAudit?.status).toBe("completed");
});

test("direct-plugin apply response loss observes current and never creates a duplicate after restart", async () => {
  const stores = createInMemoryResourceShapeStores();
  const ledger = new InMemoryOpenTofuControlStore();
  const backend: StableApplyBackend = {
    exists: false,
    creations: 0,
    operationKeys: [],
  };
  const firstAdapter = new LostApplyResponseAdapter(backend, true);
  const first = new ResourceShapeService({
    stores,
    adapter: firstAdapter,
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  await seed(first);
  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService" as const,
    name: "agent-response-loss",
    spec: {
      name: "agent-response-loss",
      image: "ghcr.io/example/agent:1.0.0",
    },
  };

  const pending = await reviewedApply(first, request);
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("deployment_finalize_pending");
  }
  expect(firstAdapter.applyInputs).toHaveLength(1);
  expect(backend.exists).toBe(true);
  expect(backend.creations).toBe(1);
  const applying = await stores.resources.get(
    "tkrn:space_1:ContainerService:agent-response-loss",
  );
  expect(applying?.phase).toBe("Applying");
  const pendingRun = await ledger.getResourceOperationRun(
    applying?.pendingOperation?.runId ?? "missing",
  );
  expect(pendingRun?.status).toBe("running");
  expect(pendingRun?.resourceOperationResult).toBeUndefined();

  const recoveryAdapter = new StableNameApplyRecoveryAdapter(backend);
  const restarted = new ResourceShapeService({
    stores,
    adapter: recoveryAdapter,
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  const preview = await restarted.preview(request);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  const recovered = await restarted.recoverApply(request, {
    planDigest: preview.value.planDigest,
  });
  expect(recovered.ok).toBe(true);
  expect(recoveryAdapter.applyInputs).toHaveLength(0);
  expect(recoveryAdapter.observeInputs).toHaveLength(1);
  expect(recoveryAdapter.refreshInputs).toHaveLength(1);
  expect(backend.creations).toBe(1);
  expect(recoveryAdapter.refreshInputs[0]?.operationKey).toBe(
    firstAdapter.applyInputs[0]?.operationKey,
  );
  const ready = await stores.resources.get(
    "tkrn:space_1:ContainerService:agent-response-loss",
  );
  expect(ready?.phase).toBe("Ready");
  const run = await ledger.getResourceOperationRun(
    ready?.lastOperationRunId ?? "missing",
  );
  expect(run?.status).toBe("succeeded");
});

test("direct-plugin apply recovery pins adapter ownership to the original Run across actors", async () => {
  const stores = createInMemoryResourceShapeStores();
  const ledger = new InMemoryOpenTofuControlStore();
  const backend: StableApplyBackend = {
    exists: false,
    creations: 0,
    operationKeys: [],
  };
  const firstAdapter = new LostApplyResponseAdapter(backend, false);
  const first = new ResourceShapeService({
    stores,
    adapter: firstAdapter,
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  await seed(first);
  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService" as const,
    name: "agent-missing-after-loss",
    spec: {
      name: "agent-missing-after-loss",
      image: "ghcr.io/example/agent:1.0.0",
    },
  };

  const pending = await reviewedApply(first, request);
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("deployment_finalize_pending");
  }
  expect(firstAdapter.applyInputs).toHaveLength(1);
  expect(backend.exists).toBe(false);
  expect(backend.creations).toBe(0);
  expect(firstAdapter.applyInputs[0]?.actor.actorAccountId).toBe(
    ACTOR.actorAccountId,
  );

  const recoveryAdapter = new StableNameApplyRecoveryAdapter(backend);
  const restarted = new ResourceShapeService({
    stores,
    adapter: recoveryAdapter,
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  const recoveryRequest = { ...request, actor: RECOVERY_ACTOR };
  const preview = await restarted.preview(recoveryRequest);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  const recovered = await restarted.recoverApply(recoveryRequest, {
    planDigest: preview.value.planDigest,
  });
  expect(recovered.ok).toBe(true);
  expect(recoveryAdapter.observeInputs).toHaveLength(1);
  expect(recoveryAdapter.refreshInputs).toHaveLength(0);
  expect(recoveryAdapter.applyInputs).toHaveLength(1);
  expect(recoveryAdapter.applyInputs[0]?.operationKey).toBe(
    firstAdapter.applyInputs[0]?.operationKey,
  );
  for (const adapterInput of [
    ...recoveryAdapter.observeInputs,
    ...recoveryAdapter.applyInputs,
  ]) {
    expect(adapterInput.actor).toEqual({
      ...RECOVERY_ACTOR,
      actorAccountId: ACTOR.actorAccountId,
    });
  }
  expect(backend.operationKeys).toEqual([
    firstAdapter.applyInputs[0]?.operationKey,
    firstAdapter.applyInputs[0]?.operationKey,
  ]);
  expect(backend.exists).toBe(true);
  expect(backend.creations).toBe(1);

  const updateAdapter = new PluginSpyAdapter();
  const updater = new ResourceShapeService({
    stores,
    adapter: updateAdapter,
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  const updated = await reviewedApply(updater, {
    ...recoveryRequest,
    spec: { ...recoveryRequest.spec, image: "ghcr.io/example/agent:2.0.0" },
  });
  expect(updated.ok).toBe(true);
  expect(updateAdapter.applyInputs).toHaveLength(1);
  expect(updateAdapter.applyInputs[0]?.actor).toEqual(RECOVERY_ACTOR);
  expect(updateAdapter.applyInputs[0]?.operationKey).not.toBe(
    firstAdapter.applyInputs[0]?.operationKey,
  );
});

test("direct-plugin delete response loss converges from drifted or missing after restart", async () => {
  for (const scenario of ["before_mutation", "after_mutation"] as const) {
    const stores = createInMemoryResourceShapeStores();
    const ledger = new InMemoryOpenTofuControlStore();
    const backend: StableDeleteBackend = {
      exists: true,
      observedStatus: "drifted",
      deleteMutations: 0,
      operationKeys: [],
      loseBeforeMutation: scenario === "before_mutation",
      loseAfterMutation: scenario === "after_mutation",
    };
    const firstAdapter = new StableNameDeleteAdapter(backend);
    const first = new ResourceShapeService({
      stores,
      adapter: firstAdapter,
      operationRuns: ledger,
      activity: new ActivityService({
        store: ledger,
        now: () => new Date(NOW),
      }),
      now: () => NOW,
    });
    await seed(first);
    const name = `delete-loss-${scenario}`;
    const request = {
      actor: ACTOR,
      space: "space_1",
      kind: "ContainerService" as const,
      name,
      spec: {
        name,
        image: "ghcr.io/example/agent:1.0.0",
      },
    };
    expect((await reviewedApply(first, request)).ok).toBe(true);

    const pending = await first.delete(
      "space_1",
      "ContainerService",
      name,
      ACTOR,
    );
    expect(pending.ok).toBe(false);
    if (!pending.ok) {
      expect(pending.error.code).toBe("deployment_finalize_pending");
    }
    expect(firstAdapter.deleteInputs).toHaveLength(1);
    const resourceId = `tkrn:space_1:ContainerService:${name}`;
    const deleting = await stores.resources.get(resourceId);
    expect(deleting?.phase).toBe("Deleting");
    const runId = deleting?.pendingOperation?.runId;
    expect(runId).toBeDefined();

    const recoveryAdapter = new StableNameDeleteAdapter(backend);
    const restarted = new ResourceShapeService({
      stores,
      adapter: recoveryAdapter,
      operationRuns: ledger,
      activity: new ActivityService({
        store: ledger,
        now: () => new Date(NOW),
      }),
      now: () => NOW,
    });
    const recovered = await restarted.delete(
      "space_1",
      "ContainerService",
      name,
      ACTOR,
    );
    expect(recovered.ok).toBe(true);
    expect(recoveryAdapter.observeInputs).toHaveLength(1);
    expect(recoveryAdapter.deleteInputs).toHaveLength(
      scenario === "before_mutation" ? 1 : 0,
    );
    if (scenario === "before_mutation") {
      expect(recoveryAdapter.deleteInputs[0]?.operationKey).toBe(
        firstAdapter.deleteInputs[0]?.operationKey,
      );
      expect(backend.operationKeys).toEqual([
        firstAdapter.deleteInputs[0]?.operationKey,
        firstAdapter.deleteInputs[0]?.operationKey,
      ]);
    } else {
      expect(backend.operationKeys).toEqual([
        firstAdapter.deleteInputs[0]?.operationKey,
      ]);
    }
    expect(backend.exists).toBe(false);
    expect(backend.deleteMutations).toBe(1);
    expect(await stores.resources.get(resourceId)).toBeUndefined();
    expect(await stores.locks.get(resourceId)).toBeUndefined();
    expect(
      (await ledger.getResourceOperationRun(runId ?? "missing"))?.status,
    ).toBe("succeeded");
  }
});

test("direct-plugin refresh atomically recovers Resource and ResolutionLock after restart", async () => {
  const baseStores = createInMemoryResourceShapeStores();
  let failRefreshCommit = false;
  const stores: ResourceShapeStores = {
    ...baseStores,
    async commitApply(input) {
      if (
        failRefreshCommit &&
        input.readyRecord.pendingOperation === undefined &&
        input.expectedApplying.phase === "Applying"
      ) {
        throw new Error("simulated refresh Resource/lock commit outage");
      }
      return await baseStores.commitApply(input);
    },
  };
  const ledger = new InMemoryOpenTofuControlStore();
  const firstAdapter = new PluginSpyAdapter();
  const first = new ResourceShapeService({
    stores,
    adapter: firstAdapter,
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  await seed(first);
  const request = {
    actor: ACTOR,
    space: "space_1",
    kind: "ContainerService" as const,
    name: "agent-refresh-recovery",
    spec: {
      name: "agent-refresh-recovery",
      image: "ghcr.io/example/agent:1.0.0",
    },
  };
  expect((await reviewedApply(first, request)).ok).toBe(true);
  const id = "tkrn:space_1:ContainerService:agent-refresh-recovery";
  const stableLock = await stores.locks.get(id);
  expect(stableLock).toBeDefined();

  failRefreshCommit = true;
  const pending = await first.refresh(
    "space_1",
    "ContainerService",
    "agent-refresh-recovery",
    ACTOR,
  );
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("deployment_finalize_pending");
  }
  expect((await stores.resources.get(id))?.phase).toBe("Applying");
  expect((await stores.locks.get(id))?.nativeResources).toEqual(
    stableLock?.nativeResources,
  );
  expect(firstAdapter.refreshInputs).toHaveLength(1);

  failRefreshCommit = false;
  const recoveryAdapter = new PluginSpyAdapter();
  const restarted = new ResourceShapeService({
    stores,
    adapter: recoveryAdapter,
    operationRuns: ledger,
    activity: new ActivityService({
      store: ledger,
      now: () => new Date(NOW),
    }),
    now: () => NOW,
  });
  const recovered = await restarted.refresh(
    "space_1",
    "ContainerService",
    "agent-refresh-recovery",
    ACTOR,
  );
  expect(recovered.ok).toBe(true);
  expect(recoveryAdapter.refreshInputs).toHaveLength(0);
  const ready = await stores.resources.get(id);
  const finalLock = await stores.locks.get(id);
  expect(ready?.phase).toBe("Ready");
  expect(finalLock?.nativeResources).toEqual(stableLock?.nativeResources);
  const run = await ledger.getResourceOperationRun(
    ready?.lastOperationRunId ?? "missing",
  );
  expect(run?.resourceOperation).toBe("refresh");
  expect(run?.status).toBe("succeeded");
});

test("apply passes selected implementation plugin metadata to the adapter", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const service = new ResourceShapeService({
    stores,
    adapter,
    ...directOperationLedger(),
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
    ...directOperationLedger(),
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
    ...directOperationLedger(),
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
    {
      type: "takosumi_object_bucket",
      id: "assets",
      ownership: "planned",
    },
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
    ...directOperationLedger(),
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

test("force delete restores host capacity when canonical CAS conflicts", async () => {
  const base = createInMemoryResourceShapeStores();
  const stores: ResourceShapeStores = {
    ...base,
    async removeResource() {
      return { status: "conflict" };
    },
  };
  const admission = new RecordingDeploymentAdmission();
  const service = new ResourceShapeService({
    stores,
    adapter: new PluginSpyAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const result = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
    { force: true },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("reconcile_conflict");
  expect(await stores.resources.get(APPLY_ID)).toBeDefined();
  expect(admission.retireContexts.map(({ reason }) => reason)).toEqual([
    "force_tombstone",
    "force_tombstone_cancelled",
  ]);
});

test("force delete restores host capacity when atomic removal throws before mutation", async () => {
  const base = createInMemoryResourceShapeStores();
  const stores: ResourceShapeStores = {
    ...base,
    async removeResource() {
      throw new Error("simulated atomic remove outage");
    },
  };
  const admission = new RecordingDeploymentAdmission();
  const service = new ResourceShapeService({
    stores,
    adapter: new PluginSpyAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const result = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
    { force: true },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("delete_failed");
    expect(result.error.message).toContain("simulated atomic remove outage");
  }
  expect(await stores.resources.get(APPLY_ID)).toBeDefined();
  expect(admission.retireContexts.map(({ reason }) => reason)).toEqual([
    "force_tombstone",
    "force_tombstone_cancelled",
  ]);
});

test("force delete leaves retained capacity fenced when compensation fails", async () => {
  const base = createInMemoryResourceShapeStores();
  const stores: ResourceShapeStores = {
    ...base,
    async removeResource() {
      return { status: "conflict" };
    },
  };
  const admission = new RecordingDeploymentAdmission();
  admission.failRetireReason = "force_tombstone_cancelled";
  const service = new ResourceShapeService({
    stores,
    adapter: new PluginSpyAdapter(),
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  const result = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
    { force: true },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("deployment_finalize_pending");
    expect(result.error.message).toContain("host capacity restore is pending");
  }
  expect(await stores.resources.get(APPLY_ID)).toBeDefined();
  expect(admission.retireContexts.map(({ reason }) => reason)).toEqual([
    "force_tombstone",
    "force_tombstone_cancelled",
  ]);
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

test("normal delete retries idempotent host retirement after the Resource is absent", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new PluginSpyAdapter();
  const admission = new RecordingDeploymentAdmission();
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
    now: () => NOW,
    moduleRegistry: TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  });
  await seed(service);
  expect((await reviewedApply(service, APPLY)).ok).toBe(true);

  admission.failRetire = true;
  const pending = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(pending.ok).toBe(false);
  if (!pending.ok) {
    expect(pending.error.code).toBe("deployment_finalize_pending");
    expect(pending.error.message).toContain("host lifecycle retirement");
  }
  expect(await stores.resources.get(APPLY_ID)).toBeUndefined();
  expect(adapter.deleteInputs).toHaveLength(1);

  admission.failRetire = false;
  const recovered = await service.delete(
    "space_1",
    "ObjectBucket",
    "assets",
    ACTOR,
  );
  expect(recovered.ok).toBe(true);
  expect(adapter.deleteInputs).toHaveLength(1);
  expect(admission.retireContexts).toEqual([
    {
      space: "space_1",
      resourceId: APPLY_ID,
      kind: "ObjectBucket",
      name: "assets",
      reason: "canonical_delete",
      now: NOW,
    },
    {
      space: "space_1",
      resourceId: APPLY_ID,
      kind: "ObjectBucket",
      name: "assets",
      reason: "canonical_delete",
      now: NOW,
    },
  ]);
});

test("force delete tombstones a failed resource without re-entering the adapter", async () => {
  const stores = createInMemoryResourceShapeStores();
  const adapter = new FailingDeleteAdapter();
  const admission = new RecordingDeploymentAdmission();
  const service = new ResourceShapeService({
    stores,
    adapter,
    deploymentAdmission: admission,
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
  expect(admission.retireContexts).toEqual([
    {
      space: "space_1",
      resourceId: APPLY_ID,
      kind: "ObjectBucket",
      name: "assets",
      reason: "force_tombstone",
      now: NOW,
    },
  ]);
  expect(await stores.locks.get("tkrn:space_1:ObjectBucket:assets")).toBe(
    undefined,
  );

  const remaining = await service.get("space_1", "ObjectBucket", "assets");
  expect(remaining.ok).toBe(false);

  // A later normal idempotent delete may repeat canonical retirement, but the
  // host can distinguish it from the force tombstone and preserve retained
  // capacity until explicit backend-absence proof is supplied.
  expect(
    (await service.delete("space_1", "ObjectBucket", "assets", ACTOR)).ok,
  ).toBe(true);
  expect(admission.retireContexts.map(({ reason }) => reason)).toEqual([
    "force_tombstone",
    "canonical_delete",
  ]);
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
