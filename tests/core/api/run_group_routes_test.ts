/**
 * RunGroup HTTP route tests (Core Specification §19 / §24; TASK-0118 9.1).
 *
 *   POST /internal/v1/workspaces/:workspaceId/plan-update -> 410 run_group_retired
 *   POST /internal/v1/workspaces/:workspaceId/drift-check -> 410 run_group_retired
 *   GET  /internal/v1/run-groups/:runGroupId        -> read a historical group + member Runs + status
 *   POST /internal/v1/run-groups/:runGroupId/approve -> 410 run_group_retired
 *
 * Drives the surface over the internal routes against an in-memory store and
 * a fake runner. Each app is planned and drift-checked through its own
 * Capsule route instead.
 */

import { expect, test } from "bun:test";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { Run } from "takosumi-contract/runs";
import type { OpenTofuRunner } from "../../../core/domains/deploy-control/mod.ts";
import type { CapsulesService } from "../../../core/domains/capsules/mod.ts";
import { applyExpectedGuardFromPlanRun } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import type { OpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fakeProviderVault,
  fixtureExecutionEvidence,
  fixtureStateCommit,
  seedProviderConnections,
} from "../../helpers/deploy-control/model_fixture.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const ARCHIVE_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "deploy-control-token";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

function runner(): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      }),
    apply: (job) =>
      Promise.resolve({
        ...fixtureStateCommit({
        outputs: {
          base_domain: { sensitive: false, value: "example.com" },
        } as never,
        rawOutputRef: job.rawOutputRef,
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        }),
        executionEvidence: fixtureExecutionEvidence(job, "apply"),
      }),
    destroy: (job) =>
      Promise.resolve({
        ...fixtureStateCommit({
          providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        }),
        executionEvidence: fixtureExecutionEvidence(job, "destroy"),
      }),
  };
}

async function seedCapsule(
  store: OpenTofuControlStore,
  operations: {
    capsules: Pick<CapsulesService, "createCapsuleInitialAuthority">;
  },
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  workspaceId: string,
  name: string,
): Promise<string> {
  const sourceRes = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      workspaceId,
      name: `${name}-repo`,
      url: `https://github.com/acme/${name}.git`,
      defaultRef: "main",
      defaultPath: ".",
    }),
  });
  expect(sourceRes.status).toBe(201);
  const sourceId = (await sourceRes.json()).source.id as string;

  const nowIso = new Date(0).toISOString();
  const config: InstallConfig = {
    id: `cfg_${name}00000001`,
    workspaceId,
    name: `${name}-module`,
    variableMapping: {},
    outputAllowlist:
      name === "producer"
        ? {
            base_domain: {
              from: "base_domain",
              type: "hostname",
              required: true,
            },
          }
        : {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const capsuleId = `cap_${name}00000001`;
  const initial = await operations.capsules.createCapsuleInitialAuthority({
    capsuleId,
    providerBindingSetId: `ipcset_${name}00000001`,
    workspaceId,
    name,
    environment: "preview",
    sourceId,
    installingPrincipalId: "deploy-control-bearer",
    installConfig: config,
    providerBindings: [],
  });
  await seedProviderConnections(store, initial.capsule);

  const snapshot: SourceSnapshot = {
    id: `snap_${name}00001`,
    origin: "git",
    workspaceId,
    sourceId,
    url: `https://github.com/acme/${name}.git`,
    ref: "main",
    resolvedCommit: "a".repeat(40),
    path: ".",
    archiveRef: `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snap_${name}/source.tar.zst`,
    archiveDigest: ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [{
        path: ".",
        providerPackages: [{ source: FIXTURE_CLOUDFLARE_PROVIDER }],
        rootProviderRequirements: [{
          source: FIXTURE_CLOUDFLARE_PROVIDER,
          moduleLocalName: "cloudflare",
        }],
      }],
    },
    fetchedByRunId: `ssr_${name}00001`,
    fetchedAt: nowIso,
  };
  await store.putSourceSnapshot(snapshot);
  const compatibilityReport: CapsuleCompatibilityReport = {
    id: `caprep_${name}00001`,
    sourceId,
    capsuleId,
    sourceSnapshotId: snapshot.id,
    modulePath: ".",
    level: "ready",
    findings: [],
    providerPackages: [{ source: FIXTURE_CLOUDFLARE_PROVIDER, allowed: true }],
    rootProviderRequirements: [{
      source: FIXTURE_CLOUDFLARE_PROVIDER,
      moduleLocalName: "cloudflare",
    }],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: nowIso,
  };
  await store.putCapsuleCompatibilityReport(compatibilityReport);
  await store.patchCapsule(capsuleId, {
    compatibilityReportId: compatibilityReport.id,
    compatibilityStatus: compatibilityReport.level,
    updatedAt: nowIso,
  });
  return capsuleId;
}

/** Applies a preview Capsule plan to completion (no approval gate). */
async function applyCapsule(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  controller: {
    runQueuedPlan(runId: string): Promise<unknown>;
    runQueuedApply(runId: string): Promise<unknown>;
  },
  capsuleId: string,
): Promise<void> {
  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers(),
  });
  if (planRes.status !== 201) {
    throw new Error(
      `Capsule plan returned ${planRes.status}: ${await planRes.text()}`,
    );
  }
  const run = (await planRes.json()).run as Run;
  if (run.status === "queued") await controller.runQueuedPlan(run.id);
  const planFetch = await app.request(`/internal/v1/plan-runs/${run.id}`, {
    headers: headers(),
  });
  expect(planFetch.status).toBe(200);
  const plan = (await planFetch.json()).planRun;
  if (!plan.planDigest) {
    throw new Error(`Capsule plan did not complete: ${JSON.stringify(plan)}`);
  }
  const applyRes = await app.request("/internal/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: plan.id,
      expected: applyExpectedGuardFromPlanRun(plan),
    }),
  });
  expect(applyRes.status).toBe(201);
  const apply = (await applyRes.json()).applyRun as Run;
  if (apply.status === "queued") await controller.runQueuedApply(apply.id);
}

