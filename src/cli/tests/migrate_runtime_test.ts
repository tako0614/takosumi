import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  resetRuntimeForTesting,
  type RuntimeAdapter,
  setRuntimeForTesting,
} from "../../kernel/shared/runtime/index.ts";
import {
  exitProcess,
  readEnv,
  spawnMigrate,
  statIsFile,
} from "../commands/migrate-runtime.ts";

/**
 * Build a minimal fake RuntimeAdapter that records subprocess / env / exit
 * / sync-read interactions so the migrate-runtime primitives can be verified
 * to route through `currentRuntime()` instead of touching `Deno.*` directly.
 */
function fakeRuntime(overrides: {
  subprocessCode?: number;
  env?: Record<string, string>;
  readSyncThrows?: boolean;
}): {
  runtime: RuntimeAdapter;
  calls: {
    subprocess: Array<{ command: string; args?: readonly string[] }>;
    exit: number[];
    reads: string[];
  };
} {
  const calls = {
    subprocess: [] as Array<{ command: string; args?: readonly string[] }>,
    exit: [] as number[],
    reads: [] as string[],
  };
  const runtime = {
    kind: "bun",
    env: {
      get: (name: string) => overrides.env?.[name],
      set: () => {},
      toObject: () => overrides.env ?? {},
    },
    fs: {
      available: true,
      readTextFileSync: (path: string | URL) => {
        calls.reads.push(String(path));
        if (overrides.readSyncThrows) throw new Error("ENOENT: missing");
        return "// script";
      },
    },
    subprocess: {
      available: true,
      run: (command: string, options?: { args?: readonly string[] }) => {
        calls.subprocess.push({ command, args: options?.args });
        return Promise.resolve({
          code: overrides.subprocessCode ?? 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      },
    },
    execPath: () => "/usr/bin/bun",
    exit: ((code: number) => {
      calls.exit.push(code);
      throw new Error(`__exit__:${code}`);
    }) as RuntimeAdapter["exit"],
    onSignal: () => {},
    serveHttp: (() => {
      throw new Error("not used");
    }) as RuntimeAdapter["serveHttp"],
  } as unknown as RuntimeAdapter;
  return { runtime, calls };
}

test("spawnMigrate routes through the runtime SubprocessAdapter", async () => {
  const { runtime, calls } = fakeRuntime({ subprocessCode: 0 });
  setRuntimeForTesting(runtime);
  try {
    const result = await spawnMigrate("bun", ["/x.ts"]);
    assert.equal(result.code, 0);
    assert.equal(calls.subprocess.length, 1);
    assert.equal(calls.subprocess[0].command, "bun");
    assert.deepEqual(calls.subprocess[0].args, ["/x.ts"]);
  } finally {
    resetRuntimeForTesting();
  }
});

test("spawnMigrate surfaces a non-zero exit code", async () => {
  const { runtime } = fakeRuntime({ subprocessCode: 7 });
  setRuntimeForTesting(runtime);
  try {
    const result = await spawnMigrate("bun", ["/x.ts"]);
    assert.equal(result.code, 7);
  } finally {
    resetRuntimeForTesting();
  }
});

test("statIsFile returns true when the sync read succeeds", () => {
  const { runtime, calls } = fakeRuntime({ readSyncThrows: false });
  setRuntimeForTesting(runtime);
  try {
    assert.equal(statIsFile("/path/db-migrate.ts"), true);
    assert.deepEqual(calls.reads, ["/path/db-migrate.ts"]);
  } finally {
    resetRuntimeForTesting();
  }
});

test("statIsFile returns false when the path is absent", () => {
  const { runtime } = fakeRuntime({ readSyncThrows: true });
  setRuntimeForTesting(runtime);
  try {
    assert.equal(statIsFile("/missing.ts"), false);
  } finally {
    resetRuntimeForTesting();
  }
});

test("readEnv reads via the runtime EnvReader", () => {
  const { runtime } = fakeRuntime({ env: { TAKOSUMI_DATABASE_URL: "pg://x" } });
  setRuntimeForTesting(runtime);
  try {
    assert.equal(readEnv("TAKOSUMI_DATABASE_URL"), "pg://x");
    assert.equal(readEnv("UNSET"), undefined);
  } finally {
    resetRuntimeForTesting();
  }
});

test("exitProcess delegates to the runtime exit", () => {
  const { runtime, calls } = fakeRuntime({});
  setRuntimeForTesting(runtime);
  try {
    assert.throws(() => exitProcess(3), /__exit__:3/);
    assert.deepEqual(calls.exit, [3]);
  } finally {
    resetRuntimeForTesting();
  }
});
