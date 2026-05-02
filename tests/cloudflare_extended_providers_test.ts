import assert from "node:assert/strict";
import {
  type CloudflareAnalyticsEngineClient,
  type CloudflareAnalyticsEngineDatasetRecord,
  type CloudflareAnalyticsEngineDatasetSpec,
  type CloudflareAnalyticsEngineMaterializationInput,
  type CloudflareAnalyticsEngineMaterializationResult,
  CloudflareAnalyticsEngineProviderMaterializer,
  type CloudflareAnalyticsEngineWriteInput,
  type CloudflareCustomDomainClient,
  type CloudflareCustomDomainMaterializationInput,
  type CloudflareCustomDomainMaterializationResult,
  CloudflareCustomDomainProviderMaterializer,
  type CloudflareCustomHostnameRecord,
  type CloudflareCustomHostnameSpec,
  type CloudflareCustomHostnameSslState,
  type CloudflareDispatchMaterializationInput,
  type CloudflareDispatchMaterializationResult,
  type CloudflareDispatchNamespaceClient,
  CloudflareDispatchNamespaceProviderMaterializer,
  type CloudflareDispatchNamespaceRecord,
  type CloudflareDispatchNamespaceSpec,
  type CloudflareDispatchTenantWorkerRecord,
  type CloudflareDispatchTenantWorkerSpec,
  type CloudflareKvClient,
  type CloudflareKvDeleteInput,
  type CloudflareKvGetInput,
  type CloudflareKvGetResult,
  type CloudflareKvMaterializationInput,
  type CloudflareKvMaterializationResult,
  type CloudflareKvNamespaceRecord,
  type CloudflareKvNamespaceSpec,
  CloudflareKvProviderMaterializer,
  type CloudflareKvPutInput,
  type CloudflareVectorizeClient,
  type CloudflareVectorizeIndexRecord,
  type CloudflareVectorizeIndexSpec,
  type CloudflareVectorizeMaterializationInput,
  type CloudflareVectorizeMaterializationResult,
  CloudflareVectorizeProviderMaterializer,
  type CloudflareVectorizeQueryInput,
  type CloudflareVectorizeQueryResult,
  type CloudflareVectorizeUpsertInput,
  type CloudflareVectorizeUpsertResult,
  type CloudflareWorkflowInstance,
  type CloudflareWorkflowInvokeInput,
  type CloudflareWorkflowRecord,
  type CloudflareWorkflowsClient,
  type CloudflareWorkflowsMaterializationInput,
  type CloudflareWorkflowsMaterializationResult,
  type CloudflareWorkflowSpec,
  CloudflareWorkflowsProviderMaterializer,
} from "../src/providers/cloudflare/mod.ts";

const now = "2026-04-30T00:00:00.000Z";

function clock(): () => Date {
  return () => new Date(now);
}

function idGen(): () => string {
  let n = 0;
  return () => `id_${++n}`;
}

function desiredState(
  extras?: Partial<{
    resources: unknown[];
    workloads: unknown[];
    routes: unknown[];
  }>,
): Parameters<CloudflareKvProviderMaterializer["materialize"]>[0] {
  return {
    id: "desired_1",
    spaceId: "space_1",
    groupId: "group_1",
    activationId: "activation_1",
    appName: "extended",
    materializedAt: now,
    workloads: (extras?.workloads as never[]) ?? [],
    resources: (extras?.resources as never[]) ?? [],
    routes: (extras?.routes as never[]) ?? [],
  };
}

