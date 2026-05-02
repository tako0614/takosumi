/**
 * Unit tests for `provider.gcp.pubsub@v1` materializer (Phase 17A2).
 */

import assert from "node:assert/strict";
import {
  GCP_PUBSUB_DESCRIPTOR,
  type GcpPubSubAdminClient,
  type GcpPubSubEnsureResult,
  type GcpPubSubListResult,
  GcpPubSubProviderMaterializer,
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
    appName: "queue",
    materializedAt: now,
    workloads: [],
    resources: [],
    routes: [],
  };
}

class FakeClient implements GcpPubSubAdminClient {
  ensureCalls: unknown[] = [];
  describeCalls: unknown[] = [];
  listCalls: unknown[] = [];
  result: GcpPubSubEnsureResult = {
    topicResourceName: "projects/proj/topics/jobs",
    subscriptionResourceName: "projects/proj/subscriptions/jobs-sub",
    observed: {
      topicResourceName: "projects/proj/topics/jobs",
      subscriptionResourceName: "projects/proj/subscriptions/jobs-sub",
      ackDeadlineSeconds: 30,
    },
  };
  pages: GcpPubSubListResult[] = [];
  shouldFail?: () => Error | undefined;

  ensureTopicAndSubscription(input: unknown): Promise<GcpPubSubEnsureResult> {
    this.ensureCalls.push(input);
    if (this.shouldFail) {
      const err = this.shouldFail();
      if (err) return Promise.reject(err);
    }
    return Promise.resolve(this.result);
  }

  describeTopic(input: unknown) {
    this.describeCalls.push(input);
    return Promise.resolve(this.result.observed);
  }

  listTopics(input: unknown): Promise<GcpPubSubListResult> {
    this.listCalls.push(input);
    const next = this.pages.shift() ??
      ({ topics: [], nextPageToken: undefined } as GcpPubSubListResult);
    return Promise.resolve(next);
  }
}

Deno.test("pubsub: materialize records descriptor and idempotency key", async () => {
  const fake = new FakeClient();
  const provider = new GcpPubSubProviderMaterializer({
    client: fake,
    projectId: "proj",
    topicName: "jobs",
    subscriptionName: "jobs-sub",
    ackDeadlineSeconds: 30,
    clock: clock(),
    idGenerator: idGen(),
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.kind, "gcp-pubsub-ensure");
  assert.equal(op.execution?.status, "succeeded");
  assert.equal(
    (op.details as Record<string, unknown>).descriptor,
    GCP_PUBSUB_DESCRIPTOR,
  );
  assert.equal(
    plan.objectAddress,
    "projects/proj/topics/jobs",
  );
});

Deno.test("pubsub: ALREADY_EXISTS surfaces conflict failure", async () => {
  const fake = new FakeClient();
  fake.shouldFail = () =>
    Object.assign(new Error("dup"), { status: "ALREADY_EXISTS" });
  const provider = new GcpPubSubProviderMaterializer({
    client: fake,
    projectId: "proj",
    topicName: "jobs",
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
  assert.equal(cond.status, "conflict");
});

Deno.test("pubsub: deadline-exceeded retries then surfaces handoff metadata", async () => {
  const fake = new FakeClient();
  fake.shouldFail = () =>
    Object.assign(new Error("timeout"), { status: "DEADLINE_EXCEEDED" });
  const handoff = {
    enqueue: () => Promise.resolve("work_pubsub_1"),
  };
  const provider = new GcpPubSubProviderMaterializer({
    client: fake,
    projectId: "proj",
    topicName: "jobs",
    clock: clock(),
    idGenerator: idGen(),
    runtime: {
      sleep: () => Promise.resolve(),
      random: () => 0,
      policy: {
        timeoutMs: 60_000,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
        maxRetries: 1,
        jitterMs: 0,
      },
      runtimeAgentHandoff: handoff,
    },
  });
  const plan = await provider.materialize(desired());
  const op = plan.operations[0]!;
  assert.equal(op.execution?.status, "failed");
  const details = op.details as Record<string, unknown>;
  assert.equal(details.handedOff, true);
  assert.equal(details.handoffWorkId, "work_pubsub_1");
});

Deno.test("pubsub: drift detected when ackDeadline differs", async () => {
  const fake = new FakeClient();
  fake.result = {
    ...fake.result,
    observed: {
      topicResourceName: "projects/proj/topics/jobs",
      ackDeadlineSeconds: 60,
    },
  };
  const provider = new GcpPubSubProviderMaterializer({
    client: fake,
    projectId: "proj",
    topicName: "jobs",
    ackDeadlineSeconds: 30,
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
  assert.ok(drift.entries.some((e) => e.path === "ackDeadlineSeconds"));
});

Deno.test("pubsub: listAllTopics paginates", async () => {
  const fake = new FakeClient();
  fake.pages = [
    {
      topics: [{ name: "projects/proj/topics/a" }],
      nextPageToken: "p2",
    },
    {
      topics: [{ name: "projects/proj/topics/b" }],
      nextPageToken: undefined,
    },
  ];
  const provider = new GcpPubSubProviderMaterializer({
    client: fake,
    projectId: "proj",
    topicName: "jobs",
    clock: clock(),
    idGenerator: idGen(),
  });
  const all = await provider.listAllTopics({ pageSize: 1 });
  assert.equal(all.length, 2);
  assert.equal(fake.listCalls.length, 2);
});
