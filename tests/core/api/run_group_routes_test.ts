/**
 * RunGroup HTTP route tests (Core Specification §19 / §24).
 *
 *   POST /internal/v1/workspaces/:workspaceId/plan-update -> create a workspace_update RunGroup
 *   GET  /internal/v1/run-groups/:runGroupId        -> read group + member Runs + status
 *   POST /internal/v1/run-groups/:runGroupId/approve -> approve waiting members
 *
 * Drives the full surface over the internal routes against an in-memory store +
 * a fake runner whose producer apply emits a `base_domain` output a downstream
 * consumer injects. A producer re-apply with a CHANGED output cascades stale,
 * then plan-update builds the group.
 */

import { expect, test } from "bun:test";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { Run } from "takosumi-contract/runs";
import type { OpenTofuRunner } from "../../../core/domains/deploy-control/mod.ts";
import { applyExpectedGuardFromPlanRun } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import type { OpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
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

/**
 * Runner whose producer apply emits a `base_domain` from a mutable holder so a
 * re-apply can emit a changed value. `producerId` is the producer Capsule id;
 * other Capsules emit a stable value.
 */
function runner(value: {
  producer: string;
  producerId?: string;
}): OpenTofuRunner {
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
        outputs: {
          base_domain: {
            sensitive: false,
            value:
              job.planRun.capsuleId === value.producerId
                ? value.producer
                : "consumer.example.com",
          },
        } as never,
      }),
    destroy: () => Promise.resolve({}),
  };
}

async function seedCapsule(
  store: OpenTofuControlStore,
  operations: {
    capsules: {
      putInstallConfig: (config: InstallConfig) => Promise<InstallConfig>;
    };
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
  await operations.capsules.putInstallConfig(config);

  const installRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name,
        environment: "preview",
        sourceId,
        installConfigId: config.id,
      }),
    },
  );
  expect(installRes.status).toBe(201);
  const capsuleId = (await installRes.json()).capsule.id as string;
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule).toBeDefined();
  await seedProviderConnections(store, capsule!);

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
    fetchedByRunId: `ssr_${name}00001`,
    fetchedAt: nowIso,
  };
  await store.putSourceSnapshot(snapshot);
  const compatibilityReport: CapsuleCompatibilityReport = {
    id: `caprep_${name}00001`,
    sourceId,
    capsuleId,
    sourceSnapshotId: snapshot.id,
    level: "ready",
    findings: [],
    providers: [],
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

test("plan-update creates a RunGroup over stale consumers; GET reads members; approve is gated", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const producerValue = { producer: "v1.example.com" };
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuControlStore: store,
    opentofuRunner: runner(producerValue),
    opentofuConnectionVault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
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

  const producer = await seedCapsule(
    store,
    operations,
    app,
    workspaceId,
    "producer",
  );
  producerValue.producerId = producer;
  const consumer = await seedCapsule(
    store,
    operations,
    app,
    workspaceId,
    "consumer",
  );

  // Dependency: consumer injects producer's base_domain.
  const depRes = await app.request(
    `/internal/v1/capsules/${consumer}/dependencies`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        producerCapsuleId: producer,
        mode: "variable_injection",
        visibility: "workspace",
        outputs: {
          base_domain: {
            from: "base_domain",
            to: "base_domain",
            required: true,
          },
        },
      }),
    },
  );
  expect(depRes.status).toBe(201);

  // Bring both up.
  await applyCapsule(app, operations.controller, producer);
  await applyCapsule(app, operations.controller, consumer);

  // Before any stale: plan-update is failed_precondition nothing_to_update.
  const emptyRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/plan-update`,
    {
      method: "POST",
      headers: headers(),
    },
  );
  expect(emptyRes.status).toBe(409);
  expect((await emptyRes.json()).error.code).toBe("failed_precondition");

  // Workspace drift-check: active Capsules are grouped under one RunGroup and
  // each member projects as read-only drift_check.
  const driftGroupRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/drift-check`,
    {
      method: "POST",
      headers: headers(),
    },
  );
  expect(driftGroupRes.status).toBe(201);
  const driftGroup = (await driftGroupRes.json()) as {
    runGroup: { id: string; type: string };
    runs: Run[];
  };
  expect(driftGroup.runGroup.type).toBe("workspace_drift_check");
  expect(driftGroup.runs).toHaveLength(2);
  expect(driftGroup.runs.every((run) => run.type === "drift_check")).toBe(true);
  expect(
    driftGroup.runs.every((run) => run.runGroupId === driftGroup.runGroup.id),
  ).toBe(true);

  // Producer re-applies with a CHANGED output -> consumer goes stale.
  producerValue.producer = "v2.example.com";
  await applyCapsule(app, operations.controller, producer);
  const consumerRow = await app.request(`/internal/v1/capsules/${consumer}`, {
    headers: headers(),
  });
  expect((await consumerRow.json()).capsule.status).toBe("stale");

  // plan-update: builds the group with the consumer as the sole member.
  const updateRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/plan-update`,
    {
      method: "POST",
      headers: headers(),
    },
  );
  expect(updateRes.status).toBe(201);
  const group = (await updateRes.json()) as {
    runGroup: { id: string; type: string; status: string; graphJson: string };
    runs: Run[];
  };
  expect(group.runGroup.type).toBe("workspace_update");
  expect(group.runs).toHaveLength(1);
  expect(group.runs[0]!.capsuleId).toBe(consumer);
  expect(group.runs[0]!.runGroupId).toBe(group.runGroup.id);

  // GET the group: same member, computed status. Preview members auto-succeed
  // (no approval gate), so the group reads succeeded.
  const getRes = await app.request(
    `/internal/v1/run-groups/${group.runGroup.id}`,
    {
      headers: headers(),
    },
  );
  expect(getRes.status).toBe(200);
  const fetched = (await getRes.json()) as {
    runGroup: { status: string };
    runs: Run[];
  };
  expect(fetched.runs).toHaveLength(1);
  expect(fetched.runGroup.status).toBe("succeeded");

  // Approve is a no-op here (no waiting members) but must still return the group.
  const approveRes = await app.request(
    `/internal/v1/run-groups/${group.runGroup.id}/approve`,
    { method: "POST", headers: headers() },
  );
  expect(approveRes.status).toBe(200);
  expect((await approveRes.json()).runGroup.id).toBe(group.runGroup.id);

  // An unknown run group is 404.
  const missingRes = await app.request(
    "/internal/v1/run-groups/rg_missing00000001",
    {
      headers: headers(),
    },
  );
  expect(missingRes.status).toBe(404);
});

test("plan-update rejects a malformed workspaceId and run-group rejects a malformed id", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuControlStore: store,
    opentofuRunner: runner({ producer: "v1" }),
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
