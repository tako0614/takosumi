import { expect, test } from "bun:test";

import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { createWorkerServiceApp } from "../../../worker/src/worker_service.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

test("Worker composition rejects a weak Run credential signing secret", async () => {
  await expect(
    createWorkerServiceApp(
      {
        TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
        TAKOSUMI_ENVIRONMENT: "test",
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: "short-secret",
      } as unknown as CloudflareWorkerEnv,
      "takosumi-api",
      { operatorInstallConfigs: [] },
    ),
  ).rejects.toThrow("32-4096 UTF-8 bytes");
});
