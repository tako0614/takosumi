import assert from "node:assert/strict";
import { Hono, type Hono as HonoApp } from "hono";
import type {
  JsonObject,
  ManifestResource,
  PlatformOperationRecoveryMode,
  PlatformTraceContext,
  ResourceHandle,
  Template,
} from "takosumi-contract";
import { registerTemplate, unregisterTemplate } from "takosumi-contract";
import {
  type CatalogReleaseWalHookVerifier,
  registerDeployPublicRoutes,
  TAKOSUMI_DEPLOY_PUBLIC_PATH,
  TAKOSUMI_IDEMPOTENCY_KEY_HEADER,
  TAKOSUMI_IDEMPOTENCY_REPLAYED_HEADER,
} from "./deploy_public_routes.ts";
import type {
  ApplyV2Outcome,
  DestroyV2Outcome,
  OperationPlanPreview,
  PriorAppliedSnapshot,
} from "../domains/deploy/apply_v2.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
  type TakosumiDeploymentRecordStore,
} from "../domains/deploy/takosumi_deployment_record_store.ts";
import type { DeployPublicIdempotencyStore } from "../domains/deploy/deploy_public_idempotency_store.ts";
import {
  appendOperationPlanJournalStages,
  InMemoryOperationJournalStore,
  type OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import {
  TAKOSUMI_APPLY_DURATION_SECONDS,
  TAKOSUMI_DEPLOY_OPERATION_COUNT,
} from "../domains/deploy/deploy_metrics.ts";
import {
  InMemoryRevokeDebtStore,
  type RevokeDebtStore,
} from "../domains/deploy/revoke_debt_store.ts";
import { InMemoryObservabilitySink } from "../services/observability/mod.ts";
import { buildOperationPlanPreview } from "../domains/deploy/operation_plan_preview.ts";
import { buildRefDag } from "../domains/deploy/ref_resolver_v2.ts";
import type {
  ServiceImportResolution,
} from "../domains/deploy/service_import_resolver.ts";

const VALID_TOKEN = "test-token-abc";

const SAMPLE_RESOURCE: ManifestResource = {
  shape: "object-store@v1",
  name: "logs",
  provider: "@takos/selfhost-filesystem",
  spec: { name: "logs", region: "local" },
};

function createApp(opts: {
  token?: string | undefined;
  applyResources?: (
    resources: readonly ManifestResource[],
    priorApplied?: ReadonlyMap<string, PriorAppliedSnapshot>,
    dryRun?: boolean,
    operationPlanPreview?: OperationPlanPreview,
    recoveryMode?: PlatformOperationRecoveryMode,
    trace?: PlatformTraceContext,
  ) => Promise<ApplyV2Outcome>;
  destroyResources?: (
    resources: readonly ManifestResource[],
    handleFor?: (resource: ManifestResource) => ResourceHandle,
    operationPlanPreview?: OperationPlanPreview,
    recoveryMode?: PlatformOperationRecoveryMode,
    trace?: PlatformTraceContext,
  ) => Promise<DestroyV2Outcome>;
  resolveServiceImports?: (
    manifest: JsonObject,
    options: {
      readonly now: () => string;
      readonly deploymentId: string;
    },
  ) => Promise<ServiceImportResolution>;
  recordStore?: TakosumiDeploymentRecordStore;
  idempotencyStore?: DeployPublicIdempotencyStore;
  operationJournalStore?: OperationJournalStore;
  revokeDebtStore?: RevokeDebtStore;
  catalogReleaseVerifier?: CatalogReleaseWalHookVerifier;
  artifactMaxBytes?: number;
  observability?: InMemoryObservabilitySink;
  tenantId?: string;
  now?: () => string;
} = {}): HonoApp {
  const app: HonoApp = new Hono();
  registerDeployPublicRoutes(app, {
    getDeployToken: () => opts.token,
    applyResources: opts.applyResources ?? (() =>
      Promise.resolve({
        applied: [
          {
            name: SAMPLE_RESOURCE.name,
            providerId: SAMPLE_RESOURCE.provider,
            handle: { kind: "test", id: "h_1" } as unknown as ApplyV2Outcome[
              "applied"
            ][number]["handle"],
            outputs: { ok: true },
            specFingerprint: "fnv1a32:00000000",
          },
        ],
        issues: [],
        status: "succeeded",
      })),
    ...(opts.destroyResources
      ? { destroyResources: opts.destroyResources }
      : {}),
    ...(opts.resolveServiceImports
      ? { resolveServiceImports: opts.resolveServiceImports }
      : {}),
    ...(opts.recordStore ? { recordStore: opts.recordStore } : {}),
    ...(opts.idempotencyStore
      ? { idempotencyStore: opts.idempotencyStore }
      : {}),
    ...(opts.operationJournalStore
      ? { operationJournalStore: opts.operationJournalStore }
      : {}),
    ...(opts.revokeDebtStore ? { revokeDebtStore: opts.revokeDebtStore } : {}),
    ...(opts.catalogReleaseVerifier
      ? { catalogReleaseVerifier: opts.catalogReleaseVerifier }
      : {}),
    ...(opts.artifactMaxBytes
      ? { artifactMaxBytes: opts.artifactMaxBytes }
      : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return app;
}

Deno.test("deploy public route returns 404 when token env unset", async () => {
  const app = createApp({ token: undefined });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
});

Deno.test("deploy public route rejects request without authorization header", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.match(body.error.message, /missing bearer token/);
});

Deno.test("deploy public route rejects wrong bearer token", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer not-the-right-token",
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.match(body.error.message, /invalid token/);
});

Deno.test("deploy public route applies manifest with valid token", async () => {
  let captured: readonly ManifestResource[] | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    applyResources: (resources) => {
      captured = resources;
      return Promise.resolve({
        applied: [
          {
            name: resources[0].name,
            providerId: resources[0].provider,
            handle: {
              kind: "test",
              id: "applied",
            } as unknown as ApplyV2Outcome[
              "applied"
            ][number]["handle"],
            outputs: { ok: true },
            specFingerprint: "fnv1a32:00000000",
          },
        ],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.outcome.status, "succeeded");
  assert.equal(body.outcome.applied.length, 1);
  assert.equal(body.outcome.applied[0].name, SAMPLE_RESOURCE.name);
  assert.deepEqual(captured, [SAMPLE_RESOURCE]);
});

Deno.test("deploy public route resolves service imports before apply", async () => {
  let captured: readonly ManifestResource[] | undefined;
  let resolverDeploymentId: string | undefined;
  const descriptor = {
    id: "takosumi.account.auth",
    version: "v1",
    contract: "takosumi.account.auth@v1",
    endpoints: [{
      role: "oidc-issuer",
      url: "https://accounts.example.test",
      path: "/",
    }],
    metadata: {},
    signature: "ed25519:sig",
    publishedAt: "2026-05-09T00:00:00.000Z",
    expiresAt: "2026-05-09T00:05:00.000Z",
    providerInstance: "provider_takosumi_cloud",
  };
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space_1",
    now: () => "2026-05-09T00:00:00.000Z",
    resolveServiceImports: (_manifest, options) => {
      resolverDeploymentId = options.deploymentId;
      return Promise.resolve({
        ok: true,
        value: [{
          alias: "account-auth",
          serviceId: "takosumi.account.auth@v1",
          resolverUrl: "https://anchor.example.test/v1/services/",
          descriptorDigest: "sha256:descriptor",
          descriptor,
          share: {
            id: "cross-instance-share:account-auth",
            serviceId: "takosumi.account.auth@v1",
            toDeploymentId: "space_1/logs",
            resolvedDescriptor: descriptor,
            resolvedAt: "2026-05-09T00:00:00.000Z",
            refreshPolicy: { kind: "ttl", ttl: "300s" },
            auditTrail: [],
          },
        }],
      });
    },
    applyResources: (resources) => {
      captured = resources;
      return Promise.resolve({
        applied: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: { kind: "test", id: "applied" } as unknown as ApplyV2Outcome[
            "applied"
          ][number]["handle"],
          outputs: { ok: true },
          specFingerprint: "fnv1a32:00000000",
        }],
        issues: [],
        status: "succeeded",
      });
    },
  });

  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0",
        kind: "Manifest",
        metadata: { name: "logs" },
        imports: [{
          alias: "account-auth",
          service: "takosumi.account.auth@v1",
        }],
        serviceResolvers: [{
          kind: "anchor",
          url: "https://anchor.example.test/v1/services/",
          publicKey: "pubkey",
        }],
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(resolverDeploymentId, "space_1/logs");
  const pins = captured?.[0].metadata?.takosumiServiceImports as
    | { pins?: readonly { descriptorDigest?: string }[] }
    | undefined;
  assert.equal(pins?.pins?.[0]?.descriptorDigest, "sha256:descriptor");
});

Deno.test("deploy public route rejects unresolved service imports before apply", async () => {
  let applyCalled = false;
  const app = createApp({
    token: VALID_TOKEN,
    resolveServiceImports: () =>
      Promise.resolve({
        ok: false,
        error: "descriptor signature invalid",
      }),
    applyResources: () => {
      applyCalled = true;
      return Promise.resolve({ applied: [], issues: [], status: "succeeded" });
    },
  });

  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0",
        kind: "Manifest",
        imports: [{
          alias: "account-auth",
          service: "takosumi.account.auth@v1",
        }],
        serviceResolvers: [{
          kind: "anchor",
          url: "https://anchor.example.test/v1/services/",
          publicKey: "pubkey",
        }],
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(applyCalled, false);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_argument");
  assert.match(body.error.message, /signature invalid/);
});

