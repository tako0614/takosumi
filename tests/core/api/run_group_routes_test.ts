/**
 * RunGroup HTTP route tests (Core Specification §19 / §24).
 *
 *   POST /internal/v1/workspaces/:spaceId/plan-update   -> create a space_update RunGroup
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
import { InMemoryOpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";
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
 * re-apply can emit a changed value. `producerId` is the producer Installation
 * id (set once it has been created); other installations emit a stable value.
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
              job.planRun.installationId === value.producerId
                ? value.producer
                : "consumer.example.com",
          },
        } as never,
      }),
    destroy: () => Promise.resolve({}),
  };
}

async function seedInstallation(
  store: OpenTofuDeploymentStore,
  operations: {
    installations: {
      putInstallConfig: (config: InstallConfig) => Promise<InstallConfig>;
    };
  },
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  spaceId: string,
  name: string,
): Promise<string> {
  const sourceRes = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      spaceId,
      name: `${name}-repo`,
      url: `https://github.com/acme/${name}.git`,
    }),
  });
  expect(sourceRes.status).toBe(201);
  const sourceId = (await sourceRes.json()).source.id as string;

  const nowIso = new Date(0).toISOString();
  const config: InstallConfig = {
    id: `cfg_${name}00000001`,
    spaceId,
    name: `${name}-module`,
    installType: "opentofu_module",
    trustLevel: "space",
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
  await operations.installations.putInstallConfig(config);

  const installRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
  const installationId = (await installRes.json()).capsule.id as string;
  const installation = await store.getInstallation(installationId);
  expect(installation).toBeDefined();
  await seedProviderConnections(store, installation!);

  const snapshot: SourceSnapshot = {
    id: `snap_${name}00001`,
    sourceId,
    url: `https://github.com/acme/${name}.git`,
    ref: "main",
    resolvedCommit: "a".repeat(40),
    path: ".",
    archiveObjectKey: `spaces/${spaceId}/sources/${sourceId}/snapshots/snap_${name}/source.tar.zst`,
    archiveDigest: ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: `ssr_${name}00001`,
    fetchedAt: nowIso,
  };
  await store.putSourceSnapshot(snapshot);
  const compatibilityReport: CapsuleCompatibilityReport = {
    id: `caprep_${name}00001`,
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
  await store.patchInstallation(installationId, {
    compatibilityReportId: compatibilityReport.id,
    compatibilityStatus: compatibilityReport.level,
    updatedAt: nowIso,
  });
  return installationId;
}

/** Applies a preview installation plan to completion (no approval gate). */
async function applyInstallation(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  installationId: string,
): Promise<void> {
  const planRes = await app.request(
    `/internal/v1/capsules/${installationId}/plan`,
    { method: "POST", headers: headers() },
  );
  expect(planRes.status).toBe(201);
  const run = (await planRes.json()).run as Run;
  const planFetch = await app.request(`/internal/v1/plan-runs/${run.id}`, {
    headers: headers(),
  });
  expect(planFetch.status).toBe(200);
  const plan = (await planFetch.json()).planRun;
  const applyRes = await app.request("/internal/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: plan.id,
      expected: applyExpectedGuardFromPlanRun(plan),
    }),
  });
  expect(applyRes.status).toBe(201);
}

