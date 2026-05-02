/**
 * Unit tests for `provider.gcp.cloud-run@v1` materializer (Phase 17A2).
 */

import assert from "node:assert/strict";
import {
  GCP_CLOUD_RUN_DESCRIPTOR,
  type GcpCloudRunDeployClient,
  type GcpCloudRunDeployResult,
  GcpCloudRunProviderMaterializer,
} from "../src/providers/gcp/mod.ts";
import type { RuntimeDesiredState } from "takosumi-contract";

const now = "2026-04-30T00:00:00.000Z";

function clock(): () => Date {
  return () => new Date(now);
}

function idGen(): () => string {
  let n = 0;
  return () => `id_${++n}`;
}

function desired(): RuntimeDesiredState {
  return {
    id: "desired_1",
    spaceId: "space",
    groupId: "group",
    activationId: "activation",
    appName: "docs",
    materializedAt: now,
    workloads: [],
    resources: [],
    routes: [],
  };
}

class FakeClient implements GcpCloudRunDeployClient {
  applyCalls: unknown[] = [];
  describeCalls: unknown[] = [];
  result: GcpCloudRunDeployResult = {
    serviceName: "docs",
    revisionName: "docs-00001-abc",
    url: "https://docs-1234.run.app",
    observed: {
      serviceName: "docs",
      revisionName: "docs-00001-abc",
      url: "https://docs-1234.run.app",
      imageRef: "gcr.io/p/docs:1",
      ready: true,
    },
  };
  shouldFail?: () => Error | undefined;

  applyService(input: unknown): Promise<GcpCloudRunDeployResult> {
    this.applyCalls.push(input);
    if (this.shouldFail) {
      const err = this.shouldFail();
      if (err) return Promise.reject(err);
    }
    return Promise.resolve(this.result);
  }

  describeService(input: unknown) {
    this.describeCalls.push(input);
    return Promise.resolve(this.result.observed);
  }
}

Deno.test("cloud-run: materialize records condition + idempotency key on success", async () => {
  const fake = new FakeClient();
  const provider = new GcpCloudRunProviderMaterializer({
    client: fake,
    projectId: "proj",
    region: "us-central1",
    serviceName: "docs",
    imageRef: "gcr.io/p/docs:1",
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(desired());
  assert.equal(plan.provider, "gcp");
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0]!;
  assert.equal(op.kind, "gcp-cloud-run-apply");
  assert.equal(op.execution?.status, "succeeded");
  assert.equal(
    (op.details as Record<string, unknown>).descriptor,
    GCP_CLOUD_RUN_DESCRIPTOR,
  );
  assert.match(
    String((op.details as Record<string, unknown>).idempotencyKey),
    /^gcp-/,
  );
  assert.equal((op.details as Record<string, unknown>).retryAttempts, 0);
});

Deno.test("cloud-run: retries transient rate-limited error then succeeds", async () => {
  const fake = new FakeClient();
  let calls = 0;
  fake.shouldFail = () => {
    calls += 1;
    if (calls <= 2) {
      return Object.assign(new Error("quota"), {
        status: "RESOURCE_EXHAUSTED",
      });
    }
    return undefined;
  };
  const provider = new GcpCloudRunProviderMaterializer({
    client: fake,
    projectId: "proj",
    region: "us-central1",
    serviceName: "docs",
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

Deno.test("cloud-run: permission-denied surfaces failed condition without retry", async () => {
  const fake = new FakeClient();
  let calls = 0;
  fake.shouldFail = () => {
    calls += 1;
    return Object.assign(new Error("forbidden"), {
      status: "PERMISSION_DENIED",
    });
  };
  const provider = new GcpCloudRunProviderMaterializer({
    client: fake,
    projectId: "proj",
    region: "us-central1",
    serviceName: "docs",
    clock: clock(),
    idGenerator: idGen(),
    runtime: { sleep: () => Promise.resolve() },
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.execution?.status, "failed");
  const condition = (op.details as Record<string, unknown>).condition as {
    status: string;
  };
  assert.equal(condition.status, "permission-denied");
  assert.equal(calls, 1);
});

Deno.test("cloud-run: drift report compares observed against desired", async () => {
  const fake = new FakeClient();
  fake.result = {
    ...fake.result,
    observed: {
      serviceName: "docs",
      imageRef: "gcr.io/p/docs:1",
      serviceAccount: "different-sa",
    },
  };
  const provider = new GcpCloudRunProviderMaterializer({
    client: fake,
    projectId: "proj",
    region: "us-central1",
    serviceName: "docs",
    imageRef: "gcr.io/p/docs:1",
    serviceAccount: "expected-sa",
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
  assert.ok(drift.entries.some((e) => e.path === "serviceAccount"));
});

Deno.test("cloud-run: observe() returns missing when describe yields undefined", async () => {
  const fake = new FakeClient();
  fake.describeService = () => Promise.resolve(undefined);
  const provider = new GcpCloudRunProviderMaterializer({
    client: fake,
    projectId: "proj",
    region: "us-central1",
    serviceName: "docs",
    clock: clock(),
    idGenerator: idGen(),
  });
  const report = await provider.observe();
  assert.equal(report.status, "missing");
});