Deno.test("deploy public route records deploy success and latency metrics", async () => {
  const observability = new InMemoryObservabilitySink();
  const app = createApp({
    token: VALID_TOKEN,
    observability,
    tenantId: "space:metrics",
    now: () => "2026-05-07T00:00:00.000Z",
  });

  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
      "x-request-id": "req_deploy_metrics",
      "x-correlation-id": "corr_deploy_metrics",
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "metrics-demo" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 200);
  const metrics = await observability.listMetrics();
  const counter = metrics.find((metric) =>
    metric.name === TAKOSUMI_DEPLOY_OPERATION_COUNT
  );
  assert.ok(counter);
  assert.equal(counter.kind, "counter");
  assert.equal(counter.value, 1);
  assert.equal(counter.spaceId, "space:metrics");
  assert.equal(counter.groupId, "metrics-demo");
  assert.equal(counter.requestId, "req_deploy_metrics");
  assert.equal(counter.correlationId, "corr_deploy_metrics");
  assert.deepEqual(counter.tags, {
    operationKind: "apply",
    status: "succeeded",
  });

  const latency = metrics.find((metric) =>
    metric.name === TAKOSUMI_APPLY_DURATION_SECONDS
  );
  assert.ok(latency);
  assert.equal(latency.kind, "histogram");
  assert.equal(latency.unit, "seconds");
  assert.equal(latency.tags?.status, "succeeded");
});

Deno.test("deploy public route forwards request trace context to applyV2", async () => {
  let capturedTrace: PlatformTraceContext | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    applyResources: (
      _resources,
      _priorApplied,
      _dryRun,
      _operationPlanPreview,
      _recoveryMode,
      trace,
    ) => {
      capturedTrace = trace;
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
      });
    },
  });

  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
      "x-request-id": "req_deploy_trace",
      "x-correlation-id": "corr_deploy_trace",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "trace-demo" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(capturedTrace?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.match(capturedTrace?.parentSpanId ?? "", /^[0-9a-f]{16}$/);
  assert.notEqual(capturedTrace?.parentSpanId, "1111111111111111");
  assert.equal(capturedTrace?.requestId, "req_deploy_trace");
  assert.equal(capturedTrace?.correlationId, "corr_deploy_trace");
});

Deno.test(
  "deploy public route rejects oversized manifest artifact before apply",
  async () => {
    let called = false;
    const resource: ManifestResource = {
      shape: "web-service@v1",
      name: "web",
      provider: "@takos/selfhost-docker",
      spec: {
        artifact: {
          kind: "oci-image",
          uri: "ghcr.io/takos/app@sha256:abc",
          size: 11,
        },
        port: 8080,
      },
    };
    const app = createApp({
      token: VALID_TOKEN,
      artifactMaxBytes: 10,
      applyResources: () => {
        called = true;
        return Promise.resolve({
          applied: [],
          issues: [],
          status: "succeeded",
        });
      },
    });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          apiVersion: "1.0" as const,
          kind: "Manifest" as const,
          resources: [resource],
        },
      }),
    });
    assert.equal(response.status, 413);
    assert.equal(called, false);
    const body = await response.json();
    assert.equal(body.error.code, "resource_exhausted");
    assert.equal(body.error.details.resource, "web");
    assert.equal(body.error.details.size, 11);
    assert.equal(body.error.details.maxBytes, 10);
  },
);

Deno.test("deploy public route checks manifest artifact size in plan mode", async () => {
  let called = false;
  const resource: ManifestResource = {
    shape: "worker@v1",
    name: "worker",
    provider: "@takos/cloudflare-workers",
    spec: {
      artifact: {
        kind: "js-bundle",
        hash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        size: 11,
      },
    },
  };
  const app = createApp({
    token: VALID_TOKEN,
    artifactMaxBytes: 10,
    applyResources: () => {
      called = true;
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "plan",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [resource],
      },
    }),
  });
  assert.equal(response.status, 413);
  assert.equal(called, false);
});

Deno.test("deploy public route records apply WAL stages around provider side effects", async () => {
  const journal = new InMemoryOperationJournalStore();
  const calls: string[] = [];
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:wal",
    operationJournalStore: journal,
    now: () => "2026-05-02T00:00:00.000Z",
    applyResources: (resources) => {
      calls.push("applyResources");
      return Promise.resolve({
        applied: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: "handle-wal",
          outputs: { ok: true },
          specFingerprint: "fnv1a32:00000000",
        }],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "wal-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["applyResources"]);

  const planResponse = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "plan",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "wal-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  const planBody = await planResponse.json();
  const digest = planBody.outcome.operationPlanPreview.operationPlanDigest;
  const entries = await journal.listByPlan("space:wal", digest);
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    ["prepare", "pre-commit", "commit", "post-commit", "observe", "finalize"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.status),
    ["recorded", "recorded", "recorded", "succeeded", "succeeded", "succeeded"],
  );
  assert.equal(entries[0].deploymentName, "wal-app");
  assert.equal(entries[0].phase, "apply");
});

Deno.test("deploy public route records upstream provenance in WAL and status", async () => {
  const journal = new InMemoryOperationJournalStore();
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:provenance",
    operationJournalStore: journal,
    now: () => "2026-05-07T00:00:00.000Z",
    applyResources: (resources) => {
      const metadata = resources[0].metadata as JsonObject;
      assert.equal(
        (metadata.takosumiDeployProvenance as JsonObject).kind,
        "takosumi.deploy-provenance-digest@v1",
      );
      return Promise.resolve({
        applied: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: "handle-provenance",
          outputs: { ok: true },
          specFingerprint: "fnv1a32:00000000",
        }],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const provenance = {
    kind: "takosumi-git.deployment-provenance@v1",
    workflowRunId: "takosumi-git:run:123",
    generatedAt: "2026-05-07T00:00:00.000Z",
    git: {
      repositoryUrl: "https://github.com/acme/demo.git",
      ref: "refs/heads/main",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    resourceArtifacts: [{
      resourceName: "logs",
      artifactName: "image",
      artifactUri: "ghcr.io/acme/demo@sha256:abc",
      workflow: { file: "build.yml", job: "build", artifact: "image" },
      stepLogs: [{
        stepName: "build",
        exitCode: 0,
        stdoutDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        stdoutBytes: 123,
      }],
    }],
  };
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      provenance,
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "provenance-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);

  const entries = await journal.listByDeployment(
    "space:provenance",
    "provenance-app",
  );
  assert.ok(entries.length > 0);
  const prepare = entries.find((entry) => entry.stage === "prepare");
  assert.ok(prepare);
  const detail = prepare!.effect.detail as JsonObject;
  const recorded = detail.provenance as JsonObject;
  assert.equal(recorded.workflowRunId, "takosumi-git:run:123");
  assert.equal(
    (recorded.resourceArtifacts as JsonObject[])[0].artifactUri,
    "ghcr.io/acme/demo@sha256:abc",
  );

  const statusResponse = await app.request(
    `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/provenance-app`,
    { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
  );
  assert.equal(statusResponse.status, 200);
  const statusBody = await statusResponse.json() as {
    provenance: { workflowRunId: string };
  };
  assert.equal(statusBody.provenance.workflowRunId, "takosumi-git:run:123");
});

Deno.test("deploy public route fails closed when CatalogRelease pre-commit hook fails", async () => {
  const journal = new InMemoryOperationJournalStore();
  const calls: string[] = [];
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:catalog-hook",
    operationJournalStore: journal,
    catalogReleaseVerifier: {
      verifyCurrentReleaseForSpace: () =>
        Promise.resolve({
          ok: false,
          reason: "publisher-key-revoked",
          message: "publisher key revoked",
          descriptorDigest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          publisherKeyId: "publisher-key:revoked",
          risk: {
            code: "implementation-unverified",
            severity: "error",
            message: "publisher key revoked",
          },
        }),
    },
    applyResources: () => {
      calls.push("applyResources");
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
      });
    },
  });

  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "hook-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(calls, []);
  const body = await response.json();
  assert.equal(body.error.code, "failed_precondition");
  assert.match(body.error.message, /pre-commit hook failed/);
  const entries = await journal.listByDeployment(
    "space:catalog-hook",
    "hook-app",
  );
  assert.deepEqual(entries.map((entry) => entry.stage), ["prepare", "abort"]);
  assert.equal(entries[1].status, "failed");
  assert.equal(
    (entries[1].effect.detail as JsonObject).reason,
    "catalog-release-pre-commit-hook-failed",
  );
});

