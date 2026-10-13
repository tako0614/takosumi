import { expect, test } from "bun:test";

import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "../../contract/api-surface.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import type { OpenTofuRunner } from "../../core/domains/deploy-control/mod.ts";

const ORIGIN = "https://takosumi.example.test";

function unusedRunner(): OpenTofuRunner {
  return {
    plan: () => Promise.reject(new Error("runner must not be dispatched")),
    apply: () => Promise.reject(new Error("runner must not be dispatched")),
    destroy: () => Promise.reject(new Error("runner must not be dispatched")),
  };
}

async function discovery(
  runner: Pick<
    Parameters<typeof createTakosumiService>[0] & object,
    "opentofuRunner" | "opentofuRunnerExecutors"
  >,
) {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    ...runner,
  });
  const wellKnown = await app.request(`${ORIGIN}${TAKOSUMI_WELL_KNOWN_PATH}`);
  const capabilities = await app.request(
    `${ORIGIN}${TAKOSUMI_PRODUCT_CAPABILITIES_PATH}`,
  );
  expect(wellKnown.status).toBe(200);
  expect(capabilities.status).toBe(200);
  return {
    features: (await wellKnown.json()).features,
    adapters: (await capabilities.json()).adapters,
  };
}

test("discovery does not advertise an OpenTofu runner that is not configured", async () => {
  const { features, adapters } = await discovery({});
  expect(features.opentofu_runner).toBe(false);
  expect(adapters.opentofu).toBe(false);
  expect(features.stacks).toBe(true);
});

test("discovery advertises the OpenTofu runner when a default runner is configured", async () => {
  const { features, adapters } = await discovery({
    opentofuRunner: unusedRunner(),
  });
  expect(features.opentofu_runner).toBe(true);
  expect(adapters.opentofu).toBe(true);
});

test("discovery advertises the OpenTofu runner when only an executor is registered", async () => {
  const { features, adapters } = await discovery({
    opentofuRunnerExecutors: new Map([["opentofu.custom", unusedRunner()]]),
  });
  expect(features.opentofu_runner).toBe(true);
  expect(adapters.opentofu).toBe(true);
});
