import assert from "node:assert/strict";
import type { ManifestResource } from "takosumi-contract";
import { buildOperationPlanPreview } from "./operation_plan_preview.ts";
import {
  appendOperationPlanJournalStages,
  InMemoryOperationJournalStore,
  OperationJournalReplayMismatchError,
} from "./operation_journal.ts";

const RESOURCE: ManifestResource = {
  shape: "object-store@v1",
  name: "logs",
  provider: "@takos/selfhost-filesystem",
  spec: { name: "logs" },
};

Deno.test("operation journal appends public plan stages idempotently", async () => {
  let ids = 0;
  const store = new InMemoryOperationJournalStore({
    idFactory: () => `journal-row-${++ids}`,
  });
  const preview = buildOperationPlanPreview({
    resources: [RESOURCE],
    planned: [{
      name: RESOURCE.name,
      shape: RESOURCE.shape,
      providerId: RESOURCE.provider,
      op: "create",
    }],
    edges: [],
    spaceId: "space:journal",
    deploymentName: "journal-app",
  });

  const first = await appendOperationPlanJournalStages({
    store,
    preview,
    phase: "apply",
    stages: ["prepare", "commit"],
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  const replay = await appendOperationPlanJournalStages({
    store,
    preview,
    phase: "apply",
    stages: ["prepare", "commit"],
    createdAt: "2026-05-02T00:00:00.000Z",
  });

  assert.deepEqual(replay, first);
  assert.equal(ids, 2);
  const listed = await store.listByPlan(
    preview.spaceId,
    preview.operationPlanDigest,
  );
  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map((entry) => entry.stage),
    ["prepare", "commit"],
  );
  assert.equal(listed[0].operationPlanDigest, preview.operationPlanDigest);
  assert.equal(
    listed[0].journalEntryId,
    preview.operations[0].idempotencyKey.journalEntryId,
  );
});

Deno.test("operation journal rejects same tuple with different effect digest", async () => {
  const store = new InMemoryOperationJournalStore({
    idFactory: () => "journal-row-1",
  });
  const base = {
    spaceId: "space:journal",
    operationPlanDigest:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const,
    journalEntryId: "operation:abc",
    operationId: "operation:abc",
    phase: "apply" as const,
    stage: "prepare" as const,
    operationKind: "create",
    resourceName: "logs",
    providerId: "@takos/selfhost-filesystem",
    status: "recorded" as const,
    createdAt: "2026-05-02T00:00:00.000Z",
  };

  await store.append({ ...base, effect: { expected: "first" } });
  assert.throws(
    () => store.append({ ...base, effect: { expected: "second" } }),
    OperationJournalReplayMismatchError,
  );
});