Deno.test("deploy public route fails closed when executable pre-commit hook fails", async () => {
  const journal = new InMemoryOperationJournalStore();
  const calls: string[] = [];
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:executable-hook",
    operationJournalStore: journal,
    catalogReleaseVerifier: {
      verifyCurrentReleaseForSpace: () =>
        Promise.resolve({
          ok: true,
          descriptorDigest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          publisherId: "publisher:test",
          publisherKeyId: "publisher-key:active",
          verifiedAt: "2026-05-05T00:00:00.000Z",
        }),
      runExecutableHooks: (input) => {
        assert.equal(input.stage, "pre-commit");
        assert.equal(input.operations[0].resourceName, SAMPLE_RESOURCE.name);
        return Promise.resolve({
          ok: false,
          status: "failed",
          stage: input.stage,
          packageId: "takos.hook.risk-gate",
          packageVersion: "1.0.0",
          reason: "policy-denied",
          message: "risk gate denied deployment",
          packages: [{
            packageId: "takos.hook.risk-gate",
            packageVersion: "1.0.0",
            status: "failed",
            reason: "policy-denied",
            message: "risk gate denied deployment",
          }],
        });
      },
    },
    applyResources: () => {
      calls.push("applyResources");
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
      });
    },
  });

  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "executable-hook-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(calls, []);
  const body = await response.json();
  assert.match(body.error.message, /risk gate denied deployment/);
  const entries = await journal.listByDeployment(
    "space:executable-hook",
    "executable-hook-app",
  );
  assert.deepEqual(entries.map((entry) => entry.stage), ["prepare", "abort"]);
  const detail = entries[1].effect.detail as JsonObject;
  assert.equal(detail.reason, "catalog-release-pre-commit-hook-failed");
  const hook = detail.catalogReleaseHook as JsonObject;
  const executableHook = hook.executableHook as JsonObject;
  assert.equal(executableHook.packageId, "takos.hook.risk-gate");
});

Deno.test("deploy public route enqueues RevokeDebt when CatalogRelease post-commit hook fails", async () => {
  const journal = new InMemoryOperationJournalStore();
  const revokeDebtStore = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:catalog-hook",
  });
  const calls: string[] = [];
  let verifyCalls = 0;
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:catalog-post-hook",
    operationJournalStore: journal,
    revokeDebtStore,
    catalogReleaseVerifier: {
      verifyCurrentReleaseForSpace: () => {
        verifyCalls += 1;
        if (verifyCalls === 1) {
          return Promise.resolve({
            ok: true,
            descriptorDigest:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            publisherId: "publisher:test",
            publisherKeyId: "publisher-key:active",
            verifiedAt: "2026-05-02T00:00:00.000Z",
          });
        }
        return Promise.resolve({
          ok: false,
          reason: "signature-invalid",
          message: "signature invalid",
          descriptorDigest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          publisherKeyId: "publisher-key:active",
          risk: {
            code: "implementation-unverified",
            severity: "error",
            message: "signature invalid",
          },
        });
      },
    },
    applyResources: (resources) => {
      calls.push("applyResources");
      return Promise.resolve({
        applied: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: "handle-post-hook",
          outputs: { ok: true },
          specFingerprint: "fnv1a32:00000000",
        }],
        issues: [],
        status: "succeeded",
      });
    },
  });

  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "post-hook-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(calls, ["applyResources"]);
  assert.equal(verifyCalls, 2);
  const debts = await revokeDebtStore.listByDeployment(
    "space:catalog-post-hook",
    "post-hook-app",
  );
  assert.equal(debts.length, 1);
  assert.equal(debts[0].reason, "approval-invalidated");
  const entries = await journal.listByDeployment(
    "space:catalog-post-hook",
    "post-hook-app",
  );
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    ["prepare", "pre-commit", "commit", "post-commit", "observe", "finalize"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.status),
    ["recorded", "recorded", "recorded", "failed", "succeeded", "succeeded"],
  );
});

Deno.test("deploy public route records RevokeDebt when executable post-commit hook fails", async () => {
  const journal = new InMemoryOperationJournalStore();
  const revokeDebtStore = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:executable-hook",
  });
  const calls: string[] = [];
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:executable-post-hook",
    operationJournalStore: journal,
    revokeDebtStore,
    catalogReleaseVerifier: {
      verifyCurrentReleaseForSpace: () =>
        Promise.resolve({
          ok: true,
          descriptorDigest:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          publisherId: "publisher:test",
          publisherKeyId: "publisher-key:active",
          verifiedAt: "2026-05-05T00:00:00.000Z",
        }),
      runExecutableHooks: (input) => {
        if (input.stage === "pre-commit") {
          return Promise.resolve({
            ok: true,
            status: "succeeded",
            stage: input.stage,
            packages: [{
              packageId: "takos.hook.audit",
              packageVersion: "1.0.0",
              status: "succeeded",
            }],
          });
        }
        return Promise.resolve({
          ok: false,
          status: "failed",
          stage: input.stage,
          packageId: "takos.hook.audit",
          packageVersion: "1.0.0",
          reason: "audit-sink-unavailable",
          message: "audit hook failed after commit",
          packages: [{
            packageId: "takos.hook.audit",
            packageVersion: "1.0.0",
            status: "failed",
            reason: "audit-sink-unavailable",
            message: "audit hook failed after commit",
          }],
        });
      },
    },
    applyResources: (resources) => {
      calls.push("applyResources");
      return Promise.resolve({
        applied: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: "handle-executable-hook",
          outputs: { ok: true },
          specFingerprint: "fnv1a32:00000000",
        }],
        issues: [],
        status: "succeeded",
      });
    },
  });

  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "executable-post-hook-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(calls, ["applyResources"]);
  const debts = await revokeDebtStore.listByDeployment(
    "space:executable-post-hook",
    "executable-post-hook-app",
  );
  assert.equal(debts.length, 1);
  assert.equal(debts[0].reason, "approval-invalidated");
  const entries = await journal.listByDeployment(
    "space:executable-post-hook",
    "executable-post-hook-app",
  );
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    ["prepare", "pre-commit", "commit", "post-commit", "observe", "finalize"],
  );
  assert.equal(entries[3].status, "failed");
  const detail = entries[3].effect.detail as JsonObject;
  const hook = detail.catalogReleaseHook as JsonObject;
  const executableHook = hook.executableHook as JsonObject;
  assert.equal(executableHook.packageId, "takos.hook.audit");
});

Deno.test("deploy public route forwards apply WAL operation plan to applyResources", async () => {
  let captured: OperationPlanPreview | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:wal-forward",
    applyResources: (
      resources,
      _priorApplied,
      _dryRun,
      operationPlanPreview,
    ) => {
      captured = operationPlanPreview;
      return Promise.resolve({
        applied: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: "handle-forward",
          outputs: { ok: true },
          specFingerprint: "fnv1a32:00000000",
        }],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "wal-forward-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.ok(captured);
  assert.equal(captured.spaceId, "space:wal-forward");
  assert.equal(captured.deploymentName, "wal-forward-app");
  const operation = captured.operations[0];
  assert.ok(operation);
  assert.equal(operation.op, "create");
  assert.equal(
    operation.idempotencyKey.operationPlanDigest,
    captured.operationPlanDigest,
  );
});

Deno.test("deploy public route records abort WAL stage when apply fails", async () => {
  const journal = new InMemoryOperationJournalStore();
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:wal-failed",
    operationJournalStore: journal,
    now: () => "2026-05-02T00:00:00.000Z",
    applyResources: (_resources, _priorApplied, dryRun) =>
      Promise.resolve(
        dryRun
          ? {
            applied: [],
            issues: [],
            status: "succeeded",
          }
          : {
            applied: [],
            issues: [{
              path: "$.resources[logs]",
              message: "provider rejected",
            }],
            status: "failed-apply",
          },
      ),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "wal-failed-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 500);

  const planResponse = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "plan",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "wal-failed-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  const planBody = await planResponse.json();
  const entries = await journal.listByPlan(
    "space:wal-failed",
    planBody.outcome.operationPlanPreview.operationPlanDigest,
  );
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    ["prepare", "pre-commit", "commit", "abort"],
  );
  assert.equal(entries.at(-1)?.status, "failed");
});