test("Workspace bulk operations and approval answer 410 run_group_retired; a historical group stays readable", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    workspaceMutationsFrozen: false,
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuControlStore: store,
    opentofuRunner: runner(),
    opentofuConnectionVault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  });

  const workspaceRes = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle: "acme",
      displayName: "acme",
      type: "personal",
      ownerUserId: "user_test00000001",
    }),
  });
  expect(workspaceRes.status).toBe(201);
  const workspaceId = (await workspaceRes.json()).workspace.id as string;

  const producer = await seedCapsule(store, operations, app, workspaceId, "producer");
  const consumer = await seedCapsule(store, operations, app, workspaceId, "consumer");
  await applyCapsule(app, operations.controller, producer);
  await applyCapsule(app, operations.controller, consumer);
  await store.patchCapsule(producer, { status: "stale", updatedAt: new Date(0).toISOString() });
  const runsBefore = (await store.listRunsByWorkspace(workspaceId)).length;

  // The retired operations refuse with the typed code whatever the Workspace
  // holds (here: one stale and one active app) and create nothing.
  for (const path of [
    `/internal/v1/workspaces/${workspaceId}/plan-update`,
    `/internal/v1/workspaces/${workspaceId}/drift-check`,
    "/internal/v1/workspaces/ws_unknown00000001/plan-update",
    "/internal/v1/run-groups/rg_missing00000001/approve",
  ]) {
    const response = await app.request(path, { method: "POST", headers: headers() });
    expect(response.status, path).toBe(410);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code, path).toBe("run_group_retired");
    expect(body.error.message, path).toContain("/capsules/{capsuleId}/plan");
  }
  expect((await store.listRunsByWorkspace(workspaceId)).length).toBe(runsBefore);
  expect(await store.listRunGroups(workspaceId)).toEqual([]);

  // The operator bearer is still required before the refusal.
  const unauthenticated = await app.request(
    `/internal/v1/workspaces/${workspaceId}/plan-update`,
    { method: "POST" },
  );
  expect(unauthenticated.status).toBe(401);

  // Each app is planned and drift-checked through its own route instead.
  const planRes = await app.request(`/internal/v1/capsules/${producer}/plan`, {
    method: "POST", headers: headers(),
  });
  expect(planRes.status).toBe(201);
  const plan = (await planRes.json()).run as Run;
  expect(plan.runGroupId).toBeUndefined();
  const driftRes = await app.request(`/internal/v1/capsules/${consumer}/drift-check`, {
    method: "POST", headers: headers(),
  });
  expect(driftRes.status).toBe(201);
  const drift = (await driftRes.json()).run as Run;
  expect(drift.type).toBe("drift_check");
  expect(drift.runGroupId).toBeUndefined();

  // A group written before the retirement keeps reading with computed status.
  await store.putRunGroup({
    id: "rg_history00000001",
    workspaceId,
    type: "workspace_update",
    status: "running",
    graphJson: JSON.stringify({
      order: [[producer, consumer]],
      runs: { [producer]: plan.id, [consumer]: drift.id },
      failures: {},
    }),
    createdAt: new Date(0).toISOString(),
  });
  const getRes = await app.request("/internal/v1/run-groups/rg_history00000001", {
    headers: headers(),
  });
  expect(getRes.status).toBe(200);
  const fetched = (await getRes.json()) as { runGroup: { id: string; status: string }; runs: Run[] };
  expect(fetched.runGroup.id).toBe("rg_history00000001");
  expect(fetched.runs.map((run) => run.id).sort()).toEqual([plan.id, drift.id].sort());
  expect(typeof fetched.runGroup.status).toBe("string");

  // Approval stays retired for an existing group too.
  const approveRes = await app.request("/internal/v1/run-groups/rg_history00000001/approve", {
    method: "POST", headers: headers(),
  });
  expect(approveRes.status).toBe(410);
  expect((await approveRes.json()).error.code).toBe("run_group_retired");

  // An unknown run group is 404.
  const missingRes = await app.request("/internal/v1/run-groups/rg_missing00000001", {
    headers: headers(),
  });
  expect(missingRes.status).toBe(404);
});

test("retired routes still reject a malformed workspaceId and run-group rejects a malformed id", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuControlStore: store,
    opentofuRunner: runner(),
  });

  const badSpace = await app.request(
    "/internal/v1/workspaces/not-a-space/plan-update",
    {
      method: "POST",
      headers: headers(),
    },
  );
  expect(badSpace.status).toBe(400);

  const badDriftSpace = await app.request(
    "/internal/v1/workspaces/not-a-space/drift-check",
    {
      method: "POST",
      headers: headers(),
    },
  );
  expect(badDriftSpace.status).toBe(400);

  const badGroup = await app.request("/internal/v1/run-groups/not-a-group", {
    headers: headers(),
  });
  expect(badGroup.status).toBe(400);
});

test("retired Output Sync internal routes are not mounted", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
  });
  const response = await app.request(
    "/internal/v1/workspaces/ws_output_sync_1/output-sync",
    { headers: headers() },
  );
  expect(response.status).toBe(404);
});
