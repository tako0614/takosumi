import { expect, test } from "bun:test";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { RunVerificationService } from "../../../../core/domains/deploy-control/run_verification.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

for (const version of [75, 76, 77, "postgres"] as const) {
  test(`${version}: dispatch reads the authoritative root separately from Capsule JSON`, async () => {
    const pg = version === "postgres" ? await PGliteSqlClient.create() : undefined;
    const db = new SqliteFakeD1();
    if (typeof version === "number") await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: version });
    const store = pg ? new SqlOpenTofuControlStore({ client: pg })
      : new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
    try {
      const { capsule } = await seedCapsuleModel(store);
      const root = version === 77 || pg ? `apps/${capsule.id}` : `workspaces/${capsule.workspaceId}/capsules/${capsule.id}`;
      if (pg) await pg.query("update takosumi_capsules set storage_root=$2 where id=$1", [capsule.id, root]);
      else if (version === 77) await db.prepare("update capsules set storage_root=? where id=?").bind(root, capsule.id).run();
      expect((await store.getCapsule(capsule.id))?.storageRoot).toBeUndefined();
      const digest = `sha256:${"a".repeat(64)}` as const;
      const plan: PlanRun = {
        id: "plan_root", workspaceId: capsule.workspaceId, capsuleId: capsule.id,
        capsuleContext: { workspaceId: capsule.workspaceId, capsuleId: capsule.id, environment: capsule.environment },
        source: { kind: "git", url: "https://example.com/source.git", commit: "a".repeat(40) },
        sourceDigest: digest, operation: "create", runnerProfileId: "opentofu-default", variablesDigest: digest,
        requiredProviders: [], status: "queued", policy: { status: "passed", reasons: [], checkedAt: 1 },
        policyDecisionDigest: digest, auditEvents: [], createdAt: 1, updatedAt: 1,
      };
      const verification = new RunVerificationService({ store, artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
        policyForPlanRun: async () => undefined, assertCompatibilityReportRunnable() {} });
      const dispatch = await verification.executionDispatch(plan, 1);
      expect(dispatch.stateScope?.stateRef).toBe(`${root}/environments/${capsule.environment}/state-versions/00000001.tfstate.enc`);
    } finally { await pg?.close(); }
  });
}
