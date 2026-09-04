import { expect, test } from "bun:test";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import type { OpenTofuRunner } from "../../../core/domains/deploy-control/mod.ts";
import { OpenTofuControllerError } from "../../../core/domains/deploy-control/errors.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";

const NOW = "2026-09-04T00:00:00.000Z";
const WORKSPACE_ID = "ws_restore001";
const SOURCE_ID = "src_restore001";
const SNAPSHOT_ID = "snap_restore001";
const COMPATIBILITY_RUN_ID = "ccr_restore00000001";
const COMPATIBILITY_REPORT_ID = "caprep_restore00000001";
const BUNDLE_DIGEST = `sha256:${"a".repeat(64)}`;
const PLAN_DIGEST = `sha256:${"b".repeat(64)}`;
const LOCK_DIGEST = `sha256:${"c".repeat(64)}`;

function runner(): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/restore.tfplan",
          digest: PLAN_DIGEST,
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [],
        providerInstallation: [],
      }),
    apply: () => Promise.resolve({ outputs: {} as never }),
    destroy: () => Promise.resolve({}),
  };
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "takosumi.capsule-configuration-restore@v1",
    bundleDigest: BUNDLE_DIGEST,
    migrationId: "migration-restore-001",
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    compatibilityCheckRunId: COMPATIBILITY_RUN_ID,
    compatibilityReportId: COMPATIBILITY_REPORT_ID,
    capsule: {
      name: "restored-app",
      environment: "production",
      autoUpdate: false,
    },
    configuration: {
      modulePath: ".",
      runnerId: "opentofu-default",
      variableMapping: { ordinary: "write-only-value" },
      outputAllowlist: {},
      policy: {},
    },
    providerBindings: [],
    ...overrides,
  };
}

async function harness() {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace({
    id: WORKSPACE_ID,
    handle: "restore-test",
    displayName: "Restore test",
    type: "personal",
    ownerUserId: "acct_restore",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.putSource({
    id: SOURCE_ID,
    workspaceId: WORKSPACE_ID,
    name: "restore-source",
    url: "https://example.com/acme/restore.git",
    defaultRef: "0123456789abcdef0123456789abcdef01234567",
    defaultPath: ".",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    hookSecretHash: `sha256:${"d".repeat(64)}`,
    autoSync: false,
  });
  const snapshot: SourceSnapshot = {
    id: SNAPSHOT_ID,
    origin: "git",
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    url: "https://example.com/acme/restore.git",
    ref: "0123456789abcdef0123456789abcdef01234567",
    resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
    path: ".",
    archiveRef: `workspaces/${WORKSPACE_ID}/sources/${SOURCE_ID}/snapshots/${SNAPSHOT_ID}/source.tar.zst`,
    archiveDigest: `sha256:${"e".repeat(64)}`,
    archiveSizeBytes: 1024,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [
        { path: ".", providerPackages: [], rootProviderRequirements: [] },
      ],
    },
    fetchedByRunId: "ssr_restore00000001",
    fetchedAt: NOW,
  };
  await store.putSourceSnapshot(snapshot);
  const report: CapsuleCompatibilityReport = {
    id: COMPATIBILITY_REPORT_ID,
    sourceId: SOURCE_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    modulePath: ".",
    level: "ready",
    findings: [],
    providerPackages: [],
    rootProviderRequirements: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: NOW,
  };
  await store.putCapsuleCompatibilityReport(report);
  const compatibilityRun: Run = {
    id: COMPATIBILITY_RUN_ID,
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    type: "compatibility_check",
    status: "succeeded",
    sourceSnapshotId: SNAPSHOT_ID,
    compatibilityReportId: COMPATIBILITY_REPORT_ID,
    createdBy: "acct_restore",
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
  };
  await store.putCompatibilityCheckRun(compatibilityRun);

  const service = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    opentofuRunner: runner(),
    authorizeDeployControlBearer: ({ token }) => {
      if (token === "operator-token") {
        return {
          actor: "operator",
          workspaceIds: "*",
          operations: "*",
          runnerProfileIds: "*",
        };
      }
      if (token === "scoped-token") {
        return {
          actor: "workspace-user",
          workspaceIds: [WORKSPACE_ID],
          operations: "*",
          runnerProfileIds: "*",
        };
      }
      return undefined;
    },
  });
  return { ...service, store };
}

