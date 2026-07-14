import { expect, test } from "bun:test";

import { createInMemoryAppContext } from "../../core/app_context.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import { StubResourceShapeAdapter } from "../../core/domains/resource-shape/mod.ts";
import { declaredDurableTestOpenTofuStore } from "../helpers/deploy-control/durable_test_store.ts";

function localContext() {
  return createInMemoryAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });
}

test("production deploy ledger rejects ephemeral storage even when dev mode is requested", async () => {
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: {
        environment: "production",
        allowUnsafeProductionDefaults: true,
      },
      runtimeEnv: {
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_DEPLOY_CONTROL_TOKEN: "control-token",
      },
      context: localContext(),
      opentofuControlStore: new InMemoryOpenTofuControlStore(),
    }),
  ).rejects.toThrow(
    "production runtime exposes the OpenTofu deploy API but no durable run ledger is configured",
  );
});

test("production Resource Shape API requires its own durable stores", async () => {
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: {
        environment: "production",
        allowUnsafeProductionDefaults: true,
      },
      runtimeEnv: {
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_DEPLOY_CONTROL_TOKEN: "control-token",
      },
      context: localContext(),
      opentofuControlStore: declaredDurableTestOpenTofuStore(),
      resourceShapeAdapter: new StubResourceShapeAdapter(),
    }),
  ).rejects.toThrow(
    "production runtime exposes the Resource Shape API but no durable Resource/ResolutionLock/TargetPool/SpacePolicy stores are configured",
  );
});