Deno.test("deploy public route refuses apply when prior public WAL is unfinished", async () => {
  const journal = new InMemoryOperationJournalStore();
  const preview = buildOperationPlanPreview({
    resources: [SAMPLE_RESOURCE],
    planned: [{
      name: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      op: "create",
    }],
    edges: buildRefDag([SAMPLE_RESOURCE]).edges,
    spaceId: "space:recovery",
    deploymentName: "stuck-app",
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "apply",
    stages: ["prepare", "pre-commit", "commit"],
    status: "recorded",
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  let applyCount = 0;
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:recovery",
    operationJournalStore: journal,
    applyResources: () => {
      applyCount += 1;
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "stuck-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "failed_precondition");
  assert.match(body.error.message, /unfinished public WAL/);
  assert.equal(applyCount, 0);
});

Deno.test("deploy public route recoveryMode continue resumes matching unfinished apply WAL", async () => {
  const journal = new InMemoryOperationJournalStore();
  const preview = buildOperationPlanPreview({
    resources: [SAMPLE_RESOURCE],
    planned: [{
      name: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      op: "create",
    }],
    edges: buildRefDag([SAMPLE_RESOURCE]).edges,
    spaceId: "space:continue",
    deploymentName: "continue-app",
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "apply",
    stages: ["prepare", "pre-commit", "commit"],
    status: "recorded",
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  let applyCount = 0;
  let capturedPlan: OperationPlanPreview | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:continue",
    operationJournalStore: journal,
    now: () => "2026-05-02T00:00:01.000Z",
    applyResources: (resources, _priorApplied, _dryRun, operationPlan) => {
      applyCount += 1;
      capturedPlan = operationPlan;
      return Promise.resolve({
        applied: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: "handle-continue",
          outputs: { ok: true },
          specFingerprint: "fnv1a32:00000000",
        }],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      recoveryMode: "continue",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "continue-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(applyCount, 1);
  assert.equal(capturedPlan?.operationPlanDigest, preview.operationPlanDigest);
  const entries = await journal.listByPlan(
    "space:continue",
    preview.operationPlanDigest,
  );
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    ["prepare", "pre-commit", "commit", "post-commit", "observe", "finalize"],
  );
  assert.equal(entries.at(-1)?.status, "succeeded");
});

Deno.test("deploy public route recoveryMode continue rejects changed OperationPlan", async () => {
  const journal = new InMemoryOperationJournalStore();
  const preview = buildOperationPlanPreview({
    resources: [SAMPLE_RESOURCE],
    planned: [{
      name: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      op: "create",
    }],
    edges: buildRefDag([SAMPLE_RESOURCE]).edges,
    spaceId: "space:continue-mismatch",
    deploymentName: "continue-mismatch-app",
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "apply",
    stages: ["prepare", "pre-commit", "commit"],
    status: "recorded",
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  let applyCount = 0;
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:continue-mismatch",
    operationJournalStore: journal,
    applyResources: () => {
      applyCount += 1;
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      recoveryMode: "continue",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "continue-mismatch-app" },
        resources: [{
          ...SAMPLE_RESOURCE,
          spec: { name: "logs", region: "local", changed: true },
        }],
      },
    }),
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "failed_precondition");
  assert.match(body.error.message, /operationPlanDigest/);
  assert.equal(applyCount, 0);
  const entries = await journal.listByPlan(
    "space:continue-mismatch",
    preview.operationPlanDigest,
  );
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    ["prepare", "pre-commit", "commit"],
  );
});

Deno.test("deploy public route recoveryMode compensate aborts WAL and enqueues RevokeDebt", async () => {
  const journal = new InMemoryOperationJournalStore();
  const revokeDebtStore = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:compensate-one",
  });
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  await recordStore.upsert({
    tenantId: "space:compensate",
    name: "compensate-app",
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "compensate-app" },
      resources: [SAMPLE_RESOURCE],
    } as unknown as JsonObject,
    appliedResources: [],
    status: "failed",
    now: "2026-05-02T00:00:00.000Z",
  });
  const preview = buildOperationPlanPreview({
    resources: [SAMPLE_RESOURCE],
    planned: [{
      name: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      op: "create",
    }],
    edges: buildRefDag([SAMPLE_RESOURCE]).edges,
    spaceId: "space:compensate",
    deploymentName: "compensate-app",
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "apply",
    stages: ["prepare", "pre-commit", "commit"],
    status: "recorded",
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  let applyCount = 0;
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:compensate",
    recordStore,
    operationJournalStore: journal,
    revokeDebtStore,
    now: () => "2026-05-02T00:00:01.000Z",
    applyResources: () => {
      applyCount += 1;
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      recoveryMode: "compensate",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "compensate-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.outcome.status, "recovery-compensate");
  assert.equal(body.outcome.journal.latestStage, "abort");
  assert.equal(body.outcome.journal.terminal, true);
  assert.equal(body.outcome.debts.length, 1);
  assert.equal(body.outcome.debts[0].id, "revoke-debt:compensate-one");
  assert.equal(body.outcome.debts[0].reason, "activation-rollback");
  assert.equal(body.outcome.debts[0].status, "open");
  assert.equal(body.outcome.debts[0].resourceName, SAMPLE_RESOURCE.name);
  assert.equal(applyCount, 0);

  const debts = await revokeDebtStore.listByDeployment(
    "space:compensate",
    "compensate-app",
  );
  assert.equal(debts.length, 1);
  const entries = await journal.listByPlan(
    "space:compensate",
    preview.operationPlanDigest,
  );
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    ["prepare", "pre-commit", "commit", "abort"],
  );

  const statusResponse = await app.request(
    `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/compensate-app`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    },
  );
  const statusBody = await statusResponse.json();
  assert.deepEqual(statusBody.revokeDebt, {
    total: 1,
    open: 1,
    operatorActionRequired: 0,
    cleared: 0,
  });
});

Deno.test("deploy public route recoveryMode compensate rejects pre-commit WAL without committed effect", async () => {
  const journal = new InMemoryOperationJournalStore();
  const preview = buildOperationPlanPreview({
    resources: [SAMPLE_RESOURCE],
    planned: [{
      name: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      op: "create",
    }],
    edges: buildRefDag([SAMPLE_RESOURCE]).edges,
    spaceId: "space:compensate-precommit",
    deploymentName: "compensate-precommit-app",
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "apply",
    stages: ["prepare", "pre-commit"],
    status: "recorded",
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:compensate-precommit",
    operationJournalStore: journal,
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      recoveryMode: "compensate",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "compensate-precommit-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "failed_precondition");
  assert.match(body.error.message, /no committed effect/);
});

Deno.test("deploy public route recoveryMode inspect returns journal without provider side effects", async () => {
  const journal = new InMemoryOperationJournalStore();
  const preview = buildOperationPlanPreview({
    resources: [SAMPLE_RESOURCE],
    planned: [{
      name: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      op: "create",
    }],
    edges: buildRefDag([SAMPLE_RESOURCE]).edges,
    spaceId: "space:inspect",
    deploymentName: "inspect-app",
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "apply",
    stages: ["prepare", "pre-commit", "commit"],
    status: "recorded",
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  let applyCount = 0;
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:inspect",
    operationJournalStore: journal,
    applyResources: () => {
      applyCount += 1;
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      recoveryMode: "inspect",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "inspect-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.outcome.status, "recovery-inspect");
  assert.equal(body.outcome.deploymentName, "inspect-app");
  assert.equal(
    body.outcome.journal.operationPlanDigest,
    preview.operationPlanDigest,
  );
  assert.equal(body.outcome.journal.latestStage, "commit");
  assert.equal(body.outcome.journal.terminal, false);
  assert.deepEqual(
    body.outcome.entries.map((entry: { stage: string }) => entry.stage),
    ["prepare", "pre-commit", "commit"],
  );
  assert.equal(applyCount, 0);
});

Deno.test("GET /v1/deployments/:name/audit returns rollback cause chain", async () => {
  const journal = new InMemoryOperationJournalStore();
  const recordStore = new InMemoryTakosumiDeploymentRecordStore({
    idFactory: () => "deployment:123",
  });
  const revokeDebtStore = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:1",
  });
  const preview = buildOperationPlanPreview({
    resources: [SAMPLE_RESOURCE],
    planned: [{
      name: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      op: "create",
    }],
    edges: buildRefDag([SAMPLE_RESOURCE]).edges,
    spaceId: "space:audit",
    deploymentName: "audit-app",
  });
  const provenance = {
    kind: "takosumi-git.deployment-provenance@v1",
    workflowRunId: "takosumi-git:run:audit",
    generatedAt: "2026-05-07T00:00:00.000Z",
    git: {
      repository: "acme/demo",
      ref: "refs/heads/main",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    resourceArtifacts: [{
      resourceName: "logs",
      artifactName: "image",
      artifactUri: "ghcr.io/acme/demo@sha256:abc",
      workflow: { file: "build.yml", job: "image", artifact: "image" },
      stepLogs: [{
        stepName: "build",
        exitCode: 0,
        stdoutDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        stdoutBytes: 123,
      }],
    }],
  };
  await recordStore.upsert({
    tenantId: "space:audit",
    name: "audit-app",
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "audit-app" },
      resources: [SAMPLE_RESOURCE as unknown as JsonObject],
    },
    appliedResources: [],
    status: "failed",
    now: "2026-05-07T00:00:00.000Z",
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "apply",
    stages: ["commit"],
    status: "recorded",
    createdAt: "2026-05-07T00:00:01.000Z",
    detail: { provenance },
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "apply",
    stages: ["abort"],
    status: "failed",
    createdAt: "2026-05-07T00:00:02.000Z",
    detail: {
      reason: "compensate-revoke-debt-enqueued",
      revokeDebtIds: ["revoke-debt:1"],
      provenance,
    },
  });
  await revokeDebtStore.enqueue({
    generatedObjectId: "generated:audit-app/logs",
    reason: "activation-rollback",
    ownerSpaceId: "space:audit",
    deploymentName: "audit-app",
    operationPlanDigest: preview.operationPlanDigest,
    journalEntryId: preview.operations[0].idempotencyKey.journalEntryId,
    operationId: preview.operations[0].operationId,
    resourceName: "logs",
    providerId: SAMPLE_RESOURCE.provider,
    now: "2026-05-07T00:00:02.000Z",
  });
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:audit",
    recordStore,
    operationJournalStore: journal,
    revokeDebtStore,
  });

  const response = await app.request(
    `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/audit-app/audit`,
    { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    status: string;
    audit: {
      deployment: { id: string; name: string };
      provenance: { workflowRunId: string };
      causeChain: Array<{
        stage: string;
        reason?: string;
        provenance?: { workflowRunId: string };
      }>;
      entries: Array<{ provenance?: { workflowRunId: string } }>;
      revokeDebts: Array<{ id: string; reason: string }>;
    };
  };
  assert.equal(body.status, "ok");
  assert.equal(body.audit.deployment.id, "deployment:123");
  assert.equal(body.audit.deployment.name, "audit-app");
  assert.equal(
    body.audit.provenance.workflowRunId,
    "takosumi-git:run:audit",
  );
  assert.deepEqual(
    body.audit.causeChain.map((cause) => cause.stage),
    ["commit", "abort"],
  );
  assert.equal(
    body.audit.causeChain[1].reason,
    "compensate-revoke-debt-enqueued",
  );
  assert.equal(
    body.audit.causeChain[1].provenance?.workflowRunId,
    "takosumi-git:run:audit",
  );
  assert.equal(
    body.audit.entries[0].provenance?.workflowRunId,
    "takosumi-git:run:audit",
  );
  assert.equal(body.audit.revokeDebts[0].id, "revoke-debt:1");
  assert.equal(body.audit.revokeDebts[0].reason, "activation-rollback");
});

Deno.test("deploy public route journal summary stays unfinished until every operation is terminal", async () => {
  const journal = new InMemoryOperationJournalStore();
  const metricsResource: ManifestResource = {
    ...SAMPLE_RESOURCE,
    name: "metrics",
    spec: { name: "metrics", region: "local" },
  };
  const resources = [SAMPLE_RESOURCE, metricsResource];
  const preview = buildOperationPlanPreview({
    resources,
    planned: resources.map((resource) => ({
      name: resource.name,
      shape: resource.shape,
      providerId: resource.provider,
      op: "create" as const,
    })),
    edges: buildRefDag(resources).edges,
    spaceId: "space:partial-terminal",
    deploymentName: "partial-terminal-app",
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "apply",
    stages: ["prepare", "pre-commit", "commit"],
    status: "recorded",
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  const finalizedOperation = preview.operations[0];
  await journal.append({
    spaceId: preview.spaceId,
    deploymentName: preview.deploymentName,
    operationPlanDigest: preview.operationPlanDigest,
    journalEntryId: finalizedOperation.idempotencyKey.journalEntryId,
    operationId: finalizedOperation.operationId,
    phase: "apply",
    stage: "finalize",
    operationKind: finalizedOperation.op,
    resourceName: finalizedOperation.resourceName,
    providerId: finalizedOperation.providerId,
    effect: {
      kind: "takosumi.test.partial-terminal-finalize@v1",
      operationId: finalizedOperation.operationId,
    },
    status: "succeeded",
    createdAt: "2026-05-02T00:00:01.000Z",
  });

  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:partial-terminal",
    operationJournalStore: journal,
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      recoveryMode: "inspect",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "partial-terminal-app" },
        resources,
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    body.outcome.journal.operationPlanDigest,
    preview.operationPlanDigest,
  );
  assert.equal(body.outcome.journal.latestStage, "finalize");
  assert.equal(body.outcome.journal.terminal, false);
});

Deno.test("deploy public route surfaces apply validation failures as 400", async () => {
  const app = createApp({
    token: VALID_TOKEN,
    applyResources: () =>
      Promise.resolve({
        applied: [],
        issues: [{ path: "$.resources[0]", message: "shape unknown" }],
        status: "failed-validation",
      }),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.status, "error");
  assert.equal(body.outcome.status, "failed-validation");
});

Deno.test("deploy public route rejects manifest without resources[]", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "no-resources" },
      },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_argument");
  assert.match(body.error.message, /resources\[\]/);
});