function restoreRequest(
  token: string,
  body: Record<string, unknown> = requestBody(),
) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": String(body.migrationId),
    },
    body: JSON.stringify(body),
  } satisfies RequestInit;
}

test("operator restore recovers atomic and Plan lost acknowledgements, then replays", async () => {
  const { app, operations, store } = await harness();
  const originalAtomic = store.createCapsuleInitialAuthority.bind(store);
  let loseAtomicAck = true;
  store.createCapsuleInitialAuthority = async (input) => {
    const result = await originalAtomic(input);
    if (loseAtomicAck) {
      loseAtomicAck = false;
      throw new Error("simulated atomic commit acknowledgement loss");
    }
    return result;
  };

  const first = await app.request(
    "/internal/v1/capsule-configuration-restores",
    restoreRequest("operator-token"),
  );
  expect(first.status).toBe(500);
  expect((await store.listCapsules(WORKSPACE_ID)).length).toBe(1);
  expect((await store.listInstallConfigs(WORKSPACE_ID)).length).toBe(1);
  expect((await store.listRunsByWorkspace(WORKSPACE_ID)).length).toBe(1);

  const originalPlan = operations.controller.createCapsulePlan.bind(
    operations.controller,
  );
  let losePlanAck = true;
  operations.controller.createCapsulePlan = async (...args) => {
    const result = await originalPlan(...args);
    if (losePlanAck) {
      losePlanAck = false;
      throw new Error("simulated Plan acknowledgement loss");
    }
    return result;
  };

  const successor = await app.request(
    "/internal/v1/capsule-configuration-restores",
    restoreRequest("operator-token"),
  );
  expect(successor.status).toBe(201);
  const successorBody = await successor.json();
  expect(successorBody.restore).toMatchObject({
    kind: "takosumi.capsule-configuration-restore@v1",
    bundleDigest: BUNDLE_DIGEST,
    replayed: false,
  });
  expect(JSON.stringify(successorBody)).not.toContain("write-only-value");

  const replay = await app.request(
    "/internal/v1/capsule-configuration-restores",
    restoreRequest("operator-token"),
  );
  expect(replay.status).toBe(200);
  const replayBody = await replay.json();
  expect(replayBody.restore).toEqual({
    ...successorBody.restore,
    replayed: true,
  });
  expect(replayBody.links).toEqual(successorBody.links);

  const capsuleId = successorBody.restore.capsuleId as string;
  const installConfigId = successorBody.restore.installConfigId as string;
  const planRunId = successorBody.restore.planRunId as string;
  const capsule = await store.getCapsule(capsuleId);
  const config = await store.getInstallConfig(installConfigId);
  const run = await operations.controller.getRun(planRunId);
  expect(capsule).toMatchObject({
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    installConfigId,
    status: "pending",
  });
  expect(config).toMatchObject({
    workspaceId: WORKSPACE_ID,
    variableMapping: { ordinary: "write-only-value" },
    internal: {
      reason: "per_install_overrides",
      migrationRestore: {
        bundleDigest: BUNDLE_DIGEST,
        migrationId: "migration-restore-001",
        sourceSnapshotId: SNAPSHOT_ID,
        compatibilityCheckRunId: COMPATIBILITY_RUN_ID,
        compatibilityReportId: COMPATIBILITY_REPORT_ID,
        actorSubject: "operator",
      },
    },
  });
  expect(run).toMatchObject({
    id: planRunId,
    type: "plan",
    capsuleId,
    sourceSnapshotId: SNAPSHOT_ID,
    compatibilityReportId: COMPATIBILITY_REPORT_ID,
  });
  expect(
    await operations.capsules.getCapsuleExecutionAuthorityEpoch(capsuleId),
  ).toBe(1);

  const before = {
    capsule,
    config,
    run,
    epoch: await operations.capsules.getCapsuleExecutionAuthorityEpoch(
      capsuleId,
    ),
  };
  const conflictBody = requestBody({
    configuration: {
      modulePath: ".",
      runnerId: "opentofu-default",
      variableMapping: { ordinary: "different-value" },
      outputAllowlist: {},
      policy: {},
    },
  });
  const conflict = await app.request(
    "/internal/v1/capsule-configuration-restores",
    restoreRequest("operator-token", conflictBody),
  );
  expect(conflict.status).toBe(409);
  expect(await store.getCapsule(capsuleId)).toEqual(before.capsule);
  expect(await store.getInstallConfig(installConfigId)).toEqual(before.config);
  expect(await operations.controller.getRun(planRunId)).toEqual(before.run);
  expect(
    await operations.capsules.getCapsuleExecutionAuthorityEpoch(capsuleId),
  ).toBe(before.epoch);
});

