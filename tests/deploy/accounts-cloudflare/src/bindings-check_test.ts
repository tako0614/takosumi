import { expect, test } from "bun:test";
import {
  checkPlatformBindings,
  REQUIRED_PLATFORM_BINDINGS,
} from "../../../../deploy/accounts-cloudflare/src/bindings-check.ts";

function fullEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  for (const name of [
    ...REQUIRED_PLATFORM_BINDINGS.d1,
    ...REQUIRED_PLATFORM_BINDINGS.r2,
    ...REQUIRED_PLATFORM_BINDINGS.durableObjects,
    ...REQUIRED_PLATFORM_BINDINGS.queues,
    ...REQUIRED_PLATFORM_BINDINGS.assets,
  ]) {
    env[name] = {}; // presence-only check; any non-null value passes.
  }
  return env;
}

test("a fully-bound env passes", () => {
  expect(checkPlatformBindings(fullEnv())).toEqual({ ok: true, missing: [] });
});

test("missing bindings are named in declaration order", () => {
  const env = fullEnv();
  delete env.R2_STATE;
  delete env.RUNNER;
  delete env.RUN_OWNER;
  const result = checkPlatformBindings(env);
  expect(result.ok).toBe(false);
  expect(result.missing).toEqual(["R2_STATE", "RUN_OWNER", "RUNNER"]);
});

test("null / undefined bindings count as missing", () => {
  const env = fullEnv();
  env.TAKOSUMI_ACCOUNTS_DB = null;
  env.TAKOSUMI_CONTROL_DB = undefined;
  const result = checkPlatformBindings(env);
  expect(result.missing).toEqual([
    "TAKOSUMI_ACCOUNTS_DB",
    "TAKOSUMI_CONTROL_DB",
  ]);
});

test("requireAssets:false allows an API-only deploy without ASSETS", () => {
  const env = fullEnv();
  delete env.ASSETS;
  expect(checkPlatformBindings(env, { requireAssets: false }).ok).toBe(true);
  expect(checkPlatformBindings(env).missing).toEqual(["ASSETS"]);
});

test("Cloud extension bindings are not part of OSS/operator readiness", () => {
  // The OSS readiness check never names a Cloud-feature binding: cloud extension
  // service bindings are config-driven (TAKOSUMI_CLOUD_EXTENSIONS) and declared
  // by the closed Takosumi Cloud delta, so a fully-bound OSS env passes without
  // any TAKOSUMI_CLOUD_* extension binding present.
  const env = fullEnv();
  expect("TAKOSUMI_CLOUD_AI_GATEWAY" in env).toBe(false);
  expect(checkPlatformBindings(env).ok).toBe(true);
  expect(
    (REQUIRED_PLATFORM_BINDINGS as Record<string, unknown>).cloudExtensions,
  ).toBeUndefined();
});
