import { expect, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import {
  InMemoryOpenTofuControlStore, planRunExecutionInputsDigestMaterial,
  type OpenTofuControlStore, type StoredRunRecord, type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

type Kind = "plan" | "apply" | "restore";
const now = "2026-09-10T00:00:00.000Z";

async function candidate(kind: Kind, id: string, workspaceId: string): Promise<StoredRunRecord> {
  if (kind === "restore") return {
    id, workspaceId, type: "restore", status: "queued", createdAt: now, createdBy: "owner",
    backupId: `backup-${id}`, capsuleId: "capsule", restoreStateGeneration: 1,
    restoredFromStateVersionId: "state-1", planDigest: "sha256:backup",
  } satisfies Run;
  if (kind === "apply") return {
    id, workspaceId, planRunId: `parent-${id}`, operation: "update", runnerProfileId: "runner",
    status: "queued", createdAt: 1, updatedAt: 1, auditEvents: [],
    expected: { planRunId: `parent-${id}`, runnerProfileId: "runner", sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables", policyDecisionDigest: "sha256:policy", planDigest: "sha256:plan", planArtifactDigest: "sha256:artifact" },
    stateBackend: { kind: "operator-managed", ref: "state" }, stateLock: { status: "pending", backendRef: "state" },
  } satisfies ApplyRun;
  return {
    id, workspaceId, source: { kind: "git", url: "https://example.test/repo.git", commit: "0123456789abcdef0123456789abcdef01234567" },
    sourceDigest: "sha256:source", operation: "update", runnerProfileId: "runner", status: "queued",
    variablesDigest: await stableJsonDigest({}),
    executionInputsDigest: await stableJsonDigest(planRunExecutionInputsDigestMaterial({ planRunId: id, variables: {} }, undefined)),
    requiredProviders: [], requiredProviderRequirements: [], policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy", auditEvents: [], createdAt: 1, updatedAt: 1,
  } satisfies PlanRun;
}

async function admit(store: OpenTofuControlStore, kind: Kind, row: StoredRunRecord, authority?: WorkspaceManagementAuthority) {
  if (kind === "plan") return await store.preparePlanRun({ run: row as PlanRun,
    inputs: { planRunId: row.id, variables: {} }, expectedWorkspaceManagementAuthority: authority });
  if (kind === "apply") return await store.beginApplyRun(row as ApplyRun, authority);
  return await store.beginRestoreRun(row as Run, authority);
}

function get(store: OpenTofuControlStore, kind: Kind, id: string) {
  return kind === "plan" ? store.getPlanRun(id) : kind === "apply" ? store.getApplyRun(id) : store.getBackupRun(id);
}

async function put(store: OpenTofuControlStore, kind: Kind, row: StoredRunRecord) {
  if (kind === "plan") return await store.putPlanRun(row as PlanRun);
  if (kind === "apply") return await store.putApplyRun(row as ApplyRun);
  return await store.putBackupRun(row as Run);
}

function claim(store: OpenTofuControlStore, kind: Kind, row: StoredRunRecord, expected?: WorkspaceManagementAuthority) {
  return store.transitionRun({ id: row.id, kind, expectFrom: ["queued"], setLeaseToken: `lease-${row.id}`,
    expectedWorkspaceManagementAuthority: expected,
    run: { ...row, status: "running", startedAt: kind === "restore" ? now : 100 } as StoredRunRecord });
}

for (const name of ["Memory", "Postgres", "D1"] as const) {
  test(`${name}: managed Runs preserve original admission across pauses without blocking same-epoch retries`, async () => {
    const pg = name === "Postgres" ? await PGliteSqlClient.create() : undefined;
    const d1 = name === "D1" ? new SqliteFakeD1() : undefined;
    const store: OpenTofuControlStore = pg ? new SqlOpenTofuControlStore({ client: pg })
      : d1 ? new CloudflareD1OpenTofuControlStore(d1) : new InMemoryOpenTofuControlStore();
    try {
      for (const kind of ["plan", "apply", "restore"] as const) {
        const workspaceId = `workspace-${name}-${kind}`;
        await store.putWorkspace({ id: workspaceId, handle: `ws-${kind}`, displayName: "Run authority", type: "personal",
          ownerUserId: "owner", createdAt: now, updatedAt: now });
        const original = { workspaceId, managementState: "active" as const, managementEpoch: 1 };
        const oldQueued = await candidate(kind, `old-${kind}`, workspaceId);
        await expect(admit(store, kind, oldQueued)).rejects.toThrow();
        const created = await admit(store, kind, oldQueued, original);
        expect(created.status).toBe("created");
        expect(JSON.stringify(created)).not.toContain("workspaceManagementAuthority");
        // Neither a raw update nor an API-shaped payload can replace original N.
        await put(store, kind, { ...oldQueued, workspaceManagementAuthority: { ...original, managementEpoch: 99 } } as StoredRunRecord);
        expect(await get(store, kind, oldQueued.id)).toEqual(oldQueued);
        await expect(put(store, kind, { ...oldQueued, workspaceId: `${workspaceId}-other` } as StoredRunRecord)).rejects.toThrow();
        expect(await get(store, kind, oldQueued.id)).toEqual(oldQueued);

        const running = await candidate(kind, `running-${kind}`, workspaceId);
        await admit(store, kind, running, original);
        const claimed = await claim(store, kind, running);
        expect(claimed.won).toBe(true);
        expect(JSON.stringify(claimed)).not.toContain("workspaceManagementAuthority");
        const retry = await candidate(kind, `retry-${kind}`, workspaceId);
        await admit(store, kind, retry, original);
        const retryClaim = await claim(store, kind, retry);
        expect(retryClaim.won).toBe(true);
        const requeued = { ...retryClaim.run!, status: "queued" } as StoredRunRecord;
        expect((await store.transitionRun({ id: retry.id, kind, expectFrom: ["running"], expectLeaseToken: `lease-${retry.id}`,
          clearLeaseToken: true, run: requeued })).won).toBe(true);
        const retried = await claim(store, kind, requeued);
        expect(retried.won).toBe(true);
        expect(await get(store, kind, retry.id)).toEqual(retried.run);
        expect((await store.transitionRun({ id: retry.id, kind, expectFrom: ["running"],
          expectLeaseToken: `lease-${retry.id}`, clearLeaseToken: true, run: requeued })).won).toBe(true);

        const legacy = await candidate(kind, `legacy-${kind}`, workspaceId);
        await put(store, kind, { ...legacy, workspaceManagementAuthority: original } as StoredRunRecord);
        expect((await claim(store, kind, legacy, original)).won).toBe(false);
        expect(await get(store, kind, legacy.id)).toEqual(legacy);

        await store.beginWorkspaceDraining(workspaceId, original);
        expect((await claim(store, kind, oldQueued)).won).toBe(false);
        expect((await claim(store, kind, requeued)).won).toBe(false);
        expect(await get(store, kind, retry.id)).toEqual(requeued);
        // No new lease: the original running owner can still converge.
        const heartbeat = { ...claimed.run!, heartbeatAt: 101 } as StoredRunRecord;
        expect((await store.transitionRun({ id: running.id, kind, expectFrom: ["running"],
          expectLeaseToken: `lease-${running.id}`, run: heartbeat })).won).toBe(true);
        const terminal = { ...heartbeat, status: "failed" } as StoredRunRecord;
        expect((await store.transitionRun({ id: running.id, kind, expectFrom: ["running"],
          expectLeaseToken: `lease-${running.id}`, clearLeaseToken: true, run: terminal })).won).toBe(true);
        expect(await get(store, kind, running.id)).toEqual(terminal);
        expect((await admit(store, kind, oldQueued, original)).status).toBe("existing");

        if (pg || d1) {
          if (pg) await pg.query("update takosumi_workspaces set management_state='active', management_epoch=3 where id=$1", [workspaceId]);
          if (d1) await d1.prepare("update workspaces set management_state='active', management_epoch=3 where id=?").bind(workspaceId).run();
          const reopened = pg ? new SqlOpenTofuControlStore({ client: pg }) : new CloudflareD1OpenTofuControlStore(d1!);
          expect((await claim(reopened, kind, oldQueued)).won).toBe(false);
          expect((await claim(reopened, kind, oldQueued, { ...original, managementEpoch: 3 })).won).toBe(false);
          expect(await get(reopened, kind, oldQueued.id)).toEqual(oldQueued);
          expect((await claim(reopened, kind, requeued, { ...original, managementEpoch: 3 })).won).toBe(false);
          expect(await get(reopened, kind, retry.id)).toEqual(requeued);
          const fresh = await candidate(kind, `fresh-${kind}`, workspaceId);
          expect((await admit(reopened, kind, fresh, { ...original, managementEpoch: 3 })).status).toBe("created");
          expect((await claim(reopened, kind, fresh)).won).toBe(true);
        }
        expect(JSON.stringify(await store.listRunsByWorkspace(workspaceId))).not.toContain("workspaceManagementAuthority");
      }
    } finally {
      await pg?.close();
    }
  }, 30_000);
}
