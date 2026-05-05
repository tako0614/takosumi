import assert from "node:assert/strict";
import { createInMemoryAppContext } from "../app_context.ts";
import { InMemoryRevokeDebtStore } from "../domains/deploy/revoke_debt_store.ts";
import {
  createRoleWorkerDaemon,
  createWorkerDaemonState,
} from "./worker_daemon.ts";

Deno.test("createRoleWorkerDaemon schedules RevokeDebt cleanup from shared store", async () => {
  const revokeDebtStore = new InMemoryRevokeDebtStore({
    idFactory: () => "revoke-debt:daemon",
  });
  await revokeDebtStore.enqueue({
    generatedObjectId: "generated:space-daemon/app/cache",
    reason: "activation-rollback",
    ownerSpaceId: "space:daemon",
    deploymentName: "app",
    now: "2026-05-04T00:00:00.000Z",
  });
  const state = createWorkerDaemonState();
  const daemon = createRoleWorkerDaemon({
    role: "takosumi-worker",
    context: createInMemoryAppContext(),
    runtimeEnv: {
      TAKOSUMI_REVOKE_DEBT_CLEANUP_INTERVAL_MS: "1",
      TAKOSUMI_REVOKE_DEBT_CLEANUP_LIMIT: "5",
    },
    revokeDebtStore,
    onTick: state.onTick,
  });

  const results = await daemon.runOnce();

  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(
    results.map((result) => result.taskName).sort(),
    ["apply", "outbox", "revoke-debt-cleanup"].sort(),
  );
  const [debt] = await revokeDebtStore.listByOwnerSpace("space:daemon");
  assert.equal(debt?.status, "operator-action-required");
  assert.equal(state.lastTickByTask.has("revoke-debt-cleanup"), true);
});