Deno.test("deploy public route rejects unknown mode value", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "rollout",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_argument");
  assert.match(body.error.message, /apply\|plan\|destroy/);
});

Deno.test("deploy public route plan mode runs applyV2 dry-run without persisting", async () => {
  let invoked = false;
  let observedDryRun: boolean | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    applyResources: (_resources, _priorApplied, dryRun) => {
      invoked = true;
      observedDryRun = dryRun;
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
        planned: [{
          name: SAMPLE_RESOURCE.name,
          shape: SAMPLE_RESOURCE.shape,
          providerId: SAMPLE_RESOURCE.provider,
          op: "create",
        }],
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "plan",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(invoked, true, "plan mode must validate through applyResources");
  assert.equal(observedDryRun, true);
  assert.equal(body.outcome.planned.length, 1);
  assert.equal(body.outcome.operationPlanPreview.spaceId, "takosumi-deploy");
  assert.match(
    body.outcome.operationPlanPreview.operationPlanDigest,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.equal(
    body.outcome.operationPlanPreview.operations[0].idempotencyKey
      .operationPlanDigest,
    body.outcome.operationPlanPreview.operationPlanDigest,
  );
});

Deno.test("deploy public route replays same idempotency key without re-applying", async () => {
  let applyCount = 0;
  const app = createApp({
    token: VALID_TOKEN,
    applyResources: (resources) => {
      applyCount += 1;
      return Promise.resolve({
        applied: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: `handle-${applyCount}`,
          outputs: { applyCount },
          specFingerprint: `fnv1a32:${applyCount}`,
        }],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const body = JSON.stringify({
    mode: "apply",
    manifest: {
      apiVersion: "1.0" as const,
      kind: "Manifest" as const,
      metadata: { name: "idem-route-app" },
      resources: [SAMPLE_RESOURCE],
    },
  });
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${VALID_TOKEN}`,
    [TAKOSUMI_IDEMPOTENCY_KEY_HEADER]: "idem-1",
  };
  const first = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get(TAKOSUMI_IDEMPOTENCY_REPLAYED_HEADER), null);

  const second = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(second.status, 200);
  assert.equal(
    second.headers.get(TAKOSUMI_IDEMPOTENCY_REPLAYED_HEADER),
    "true",
  );
  const replayed = await second.json();
  assert.equal(replayed.outcome.applied[0].handle, "handle-1");
  assert.equal(
    applyCount,
    1,
    "same idempotency key + same body must not call applyResources twice",
  );
});

Deno.test("deploy public route rejects same idempotency key with different body", async () => {
  let applyCount = 0;
  const app = createApp({
    token: VALID_TOKEN,
    applyResources: (resources) => {
      applyCount += 1;
      return Promise.resolve({
        applied: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: `handle-${applyCount}`,
          outputs: {},
          specFingerprint: `fnv1a32:${applyCount}`,
        }],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${VALID_TOKEN}`,
    [TAKOSUMI_IDEMPOTENCY_KEY_HEADER]: "idem-conflict",
  };
  const first = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "idem-conflict-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(first.status, 200);

  const second = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "idem-conflict-app" },
        resources: [{ ...SAMPLE_RESOURCE, spec: { name: "other" } }],
      },
    }),
  });
  assert.equal(second.status, 409);
  const error = await second.json();
  assert.equal(error.error.code, "failed_precondition");
  assert.match(error.error.message, /idempotency key/);
  assert.equal(applyCount, 1);
});

const TEST_TEMPLATE_ID = "deploy-public-test-template";
const TEST_TEMPLATE_VERSION = "v1";
const TEST_TEMPLATE_REF = `${TEST_TEMPLATE_ID}@${TEST_TEMPLATE_VERSION}`;

const testTemplate: Template = {
  id: TEST_TEMPLATE_ID,
  version: TEST_TEMPLATE_VERSION,
  description: "fixture for deploy_public_routes template-expansion tests",
  validateInputs(value, issues) {
    if (
      typeof value !== "object" || value === null || Array.isArray(value)
    ) {
      issues.push({ path: "$", message: "must be an object" });
      return;
    }
    const inputs = value as Record<string, unknown>;
    if (typeof inputs.serviceName !== "string" || inputs.serviceName === "") {
      issues.push({
        path: "$.serviceName",
        message: "must be a non-empty string",
      });
    }
  },
  expand(inputs) {
    const serviceName = (inputs as { serviceName: string }).serviceName;
    return [
      {
        shape: "object-store@v1",
        name: serviceName,
        provider: "@takos/selfhost-filesystem",
        spec: { name: serviceName, region: "local" },
      },
    ];
  },
};

Deno.test("deploy public route expands template with valid inputs", async () => {
  registerTemplate(testTemplate);
  try {
    let captured: readonly ManifestResource[] | undefined;
    const app = createApp({
      token: VALID_TOKEN,
      applyResources: (resources) => {
        captured = resources;
        return Promise.resolve({
          applied: [
            {
              name: resources[0].name,
              providerId: resources[0].provider,
              handle: {
                kind: "test",
                id: "applied",
              } as unknown as ApplyV2Outcome["applied"][number]["handle"],
              outputs: { ok: true },
              specFingerprint: "fnv1a32:00000000",
            },
          ],
          issues: [],
          status: "succeeded",
        });
      },
    });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          apiVersion: "1.0" as const,
          kind: "Manifest" as const,
          template: {
            template: TEST_TEMPLATE_REF,
            inputs: { serviceName: "logs" },
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.outcome.status, "succeeded");
    assert.ok(captured, "applyResources must receive expanded resources");
    assert.equal(captured!.length, 1);
    assert.equal(captured![0].name, "logs");
    assert.equal(captured![0].shape, "object-store@v1");
  } finally {
    unregisterTemplate(TEST_TEMPLATE_ID, TEST_TEMPLATE_VERSION);
  }
});

