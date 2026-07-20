import { expect, test } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";
import { ActivityService } from "../../../core/domains/activity/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import {
  createInMemoryResourceShapeStores,
  formatResourceShapeId,
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  ResourceArtifactService,
  ResourceShapeService,
  StubResourceShapeAdapter,
} from "../../../core/domains/resource-shape/mod.ts";
import { sha256HexAsync } from "../../../core/shared/runtime/hash.ts";
import type {
  ActorContext,
  ResourceArtifactPointer,
  ResourceArtifactWriter,
  ResourceArtifactWriteInput,
  ResourceArtifactWriteScope,
} from "takosumi-contract";

const TOKEN = "resource-artifact-test-token";
const CREATED_AT = "2026-07-20T00:00:00.000Z";

class RecordingArtifactWriter implements ResourceArtifactWriter {
  readonly writes: ResourceArtifactWriteInput[] = [];
  maxBytes = 1024;
  throwOnWrite = false;
  substituteDigest = false;

  prepare(_scope: ResourceArtifactWriteScope): { readonly maxBytes: number } {
    return { maxBytes: this.maxBytes };
  }

  async write(
    input: ResourceArtifactWriteInput,
  ): Promise<ResourceArtifactPointer> {
    this.writes.push(input);
    if (this.throwOnWrite) throw new Error("storage unavailable");
    return {
      purpose: input.purpose,
      ref: `test-artifact:v1:${input.workspaceId}:${input.runId}`,
      digest: this.substituteDigest
        ? (`sha256:${"f".repeat(64)}` as const)
        : input.expectedDigest,
      sizeBytes: input.bytes.byteLength,
    };
  }
}

async function fixture(
  actor: ActorContext = actorFor("workspace_1", ["resources:write"]),
) {
  const ledger = new InMemoryOpenTofuControlStore();
  const activity = new ActivityService({
    store: ledger,
    now: () => new Date(CREATED_AT),
  });
  const writer = new RecordingArtifactWriter();
  const artifacts = new ResourceArtifactService({
    store: ledger,
    activity,
    writer,
    now: () => CREATED_AT,
  });
  const resourceStores = createInMemoryResourceShapeStores();
  const service = new ResourceShapeService({
    stores: resourceStores,
    adapter: new StubResourceShapeAdapter(),
    activity,
    operationRuns: ledger,
    schemaRegistry: LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    now: () => CREATED_AT,
  });
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    resourceShapeRouteOptions: {
      service,
      artifactService: artifacts,
      enabledResourceShapeKinds: ["EdgeWorker"],
      installedResourceShapeKinds:
        LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY.kinds(),
      getResourceShapeBearerToken: () => TOKEN,
      resolveActor: () => actor,
    },
    requestCorrelation: false,
  });
  return { app, ledger, writer, resourceStores };
}

test("Resource artifact route authenticates, scopes, and tenant-binds raw bytes", async () => {
  const bytes = new TextEncoder().encode("worker artifact");
  const digest = await digestOf(bytes);
  const noAuth = await fixture();
  expect(
    (await noAuth.app.request(artifactRequest(bytes, digest))).status,
  ).toBe(401);

  const readOnly = await fixture(actorFor("workspace_1", ["resources:read"]));
  expect(
    (await readOnly.app.request(artifactRequest(bytes, digest, TOKEN))).status,
  ).toBe(403);

  const otherTenant = await fixture(
    actorFor("workspace_other", ["resources:write"]),
  );
  expect(
    (await otherTenant.app.request(artifactRequest(bytes, digest, TOKEN)))
      .status,
  ).toBe(403);
  expect(otherTenant.writer.writes).toHaveLength(0);

  const invalidHeaders = await fixture();
  const invalid = artifactRequest(bytes, digest, TOKEN);
  invalid.headers.set("x-takosumi-artifact-purpose", "invalid purpose");
  expect((await invalidHeaders.app.request(invalid)).status).toBe(400);
  expect(invalidHeaders.writer.writes).toHaveLength(0);
});

