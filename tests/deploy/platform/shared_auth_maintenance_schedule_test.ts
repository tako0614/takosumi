import { expect, spyOn, test } from "bun:test";
import platformWorker, { type CloudflareWorkerEnv } from "../../../deploy/platform/worker.ts";
import {
  runScheduledSharedAuthMaintenance,
  type SharedAuthEnvironment,
  type SharedAuthRpc,
} from "../../../worker/src/shared_auth_rpc.ts";

const cron = "*/5 * * * *";
const legacyBinding: SharedAuthRpc = {
  fetchSharedAuth: async () => null,
  authenticateSharedAuth: async () => ({ kind: "unauthenticated" }),
  resolveSharedAuthWorkspace: async () => ({ kind: "forbidden" }),
};
const optedIn = {
  TAKOSUMI_HOSTED_AUTH_MAINTENANCE_ENABLED: "1",
  TAKOSUMI_ENVIRONMENT: "staging",
  TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
  TAKOSUMI_SHARED_AUTH_ORIGIN: "https://app-staging.takosumi.com",
} satisfies SharedAuthEnvironment;

test.each([
  ["unset flag", { TAKOSUMI_HOSTED_AUTH_MAINTENANCE_ENABLED: undefined }, cron],
  ["disabled flag", { TAKOSUMI_HOSTED_AUTH_MAINTENANCE_ENABLED: "0" }, cron],
  ["stock profile", { TAKOSUMI_SHARED_AUTH_PROFILE: undefined }, cron],
  ["production", { TAKOSUMI_ENVIRONMENT: "production" }, cron],
  ["different origin", { TAKOSUMI_SHARED_AUTH_ORIGIN: "https://other.example.test" }, cron],
  ["one-minute cadence", {}, "* * * * *"],
  ["absent scheduled expression", {}, undefined],
] as const)("Hosted auth maintenance skips %s", async (_name, override, scheduledCron) => {
  let bindingReads = 0;
  await runScheduledSharedAuthMaintenance({
    ...optedIn,
    ...override,
    get HOSTED() {
      bindingReads++;
      return legacyBinding;
    },
  }, scheduledCron);
  expect(bindingReads).toBe(0);
});

test("the platform scheduled event retains exactly one private call", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const pending = Promise.withResolvers<void>();
  const tasks: Promise<unknown>[] = [];
  let calls = 0;
  const binding: SharedAuthRpc = {
    ...legacyBinding,
    drainSharedAuthRevocations(...args: unknown[]) {
      expect(this).toBe(binding);
      expect(args).toEqual([]);
      calls++;
      return pending.promise;
    },
  };

  try {
    await platformWorker.scheduled({ cron }, {
      ...optedIn,
      HOSTED: binding,
      TAKOSUMI_CONTROL_DB: {
        prepare() {
          throw new Error("local fixture has no Control store");
        },
      },
    } as CloudflareWorkerEnv, {
      waitUntil(task) {
        tasks.push(task);
      },
    });
    expect(calls).toBe(1);
    const completion = Promise.all(tasks);
    expect(await Promise.race([
      completion.then(() => "finished"),
      Bun.sleep(0).then(() => "pending"),
    ])).toBe("pending");
    pending.resolve();
    await completion;
  } finally {
    pending.resolve();
    await Promise.allSettled(tasks);
    warning.mockRestore();
  }
});

test("missing or failing Hosted maintenance leaves a fixed diagnostic without retry", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  let calls = 0;
  try {
    await runScheduledSharedAuthMaintenance({ ...optedIn, HOSTED: legacyBinding }, cron);
    await runScheduledSharedAuthMaintenance({
      ...optedIn,
      HOSTED: {
        ...legacyBinding,
        async drainSharedAuthRevocations() {
          calls++;
          throw new Error("synthetic provider details");
        },
      },
    }, cron);
    expect(calls).toBe(1);
    expect(warning.mock.calls).toEqual([
      ['{"event":"hosted_auth_maintenance_failed"}'],
      ['{"event":"hosted_auth_maintenance_failed"}'],
    ]);
  } finally {
    warning.mockRestore();
  }
});