Deno.test("deploy public route surfaces template input validation as 400", async () => {
  registerTemplate(testTemplate);
  try {
    const app = createApp({ token: VALID_TOKEN });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          apiVersion: "1.0" as const,
          kind: "Manifest" as const,
          template: { template: TEST_TEMPLATE_REF, inputs: {} },
        },
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, "invalid_argument");
    assert.match(body.error.message, /serviceName/);
    assert.match(body.error.message, /must be a non-empty string/);
  } finally {
    unregisterTemplate(TEST_TEMPLATE_ID, TEST_TEMPLATE_VERSION);
  }
});

Deno.test("deploy public route appends explicit resources after template expansion", async () => {
  registerTemplate(testTemplate);
  try {
    let captured: readonly ManifestResource[] | undefined;
    const app = createApp({
      token: VALID_TOKEN,
      applyResources: (resources) => {
        captured = resources;
        return Promise.resolve({
          applied: resources.map((resource) => ({
            name: resource.name,
            providerId: resource.provider,
            handle: resource.name,
            outputs: {},
            specFingerprint: "fnv1a32:00000000",
          })),
          issues: [],
          status: "succeeded",
        });
      },
    });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          apiVersion: "1.0" as const,
          kind: "Manifest" as const,
          template: {
            template: TEST_TEMPLATE_REF,
            inputs: { serviceName: "logs" },
          },
          resources: [SAMPLE_RESOURCE],
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.ok(captured, "applyResources must receive expanded resources");
    assert.deepEqual(captured!.map((resource) => resource.name), [
      "logs",
      SAMPLE_RESOURCE.name,
    ]);
  } finally {
    unregisterTemplate(TEST_TEMPLATE_ID, TEST_TEMPLATE_VERSION);
  }
});

Deno.test("deploy public route rejects unknown template ref", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        template: { template: "nonexistent-template@v999", inputs: {} },
      },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_argument");
  assert.match(body.error.message, /not registered/);
});

Deno.test("deploy public route runs destroy mode against destroyV2", async () => {
  let captured: readonly ManifestResource[] | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    destroyResources: (resources) => {
      captured = resources;
      return Promise.resolve(
        {
          destroyed: [
            {
              name: resources[0].name,
              providerId: resources[0].provider,
              handle: resources[0].name,
            },
          ],
          errors: [],
          issues: [],
          status: "succeeded",
        } satisfies DestroyV2Outcome,
      );
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      force: true,
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.outcome.status, "succeeded");
  assert.equal(body.outcome.destroyed.length, 1);
  assert.equal(body.outcome.destroyed[0].name, SAMPLE_RESOURCE.name);
  assert.deepEqual(captured, [SAMPLE_RESOURCE]);
});

Deno.test("deploy public route forwards destroy WAL operation plan to destroyResources", async () => {
  let captured: OperationPlanPreview | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:destroy-forward",
    destroyResources: (resources, _handleFor, operationPlanPreview) => {
      captured = operationPlanPreview;
      return Promise.resolve({
        destroyed: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: resources[0].name,
        }],
        errors: [],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      force: true,
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "destroy-forward-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.ok(captured);
  assert.equal(captured.spaceId, "space:destroy-forward");
  assert.equal(captured.deploymentName, "destroy-forward-app");
  const operation = captured.operations[0];
  assert.ok(operation);
  assert.equal(operation.op, "delete");
  assert.equal(
    operation.idempotencyKey.operationPlanDigest,
    captured.operationPlanDigest,
  );
});

Deno.test("deploy public route recoveryMode continue finalizes destroy already marked destroyed", async () => {
  const journal = new InMemoryOperationJournalStore();
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  await recordStore.upsert({
    tenantId: "space:destroy-continue",
    name: "destroy-continue-app",
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "destroy-continue-app" },
      resources: [SAMPLE_RESOURCE],
    } as unknown as JsonObject,
    appliedResources: [],
    status: "destroyed",
    now: "2026-05-02T00:00:00.000Z",
  });
  const preview = buildOperationPlanPreview({
    resources: [SAMPLE_RESOURCE],
    planned: [{
      name: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      op: "delete",
    }],
    edges: buildRefDag([SAMPLE_RESOURCE]).edges,
    spaceId: "space:destroy-continue",
    deploymentName: "destroy-continue-app",
  });
  await appendOperationPlanJournalStages({
    store: journal,
    preview,
    phase: "destroy",
    stages: ["prepare", "pre-commit", "commit"],
    status: "recorded",
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  let destroyCount = 0;
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:destroy-continue",
    recordStore,
    operationJournalStore: journal,
    now: () => "2026-05-02T00:00:01.000Z",
    destroyResources: () => {
      destroyCount += 1;
      return Promise.resolve({
        destroyed: [],
        errors: [],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      recoveryMode: "continue",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "destroy-continue-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome.status, "succeeded");
  assert.equal(body.outcome.destroyed[0].name, SAMPLE_RESOURCE.name);
  assert.equal(destroyCount, 0);
  const entries = await journal.listByPlan(
    "space:destroy-continue",
    preview.operationPlanDigest,
  );
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    ["prepare", "pre-commit", "commit", "post-commit", "observe", "finalize"],
  );
});

Deno.test("deploy public route records destroy WAL stages", async () => {
  const journal = new InMemoryOperationJournalStore();
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  await recordStore.upsert({
    tenantId: "space:destroy-wal",
    name: "destroy-wal-app",
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "destroy-wal-app" },
      resources: [SAMPLE_RESOURCE],
    } as unknown as JsonObject,
    appliedResources: [{
      resourceName: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      handle: "handle-destroy-wal",
      outputs: {},
      appliedAt: "2026-05-02T00:00:00.000Z",
      specFingerprint: "fnv1a32:00000000",
    }],
    status: "applied",
    now: "2026-05-02T00:00:00.000Z",
  });
  const app = createApp({
    token: VALID_TOKEN,
    tenantId: "space:destroy-wal",
    recordStore,
    operationJournalStore: journal,
    now: () => "2026-05-02T00:00:01.000Z",
    destroyResources: (resources, handleFor) =>
      Promise.resolve({
        destroyed: [{
          name: resources[0].name,
          providerId: resources[0].provider,
          handle: handleFor?.(resources[0]) ?? resources[0].name,
        }],
        errors: [],
        issues: [],
        status: "succeeded",
      }),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "destroy-wal-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);

  const dag = buildRefDag([SAMPLE_RESOURCE]);
  const preview = buildOperationPlanPreview({
    resources: [SAMPLE_RESOURCE],
    planned: [{
      name: SAMPLE_RESOURCE.name,
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      op: "delete",
    }],
    edges: dag.edges,
    spaceId: "space:destroy-wal",
    deploymentName: "destroy-wal-app",
  });
  const entries = await journal.listByPlan(
    "space:destroy-wal",
    preview.operationPlanDigest,
  );
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    ["prepare", "pre-commit", "commit", "post-commit", "observe", "finalize"],
  );
  assert.equal(entries[0].phase, "destroy");
  assert.equal(entries[0].operationKind, "delete");
});

Deno.test("deploy public route surfaces destroy partial outcome with 200 + errors", async () => {
  const app = createApp({
    token: VALID_TOKEN,
    destroyResources: () =>
      Promise.resolve(
        {
          destroyed: [],
          errors: [
            {
              name: "logs",
              providerId: "filesystem",
              handle: "logs",
              message: "boom",
            },
          ],
          issues: [],
          status: "partial",
        } satisfies DestroyV2Outcome,
      ),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      force: true,
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.outcome.status, "partial");
  assert.equal(body.outcome.errors.length, 1);
  assert.equal(body.outcome.errors[0].message, "boom");
});

Deno.test("deploy public route surfaces destroy validation failures as 400", async () => {
  const app = createApp({
    token: VALID_TOKEN,
    destroyResources: () =>
      Promise.resolve(
        {
          destroyed: [],
          errors: [],
          issues: [{ path: "$.resources[0]", message: "shape unknown" }],
          status: "failed-validation",
        } satisfies DestroyV2Outcome,
      ),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      force: true,
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.status, "error");
  assert.equal(body.outcome.status, "failed-validation");
});

// --- Task 2: apply persists to recordStore -----------------------------------

Deno.test("apply persists handles + manifest to recordStore", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    applyResources: () =>
      Promise.resolve({
        applied: [
          {
            name: SAMPLE_RESOURCE.name,
            providerId: SAMPLE_RESOURCE.provider,
            handle: "arn:aws:s3:::real-bucket",
            outputs: { url: "https://logs.example" },
            specFingerprint: "fnv1a32:00000000",
          },
        ],
        issues: [],
        status: "succeeded",
      }),
    now: () => "2026-05-02T00:00:00.000Z",
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "my-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);

  const persisted = await recordStore.get("takosumi-deploy", "my-app");
  assert.ok(persisted, "apply must upsert a record keyed by metadata.name");
  assert.equal(persisted!.status, "applied");
  assert.equal(persisted!.appliedResources.length, 1);
  assert.equal(persisted!.appliedResources[0].resourceName, "logs");
  assert.equal(
    persisted!.appliedResources[0].handle,
    "arn:aws:s3:::real-bucket",
    "persisted handle must be the apply-time ARN, not the resource name",
  );
  assert.equal(persisted!.appliedResources[0].shape, "object-store@v1");
  assert.equal(
    persisted!.appliedResources[0].providerId,
    "@takos/selfhost-filesystem",
  );
});

Deno.test("apply scopes records by configured tenant/Space id", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    tenantId: "space:acme-prod",
    now: () => "2026-05-02T00:00:00.000Z",
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "my-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(
    await recordStore.get("takosumi-deploy", "my-app"),
    undefined,
  );
  const scoped = await recordStore.get("space:acme-prod", "my-app");
  assert.ok(scoped, "apply must use the configured public deploy scope");
  assert.equal(scoped.tenantId, "space:acme-prod");
});

Deno.test("apply persists `failed` status when applyV2 returns failed-apply", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    applyResources: () =>
      Promise.resolve({
        applied: [],
        issues: [{ path: "$", message: "boom" }],
        status: "failed-apply",
      }),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "broken-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 500);
  const persisted = await recordStore.get("takosumi-deploy", "broken-app");
  assert.ok(persisted);
  assert.equal(persisted!.status, "failed");
});

