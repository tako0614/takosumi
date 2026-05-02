/**
 * Unit tests for `provider.gcp.secret-manager@v1` materializer (Phase 17A2).
 */

import assert from "node:assert/strict";
import {
  GCP_SECRET_MANAGER_DESCRIPTOR,
  type GcpSecretManagerAdminClient,
  type GcpSecretManagerEnsureResult,
  GcpSecretManagerProviderMaterializer,
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
    appName: "secret",
    materializedAt: now,
    workloads: [],
    resources: [],
    routes: [],
  };
}

class FakeClient implements GcpSecretManagerAdminClient {
  ensureCalls: unknown[] = [];
  describeCalls: unknown[] = [];
  result: GcpSecretManagerEnsureResult = {
    secretResourceName: "projects/proj/secrets/db-password",
    latestVersion: "1",
    observed: {
      secretResourceName: "projects/proj/secrets/db-password",
      replicationPolicy: "automatic",
      latestVersion: "1",
    },
  };
  shouldFail?: () => Error | undefined;

  ensureSecret(input: unknown): Promise<GcpSecretManagerEnsureResult> {
    this.ensureCalls.push(input);
    if (this.shouldFail) {
      const err = this.shouldFail();
      if (err) return Promise.reject(err);
    }
    return Promise.resolve(this.result);
  }

  describeSecret(input: unknown) {
    this.describeCalls.push(input);
    return Promise.resolve(this.result.observed);
  }
}

Deno.test("secret-manager: materialize records descriptor and idempotency key", async () => {
  const fake = new FakeClient();
  const provider = new GcpSecretManagerProviderMaterializer({
    client: fake,
    projectId: "proj",
    secretId: "db-password",
    replicationPolicy: "automatic",
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.kind, "gcp-secret-manager-ensure");
  assert.equal(op.execution?.status, "succeeded");
  assert.equal(
    (op.details as Record<string, unknown>).descriptor,
    GCP_SECRET_MANAGER_DESCRIPTOR,
  );
  assert.equal(plan.objectAddress, "projects/proj/secrets/db-password");
});

Deno.test("secret-manager: 401 unauthorized maps to permission-denied", async () => {
  const fake = new FakeClient();
  fake.shouldFail = () =>
    Object.assign(new Error("unauthorized"), { httpStatus: 401 });
  const provider = new GcpSecretManagerProviderMaterializer({
    client: fake,
    projectId: "proj",
    secretId: "db-password",
    clock: clock(),
    idGenerator: idGen(),
    runtime: { sleep: () => Promise.resolve() },
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.execution?.status, "failed");
  const cond = (op.details as Record<string, unknown>).condition as {
    status: string;
    httpStatus?: number;
  };
  assert.equal(cond.status, "permission-denied");
  assert.equal(cond.httpStatus, 401);
});

Deno.test("secret-manager: 504 gateway timeout retries until success", async () => {
  const fake = new FakeClient();
  let calls = 0;
  fake.shouldFail = () => {
    calls += 1;
    if (calls <= 2) {
      return Object.assign(new Error("gw timeout"), { httpStatus: 504 });
    }
    return undefined;
  };
  const provider = new GcpSecretManagerProviderMaterializer({
    client: fake,
    projectId: "proj",
    secretId: "db-password",
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

Deno.test("secret-manager: drift report flags replication policy mismatch", async () => {
  const fake = new FakeClient();
  fake.result = {
    ...fake.result,
    observed: {
      secretResourceName: "projects/proj/secrets/db-password",
      replicationPolicy: "user-managed",
    },
  };
  const provider = new GcpSecretManagerProviderMaterializer({
    client: fake,
    projectId: "proj",
    secretId: "db-password",
    replicationPolicy: "automatic",
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
  assert.ok(drift.entries.some((e) => e.path === "replicationPolicy"));
});

Deno.test("secret-manager: observe() returns missing when describe yields undefined", async () => {
  const fake = new FakeClient();
  fake.describeSecret = () => Promise.resolve(undefined);
  const provider = new GcpSecretManagerProviderMaterializer({
    client: fake,
    projectId: "proj",
    secretId: "db-password",
    clock: clock(),
    idGenerator: idGen(),
  });
  const report = await provider.observe();
  assert.equal(report.status, "missing");
});
