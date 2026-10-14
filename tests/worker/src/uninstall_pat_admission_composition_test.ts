import { expect, test } from "bun:test";

import { handleControlRoute } from "../../../accounts/service/src/control-routes.ts";
import { D1AccountsStore } from "../../../accounts/service/src/d1-store.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import {
  createCloudflareD1OpenTofuControlStore,
  initializeD1OpenTofuLedgerSchemaBinding,
} from "../../../worker/src/d1_opentofu_store.ts";
import { createWorkerServiceApp } from "../../../worker/src/worker_service.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const DAY_MS = 86_400_000;

function baseEnv(
  controlDb: SqliteFakeD1,
  accountsDb: SqliteFakeD1,
): CloudflareWorkerEnv {
  return {
    TAKOSUMI_CONTROL_DB: controlDb,
    TAKOSUMI_ACCOUNTS_DB: accountsDb,
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
  } as unknown as CloudflareWorkerEnv;
}

test("Worker composition requires a PAT to outlive the scheduled uninstall deadline", async () => {
  async function scheduleWithPat(expiresInDays?: number) {
    const controlDb = new SqliteFakeD1();
    await initializeD1OpenTofuLedgerSchemaBinding(controlDb, "bootstrap");
    const controlStore = createCloudflareD1OpenTofuControlStore(controlDb);
    const seeded = await seedCapsuleModel(controlStore);
    await controlStore.putCapsule({
      ...seeded.capsule,
      status: "active",
      currentStateGeneration: 1,
    });
    const subject = "tsub_worker_uninstall_owner";
    await controlStore.putWorkspace({
      ...seeded.workspace,
      ownerUserId: subject,
    });

    const accountsDb = new SqliteFakeD1();
    const accounts = new D1AccountsStore(accountsDb);
    const now = Date.now();
    await accounts.saveAccount({ subject, createdAt: now, updatedAt: now });
    const secret = `fixture-worker-uninstall-${expiresInDays ?? "never"}`;
    await accounts.savePersonalAccessToken(secret, {
      tokenId: `pat_${expiresInDays ?? "never"}`,
      tokenPrefix: "fixture",
      subject,
      name: "uninstall",
      scopes: ["write"],
      workspaceId: seeded.workspace.id,
      createdAt: now,
      ...(expiresInDays === undefined
        ? {}
        : { expiresAt: now + expiresInDays * DAY_MS }),
    });

    const created = await createWorkerServiceApp(
      baseEnv(controlDb, accountsDb),
      "takosumi-api",
      { operatorInstallConfigs: [] },
    );
    const url = new URL(
      `https://app.takosumi.test/api/v1/capsules/${seeded.capsule.id}/uninstall`,
    );
    const response = await handleControlRoute({
      request: new Request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
      }),
      url,
      store: accounts,
      operations: created.operations,
    });
    if (!response) throw new Error("uninstall control route was not matched");
    return {
      response,
      capsule: await created.operations.capsules.getCapsule(seeded.capsule.id),
      workspaceId: seeded.workspace.id,
      store: controlStore,
    };
  }

  // One hour past the scheduled deadline is still inside the required margin.
  const short = await scheduleWithPat(7 + 1 / 24);
  expect(short.response.status).toBe(409);
  expect(await short.response!.json()).toMatchObject({ error: {
    code: "failed_precondition",
    details: { reason: "capsule_uninstall_pat_deadline_unverified" },
  } });
  expect(short.capsule.status).toBe("active");
  expect(short.capsule.uninstall).toBeUndefined();
  expect(await short.store.listActivityEvents(short.workspaceId, { limit: 100 }))
    .toHaveLength(0);

  const long = await scheduleWithPat(14);
  expect(long.response.status).toBe(202);
  expect(long.capsule.uninstall?.phase).toBe("scheduled");

  const never = await scheduleWithPat();
  expect(never.response.status).toBe(202);
  expect(never.capsule.uninstall?.phase).toBe("scheduled");
});
