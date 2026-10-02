import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTakosumiService } from "../../../../core/bootstrap.ts";
import {
  applyExpectedGuardFromPlanRun,
  type OpenTofuApplyJob,
} from "../../../../core/domains/deploy-control/mod.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fakeProviderVault,
  fixtureExecutionEvidence,
  fixtureStateCommit,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function deterministicRunner() {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local" as const,
          ref: "runner-local://pg-restart/tfplan",
          digest: PLAN_DIGEST,
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      }),
    apply: (job: OpenTofuApplyJob) =>
      Promise.resolve(
        fixtureStateCommit({
          rawOutputRef: job.rawOutputRef,
          outputs: {
            launch_url: {
              sensitive: false,
              value: "https://pg-restart.example.test",
            },
          },
          providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
          executionEvidence: fixtureExecutionEvidence(job, "apply"),
        }),
      ),
  };
}

function createCoreService(sqlClient: PGliteSqlClient) {
  return createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    sqlClient,
    opentofuRunner: deterministicRunner(),
    opentofuConnectionVault: fakeProviderVault() as never,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
}

async function readLifecycle(
  service: Awaited<ReturnType<typeof createCoreService>>,
  ids: {
    readonly sourceId: string;
    readonly sourceSnapshotId: string;
    readonly capsuleId: string;
    readonly planRunId: string;
    readonly applyRunId: string;
    readonly stateVersionId: string;
    readonly outputId: string;
  },
) {
  const { operations } = service;
  const [source, sourceSnapshot, capsule, plan, apply, run, state, output] =
    await Promise.all([
      operations.getSource(ids.sourceId),
      operations.getSourceSnapshot(ids.sourceSnapshotId),
      operations.controller.getCapsule(ids.capsuleId),
      operations.controller.getPlanRun(ids.planRunId),
      operations.controller.getApplyRun(ids.applyRunId),
      operations.controller.getRun(ids.applyRunId),
      operations.controller.getStateVersion(ids.stateVersionId),
      operations.controller.getOutput(ids.outputId),
    ]);

  return {
    source: source.source,
    sourceSnapshot,
    capsule: capsule.capsule,
    planRun: plan.planRun,
    applyRun: apply.applyRun,
    run,
    stateVersion: state.stateVersion,
    output,
  };
}

