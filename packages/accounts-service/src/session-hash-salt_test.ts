import { expect, test } from "bun:test";
import { assertThrows } from "../../../test/assert.ts";
import process from "node:process";
import { readEnvVar } from "./read-env.ts";
import {
  __resetSessionHashSaltConfigForTesting,
  registerSessionHashSaltConfig,
  resolveSessionHashSalt,
} from "./session-hash-salt.ts";

const SALT_ENV = "TEST_SESSION_HASH_SALT";
const PRODUCTION_MARKERS = ["NODE_ENV", "TAKOSUMI_ENV"] as const;

type TestProcessGlobal = {
  process?: typeof process;
};

type EnvSnapshot = {
  env: Map<string, string | undefined>;
  process: TestProcessGlobal["process"];
};

function snapshotEnv(
  names: readonly string[],
): EnvSnapshot {
  const env = new Map<string, string | undefined>();
  for (const name of names) env.set(name, process.env[name]);
  const globalWithProcess = globalThis as TestProcessGlobal;
  return { env, process: globalWithProcess.process };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [name, value] of snapshot.env) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  (globalThis as TestProcessGlobal).process = snapshot.process;
}

test("resolveSessionHashSalt returns the configured salt when set", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    __resetSessionHashSaltConfigForTesting();
    process.env[SALT_ENV] = "high-entropy-operator-secret";
    process.env["NODE_ENV"] = "production";
    expect(resolveSessionHashSalt(SALT_ENV)).toEqual("high-entropy-operator-secret");
  } finally {
    restoreEnv(snapshot);
    __resetSessionHashSaltConfigForTesting();
  }
});

test("resolveSessionHashSalt prefers a registered salt over env and markers", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    __resetSessionHashSaltConfigForTesting();
    // No process salt, production marker present: without a registered salt
    // this would throw. Registering a salt (the Workers env-binding path)
    // resolves it fail-closed.
    delete process.env[SALT_ENV];
    process.env["NODE_ENV"] = "production";
    registerSessionHashSaltConfig({ salt: "registered-operator-secret" });
    expect(resolveSessionHashSalt(SALT_ENV)).toEqual("registered-operator-secret");
  } finally {
    restoreEnv(snapshot);
    __resetSessionHashSaltConfigForTesting();
  }
});

test("resolveSessionHashSalt ignores an empty registered salt", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    __resetSessionHashSaltConfigForTesting();
    process.env[SALT_ENV] = "env-secret";
    delete process.env["NODE_ENV"];
    delete process.env["TAKOSUMI_ENV"];
    registerSessionHashSaltConfig({ salt: "" });
    expect(resolveSessionHashSalt(SALT_ENV)).toEqual("env-secret");
  } finally {
    restoreEnv(snapshot);
    __resetSessionHashSaltConfigForTesting();
  }
});

test("resolveSessionHashSalt uses the dev fallback when unset in non-production", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    delete process.env[SALT_ENV];
    for (const marker of PRODUCTION_MARKERS) delete process.env[marker];
    expect(resolveSessionHashSalt(SALT_ENV)).toEqual("takosumi:dev-only-session-hash-salt");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveSessionHashSalt throws when unset and NODE_ENV=production", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    delete process.env[SALT_ENV];
    delete process.env["TAKOSUMI_ENV"];
    process.env["NODE_ENV"] = "production";
    assertThrows(
      () => resolveSessionHashSalt(SALT_ENV),
      Error,
      "session hash salt must be configured in production",
    );
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveSessionHashSalt throws when unset and TAKOSUMI_ENV=production", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    delete process.env[SALT_ENV];
    delete process.env["NODE_ENV"];
    process.env["TAKOSUMI_ENV"] = "production";
    assertThrows(
      () => resolveSessionHashSalt(SALT_ENV),
      Error,
      "session hash salt must be configured in production",
    );
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveSessionHashSalt does not throw for NODE_ENV other than production", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    delete process.env[SALT_ENV];
    delete process.env["TAKOSUMI_ENV"];
    process.env["NODE_ENV"] = "development";
    expect(resolveSessionHashSalt(SALT_ENV)).toEqual("takosumi:dev-only-session-hash-salt");
  } finally {
    restoreEnv(snapshot);
  }
});

test("readEnvVar returns undefined when process env is unavailable", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    process.env[SALT_ENV] = "hidden-from-workers";
    (globalThis as TestProcessGlobal).process = undefined;
    expect(readEnvVar(SALT_ENV)).toBeUndefined();
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveSessionHashSalt fails closed when process env is unavailable", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    __resetSessionHashSaltConfigForTesting();
    delete process.env[SALT_ENV];
    for (const marker of PRODUCTION_MARKERS) delete process.env[marker];
    (globalThis as TestProcessGlobal).process = undefined;
    assertThrows(
      () => resolveSessionHashSalt(SALT_ENV),
      Error,
      "session hash salt must be configured on Cloudflare Workers",
    );
  } finally {
    restoreEnv(snapshot);
    __resetSessionHashSaltConfigForTesting();
  }
});

test("resolveSessionHashSalt allows explicit dev fallback without process env", () => {
  const snapshot = snapshotEnv([SALT_ENV, ...PRODUCTION_MARKERS]);
  try {
    __resetSessionHashSaltConfigForTesting();
    delete process.env[SALT_ENV];
    for (const marker of PRODUCTION_MARKERS) delete process.env[marker];
    (globalThis as TestProcessGlobal).process = undefined;
    registerSessionHashSaltConfig({ allowDevFallback: true });
    expect(resolveSessionHashSalt(SALT_ENV)).toEqual("takosumi:dev-only-session-hash-salt");
  } finally {
    restoreEnv(snapshot);
    __resetSessionHashSaltConfigForTesting();
  }
});