test("operator restore fences a concurrent Capsule authority transition before Plan persistence", async () => {
  const { app, operations, store } = await harness();
  const originalPlan = operations.controller.createCapsulePlan.bind(
    operations.controller,
  );
  let interleaved = false;
  operations.controller.createCapsulePlan = async (...args) => {
    if (!interleaved) {
      interleaved = true;
      const [capsule] = await store.listCapsules(WORKSPACE_ID);
      if (!capsule) throw new Error("restore initial authority was not created");
      await store.putCapsule({
        ...capsule,
        status: "destroyed",
        updatedAt: "2026-09-04T00:00:00.001Z",
      });
      await store.putCapsule({
        ...capsule,
        status: "pending",
        updatedAt: "2026-09-04T00:00:00.002Z",
      });
    }
    return await originalPlan(...args);
  };

  const rejected = await app.request(
    "/internal/v1/capsule-configuration-restores",
    restoreRequest("operator-token"),
  );
  expect(rejected.status).toBe(409);
  expect(interleaved).toBe(true);
  const [capsule] = await store.listCapsules(WORKSPACE_ID);
  expect(capsule).toBeDefined();
  expect(
    await operations.capsules.getCapsuleExecutionAuthorityEpoch(capsule!.id),
  ).toBe(2);
  expect(
    (await store.listRunsByWorkspace(WORKSPACE_ID)).filter(
      (run) => run.type === "plan",
    ),
  ).toEqual([]);
});

test("restore requires unrestricted operator, exact key/digest, and provider neutrality", async () => {
  const { app, store } = await harness();
  const unauthenticated = await app.request(
    "/internal/v1/capsule-configuration-restores",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    },
  );
  expect(unauthenticated.status).toBe(401);

  const scoped = await app.request(
    "/internal/v1/capsule-configuration-restores",
    restoreRequest("scoped-token"),
  );
  expect(scoped.status).toBe(403);

  for (const body of [
    requestBody({ bundleDigest: "sha256:not-a-digest" }),
    requestBody({ providerBindings: [{ provider: "example.invalid" }] }),
  ]) {
    const response = await app.request(
      "/internal/v1/capsule-configuration-restores",
      restoreRequest("operator-token", body),
    );
    expect(response.status).toBe(400);
  }
  const wrongKey = await app.request(
    "/internal/v1/capsule-configuration-restores",
    {
      ...restoreRequest("operator-token"),
      headers: {
        ...restoreRequest("operator-token").headers,
        "idempotency-key": "different-migration",
      },
    },
  );
  expect(wrongKey.status).toBe(400);

  const source = await store.getSource(SOURCE_ID);
  if (!source) throw new Error("restore fixture Source is missing");
  await store.putSource({ ...source, defaultPath: "changed-after-snapshot" });
  const driftedSource = await app.request(
    "/internal/v1/capsule-configuration-restores",
    restoreRequest("operator-token"),
  );
  expect(driftedSource.status).toBe(409);
  expect(await store.listCapsules(WORKSPACE_ID)).toEqual([]);
  expect(await store.listInstallConfigs(WORKSPACE_ID)).toEqual([]);
});

test("operator restore runs complete provider semantic preflight before initial authority", async () => {
  const { app, operations, store } = await harness();
  const controller = operations.controller as unknown as {
    validateCapsuleConfigurationProviderBindings: () => Promise<void>;
  };
  const original = controller.validateCapsuleConfigurationProviderBindings;
  controller.validateCapsuleConfigurationProviderBindings = async () => {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "provider semantic preflight rejected the proposed binding set",
      { reason: "provider_connection_setup_required" },
    );
  };
  try {
    const response = await app.request(
      "/internal/v1/capsule-configuration-restores",
      restoreRequest("operator-token"),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: "failed_precondition",
      details: { reason: "provider_connection_setup_required" },
    });
  } finally {
    controller.validateCapsuleConfigurationProviderBindings = original;
  }
  expect(await store.listCapsules(WORKSPACE_ID)).toEqual([]);
  expect(await store.listInstallConfigs(WORKSPACE_ID)).toEqual([]);
  expect(
    (await store.listRunsByWorkspace(WORKSPACE_ID)).filter(
      (run) => run.type === "plan",
    ),
  ).toEqual([]);
});
