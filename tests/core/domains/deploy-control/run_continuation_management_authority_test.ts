import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import type { Workspace } from "takosumi-contract/workspaces";
import {
  capsuleLifecycleExpected,
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type RunManagementAuthorityInput,
  type StoredRunRecord,
  type UpdateCapsuleLifecycleCommand,
  type UpdateCapsuleLifecycleResult,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-09-10T00:00:00.000Z";
const pgClients: PGliteSqlClient[] = [];

setDefaultTimeout(20_000);

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

type ManagedRunKind = "plan" | "apply" | "restore";

interface Adapter {
  readonly label: string;
  readonly store: OpenTofuControlStore;
  readonly reopen: () => OpenTofuControlStore;
  readonly resumeManagement?: (workspaceId: string) => Promise<void>;
  readonly corruptRunJson?: (
    runId: string,
    mutate: (record: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<void>;
  readonly corruptRunPhysicalWorkspace?: (
    runId: string,
    workspaceId: string,
  ) => Promise<void>;
}

function parseJson(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  return structuredClone(parsed) as Record<string, unknown>;
}

async function adapters(): Promise<readonly Adapter[]> {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const d1 = new SqliteFakeD1();
  const memory = new InMemoryOpenTofuControlStore();
  return [
    {
      label: "memory",
      store: memory,
      reopen: () => memory,
    },
    {
      label: "postgres",
      store: new SqlOpenTofuControlStore({ client: pg }),
      reopen: () => new SqlOpenTofuControlStore({ client: pg }),
      async resumeManagement(workspaceId) {
        await pg.query(
          "update takosumi_workspaces set management_state = 'active', management_epoch = management_epoch + 1 where id = $1 and management_state = 'draining'",
          [workspaceId],
        );
      },
      async corruptRunJson(runId, mutate) {
        const result = await pg.query<{ readonly runJson: unknown }>(
          'select run_json as "runJson" from takosumi_runs where id = $1',
          [runId],
        );
        await pg.query(
          "update takosumi_runs set run_json = $1::jsonb where id = $2",
          [JSON.stringify(mutate(parseJson(result.rows[0]?.runJson))), runId],
        );
      },
      async corruptRunPhysicalWorkspace(runId, workspaceId) {
        await pg.query(
          "update takosumi_runs set space_id = $1 where id = $2",
          [workspaceId, runId],
        );
      },
    },
    {
      label: "d1",
      store: new CloudflareD1OpenTofuControlStore(d1),
      reopen: () => new CloudflareD1OpenTofuControlStore(d1),
      async resumeManagement(workspaceId) {
        await d1
          .prepare(
            "update workspaces set management_state = 'active', management_epoch = management_epoch + 1 where id = ? and management_state = 'draining'",
          )
          .bind(workspaceId)
          .run();
      },
      async corruptRunJson(runId, mutate) {
        const row = await d1
          .prepare("select run_json as runJson from runs where id = ?")
          .bind(runId)
          .first<{ readonly runJson: unknown }>();
        await d1
          .prepare("update runs set run_json = ? where id = ?")
          .bind(JSON.stringify(mutate(parseJson(row?.runJson))), runId)
          .run();
      },
      async corruptRunPhysicalWorkspace(runId, workspaceId) {
        await d1
          .prepare("update runs set space_id = ? where id = ?")
          .bind(workspaceId, runId)
          .run();
      },
    },
  ];
}

function workspace(id: string): Workspace {
  return {
    id,
    handle: `handle-${id}`,
    displayName: id,
    type: "personal",
    ownerUserId: `owner-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function capsule(id: string, workspaceId: string): Capsule {
  return {
    id,
    workspaceId,
    projectId: `project-${id}`,
    name: `capsule-${id}`,
    slug: `capsule-${id}`,
    sourceId: `source-${id}`,
    installConfigId: `config-${id}`,
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    autoUpdate: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function planRun(id: string, workspaceId: string): PlanRun {
  return {
    id,
    workspaceId,
    source: {
      kind: "git",
      url: "https://example.test/continuation-authority.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "runner",
    variablesDigest: "sha256:variables",
    executionInputsDigest: "sha256:inputs",
    requiredProviders: [],
    requiredProviderRequirements: [],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function applyRun(id: string, workspaceId: string): ApplyRun {
  const planRunId = `plan-${id}`;
  return {
    id,
    planRunId,
    workspaceId,
    operation: "update",
    runnerProfileId: "runner",
    status: "queued",
    expected: {
      planRunId,
      runnerProfileId: "runner",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "operator-managed", ref: "state" },
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function restoreRun(id: string, workspaceId: string): Run {
  return {
    id,
    workspaceId,
    type: "restore",
    status: "queued",
    backupId: `backup-${id}`,
    capsuleId: `capsule-${id}`,
    restoreStateGeneration: 1,
    createdBy: "owner",
    createdAt: NOW,
  };
}

function run(
  kind: ManagedRunKind,
  id: string,
  workspaceId: string,
): PlanRun | ApplyRun | Run {
  return kind === "plan"
    ? planRun(id, workspaceId)
    : kind === "apply"
      ? applyRun(id, workspaceId)
      : restoreRun(id, workspaceId);
}

async function activeAuthority(
  store: OpenTofuControlStore,
  workspaceId: string,
): Promise<WorkspaceManagementAuthority> {
  const management = await store.getWorkspaceManagement(workspaceId);
  if (!management || management.managementState !== "active") {
    throw new Error(`Workspace ${workspaceId} is not active`);
  }
  return {
    workspaceId,
    managementState: "active",
    managementEpoch: management.managementEpoch,
  };
}

async function admit(
  store: OpenTofuControlStore,
  kind: ManagedRunKind,
  candidate: PlanRun | ApplyRun | Run,
  authority: WorkspaceManagementAuthority,
): Promise<void> {
  if (kind === "plan") {
    const result = await store.preparePlanRun({
      run: candidate as PlanRun,
      inputs: { planRunId: candidate.id, variables: {} },
      expectedWorkspaceManagementAuthority: authority,
    });
    expect(result.status).toBe("created");
    return;
  }
  const result = kind === "apply"
    ? await store.beginApplyRun(candidate as ApplyRun, authority)
    : await store.beginRestoreRun(candidate as Run, authority);
  expect(result.status).toBe("created");
}

function getRun(
  store: OpenTofuControlStore,
  kind: ManagedRunKind,
  id: string,
): Promise<PlanRun | ApplyRun | Run | undefined> {
  return kind === "plan"
    ? store.getPlanRun(id)
    : kind === "apply"
      ? store.getApplyRun(id)
      : store.getBackupRun(id);
}

async function putRun(
  store: OpenTofuControlStore,
  kind: ManagedRunKind,
  candidate: PlanRun | ApplyRun | Run,
): Promise<void> {
  if (kind === "plan") {
    await store.putPlanRun(candidate as PlanRun);
  } else if (kind === "apply") {
    await store.putApplyRun(candidate as ApplyRun);
  } else {
    await store.putBackupRun(candidate as Run);
  }
}

function publicRunHasNoAuthority(value: unknown): void {
  expect(
    value && typeof value === "object"
      ? Object.prototype.hasOwnProperty.call(
          value,
          "workspaceManagementAuthority",
        )
      : false,
  ).toBe(false);
  expect(JSON.stringify(value)).not.toContain("workspaceManagementAuthority");
}

function runAuthorityInput(
  id: string,
  workspaceId: string,
  kind: ManagedRunKind,
): RunManagementAuthorityInput {
  return { id, workspaceId, kind };
}

test("Run continuation getter returns only the saved original authority for an exact row", async () => {
  for (const adapter of await adapters()) {
    const { store, label } = adapter;
    const workspaceId = `continuation-getter-${label}`;
    await store.putWorkspace(workspace(workspaceId));
    const original = await activeAuthority(store, workspaceId);

    for (const kind of ["plan", "apply", "restore"] as const) {
      const row = run(kind, `continuation-${label}-${kind}`, workspaceId);
      await admit(store, kind, row, original);
      const input = runAuthorityInput(row.id, workspaceId, kind);
      expect(await store.getRunManagementAuthority(input), `${label}:${kind}`).toEqual(
        original,
      );

      const observed = await store.getRunManagementAuthority(input);
      if (!observed) throw new Error(`${label}:${kind} authority missing`);
      (observed as unknown as { managementEpoch: number }).managementEpoch = 99;
      expect(await store.getRunManagementAuthority(input), `${label}:${kind}:clone`).toEqual(
        original,
      );

      expect(
        await store.getRunManagementAuthority(
          runAuthorityInput(`${row.id}-wrong`, workspaceId, kind),
        ),
        `${label}:${kind}:id`,
      ).toBeUndefined();
      expect(
        await store.getRunManagementAuthority(
          runAuthorityInput(row.id, `${workspaceId}-wrong`, kind),
        ),
        `${label}:${kind}:workspace`,
      ).toBeUndefined();
      const wrongKind = kind === "plan" ? "apply" : kind === "apply" ? "restore" : "plan";
      expect(
        await store.getRunManagementAuthority(
          runAuthorityInput(row.id, workspaceId, wrongKind),
        ),
        `${label}:${kind}:kind`,
      ).toBeUndefined();
      publicRunHasNoAuthority(await getRun(store, kind, row.id));
    }

    expect(
      JSON.stringify(await store.listRunsByWorkspace(workspaceId)),
      `${label}:list`,
    ).not.toContain("workspaceManagementAuthority");

    expect(await store.beginWorkspaceDraining(workspaceId, original), label).toMatchObject({
      status: "started",
      management: { managementState: "draining", managementEpoch: 2 },
    });
    const drainingRow = runAuthorityInput(
      `continuation-${label}-plan`,
      workspaceId,
      "plan",
    );
    expect(await store.getRunManagementAuthority(drainingRow), `${label}:draining`).toEqual(
      original,
    );

    if (adapter.resumeManagement) {
      await adapter.resumeManagement(workspaceId);
      const reopened = adapter.reopen();
      expect(await reopened.getWorkspaceManagement(workspaceId), `${label}:resume`).toMatchObject({
        managementState: "active",
        managementEpoch: 3,
      });
      expect(
        await reopened.getRunManagementAuthority(drainingRow),
        `${label}:resumed`,
      ).toEqual(original);
    }
  }
});

test("Run continuation getter rejects legacy, malformed, and physically or JSON-mismatched rows", async () => {
  for (const adapter of await adapters()) {
    const { store, label } = adapter;
    const workspaceId = `continuation-corrupt-${label}`;
    const foreignWorkspaceId = `${workspaceId}-foreign`;
    await store.putWorkspace(workspace(workspaceId));
    await store.putWorkspace(workspace(foreignWorkspaceId));
    const original = await activeAuthority(store, workspaceId);

    const legacy = planRun(`continuation-legacy-${label}`, workspaceId);
    await putRun(store, "plan", legacy);
    expect(
      await store.getRunManagementAuthority(
        runAuthorityInput(legacy.id, workspaceId, "plan"),
      ),
      `${label}:legacy`,
    ).toBeUndefined();

    if (!adapter.corruptRunJson || !adapter.corruptRunPhysicalWorkspace) continue;

    const jsonMismatch = applyRun(`continuation-json-${label}`, workspaceId);
    await admit(store, "apply", jsonMismatch, original);
    await adapter.corruptRunJson(jsonMismatch.id, (record) => ({
      ...record,
      workspaceId: foreignWorkspaceId,
    }));
    expect(
      await store.getRunManagementAuthority(
        runAuthorityInput(jsonMismatch.id, workspaceId, "apply"),
      ),
      `${label}:json-workspace`,
    ).toBeUndefined();

    const physicalMismatch = restoreRun(`continuation-physical-${label}`, workspaceId);
    await admit(store, "restore", physicalMismatch, original);
    await adapter.corruptRunPhysicalWorkspace(
      physicalMismatch.id,
      foreignWorkspaceId,
    );
    expect(
      await store.getRunManagementAuthority(
        runAuthorityInput(physicalMismatch.id, workspaceId, "restore"),
      ),
      `${label}:physical-workspace`,
    ).toBeUndefined();

    const malformed = planRun(`continuation-malformed-${label}`, workspaceId);
    await admit(store, "plan", malformed, original);
    await adapter.corruptRunJson(malformed.id, (record) => ({
      ...record,
      workspaceManagementAuthority: {
        workspaceId,
        managementState: "active",
        managementEpoch: "not-a-number",
      },
    }));
    expect(
      await store.getRunManagementAuthority(
        runAuthorityInput(malformed.id, workspaceId, "plan"),
      ),
      `${label}:malformed`,
    ).toBeUndefined();
  }
});

type MarkerCommand = UpdateCapsuleLifecycleCommand & {
  readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
};

function markerCommand(
  capsuleRecord: Capsule,
  executionAuthorityEpoch: number,
  sourceSnapshotId: string,
  updatedAt: string,
  expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
): MarkerCommand {
  const mutation = expectedWorkspaceManagementAuthority === undefined
    ? ({ kind: "auto-update-claim", sourceSnapshotId } as never)
    : {
        kind: "auto-update-claim" as const,
        sourceSnapshotId,
        expectedWorkspaceManagementAuthority,
      };
  return {
    capsuleId: capsuleRecord.id,
    expected: capsuleLifecycleExpected(
      capsuleRecord,
      executionAuthorityEpoch,
    ),
    mutation,
    updatedAt,
  } as MarkerCommand;
}

async function updateMarker(
  store: OpenTofuControlStore,
  input: MarkerCommand,
): Promise<UpdateCapsuleLifecycleResult> {
  return await store.updateCapsuleLifecycle(input);
}

test("auto-update marker requires the original authority while new markers are admissions", async () => {
  for (const adapter of await adapters()) {
    const { store, label } = adapter;
    const workspaceId = `continuation-marker-${label}`;
    const capsuleId = `continuation-marker-capsule-${label}`;
    await store.putWorkspace(workspace(workspaceId));
    const original = await activeAuthority(store, workspaceId);
    const initial = capsule(capsuleId, workspaceId);
    await store.putCapsule(initial);
    const executionEpoch = await store.getCapsuleExecutionAuthorityEpoch(capsuleId);
    if (executionEpoch === undefined) throw new Error(`${label}:missing capsule epoch`);

    const missing = await updateMarker(
      store,
      markerCommand(
        initial,
        executionEpoch,
        `snapshot-missing-${label}`,
        `${NOW}01`,
      ),
    );
    expect(missing, `${label}:missing`).toEqual({
      kind: "conflict",
      current: initial,
    });

    const first = await updateMarker(
      store,
      markerCommand(
        initial,
        executionEpoch,
        `snapshot-first-${label}`,
        `${NOW}02`,
        original,
      ),
    );
    expect(first.kind, `${label}:first`).toBe("updated");
    if (first.kind !== "updated") throw new Error(`${label}:marker admission failed`);
    const claimed = first.capsule;

    expect(await store.beginWorkspaceDraining(workspaceId, original), label).toMatchObject({
      status: "started",
      management: { managementState: "draining", managementEpoch: 2 },
    });

    const replay = await updateMarker(
      store,
      markerCommand(
        claimed,
        executionEpoch,
        `snapshot-first-${label}`,
        `${NOW}03`,
        original,
      ),
    );
    expect(replay, `${label}:replay`).toEqual({ kind: "unchanged", capsule: claimed });

    const nextMarker = `snapshot-second-${label}`;
    if (adapter.resumeManagement) {
      await adapter.resumeManagement(workspaceId);
      const reopened = adapter.reopen();
      expect(await reopened.getWorkspaceManagement(workspaceId), `${label}:resume`).toMatchObject({
        managementState: "active",
        managementEpoch: 3,
      });
      const current = await reopened.getCapsule(capsuleId);
      if (!current) throw new Error(`${label}:capsule disappeared`);
      const denied = await updateMarker(
        reopened,
        markerCommand(current, executionEpoch, nextMarker, `${NOW}04`, original),
      );
      expect(denied, `${label}:old-epoch`).toEqual({
        kind: "conflict",
        current: claimed,
      });
      expect(await reopened.getCapsule(capsuleId), `${label}:unchanged`).toEqual(claimed);
    } else {
      const denied = await updateMarker(
        store,
        markerCommand(claimed, executionEpoch, nextMarker, `${NOW}04`, original),
      );
      expect(denied, `${label}:draining`).toEqual({
        kind: "conflict",
        current: claimed,
      });
      expect(await store.getCapsule(capsuleId), `${label}:unchanged`).toEqual(claimed);
    }
  }
});