Deno.test("Cloudflare KV provider materializes namespaces and records operation", async () => {
  const fake = new FakeKvClient();
  const provider = new CloudflareKvProviderMaterializer({
    client: fake,
    accountId: "account_1",
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(
    desiredState({
      resources: [{
        kind: "kv",
        name: "session-cache",
        bindingName: "SESSIONS",
      }],
    }),
  );
  assert.equal(plan.provider, "cloudflare");
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0]!;
  assert.equal(op.kind, "cloudflare-kv-namespace-apply");
  assert.equal(op.execution?.status, "succeeded");
  assert.deepEqual(fake.lastInput?.namespaces, [
    {
      id: undefined,
      title: "session-cache",
      bindingName: "SESSIONS",
      preview: undefined,
    },
  ]);

  // CRUD round-trip
  const rec = await fake.ensureNamespace({ title: "x", bindingName: "X" });
  await fake.put({ namespaceId: rec.id, key: "k", value: "v" });
  const got = await fake.get({ namespaceId: rec.id, key: "k" });
  assert.equal(new TextDecoder().decode(got?.value), "v");
  assert.equal(await fake.delete({ namespaceId: rec.id, key: "k" }), true);
});

Deno.test("Cloudflare dispatch namespace provider deploys tenant worker", async () => {
  const fake = new FakeDispatchClient();
  const provider = new CloudflareDispatchNamespaceProviderMaterializer({
    client: fake,
    accountId: "account_1",
    namespaceName: "tenants-prod",
    description: "production tenant routing",
    clock: clock(),
    idGenerator: idGen(),
    resolveTenantWorker: () => ({
      namespace: "tenants-prod",
      scriptName: "tenant-space-1",
      tenantKey: "space_1",
      script: "export default { fetch() { return new Response('ok') } }",
    }),
  });
  const plan = await provider.materialize(desiredState());
  assert.equal(plan.operations[0]?.kind, "cloudflare-dispatch-namespace-apply");
  assert.equal(plan.operations[0]?.execution?.status, "succeeded");
  assert.equal(fake.lastInput?.namespace.name, "tenants-prod");
  assert.equal(fake.lastInput?.tenantWorker?.scriptName, "tenant-space-1");
});

Deno.test("Cloudflare Vectorize provider creates indexes from desired resources", async () => {
  const fake = new FakeVectorizeClient();
  const provider = new CloudflareVectorizeProviderMaterializer({
    client: fake,
    accountId: "account_1",
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(
    desiredState({
      resources: [
        { kind: "vectorize", name: "docs", dimensions: 1024, metric: "cosine" },
      ],
    }),
  );
  assert.equal(plan.operations[0]?.kind, "cloudflare-vectorize-apply");
  assert.equal(fake.lastInput?.indexes[0]?.name, "docs");
  assert.equal(fake.lastInput?.indexes[0]?.dimensions, 1024);

  const upserted = await fake.upsert({
    indexName: "docs",
    vectors: [{ id: "v1", values: [0.1, 0.2, 0.3] }],
  });
  assert.equal(upserted.upserted, 1);
  const queried = await fake.query({ indexName: "docs", vector: [0.1] });
  assert.equal(queried.matches.length, 1);
});

Deno.test("Cloudflare Analytics Engine provider records dataset binding", async () => {
  const fake = new FakeAnalyticsEngineClient();
  const provider = new CloudflareAnalyticsEngineProviderMaterializer({
    client: fake,
    accountId: "account_1",
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(
    desiredState({
      resources: [
        { kind: "analytics-engine", name: "telemetry", bindingName: "AE" },
      ],
    }),
  );
  assert.equal(plan.operations[0]?.kind, "cloudflare-analytics-engine-apply");
  assert.equal(fake.lastInput?.datasets[0]?.dataset, "telemetry");

  await fake.writeDataPoint({
    dataset: "telemetry",
    point: { indexes: ["space_1"], doubles: [1.5] },
  });
  assert.equal(fake.writes.length, 1);
});

Deno.test("Cloudflare Workflows provider deploys workflow definitions", async () => {
  const fake = new FakeWorkflowsClient();
  const provider = new CloudflareWorkflowsProviderMaterializer({
    client: fake,
    accountId: "account_1",
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(
    desiredState({
      workloads: [
        {
          kind: "workflow",
          name: "billing-cycle",
          script: "export class BillingCycle {}",
          className: "BillingCycle",
        },
      ],
    }),
  );
  assert.equal(plan.operations[0]?.kind, "cloudflare-workflows-apply");
  assert.equal(fake.lastInput?.workflows[0]?.name, "billing-cycle");

  const instance = await fake.invoke({
    workflowName: "billing-cycle",
    params: { spaceId: "space_1" },
  });
  assert.equal(instance.status, "queued");
});

Deno.test("Cloudflare Custom Domain provider verifies hostnames + refreshes SSL", async () => {
  const fake = new FakeCustomDomainClient();
  const provider = new CloudflareCustomDomainProviderMaterializer({
    client: fake,
    zoneId: "zone_1",
    accountId: "account_1",
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(
    desiredState({
      routes: [
        { hostname: "app.example.com" },
        { hostname: "api.example.com" },
        { hostname: "app.example.com" }, // duplicate filtered
      ],
    }),
  );
  assert.equal(plan.operations[0]?.kind, "cloudflare-custom-domain-apply");
  assert.equal(fake.lastInput?.hostnames.length, 2);
  assert.deepEqual(
    fake.lastInput?.hostnames.map((h) => h.hostname).slice().sort(),
    ["api.example.com", "app.example.com"],
  );

  const verified = await fake.verify({
    zoneId: "zone_1",
    hostnameId: "hostname_1",
  });
  assert.equal(verified.status, "active");
  const ssl = await fake.refreshSsl({
    zoneId: "zone_1",
    hostnameId: "hostname_1",
  });
  assert.equal(ssl.status, "active");
});

// ---------- fakes ----------

class FakeKvClient implements CloudflareKvClient {
  lastInput?: CloudflareKvMaterializationInput;
  readonly #namespaces = new Map<string, CloudflareKvNamespaceRecord>();
  readonly #values = new Map<
    string,
    { value: Uint8Array; metadata?: Record<string, string> }
  >();

  ensureNamespace(
    spec: CloudflareKvNamespaceSpec,
  ): Promise<CloudflareKvNamespaceRecord> {
    const id = spec.id ?? `kv_${spec.title}`;
    const rec: CloudflareKvNamespaceRecord = {
      id,
      title: spec.title,
      bindingName: spec.bindingName,
      preview: spec.preview ?? false,
    };
    this.#namespaces.set(id, rec);
    return Promise.resolve(rec);
  }

  listNamespaces(): Promise<readonly CloudflareKvNamespaceRecord[]> {
    return Promise.resolve([...this.#namespaces.values()]);
  }

  deleteNamespace(id: string): Promise<boolean> {
    return Promise.resolve(this.#namespaces.delete(id));
  }

  put(input: CloudflareKvPutInput): Promise<void> {
    const value = typeof input.value === "string"
      ? new TextEncoder().encode(input.value)
      : input.value;
    this.#values.set(`${input.namespaceId}/${input.key}`, {
      value,
      metadata: input.metadata,
    });
    return Promise.resolve();
  }

  get(input: CloudflareKvGetInput): Promise<CloudflareKvGetResult | undefined> {
    const entry = this.#values.get(`${input.namespaceId}/${input.key}`);
    if (!entry) return Promise.resolve(undefined);
    return Promise.resolve({
      key: input.key,
      value: entry.value,
      metadata: entry.metadata,
    });
  }

  delete(input: CloudflareKvDeleteInput): Promise<boolean> {
    return Promise.resolve(
      this.#values.delete(`${input.namespaceId}/${input.key}`),
    );
  }

  materializeNamespaces(
    input: CloudflareKvMaterializationInput,
  ): Promise<CloudflareKvMaterializationResult> {
    this.lastInput = input;
    const records = input.namespaces.map((spec) => ({
      id: spec.id ?? `kv_${spec.title}`,
      title: spec.title,
      bindingName: spec.bindingName,
      preview: spec.preview ?? false,
    }));
    return Promise.resolve({ namespaces: records, stdout: "kv ok" });
  }
}

class FakeDispatchClient implements CloudflareDispatchNamespaceClient {
  lastInput?: CloudflareDispatchMaterializationInput;
  ensureNamespace(
    spec: CloudflareDispatchNamespaceSpec,
  ): Promise<CloudflareDispatchNamespaceRecord> {
    return Promise.resolve({
      name: spec.name,
      id: `ns_${spec.name}`,
      createdAt: now,
    });
  }
  listNamespaces(): Promise<readonly CloudflareDispatchNamespaceRecord[]> {
    return Promise.resolve([]);
  }
  deleteNamespace(_name: string): Promise<boolean> {
    return Promise.resolve(true);
  }
  deployTenantWorker(
    spec: CloudflareDispatchTenantWorkerSpec,
  ): Promise<CloudflareDispatchTenantWorkerRecord> {
    return Promise.resolve({
      namespace: spec.namespace,
      scriptName: spec.scriptName,
      tenantKey: spec.tenantKey,
      etag: "etag_1",
      deployedAt: now,
    });
  }
  materialize(
    input: CloudflareDispatchMaterializationInput,
  ): Promise<CloudflareDispatchMaterializationResult> {
    this.lastInput = input;
    return Promise.resolve({
      namespace: {
        name: input.namespace.name,
        id: `ns_${input.namespace.name}`,
        createdAt: now,
      },
      tenantWorker: input.tenantWorker
        ? {
          namespace: input.tenantWorker.namespace,
          scriptName: input.tenantWorker.scriptName,
          tenantKey: input.tenantWorker.tenantKey,
          etag: "etag_1",
          deployedAt: now,
        }
        : undefined,
      stdout: "dispatch ok",
    });
  }
}

class FakeVectorizeClient implements CloudflareVectorizeClient {
  lastInput?: CloudflareVectorizeMaterializationInput;
  ensureIndex(
    spec: CloudflareVectorizeIndexSpec,
  ): Promise<CloudflareVectorizeIndexRecord> {
    return Promise.resolve({ ...spec, id: `idx_${spec.name}`, createdAt: now });
  }
  listIndexes(): Promise<readonly CloudflareVectorizeIndexRecord[]> {
    return Promise.resolve([]);
  }
  deleteIndex(_name: string): Promise<boolean> {
    return Promise.resolve(true);
  }
  upsert(
    input: CloudflareVectorizeUpsertInput,
  ): Promise<CloudflareVectorizeUpsertResult> {
    return Promise.resolve({
      indexName: input.indexName,
      upserted: input.vectors.length,
    });
  }
  query(
    input: CloudflareVectorizeQueryInput,
  ): Promise<CloudflareVectorizeQueryResult> {
    return Promise.resolve({
      matches: [{
        id: "m1",
        score: 0.99,
        values: input.returnValues ? [0.1] : undefined,
      }],
    });
  }
  materializeIndexes(
    input: CloudflareVectorizeMaterializationInput,
  ): Promise<CloudflareVectorizeMaterializationResult> {
    this.lastInput = input;
    return Promise.resolve({
      indexes: input.indexes.map((spec) => ({
        ...spec,
        id: `idx_${spec.name}`,
        createdAt: now,
      })),
      stdout: "vectorize ok",
    });
  }
}

class FakeAnalyticsEngineClient implements CloudflareAnalyticsEngineClient {
  lastInput?: CloudflareAnalyticsEngineMaterializationInput;
  readonly writes: CloudflareAnalyticsEngineWriteInput[] = [];

  ensureDataset(
    spec: CloudflareAnalyticsEngineDatasetSpec,
  ): Promise<CloudflareAnalyticsEngineDatasetRecord> {
    return Promise.resolve({ ...spec });
  }
  writeDataPoint(input: CloudflareAnalyticsEngineWriteInput): Promise<void> {
    this.writes.push(input);
    return Promise.resolve();
  }
  materializeDatasets(
    input: CloudflareAnalyticsEngineMaterializationInput,
  ): Promise<CloudflareAnalyticsEngineMaterializationResult> {
    this.lastInput = input;
    return Promise.resolve({
      datasets: input.datasets.map((d) => ({ ...d })),
      stdout: "ae ok",
    });
  }
}

class FakeWorkflowsClient implements CloudflareWorkflowsClient {
  lastInput?: CloudflareWorkflowsMaterializationInput;
  deployWorkflow(
    spec: CloudflareWorkflowSpec,
  ): Promise<CloudflareWorkflowRecord> {
    return Promise.resolve({
      name: spec.name,
      className: spec.className,
      version: "v1",
      etag: "etag_1",
      deployedAt: now,
    });
  }
  listWorkflows(): Promise<readonly CloudflareWorkflowRecord[]> {
    return Promise.resolve([]);
  }
  invoke(
    input: CloudflareWorkflowInvokeInput,
  ): Promise<CloudflareWorkflowInstance> {
    return Promise.resolve({
      workflowName: input.workflowName,
      instanceId: input.instanceId ?? "instance_1",
      status: "queued",
      startedAt: now,
    });
  }
  describeInstance(): Promise<CloudflareWorkflowInstance | undefined> {
    return Promise.resolve(undefined);
  }
  terminateInstance(): Promise<boolean> {
    return Promise.resolve(true);
  }
  materializeWorkflows(
    input: CloudflareWorkflowsMaterializationInput,
  ): Promise<CloudflareWorkflowsMaterializationResult> {
    this.lastInput = input;
    return Promise.resolve({
      workflows: input.workflows.map((spec) => ({
        name: spec.name,
        className: spec.className,
        version: "v1",
        etag: "etag_1",
        deployedAt: now,
      })),
      stdout: "workflows ok",
    });
  }
}

class FakeCustomDomainClient implements CloudflareCustomDomainClient {
  lastInput?: CloudflareCustomDomainMaterializationInput;
  readonly #ssl: CloudflareCustomHostnameSslState = {
    status: "active",
    method: "http",
    certificateAuthority: "lets_encrypt",
  };
  ensureCustomHostname(input: {
    readonly zoneId: string;
    readonly spec: CloudflareCustomHostnameSpec;
  }): Promise<CloudflareCustomHostnameRecord> {
    return Promise.resolve({
      id: "hostname_1",
      hostname: input.spec.hostname,
      status: "active",
      ssl: this.#ssl,
      createdAt: now,
    });
  }
  getCustomHostname(): Promise<CloudflareCustomHostnameRecord | undefined> {
    return Promise.resolve(undefined);
  }
  refreshSsl(_input: {
    readonly zoneId: string;
    readonly hostnameId: string;
  }): Promise<CloudflareCustomHostnameSslState> {
    return Promise.resolve(this.#ssl);
  }
  verify(input: {
    readonly zoneId: string;
    readonly hostnameId: string;
  }): Promise<CloudflareCustomHostnameRecord> {
    return Promise.resolve({
      id: input.hostnameId,
      hostname: "app.example.com",
      status: "active",
      ssl: this.#ssl,
      createdAt: now,
    });
  }
  deleteCustomHostname(): Promise<boolean> {
    return Promise.resolve(true);
  }
  materializeHostnames(
    input: CloudflareCustomDomainMaterializationInput,
  ): Promise<CloudflareCustomDomainMaterializationResult> {
    this.lastInput = input;
    return Promise.resolve({
      hostnames: input.hostnames.map((spec, i) => ({
        id: `hostname_${i + 1}`,
        hostname: spec.hostname,
        status: "active" as const,
        ssl: this.#ssl,
        createdAt: now,
      })),
      stdout: "custom-domain ok",
    });
  }
}
