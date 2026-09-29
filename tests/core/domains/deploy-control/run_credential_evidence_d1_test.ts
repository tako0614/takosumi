import { expect, test } from "bun:test";

import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

test("D1 atomically appends a current-owner refresh ack and preserves it across stale Run writes", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_refresh_audit_d1",
    capsuleId: "cap_refresh_audit_d1",
  });
  const run: PlanRun = {
    id: "plan_refresh_audit_d1",
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    source: { kind: "git", url: "https://example.test/source.git" },
    sourceDigest: "sha256:source",
    operation: "apply",
    runnerProfileId: "runner_test",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "running",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
    heartbeatAt: 1,
  };
  await store.putPlanRun(run);
  // This test starts from an already-claimed row to exercise the exact
  // single-statement D1 append and replacement paths, not Run admission.
  await db.prepare("UPDATE runs SET lease_token = ? WHERE id = ?")
    .bind("owner-a", run.id).run();
  const event = {
    id: `${run.id}:credential.refresh.accepted:1`,
    type: "credential.refresh.accepted",
    at: 2,
    data: { sequence: 1, connectionId: "conn_test", provider: "cloudflare" },
  };
  const append = (leaseToken: string, id = event.id) =>
    store.appendRunningRunAuditEvent({
      id: run.id, kind: "plan", workspaceId: run.workspaceId, leaseToken,
      event: { ...event, id },
    });
  expect(await append("owner-a")).toBe(true);
  expect(await append("owner-a")).toBe(false);
  expect(await append("stale-owner", `${event.id}:stale`)).toBe(false);
  expect((await store.transitionRun({
    id: run.id, kind: "plan", expectFrom: ["running"],
    expectLeaseToken: "owner-a", heartbeatAt: 3,
    run: { ...run, heartbeatAt: 3, updatedAt: 3 },
  })).won).toBe(true);
  await db.prepare("UPDATE runs SET lease_token = ? WHERE id = ?")
    .bind("owner-b", run.id).run();
  expect(await append("owner-a", `${event.id}:stale-after-takeover`)).toBe(false);
  expect(await append("owner-b", `${event.id}:successor`)).toBe(true);
  expect((await store.transitionRun({
    id: run.id, kind: "plan", expectFrom: ["running"],
    expectLeaseToken: "owner-b", clearLeaseToken: true,
    run: { ...run, status: "failed", updatedAt: 4, finishedAt: 4 },
  })).won).toBe(true);
  expect((await store.getPlanRun(run.id))?.auditEvents).toEqual([
    event, { ...event, id: `${event.id}:successor` },
  ]);
  expect(await append("owner-a", `${event.id}:late`)).toBe(false);
});

test("D1 apply state commit preserves an ACK appended after its terminal snapshot", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_refresh_commit_d1",
    capsuleId: "cap_refresh_commit_d1",
  });
  const run: ApplyRun = {
    id: "apply_refresh_commit_d1",
    planRunId: "plan_refresh_commit_d1",
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    operation: "apply",
    runnerProfileId: "runner_test",
    status: "running",
    expected: {
      planRunId: "plan_refresh_commit_d1",
      capsuleId: seeded.capsule.id,
      currentStateVersionId: null,
      runnerProfileId: "runner_test",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "encrypted-r2" },
    stateLock: { status: "not_required", backendRef: "ref" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
    heartbeatAt: 1,
  };
  await store.putApplyRun(run);
  await db.prepare("UPDATE runs SET lease_token = ? WHERE id = ?")
    .bind("owner-a", run.id).run();
  const event = {
    id: "opaque-refresh-ack",
    type: "credential.refresh.accepted",
    at: 2,
    data: { sequence: 1, connectionId: "conn_test", provider: "cloudflare" },
  };
  expect(await store.appendRunningRunAuditEvent({
    id: run.id, kind: "apply", workspaceId: run.workspaceId,
    leaseToken: "owner-a", event,
  })).toBe(true);
  const result = await store.commitRunState({
    capsulePatch: {
      id: seeded.capsule.id,
      patch: { updatedAt: "2026-09-28T00:00:00.000Z" },
      guard: {
        currentStateVersionId: seeded.capsule.currentStateVersionId,
        status: seeded.capsule.status,
      },
    },
    applyRunTerminal: { ...run, status: "succeeded", updatedAt: 3, finishedAt: 3 },
    applyRunLeaseToken: "owner-a",
  });
  expect(result.applyRunLeaseLost).not.toBe(true);
  expect((await store.getApplyRun(run.id))?.auditEvents).toEqual([event]);
});
