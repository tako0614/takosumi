/**
 * RunGroup HTTP route tests (Core Specification §19 / §24).
 *
 *   POST /api/spaces/:spaceId/plan-update   -> create a space_update RunGroup
 *   GET  /api/run-groups/:runGroupId        -> read group + member Runs + status
 *   POST /api/run-groups/:runGroupId/approve -> approve waiting members
 *
 * Drives the full surface over the public routes against an in-memory store +
 * a fake runner whose producer apply emits a `base_domain` output a downstream
 * consumer injects. A producer re-apply with a CHANGED output cascades stale,
 * then plan-update builds the group.
 */

import { expect, test } from "bun:test";
import type { InstallConfig } from "takosumi-contract/installations";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { Run } from "takosumi-contract/runs";
import type { OpenTofuRunner } from "../domains/deploy-control/mod.ts";
import { applyExpectedGuardFromPlanRun } from "../domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import { createTakosumiService } from "../bootstrap.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
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
function runner(value: { producer: string; producerId?: string }): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
        },
      }),
    apply: (job) =>
      Promise.resolve({
        outputs: {
          base_domain: {
            sensitive: false,
            value: job.planRun.installationId === value.producerId
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
  const sourceRes = await app.request("/api/sources", {
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
    outputAllowlist: {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await operations.installations.putInstallConfig(config);

  const installRes = await app.request(`/api/spaces/${spaceId}/installations`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      name,
      environment: "preview",
      sourceId,
      installConfigId: config.id,
    }),
  });
  expect(installRes.status).toBe(201);
  const installationId = (await installRes.json()).installation.id as string;

  const snapshot: SourceSnapshot = {
    id: `snap_${name}00001`,
    sourceId,
    url: `https://github.com/acme/${name}.git`,
    ref: "main",
    resolvedCommit: "a".repeat(40),
    path: ".",
    archiveObjectKey:
      `spaces/${spaceId}/sources/${sourceId}/snapshots/snap_${name}/source.tar.zst`,
    archiveDigest: ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: `ssr_${name}00001`,
    fetchedAt: nowIso,
  };
  await store.putSourceSnapshot(snapshot);
  return installationId;
}

/** Applies a preview installation plan to completion (no approval gate). */
async function applyInstallation(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  installationId: string,
): Promise<void> {
  const planRes = await app.request(
    `/api/installations/${installationId}/plan`,
    { method: "POST", headers: headers() },
  );
  expect(planRes.status).toBe(201);
  const plan = (await planRes.json()).planRun;
  const applyRes = await app.request("/v1/apply-runs", {
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
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1", TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN },
    opentofuDeploymentStore: store,
    opentofuRunner: runner(producerValue),
    startWorkerDaemon: false,
  });

  const spaceRes = await app.request("/api/spaces", {
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
    `/api/installations/${consumer}/dependencies`,
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
  const emptyRes = await app.request(`/api/spaces/${spaceId}/plan-update`, {
    method: "POST",
    headers: headers(),
  });
  expect(emptyRes.status).toBe(409);
  expect((await emptyRes.json()).error.code).toBe("failed_precondition");

  // Producer re-applies with a CHANGED output -> consumer goes stale.
  producerValue.producer = "v2.example.com";
  await applyInstallation(app, producer);
  const consumerRow = await app.request(`/api/installations/${consumer}`, {
    headers: headers(),
  });
  expect((await consumerRow.json()).installation.status).toBe("stale");

  // plan-update: builds the group with the consumer as the sole member.
  const updateRes = await app.request(`/api/spaces/${spaceId}/plan-update`, {
    method: "POST",
    headers: headers(),
  });
  expect(updateRes.status).toBe(201);
  const group = await updateRes.json() as {
    runGroup: { id: string; type: string; status: string; graphJson: string };
    runs: Run[];
  };
  expect(group.runGroup.type).toBe("space_update");
  expect(group.runs).toHaveLength(1);
  expect(group.runs[0]!.installationId).toBe(consumer);
  expect(group.runs[0]!.runGroupId).toBe(group.runGroup.id);

  // GET the group: same member, computed status. Preview members auto-succeed
  // (no approval gate), so the group reads succeeded.
  const getRes = await app.request(`/api/run-groups/${group.runGroup.id}`, {
    headers: headers(),
  });
  expect(getRes.status).toBe(200);
  const fetched = await getRes.json() as {
    runGroup: { status: string };
    runs: Run[];
  };
  expect(fetched.runs).toHaveLength(1);
  expect(fetched.runGroup.status).toBe("succeeded");

  // Approve is a no-op here (no waiting members) but must still return the group.
  const approveRes = await app.request(
    `/api/run-groups/${group.runGroup.id}/approve`,
    { method: "POST", headers: headers() },
  );
  expect(approveRes.status).toBe(200);
  expect((await approveRes.json()).runGroup.id).toBe(group.runGroup.id);

  // An unknown run group is 404.
  const missingRes = await app.request("/api/run-groups/rg_missing00000001", {
    headers: headers(),
  });
  expect(missingRes.status).toBe(404);
});

test("plan-update rejects a malformed spaceId and run-group rejects a malformed id", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1", TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN },
    opentofuDeploymentStore: store,
    opentofuRunner: runner({ producer: "v1" }),
    startWorkerDaemon: false,
  });

  const badSpace = await app.request("/api/spaces/not-a-space/plan-update", {
    method: "POST",
    headers: headers(),
  });
  expect(badSpace.status).toBe(400);

  const badGroup = await app.request("/api/run-groups/not-a-group", {
    headers: headers(),
  });
  expect(badGroup.status).toBe(400);
});
