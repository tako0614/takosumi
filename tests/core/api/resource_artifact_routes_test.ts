import { expect, test } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";
import { ActivityService } from "../../../core/domains/activity/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import {
  createInMemoryResourceShapeStores,
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

test("retired Resource artifact route stays unavailable with and without a bearer", async () => {
  const { app, ledger, writer } = await fixture();
  const bytes = new TextEncoder().encode("retired worker artifact");
  const digest = await digestOf(bytes);

  for (const token of [undefined, TOKEN]) {
    const response = await app.request(artifactRequest(bytes, digest, token));
    expect(response.status).toBe(404);
  }

  expect(writer.writes).toHaveLength(0);
  expect(await ledger.listRunsByWorkspace("workspace_1")).toEqual([]);
  expect(await ledger.listActivityEvents("workspace_1")).toEqual([]);
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
