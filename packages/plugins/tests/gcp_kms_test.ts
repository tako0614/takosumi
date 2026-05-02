/**
 * Unit tests for `provider.gcp.kms@v1` materializer (Phase 17A2).
 */

import assert from "node:assert/strict";
import {
  GCP_KMS_DESCRIPTOR,
  type GcpKmsAdminClient,
  type GcpKmsEnsureResult,
  GcpKmsProviderMaterializer,
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
    appName: "kms",
    materializedAt: now,
    workloads: [],
    resources: [],
    routes: [],
  };
}

class FakeClient implements GcpKmsAdminClient {
  ensureCalls: unknown[] = [];
  describeCalls: unknown[] = [];
  result: GcpKmsEnsureResult = {
    cryptoKeyResourceName:
      "projects/proj/locations/us-central1/keyRings/ring/cryptoKeys/key",
    primaryVersion: "1",
    observed: {
      cryptoKeyResourceName:
        "projects/proj/locations/us-central1/keyRings/ring/cryptoKeys/key",
      purpose: "ENCRYPT_DECRYPT",
      rotationPeriod: "7776000s",
      protectionLevel: "SOFTWARE",
      primaryVersion: "1",
    },
  };
  shouldFail?: () => Error | undefined;

  ensureCryptoKey(input: unknown): Promise<GcpKmsEnsureResult> {
    this.ensureCalls.push(input);
    if (this.shouldFail) {
      const err = this.shouldFail();
      if (err) return Promise.reject(err);
    }
    return Promise.resolve(this.result);
  }

  describeCryptoKey(input: unknown) {
    this.describeCalls.push(input);
    return Promise.resolve(this.result.observed);
  }
}

Deno.test("kms: materialize records descriptor and idempotency key", async () => {
  const fake = new FakeClient();
  const provider = new GcpKmsProviderMaterializer({
    client: fake,
    projectId: "proj",
    location: "us-central1",
    keyRingName: "ring",
    cryptoKeyName: "key",
    purpose: "ENCRYPT_DECRYPT",
    rotationPeriod: "7776000s",
    protectionLevel: "SOFTWARE",
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.kind, "gcp-kms-ensure");
  assert.equal(op.execution?.status, "succeeded");
  assert.equal(
    (op.details as Record<string, unknown>).descriptor,
    GCP_KMS_DESCRIPTOR,
  );
  assert.equal(
    plan.objectAddress,
    "projects/proj/locations/us-central1/keyRings/ring/cryptoKeys/key",
  );
});

Deno.test("kms: FAILED_PRECONDITION is non-retriable", async () => {
  const fake = new FakeClient();
  let calls = 0;
  fake.shouldFail = () => {
    calls += 1;
    return Object.assign(new Error("precond"), {
      status: "FAILED_PRECONDITION",
    });
  };
  const provider = new GcpKmsProviderMaterializer({
    client: fake,
    projectId: "proj",
    location: "us-central1",
    keyRingName: "ring",
    cryptoKeyName: "key",
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
  assert.equal(cond.status, "failed-precondition");
  assert.equal(calls, 1);
});

Deno.test("kms: INTERNAL retries until success", async () => {
  const fake = new FakeClient();
  let calls = 0;
  fake.shouldFail = () => {
    calls += 1;
    if (calls <= 2) {
      return Object.assign(new Error("internal"), { status: "INTERNAL" });
    }
    return undefined;
  };
  const provider = new GcpKmsProviderMaterializer({
    client: fake,
    projectId: "proj",
    location: "us-central1",
    keyRingName: "ring",
    cryptoKeyName: "key",
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

Deno.test("kms: drift detected when rotationPeriod differs", async () => {
  const fake = new FakeClient();
  fake.result = {
    ...fake.result,
    observed: {
      cryptoKeyResourceName:
        "projects/proj/locations/us-central1/keyRings/ring/cryptoKeys/key",
      purpose: "ENCRYPT_DECRYPT",
      rotationPeriod: "2592000s",
      protectionLevel: "SOFTWARE",
    },
  };
  const provider = new GcpKmsProviderMaterializer({
    client: fake,
    projectId: "proj",
    location: "us-central1",
    keyRingName: "ring",
    cryptoKeyName: "key",
    purpose: "ENCRYPT_DECRYPT",
    rotationPeriod: "7776000s",
    protectionLevel: "SOFTWARE",
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
  assert.ok(drift.entries.some((e) => e.path === "rotationPeriod"));
});

Deno.test("kms: observe() returns missing when key was deleted", async () => {
  const fake = new FakeClient();
  fake.describeCryptoKey = () => Promise.resolve(undefined);
  const provider = new GcpKmsProviderMaterializer({
    client: fake,
    projectId: "proj",
    location: "us-central1",
    keyRingName: "ring",
    cryptoKeyName: "key",
    clock: clock(),
    idGenerator: idGen(),
  });
  const report = await provider.observe();
  assert.equal(report.status, "missing");
});