Deno.test("failed update apply preserves prior applied resource handles", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const priorManifest = {
    apiVersion: "1.0" as const,
    kind: "Manifest" as const,
    metadata: { name: "existing-app" },
    resources: [SAMPLE_RESOURCE],
  } as unknown as JsonObject;
  await recordStore.upsert({
    tenantId: "takosumi-deploy",
    name: "existing-app",
    manifest: priorManifest,
    appliedResources: [{
      resourceName: "logs",
      shape: SAMPLE_RESOURCE.shape,
      providerId: SAMPLE_RESOURCE.provider,
      handle: "arn:test:existing",
      outputs: { url: "https://existing.example" },
      appliedAt: "2026-05-01T00:00:00.000Z",
      specFingerprint: "sha256:existing",
    }],
    status: "applied",
    now: "2026-05-01T00:00:00.000Z",
  });
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    applyResources: () =>
      Promise.resolve({
        applied: [],
        issues: [{ path: "$.resources[web]", message: "boom" }],
        status: "failed-apply",
      }),
    now: () => "2026-05-02T00:00:00.000Z",
  });

  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "existing-app" },
        resources: [{
          ...SAMPLE_RESOURCE,
          spec: { name: "logs", region: "us-east-1", upgraded: true },
        }],
      },
    }),
  });

  assert.equal(response.status, 500);
  const persisted = await recordStore.get("takosumi-deploy", "existing-app");
  assert.ok(persisted);
  assert.equal(persisted.status, "failed");
  assert.deepEqual(persisted.manifest, priorManifest);
  assert.equal(persisted.appliedResources.length, 1);
  assert.equal(persisted.appliedResources[0].handle, "arn:test:existing");
});

Deno.test("apply does not persist on validation failure", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    applyResources: () =>
      Promise.resolve({
        applied: [],
        issues: [{ path: "$.resources[0]", message: "shape unknown" }],
        status: "failed-validation",
      }),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "invalid-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 400);
  // failed-validation is a manifest-level fault, not a deploy attempt.
  const persisted = await recordStore.get("takosumi-deploy", "invalid-app");
  assert.equal(persisted, undefined);
});

// --- Task 3: destroy uses persisted handles ----------------------------------

Deno.test("destroy feeds persisted handles into destroyV2 via handleFor", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  // Seed the store with a prior apply.
  await recordStore.upsert({
    tenantId: "takosumi-deploy",
    name: "my-app",
    manifest: { apiVersion: "1.0" as const, kind: "Manifest" as const },
    appliedResources: [{
      resourceName: "logs",
      shape: "object-store@v1",
      providerId: "filesystem",
      handle: "arn:aws:s3:::real-bucket",
      outputs: {},
      appliedAt: "2026-05-01T00:00:00.000Z",
    }],
    status: "applied",
    now: "2026-05-01T00:00:00.000Z",
  });

  let observedHandle: ResourceHandle | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    destroyResources: (resources, handleFor) => {
      observedHandle = handleFor ? handleFor(resources[0]) : undefined;
      return Promise.resolve(
        {
          destroyed: [{
            name: resources[0].name,
            providerId: resources[0].provider,
            handle: handleFor?.(resources[0]) ?? resources[0].name,
          }],
          errors: [],
          issues: [],
          status: "succeeded",
        } satisfies DestroyV2Outcome,
      );
    },
    now: () => "2026-05-02T00:00:00.000Z",
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "my-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    observedHandle,
    "arn:aws:s3:::real-bucket",
    "destroy must receive the persisted handle, not resource.name",
  );
  const persisted = await recordStore.get("takosumi-deploy", "my-app");
  assert.equal(persisted!.status, "destroyed");
  assert.equal(persisted!.appliedResources.length, 0);
});

Deno.test(
  "destroy without prior record refuses with 409 by default",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    let destroyCalled = false;
    const app = createApp({
      token: VALID_TOKEN,
      recordStore,
      destroyResources: () => {
        destroyCalled = true;
        return Promise.resolve(
          {
            destroyed: [],
            errors: [],
            issues: [],
            status: "succeeded",
          } satisfies DestroyV2Outcome,
        );
      },
    });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "destroy",
        manifest: {
          apiVersion: "1.0" as const,
          kind: "Manifest" as const,
          metadata: { name: "ghost" },
          resources: [SAMPLE_RESOURCE],
        },
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error.code, "failed_precondition");
    assert.match(body.error.message, /no prior deploy record/);
    assert.equal(
      destroyCalled,
      false,
      "destroyV2 must not be invoked without state",
    );
  },
);

Deno.test(
  "destroy without prior record falls back to resource.name when force=true",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    let observedHandleFor: unknown = "untouched";
    const app = createApp({
      token: VALID_TOKEN,
      recordStore,
      destroyResources: (_resources, handleFor) => {
        observedHandleFor = handleFor;
        return Promise.resolve(
          {
            destroyed: [{
              name: SAMPLE_RESOURCE.name,
              providerId: SAMPLE_RESOURCE.provider,
              handle: SAMPLE_RESOURCE.name,
            }],
            errors: [],
            issues: [],
            status: "succeeded",
          } satisfies DestroyV2Outcome,
        );
      },
    });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "destroy",
        force: true,
        manifest: {
          apiVersion: "1.0" as const,
          kind: "Manifest" as const,
          metadata: { name: "ghost" },
          resources: [SAMPLE_RESOURCE],
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      observedHandleFor,
      undefined,
      "force: no record means no handleFor (destroyV2 falls back to resource.name)",
    );
  },
);

// --- Task 4: GET /v1/deployments + GET /v1/deployments/:name -----------------

Deno.test("GET /v1/deployments returns the deployment list", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  await recordStore.upsert({
    tenantId: "takosumi-deploy",
    name: "app-1",
    manifest: { apiVersion: "1.0" as const, kind: "Manifest" as const },
    appliedResources: [{
      resourceName: "bucket",
      shape: "object-store@v1",
      providerId: "aws-s3",
      handle: "arn:1",
      outputs: {},
      appliedAt: "2026-05-01T00:00:00.000Z",
    }],
    status: "applied",
    now: "2026-05-01T00:00:00.000Z",
  });
  await recordStore.upsert({
    tenantId: "takosumi-deploy",
    name: "app-2",
    manifest: { apiVersion: "1.0" as const, kind: "Manifest" as const },
    appliedResources: [],
    status: "destroyed",
    now: "2026-05-01T00:00:00.000Z",
  });
  const app = createApp({ token: VALID_TOKEN, recordStore });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    deployments: ReadonlyArray<{
      name: string;
      status: string;
      resources: ReadonlyArray<
        { name: string; shape: string; provider: string; status: string }
      >;
    }>;
  };
  assert.equal(body.deployments.length, 2);
  const names = body.deployments.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["app-1", "app-2"]);
  const app1 = body.deployments.find((entry) => entry.name === "app-1")!;
  assert.equal(app1.status, "applied");
  assert.equal(app1.resources.length, 1);
  assert.equal(app1.resources[0].name, "bucket");
  assert.equal(app1.resources[0].shape, "object-store@v1");
  assert.equal(app1.resources[0].provider, "aws-s3");
});

