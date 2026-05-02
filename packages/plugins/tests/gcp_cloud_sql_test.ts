/**
 * Unit tests for `provider.gcp.cloud-sql@v1` materializer (Phase 17A2).
 */

import assert from "node:assert/strict";
import {
  GCP_CLOUD_SQL_DESCRIPTOR,
  type GcpCloudSqlAdminClient,
  type GcpCloudSqlEnsureResult,
  GcpCloudSqlProviderMaterializer,
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
    appName: "data",
    materializedAt: now,
    workloads: [],
    resources: [],
    routes: [],
  };
}

class FakeClient implements GcpCloudSqlAdminClient {
  ensureCalls: unknown[] = [];
  describeCalls: unknown[] = [];
  result: GcpCloudSqlEnsureResult = {
    instanceId: "data-pg",
    connectionName: "proj:us-central1:data-pg",
    databaseName: "app",
    userName: "app",
    observed: {
      instanceId: "data-pg",
      databaseVersion: "POSTGRES_16",
      tier: "db-f1-micro",
      region: "us-central1",
      state: "RUNNABLE",
      connectionName: "proj:us-central1:data-pg",
    },
  };
  shouldFail?: () => Error | undefined;

  ensureInstance(input: unknown): Promise<GcpCloudSqlEnsureResult> {
    this.ensureCalls.push(input);
    if (this.shouldFail) {
      const err = this.shouldFail();
      if (err) return Promise.reject(err);
    }
    return Promise.resolve(this.result);
  }

  describeInstance(input: unknown) {
    this.describeCalls.push(input);
    return Promise.resolve(this.result.observed);
  }
}

Deno.test("cloud-sql: materialize records descriptor and idempotency key", async () => {
  const fake = new FakeClient();
  const provider = new GcpCloudSqlProviderMaterializer({
    client: fake,
    projectId: "proj",
    region: "us-central1",
    instanceId: "data-pg",
    databaseVersion: "POSTGRES_16",
    tier: "db-f1-micro",
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.kind, "gcp-cloud-sql-ensure");
  assert.equal(op.execution?.status, "succeeded");
  assert.equal(
    (op.details as Record<string, unknown>).descriptor,
    GCP_CLOUD_SQL_DESCRIPTOR,
  );
  assert.match(
    String((op.details as Record<string, unknown>).idempotencyKey),
    /^gcp-/,
  );
});

Deno.test("cloud-sql: NOT_FOUND surfaces failed condition without retries", async () => {
  const fake = new FakeClient();
  let calls = 0;
  fake.shouldFail = () => {
    calls += 1;
    return Object.assign(new Error("missing"), { status: "NOT_FOUND" });
  };
  const provider = new GcpCloudSqlProviderMaterializer({
    client: fake,
    projectId: "proj",
    region: "us-central1",
    instanceId: "data-pg",
    clock: clock(),
    idGenerator: idGen(),
    runtime: { sleep: () => Promise.resolve() },
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.execution?.status, "failed");
  const condition = (op.details as Record<string, unknown>).condition as {
    status: string;
    retriable: boolean;
  };
  assert.equal(condition.status, "not-found");
  assert.equal(condition.retriable, false);
  assert.equal(calls, 1);
});

Deno.test("cloud-sql: retries on UNAVAILABLE then succeeds", async () => {
  const fake = new FakeClient();
  let calls = 0;
  fake.shouldFail = () => {
    calls += 1;
    if (calls <= 1) {
      return Object.assign(new Error("backend"), { status: "UNAVAILABLE" });
    }
    return undefined;
  };
  const provider = new GcpCloudSqlProviderMaterializer({
    client: fake,
    projectId: "proj",
    region: "us-central1",
    instanceId: "data-pg",
    clock: clock(),
    idGenerator: idGen(),
    runtime: {
      sleep: () => Promise.resolve(),
      random: () => 0,
      policy: {
        timeoutMs: 60_000,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
        maxRetries: 3,
        jitterMs: 0,
      },
    },
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.execution?.status, "succeeded");
  assert.equal((op.details as Record<string, unknown>).retryAttempts, 1);
});

Deno.test("cloud-sql: drift detected when desired tier differs from observed", async () => {
  const fake = new FakeClient();
  fake.result = {
    ...fake.result,
    observed: {
      instanceId: "data-pg",
      tier: "db-g1-small",
      databaseVersion: "POSTGRES_16",
      region: "us-central1",
    },
  };
  const provider = new GcpCloudSqlProviderMaterializer({
    client: fake,
    projectId: "proj",
    region: "us-central1",
    instanceId: "data-pg",
    tier: "db-f1-micro",
    databaseVersion: "POSTGRES_16",
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
  assert.ok(drift.entries.some((e) => e.path === "tier"));
});

Deno.test("cloud-sql: observe() falls back to unknown when describe is absent", async () => {
  // Pass a minimal client lacking describeInstance to exercise the fallback.
  const provider = new GcpCloudSqlProviderMaterializer({
    client: {
      ensureInstance() {
        return Promise.resolve({ instanceId: "data-pg" });
      },
    },
    projectId: "proj",
    region: "us-central1",
    instanceId: "data-pg",
    clock: clock(),
    idGenerator: idGen(),
  });
  const report = await provider.observe();
  assert.equal(report.status, "unknown");
});
