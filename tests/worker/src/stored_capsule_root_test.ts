import { expect, test } from "bun:test";
import { storedCapsuleArtifactRoot } from "../../../worker/src/stored-capsule-root.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

test("persisted Capsule root wins over stale JSON while foreign roots remain rejected", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const capsule = { id: "cap_root", workspaceId: "ws_root", environment: "production", storageRoot: "apps/cap_root" };
  const legacyRoot = "workspaces/ws_root/capsules/cap_root";
  await db.prepare(`insert into capsules(id,space_id,project_id,name,slug,source_id,install_config_id,
    environment,current_state_generation,status,record_json,created_at,updated_at,storage_root)
    values('cap_root','ws_root','project','app','app','source','config','production',0,'pending',?,'now','now',?)`)
    .bind(JSON.stringify(capsule), legacyRoot).run();
  expect(await storedCapsuleArtifactRoot(db, "ws_root", "cap_root", "production")).toBe(legacyRoot);
  await db.prepare("update capsules set storage_root='apps/foreign'").run();
  await expect(storedCapsuleArtifactRoot(db, "ws_root", "cap_root", "production")).rejects.toThrow();
});