test("plan-update creates a RunGroup over stale consumers; GET reads members; approve is gated", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const producerValue = { producer: "v1.example.com" };
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuDeploymentStore: store,
    opentofuRunner: runner(producerValue),
    opentofuConnectionVault: fakeProviderVault() as never,
    startWorkerDaemon: false,
  });

  const spaceRes = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle: "acme",
      displayName: "acme",
      type: "personal",
      ownerUserId: "user_test00000001",
    }),
  });
  expect(spaceRes.status).toBe(201);
  const spaceId = (await spaceRes.json()).space.id as string;

  const producer = await seedInstallation(
    store,
    operations,
    app,
    spaceId,
    "producer",
  );
  producerValue.producerId = producer;
  const consumer = await seedInstallation(
    store,
    operations,
    app,
    spaceId,
    "consumer",
  );

  // Dependency: consumer injects producer's base_domain.
  const depRes = await app.request(
    `/internal/v1/capsules/${consumer}/dependencies`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        producerInstallationId: producer,
        mode: "variable_injection",
        visibility: "space",
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
  await applyInstallation(app, producer);
  await applyInstallation(app, consumer);

  // Before any stale: plan-update is failed_precondition nothing_to_update.
  const emptyRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/plan-update`,
    {
      method: "POST",
      headers: headers(),
    },
  );
  expect(emptyRes.status).toBe(409);
  expect((await emptyRes.json()).error.code).toBe("failed_precondition");

  // Space drift-check: active Installations are grouped under one RunGroup and
  // each member projects as read-only drift_check.
  const driftGroupRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/drift-check`,
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
  expect(driftGroup.runGroup.type).toBe("space_drift_check");
  expect(driftGroup.runs).toHaveLength(2);
  expect(driftGroup.runs.every((run) => run.type === "drift_check")).toBe(true);
  expect(
    driftGroup.runs.every((run) => run.runGroupId === driftGroup.runGroup.id),
  ).toBe(true);

  // Producer re-applies with a CHANGED output -> consumer goes stale.
  producerValue.producer = "v2.example.com";
  await applyInstallation(app, producer);
  const consumerRow = await app.request(`/internal/v1/capsules/${consumer}`, {
    headers: headers(),
  });
  expect((await consumerRow.json()).capsule.status).toBe("stale");

  // plan-update: builds the group with the consumer as the sole member.
  const updateRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/plan-update`,
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
  expect(group.runGroup.type).toBe("space_update");
  expect(group.runs).toHaveLength(1);
  expect(group.runs[0]!.installationId).toBe(consumer);
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

test("plan-update rejects a malformed spaceId and run-group rejects a malformed id", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuDeploymentStore: store,
    opentofuRunner: runner({ producer: "v1" }),
    startWorkerDaemon: false,
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

test("Output Sync internal routes expose settings, snapshot, and disabled gate", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
  });
  const workspaceId = "space_output_sync_1";
  const create = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle: "output-sync",
      displayName: "Output Sync",
      type: "personal",
      ownerUserId: "user_test",
    }),
  });
  expect(create.status).toBe(201);
  const actualWorkspaceId = (await create.json()).space.id as string;
  expect(actualWorkspaceId).not.toBe(workspaceId);

  const status = await app.request(
    `/internal/v1/workspaces/${actualWorkspaceId}/output-sync`,
    { headers: headers() },
  );
  expect(status.status).toBe(200);
  expect((await status.json()).state.enabled).toBe(true);

  const snapshot = await app.request(
    `/internal/v1/workspaces/${actualWorkspaceId}/output-sync/snapshot`,
    { headers: headers() },
  );
  expect(snapshot.status).toBe(200);
  expect(snapshot.headers.get("etag")).toBe('"takosumi-output-sync-0"');
  const cachedSnapshot = await app.request(
    `/internal/v1/workspaces/${actualWorkspaceId}/output-sync/snapshot`,
    {
      headers: headers({
        "if-none-match": '"takosumi-output-sync-0"',
      }),
    },
  );
  expect(cachedSnapshot.status).toBe(304);

  const disabled = await app.request(
    `/internal/v1/workspaces/${actualWorkspaceId}/output-sync`,
    {
      method: "PATCH",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ enabled: false }),
    },
  );
  expect(disabled.status).toBe(200);
  expect((await disabled.json()).state.enabled).toBe(false);

  const reconcile = await app.request(
    `/internal/v1/workspaces/${actualWorkspaceId}/output-sync/reconcile`,
    { method: "POST", headers: headers() },
  );
  expect(reconcile.status).toBe(409);
});