test("Resource artifact staging persists one canonical Run and replays without rewriting bytes", async () => {
  const { app, ledger, writer, resourceStores } = await fixture();
  const bytes = new TextEncoder().encode("immutable worker archive");
  const digest = await digestOf(bytes);
  const first = await app.request(artifactRequest(bytes, digest, TOKEN));
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as {
    artifact: ResourceArtifactPointer;
    run: Record<string, unknown>;
    replayed: boolean;
  };
  expect(firstBody.replayed).toBe(false);
  expect(firstBody.artifact.digest).toBe(digest);
  expect(firstBody.run).toMatchObject({
    type: "artifact",
    status: "succeeded",
    resourceOperation: "artifact",
    workspaceId: "workspace_1",
  });
  expect(firstBody.run).not.toHaveProperty("resourceOperationKey");
  expect(firstBody.run).not.toHaveProperty("resourceOperationResult");
  expect(writer.writes).toHaveLength(1);

  const runId = String(firstBody.run.id);
  expect(await ledger.listArtifactRecordsForRun(runId)).toEqual([
    {
      id: `artifact_${runId.slice("run_".length)}`,
      runId,
      kind: "worker_release",
      ref: firstBody.artifact.ref,
      digest,
      sizeBytes: bytes.byteLength,
      createdAt: CREATED_AT,
    },
  ]);
  expect(
    await resourceStores.resources.get(
      formatResourceShapeId("workspace_1", "EdgeWorker", "takos"),
    ),
  ).toBeUndefined();

  const replay = await app.request(artifactRequest(bytes, digest, TOKEN));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    artifact: firstBody.artifact,
    run: { id: runId, status: "succeeded" },
    replayed: true,
  });
  expect(writer.writes).toHaveLength(1);
});

test("Resource artifact staging rejects digest mismatch, oversize, and key substitution", async () => {
  const { app, writer } = await fixture();
  const bytes = new TextEncoder().encode("first artifact");
  const digest = await digestOf(bytes);

  const mismatch = await app.request(
    artifactRequest(bytes, `sha256:${"0".repeat(64)}`, TOKEN),
  );
  expect(mismatch.status).toBe(400);
  expect(writer.writes).toHaveLength(0);

  writer.maxBytes = bytes.byteLength - 1;
  const oversize = await app.request(artifactRequest(bytes, digest, TOKEN));
  expect(oversize.status).toBe(413);
  expect(writer.writes).toHaveLength(0);

  writer.maxBytes = 1024;
  expect(
    (await app.request(artifactRequest(bytes, digest, TOKEN))).status,
  ).toBe(200);
  const changed = new TextEncoder().encode("different artifact");
  const conflict = await app.request(
    artifactRequest(changed, await digestOf(changed), TOKEN),
  );
  expect(conflict.status).toBe(409);
  expect(writer.writes).toHaveLength(1);
});

test("Resource artifact staging leaves a retryable Run on host failure and rejects substituted evidence", async () => {
  const { app, writer } = await fixture();
  const bytes = new TextEncoder().encode("retryable artifact");
  const digest = await digestOf(bytes);
  writer.throwOnWrite = true;
  const unavailable = await app.request(artifactRequest(bytes, digest, TOKEN));
  expect(unavailable.status).toBe(503);

  writer.throwOnWrite = false;
  const retried = await app.request(artifactRequest(bytes, digest, TOKEN));
  expect(retried.status).toBe(200);
  expect((await retried.json()) as { replayed: boolean }).toMatchObject({
    replayed: true,
  });

  const second = await fixture();
  second.writer.substituteDigest = true;
  const invalid = await second.app.request(
    artifactRequest(bytes, digest, TOKEN, "artifact-key-0002"),
  );
  expect(invalid.status).toBe(502);
});

function actorFor(workspaceId: string, scopes: string[]): ActorContext {
  return {
    actorAccountId: "account_1",
    workspaceId,
    roles: ["operator"],
    scopes,
    requestId: "request_1",
  };
}

function artifactRequest(
  bytes: Uint8Array,
  digest: string,
  token?: string,
  idempotencyKey = "artifact-key-0001",
): Request {
  return new Request(
    "http://localhost/v1/resources/EdgeWorker/takos/artifacts?space=workspace_1",
    {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/gzip",
        "idempotency-key": idempotencyKey,
        "x-takosumi-artifact-purpose": "worker_release",
        "x-takosumi-artifact-sha256": digest,
      },
      body: bytes,
    },
  );
}

async function digestOf(bytes: Uint8Array): Promise<`sha256:${string}`> {
  return `sha256:${await sha256HexAsync(bytes)}`;
}