Deno.test(
  "GET /v1/deployments/:name returns a single deployment record",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    const operationJournalStore = new InMemoryOperationJournalStore();
    await recordStore.upsert({
      tenantId: "takosumi-deploy",
      name: "single",
      manifest: { apiVersion: "1.0" as const, kind: "Manifest" as const },
      appliedResources: [{
        resourceName: "bucket",
        shape: "object-store@v1",
        providerId: "aws-s3",
        handle: "arn:single",
        outputs: { region: "us-east-1" },
        appliedAt: "2026-05-01T00:00:00.000Z",
      }],
      status: "applied",
      now: "2026-05-01T00:00:00.000Z",
    });
    const dag = buildRefDag([SAMPLE_RESOURCE]);
    const preview = buildOperationPlanPreview({
      resources: [SAMPLE_RESOURCE],
      planned: [{
        name: SAMPLE_RESOURCE.name,
        shape: SAMPLE_RESOURCE.shape,
        providerId: SAMPLE_RESOURCE.provider,
        op: "create",
      }],
      edges: dag.edges,
      spaceId: "takosumi-deploy",
      deploymentName: "single",
    });
    await appendOperationPlanJournalStages({
      store: operationJournalStore,
      preview,
      phase: "apply",
      stages: ["prepare", "pre-commit", "commit", "finalize"],
      status: "succeeded",
      createdAt: "2026-05-01T00:00:01.000Z",
    });
    const app = createApp({
      token: VALID_TOKEN,
      recordStore,
      operationJournalStore,
    });
    const response = await app.request(
      `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/single`,
      { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as {
      id: string;
      name: string;
      status: string;
      journal: {
        operationPlanDigest: string;
        phase: string;
        latestStage: string;
        status: string;
        terminal: boolean;
      };
      resources: ReadonlyArray<{ outputs: Record<string, unknown> }>;
    };
    assert.equal(body.id.length > 0, true);
    assert.equal(body.name, "single");
    assert.equal(body.status, "applied");
    assert.equal(body.journal.operationPlanDigest, preview.operationPlanDigest);
    assert.equal(body.journal.phase, "apply");
    assert.equal(body.journal.latestStage, "finalize");
    assert.equal(body.journal.status, "succeeded");
    assert.equal(body.journal.terminal, true);
    assert.deepEqual(body.resources[0].outputs, { region: "us-east-1" });
  },
);

Deno.test("GET /v1/deployments/:name returns 404 when missing", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(
    `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/never-existed`,
    { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
});

Deno.test("GET /v1/deployments rejects missing token", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "unauthenticated");
});

Deno.test("GET /v1/deployments returns 404 when token env unset", async () => {
  const app = createApp({ token: undefined });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    headers: { authorization: "Bearer anything" },
  });
  assert.equal(response.status, 404);
});

// --- Apply idempotency over the public route -------------------------------

Deno.test(
  "apply idempotency: identical re-submission skips provider.apply (matching fingerprint)",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    let applyCount = 0;
    let lastPriorApplied: ReadonlyMap<string, PriorAppliedSnapshot> | undefined;
    const app = createApp({
      token: VALID_TOKEN,
      recordStore,
      applyResources: (resources, priorApplied) => {
        lastPriorApplied = priorApplied;
        // Simulate applyV2 fingerprint computation: deterministic per-spec.
        const seed = JSON.stringify(resources[0].spec);
        const fingerprint = `fnv1a32:${
          seed.length.toString(16).padStart(8, "0")
        }`;
        const snapshot = priorApplied?.get(resources[0].name);
        if (
          snapshot && snapshot.specFingerprint === fingerprint &&
          snapshot.providerId === resources[0].provider
        ) {
          // Reuse path: do not call provider.
          return Promise.resolve({
            applied: [{
              name: resources[0].name,
              providerId: resources[0].provider,
              handle: snapshot.handle,
              outputs: snapshot.outputs,
              specFingerprint: fingerprint,
            }],
            issues: [],
            status: "succeeded" as const,
            reused: 1,
          });
        }
        applyCount += 1;
        return Promise.resolve({
          applied: [{
            name: resources[0].name,
            providerId: resources[0].provider,
            handle: `arn:test:${applyCount}`,
            outputs: { url: `https://test/${applyCount}` },
            specFingerprint: fingerprint,
          }],
          issues: [],
          status: "succeeded" as const,
        });
      },
    });
    const body = JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "idempotent-app" },
        resources: [SAMPLE_RESOURCE],
      },
    });
    // First apply: provider runs.
    const first = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body,
    });
    assert.equal(first.status, 200);
    assert.equal(applyCount, 1);
    assert.equal(
      lastPriorApplied?.size ?? 0,
      0,
      "first apply has no prior snapshot",
    );

    // Second apply: same manifest → fingerprint matches, provider must NOT run.
    const second = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body,
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as {
      outcome: {
        status: string;
        applied: Array<{ handle: string }>;
        reused?: number;
      };
    };
    assert.equal(secondBody.outcome.status, "succeeded");
    assert.equal(secondBody.outcome.reused, 1);
    assert.equal(
      applyCount,
      1,
      "provider.apply must be called only once for identical re-submissions",
    );
    assert.equal(
      lastPriorApplied?.size,
      1,
      "second apply must receive the prior snapshot",
    );
    assert.equal(
      secondBody.outcome.applied[0].handle,
      "arn:test:1",
      "reused entry surfaces the prior handle",
    );
  },
);

Deno.test(
  "apply idempotency: edited spec triggers another provider.apply call",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    let applyCount = 0;
    const app = createApp({
      token: VALID_TOKEN,
      recordStore,
      applyResources: (resources, priorApplied) => {
        const seed = JSON.stringify(resources[0].spec);
        const fingerprint = `fnv1a32:${
          seed.length.toString(16).padStart(8, "0")
        }`;
        const snapshot = priorApplied?.get(resources[0].name);
        if (
          snapshot && snapshot.specFingerprint === fingerprint &&
          snapshot.providerId === resources[0].provider
        ) {
          return Promise.resolve({
            applied: [{
              name: resources[0].name,
              providerId: resources[0].provider,
              handle: snapshot.handle,
              outputs: snapshot.outputs,
              specFingerprint: fingerprint,
            }],
            issues: [],
            status: "succeeded" as const,
            reused: 1,
          });
        }
        applyCount += 1;
        return Promise.resolve({
          applied: [{
            name: resources[0].name,
            providerId: resources[0].provider,
            handle: `arn:test:${applyCount}`,
            outputs: { url: `https://test/${applyCount}` },
            specFingerprint: fingerprint,
          }],
          issues: [],
          status: "succeeded" as const,
        });
      },
    });
    // First apply with one spec.
    const first = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          apiVersion: "1.0" as const,
          kind: "Manifest" as const,
          metadata: { name: "edited-app" },
          resources: [{
            ...SAMPLE_RESOURCE,
            spec: { name: "logs", region: "local" },
          }],
        },
      }),
    });
    assert.equal(first.status, 200);
    assert.equal(applyCount, 1);

    // Second apply: spec edited → fingerprint changes → provider runs again.
    const second = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          apiVersion: "1.0" as const,
          kind: "Manifest" as const,
          metadata: { name: "edited-app" },
          resources: [{
            ...SAMPLE_RESOURCE,
            spec: { name: "logs", region: "us-east-1", upgraded: true },
          }],
        },
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(
      applyCount,
      2,
      "edited spec must call provider.apply again",
    );
  },
);

// --- Concurrency lock over the public route --------------------------------

Deno.test(
  "concurrent apply submissions for the same deployment serialise via recordStore lock",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    let inFlight = 0;
    let maxInFlight = 0;
    const app = createApp({
      token: VALID_TOKEN,
      recordStore,
      applyResources: async (resources) => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield several times so the second apply has a chance to overlap
        // if the lock was missing.
        for (let i = 0; i < 20; i++) await Promise.resolve();
        inFlight -= 1;
        return {
          applied: [{
            name: resources[0].name,
            providerId: resources[0].provider,
            handle: "arn:test:concurrent",
            outputs: { ok: true },
            specFingerprint: "fnv1a32:00000000",
          }],
          issues: [],
          status: "succeeded" as const,
        };
      },
    });
    const body = JSON.stringify({
      mode: "apply",
      manifest: {
        apiVersion: "1.0" as const,
        kind: "Manifest" as const,
        metadata: { name: "concurrent-app" },
        resources: [SAMPLE_RESOURCE],
      },
    });
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    };
    const [r1, r2] = await Promise.all([
      app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
        method: "POST",
        headers,
        body,
      }),
      app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
        method: "POST",
        headers,
        body,
      }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(
      maxInFlight,
      1,
      "lock must prevent both applies from overlapping inside applyResources",
    );
  },
);

Deno.test(
  "concurrent applies on different deployments are not blocked by each other",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    let inFlight = 0;
    let maxInFlight = 0;
    let entered = 0;
    let releaseBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      releaseBothEntered = resolve;
    });
    const app = createApp({
      token: VALID_TOKEN,
      recordStore,
      applyResources: async (resources) => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        entered += 1;
        if (entered === 2) releaseBothEntered();
        const timeout = setTimeout(() => releaseBothEntered(), 50);
        await bothEntered.finally(() => clearTimeout(timeout));
        inFlight -= 1;
        return {
          applied: [{
            name: resources[0].name,
            providerId: resources[0].provider,
            handle: "arn:test:parallel",
            outputs: { ok: true },
            specFingerprint: "fnv1a32:00000000",
          }],
          issues: [],
          status: "succeeded" as const,
        };
      },
    });
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    };
    const [r1, r2] = await Promise.all([
      app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
        method: "POST",
        headers,
        body: JSON.stringify({
          mode: "apply",
          manifest: {
            apiVersion: "1.0" as const,
            kind: "Manifest" as const,
            metadata: { name: "deploy-a" },
            resources: [SAMPLE_RESOURCE],
          },
        }),
      }),
      app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
        method: "POST",
        headers,
        body: JSON.stringify({
          mode: "apply",
          manifest: {
            apiVersion: "1.0" as const,
            kind: "Manifest" as const,
            metadata: { name: "deploy-b" },
            resources: [SAMPLE_RESOURCE],
          },
        }),
      }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(
      maxInFlight,
      2,
      "different deployment names must not share the same lock",
    );
  },
);