test("Core Apply lineage survives closing and reopening the exact PostgreSQL data snapshot", async () => {
  const originalClient = await PGliteSqlClient.create();
  let reopenedClient: PGliteSqlClient | undefined;
  let emptyClient: PGliteSqlClient | undefined;
  let snapshotDirectory: string | undefined;
  try {
    // This fixture intentionally uses a synthetic Workspace owner; it does not
    // exercise or claim persistence of Accounts sessions or authentication.
    const store = new SqlOpenTofuControlStore({ client: originalClient });
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_core_pg_restart",
      capsuleId: "cap_core_pg_restart",
      sourceId: "src_core_pg_restart",
      snapshotId: "snap_core_pg_restart",
      installConfigId: "cfg_core_pg_restart",
      requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
    });
    await seedProviderConnections(store, seeded.capsule);
    await store.putCapsuleCompatibilityReport({
      id: "caprep_core_pg_restart",
      sourceId: seeded.source.id,
      capsuleId: seeded.capsule.id,
      sourceSnapshotId: seeded.snapshot.id,
      modulePath: ".",
      level: "ready",
      findings: [],
      providerPackages: [
        { source: FIXTURE_CLOUDFLARE_PROVIDER, allowed: true },
      ],
      rootProviderRequirements: [
        {
          source: FIXTURE_CLOUDFLARE_PROVIDER,
          moduleLocalName: "cloudflare",
        },
      ],
      resources: [],
      dataSources: [],
      provisioners: [],
      rootModuleOutputs: [
        { name: "launch_url", sensitive: false, ephemeral: false },
      ],
      createdAt: "2026-06-06T00:00:00.000Z",
    });
    await store.putCapsule({
      ...seeded.capsule,
      compatibilityReportId: "caprep_core_pg_restart",
      compatibilityStatus: "ready",
    });

    const firstService = await createCoreService(originalClient);
    const { planRun } = await firstService.operations.controller.createCapsulePlan(
      seeded.capsule.id,
    );
    expect(planRun.status).toBe("succeeded");
    const { applyRun } = await firstService.operations.controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    });
    expect(applyRun.status).toBe("succeeded");
    expect(applyRun.stateVersionId).toBeString();
    expect(applyRun.outputId).toBeString();

    const ids = {
      sourceId: seeded.source.id,
      sourceSnapshotId: seeded.snapshot.id,
      capsuleId: seeded.capsule.id,
      planRunId: planRun.id,
      applyRunId: applyRun.id,
      stateVersionId: applyRun.stateVersionId!,
      outputId: applyRun.outputId!,
    };
    const before = await readLifecycle(firstService, ids);
    expect(before.source.id).toBe(ids.sourceId);
    expect(before.sourceSnapshot.id).toBe(ids.sourceSnapshotId);
    expect(before.planRun.sourceSnapshotId).toBe(ids.sourceSnapshotId);
    expect(before.applyRun.id).toBe(ids.applyRunId);
    expect(before.run.id).toBe(ids.applyRunId);
    expect(before.capsule.currentStateVersionId).toBe(ids.stateVersionId);
    expect(before.capsule.currentStateGeneration).toBe(1);
    expect(before.stateVersion.id).toBe(ids.stateVersionId);
    expect(before.stateVersion.generation).toBe(1);
    expect(before.stateVersion.createdByRunId).toBe(ids.applyRunId);
    expect(before.applyRun.outputId).toBe(ids.outputId);
    expect(before.output).toMatchObject({
      id: ids.outputId,
      publicOutputs: { launch_url: "https://pg-restart.example.test" },
    });

    snapshotDirectory = await mkdtemp(
      join(tmpdir(), "takosumi-core-pg-restart-"),
    );
    const snapshotArtifactPath = join(snapshotDirectory, "database.tar");
    const snapshotArtifact = await originalClient.snapshotDataDir();
    await writeFile(
      snapshotArtifactPath,
      new Uint8Array(await snapshotArtifact.arrayBuffer()),
      { mode: 0o600, flag: "wx" },
    );
    await originalClient.close();

    // Reopen the exact bytes read from the owned temporary artifact. This path
    // does not run migrations or call the seed fixture again; only fresh PGlite
    // and Core service instances are composed.
    const persistedSnapshotBytes = await readFile(snapshotArtifactPath);
    reopenedClient = await PGliteSqlClient.fromDataDirSnapshot(
      new Blob([persistedSnapshotBytes]),
    );
    const restartedService = await createCoreService(reopenedClient);
    const after = await readLifecycle(restartedService, ids);
    expect(after).toEqual(before);

    await reopenedClient.close();
    reopenedClient = undefined;

    // A separately initialized, empty database remains empty: recreating Core
    // does not recreate prior rows, and the exact old identities fail closed.
    emptyClient = await PGliteSqlClient.create();
    const emptyService = await createCoreService(emptyClient);
    await expect(
      emptyService.operations.controller.getRun(ids.applyRunId),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      emptyService.operations.getSourceSnapshot(ids.sourceSnapshotId),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await emptyService.operations.controller.listRuns(
        "workspace_core_pg_restart",
      ),
    ).toEqual([]);
  } finally {
    if (reopenedClient && !reopenedClient.closed) await reopenedClient.close();
    if (emptyClient && !emptyClient.closed) await emptyClient.close();
    if (!originalClient.closed) await originalClient.close();
    if (snapshotDirectory) {
      await rm(snapshotDirectory, { recursive: true, force: true });
    }
  }
});
