import { expect, test } from "bun:test";

import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "../../contract/api-surface.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import type { OpenTofuRunner } from "../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";

const ORIGIN = "https://takosumi.example.test";

function unusedRunner(): OpenTofuRunner {
  return {
    plan: () => Promise.reject(new Error("runner must not be dispatched")),
    apply: () => Promise.reject(new Error("runner must not be dispatched")),
    destroy: () => Promise.reject(new Error("runner must not be dispatched")),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("service startup waits for configured runner profile persistence", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const started = deferred();
  const persist = deferred();
  const put = store.putRunnerProfile.bind(store);
  store.putRunnerProfile = async (profile) => {
    started.resolve();
    await persist.promise;
    await put(profile);
  };
  let settled = false;
  const startup = createTakosumiService({
    authorizeInterfaceBearer: () => undefined,
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
  }).finally(() => { settled = true; });
  try {
    await started.promise;
    await Bun.sleep(0);
    expect(settled).toBe(false);
  } finally {
    persist.resolve();
    await startup;
  }
  expect(await store.listRunnerProfiles()).toHaveLength(1);
});

test("service startup rejects a failed runner profile write", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const started = deferred();
  const persist = deferred();
  const failure = new Error("runner profile persistence refused");
  store.putRunnerProfile = async () => {
    started.resolve();
    await persist.promise;
  };
  type Outcome =
    | { status: "resolved"; service: Awaited<ReturnType<typeof createTakosumiService>> }
    | { status: "rejected"; error: unknown };
  let observed: Outcome | undefined;
  const startup = createTakosumiService({
    authorizeInterfaceBearer: () => undefined,
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
  }).then<Outcome, Outcome>(
    (service) => (observed = { status: "resolved", service }),
    (error) => (observed = { status: "rejected", error }),
  );
  await started.promise;
  await Bun.sleep(0);
  // Observe the old controller's pending seed before rejecting the gate, so
  // the regression does not leave a rejected promise in the shared test process.
  const oldSeed = observed?.status === "resolved"
    ? observed.service.operations.listRunnerProfiles().catch(() => {})
    : undefined;
  persist.reject(failure);
  const outcome = await startup;
  if (outcome.status === "resolved") {
    await (oldSeed ?? outcome.service.operations.listRunnerProfiles().catch(() => {}));
  }
  expect(outcome.status).toBe("rejected");
  if (outcome.status === "rejected") expect(outcome.error).toBe(failure);
});

async function discovery(
  runner: Pick<
    Parameters<typeof createTakosumiService>[0] & object,
    "opentofuRunner" | "opentofuRunnerExecutors"
  >,
) {
  const { app } = await createTakosumiService({
    authorizeInterfaceBearer: () => undefined,
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
