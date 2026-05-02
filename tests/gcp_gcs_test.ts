/**
 * Unit tests for `provider.gcp.gcs@v1` materializer (Phase 17A2).
 */

import assert from "node:assert/strict";
import {
  GCP_GCS_DESCRIPTOR,
  type GcpGcsBucketAdminClient,
  type GcpGcsEnsureResult,
  type GcpGcsListObjectsResult,
  GcpGcsProviderMaterializer,
} from "../src/providers/gcp/mod.ts";
import type { RuntimeDesiredState } from "takosumi-contract";

const now = "2026-04-30T00:00:00.000Z";
const clock = () => () => new Date(now);
const idGen = () => {
  let n = 0;
  return () => `id_${++n}`;
};

function desired(): RuntimeDesiredState {
  return {
    id: "desired_1",
    spaceId: "space",
    groupId: "group",
    activationId: "activation",
    appName: "store",
    materializedAt: now,
    workloads: [],
    resources: [],
    routes: [],
  };
}

class FakeClient implements GcpGcsBucketAdminClient {
  ensureCalls: unknown[] = [];
  describeCalls: unknown[] = [];
  listCalls: unknown[] = [];
  result: GcpGcsEnsureResult = {
    bucketName: "store-bucket",
    location: "US",
    selfLink: "https://storage.googleapis.com/store-bucket",
    observed: {
      bucketName: "store-bucket",
      location: "US",
      storageClass: "STANDARD",
      versioning: true,
      publicAccessPrevention: "enforced",
    },
  };
  pages: GcpGcsListObjectsResult[] = [];
  shouldFail?: () => Error | undefined;

  ensureBucket(input: unknown): Promise<GcpGcsEnsureResult> {
    this.ensureCalls.push(input);
    if (this.shouldFail) {
      const err = this.shouldFail();
      if (err) return Promise.reject(err);
    }
    return Promise.resolve(this.result);
  }

  describeBucket(input: unknown) {
    this.describeCalls.push(input);
    return Promise.resolve(this.result.observed);
  }

  listBucketObjects(input: unknown): Promise<GcpGcsListObjectsResult> {
    this.listCalls.push(input);
    const next = this.pages.shift() ??
      ({ objects: [], nextPageToken: undefined } as GcpGcsListObjectsResult);
    return Promise.resolve(next);
  }
}

Deno.test("gcs: materialize records descriptor and idempotency key", async () => {
  const fake = new FakeClient();
  const provider = new GcpGcsProviderMaterializer({
    client: fake,
    projectId: "proj",
    bucketName: "store-bucket",
    location: "US",
    storageClass: "STANDARD",
    versioning: true,
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.kind, "gcp-gcs-ensure");
  assert.equal(op.execution?.status, "succeeded");
  assert.equal(
    (op.details as Record<string, unknown>).descriptor,
    GCP_GCS_DESCRIPTOR,
  );
  assert.equal(plan.objectAddress, "gs://store-bucket");
});

Deno.test("gcs: HTTP 429 retries until success", async () => {
  const fake = new FakeClient();
  let calls = 0;
  fake.shouldFail = () => {
    calls += 1;
    if (calls <= 2) {
      return Object.assign(new Error("rate"), { httpStatus: 429 });
    }
    return undefined;
  };
  const provider = new GcpGcsProviderMaterializer({
    client: fake,
    projectId: "proj",
    bucketName: "store-bucket",
    clock: clock(),
    idGenerator: idGen(),
    runtime: {
      sleep: () => Promise.resolve(),
      random: () => 0,
      policy: {
        timeoutMs: 60_000,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
        maxRetries: 5,
        jitterMs: 0,
      },
    },
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.execution?.status, "succeeded");
  assert.equal((op.details as Record<string, unknown>).retryAttempts, 2);
});

Deno.test("gcs: invalid-argument is non-retriable failure", async () => {
  const fake = new FakeClient();
  fake.shouldFail = () =>
    Object.assign(new Error("bad"), { status: "INVALID_ARGUMENT" });
  const provider = new GcpGcsProviderMaterializer({
    client: fake,
    projectId: "proj",
    bucketName: "store-bucket",
    clock: clock(),
    idGenerator: idGen(),
    runtime: { sleep: () => Promise.resolve() },
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.execution?.status, "failed");
  const cond = (op.details as Record<string, unknown>).condition as {
    status: string;
  };
  assert.equal(cond.status, "invalid-argument");
});

Deno.test("gcs: drift report flags differing storage class", async () => {
  const fake = new FakeClient();
  fake.result = {
    ...fake.result,
    observed: {
      bucketName: "store-bucket",
      storageClass: "NEARLINE",
      versioning: true,
    },
  };
  const provider = new GcpGcsProviderMaterializer({
    client: fake,
    projectId: "proj",
    bucketName: "store-bucket",
    storageClass: "STANDARD",
    versioning: true,
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  const drift = (op.details as Record<string, unknown>).drift as {
    status: string;
    entries: Array<{ path: string }>;
  };
  assert.equal(drift.status, "drift");
  assert.ok(drift.entries.some((e) => e.path === "storageClass"));
});

Deno.test("gcs: listAllObjects paginates over multiple pages", async () => {
  const fake = new FakeClient();
  fake.pages = [
    { objects: [{ name: "a" }, { name: "b" }], nextPageToken: "p2" },
    { objects: [{ name: "c" }], nextPageToken: undefined },
  ];
  const provider = new GcpGcsProviderMaterializer({
    client: fake,
    projectId: "proj",
    bucketName: "store-bucket",
    clock: clock(),
    idGenerator: idGen(),
  });
  const all = await provider.listAllObjects({ pageSize: 2 });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((o) => o.name), ["a", "b", "c"]);
  assert.equal(fake.listCalls.length, 2);
});
