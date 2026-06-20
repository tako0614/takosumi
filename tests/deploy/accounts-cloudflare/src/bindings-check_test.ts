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
  const result = checkPlatformBindings(env);
  expect(result.ok).toBe(false);
  expect(result.missing).toEqual(["R2_STATE", "RUNNER"]);
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
