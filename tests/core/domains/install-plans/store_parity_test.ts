import { expect, test } from "bun:test";

import { D1GitInstallPlanStore } from "../../../../core/domains/install-plans/d1_store.ts";
import { SqlGitInstallPlanStore } from "../../../../core/domains/install-plans/sql_store.ts";
import {
  InMemoryGitInstallPlanStore,
  type GitInstallPlanStore,
  type StoredGitInstallPlan,
} from "../../../../core/domains/install-plans/store.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

test("Git install-plan store has idempotency and CAS parity", async () => {
  const postgres = await PGliteSqlClient.create();
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  try {
    for (const store of [
      new InMemoryGitInstallPlanStore(),
      new SqlGitInstallPlanStore(postgres),
      new D1GitInstallPlanStore(d1),
    ]) {
      await expectStoreParity(store);
    }
  } finally {
    await postgres.close();
  }
});

async function expectStoreParity(store: GitInstallPlanStore): Promise<void> {
  const first = plan("ip_one", "digest_one");
  expect((await store.create(first)).status).toBe("created");

  const replay = await store.create({ ...first, id: "ip_replay" });
  expect(replay).toMatchObject({ status: "replayed", plan: { id: first.id } });

  const conflict = await store.create({
    ...first,
    id: "ip_conflict",
    requestDigest: "digest_two",
  });
  expect(conflict).toMatchObject({
    status: "conflict",
    plan: { id: first.id, requestDigest: "digest_one" },
  });
  expect(
    (
      await store.create({
        ...first,
        id: "ip_other_actor",
        createdBy: "user_two",
        actorSubject: "user_two",
      })
    ).status,
  ).toBe("created");
  expect(
    (
      await store.create({
        ...first,
        id: "ip_other_workspace",
        workspaceId: "ws_two",
      })
    ).status,
  ).toBe("created");

  const claim = await store.claimReconcile({
    id: first.id,
    expectedGeneration: 0,
    leaseToken: "lease_one",
    claimedAt: "2026-08-21T00:01:00.000Z",
    leaseExpiresAt: "2026-08-21T00:01:30.000Z",
  });
  expect(claim).toMatchObject({
    status: "claimed",
    claim: { plan: { generation: 1 } },
  });
  if (claim.status !== "claimed") throw new Error("claim was not acquired");

  await expect(
    store.completeReconcile({
      id: first.id,
      expectedGeneration: 1,
      leaseToken: "lease_one",
      plan: { ...claim.claim.plan, generation: 2 },
    }),
  ).rejects.toThrow("completion generation changed");
  await expect(
    store.completeReconcile({
      id: first.id,
      expectedGeneration: 1,
      leaseToken: "lease_one",
      plan: { ...claim.claim.plan, createdBy: "user_other" },
    }),
  ).rejects.toThrow("immutable request scope changed");

  expect(
    await store.claimReconcile({
      id: first.id,
      expectedGeneration: 0,
      leaseToken: "lease_stale",
      claimedAt: "2026-08-21T00:01:01.000Z",
      leaseExpiresAt: "2026-08-21T00:01:31.000Z",
    }),
  ).toMatchObject({ status: "conflict", plan: { generation: 1 } });

  const completedPlan: StoredGitInstallPlan = {
    ...claim.claim.plan,
    phase: "compiling_install",
    sourceId: "src_one",
    updatedAt: "2026-08-21T00:01:02.000Z",
  };
  expect(
    await store.completeReconcile({
      id: first.id,
      expectedGeneration: 1,
      leaseToken: "lease_one",
      plan: completedPlan,
    }),
  ).toMatchObject({
    status: "completed",
    plan: {
      phase: "compiling_install",
      sourceId: "src_one",
      generation: 1,
    },
  });
  expect(await store.get(first.id)).toEqual(completedPlan);

  const revision = revisionPlan();
  expect((await store.create(revision)).status).toBe("created");
  const revisionClaim = await store.claimReconcile({
    id: revision.id,
    expectedGeneration: 0,
    leaseToken: "lease_revision",
    claimedAt: "2026-08-21T00:02:00.000Z",
    leaseExpiresAt: "2026-08-21T00:02:30.000Z",
  });
  if (revisionClaim.status !== "claimed") {
    throw new Error("revision claim was not acquired");
  }
  await expect(
    store.completeReconcile({
      id: revision.id,
      expectedGeneration: 1,
      leaseToken: "lease_revision",
      plan: {
        ...revisionClaim.claim.plan,
        capsuleId: "cap_wrong",
      },
    }),
  ).rejects.toThrow("immutable request scope changed");
}

function plan(id: string, requestDigest: string): StoredGitInstallPlan {
  return {
    id,
    workspaceId: "ws_one",
    createdBy: "user_one",
    actorSubject: "user_one",
    idempotencyKeyHash: "key_hash_one",
    requestDigest,
    source: {
      name: "repo",
      url: "https://github.com/takos/example.git",
      ref: "main",
      path: ".",
    },
    capsule: { name: "example", environment: "production" },
    options: {},
    phase: "syncing_source",
    generation: 0,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

function revisionPlan(): StoredGitInstallPlan {
  return {
    ...plan("rp_one", "digest_revision"),
    idempotencyKeyHash: "key_hash_revision",
    operation: "revision",
    sourceId: "src_revision",
    capsuleId: "cap_revision",
    installConfigId: "cfg_revision",
    installConfigBaseId: "cfg_revision",
    installConfigBaseDigest: "sha256:config",
    installModulePath: ".",
    revision: {
      targetRef: "release/v2",
      base: {
        capsuleStateGeneration: 2,
        installConfigId: "cfg_revision",
        installConfigDigest: "sha256:config",
        sourceDefaultRef: "main",
        sourceDefaultPath: ".",
      },
    },
  };
}
