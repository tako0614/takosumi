import { expect, test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createSubprocessGitRunner,
  createSubprocessTarRunner,
  currentRuntime,
  denoRuntime,
  isDeno,
  resetRuntimeForTesting,
  setRuntimeForTesting,
} from "./index.ts";
import { isNode, nodeRuntime } from "./node.ts";
import type { SubprocessAdapter, SubprocessOutput } from "./runtime.ts";

// EXPECTED-FAIL UNDER BUN (skipped): these assert Deno-only fallback semantics
// that cannot hold under the bun runtime. Under bun the `Deno` global is the
// compat shim from tools/bun-migration/shims/deno-compat.ts, not the real Deno
// runtime, so `isDeno()` is false and `Deno.serve` does not exist. They still
// run unchanged under `deno test`. (See the per-test `ignore` comments below.)
test.skip("currentRuntime detects Deno when running on Deno", () => {
    resetRuntimeForTesting();
    expect(isDeno()).toBeTruthy();
    const runtime = currentRuntime();
    expect(runtime.kind).toEqual("deno");
  });

test.skip("isDeno wins over isNode on the host (Deno also reports process.versions.node)", () => {
    // Deno 2.x exposes a Node-compat `globalThis.process` with a faked
    // `versions.node`, so `isNode()` is TRUE on Deno too. `isDeno()` (which
    // probes a genuine `Deno.Command`) is therefore the authoritative
    // discriminator and `currentRuntime()` checks it FIRST. Asserting this here
    // locks in that `currentRuntime()` must never route a Deno host to the Node
    // adapter just because `process.versions.node` is present.
    resetRuntimeForTesting();
    expect(isDeno()).toBeTruthy();
    expect(isNode()).toBeTruthy();
    expect(currentRuntime().kind).toEqual("deno");
  });

test("isDeno discriminator probes Deno.Command, rejecting the @deno/shim-deno shape", () => {
  // Mirror the exact `isDeno()` probe against synthetic globals to document the
  // regression contract without touching the read-only host `Deno`. The dnt npm
  // build injects `@deno/shim-deno`, so on Node `globalThis.Deno` is defined but
  // lacks `Command`; the probe must return false for that shape. It must NOT
  // also gate on Node being absent, since real Deno reports
  // `process.versions.node`.
  const probesDenoCommand = (g: { Deno?: { Command?: unknown } }): boolean =>
    typeof g.Deno?.Command === "function";
  // @deno/shim-deno on Node: Deno defined, no Command -> NOT Deno.
  expect(!probesDenoCommand({
      Deno: { readTextFile: () => {} } as { Command?: unknown },
    })).toBeTruthy();
  // Real Deno: Command is a function -> Deno, even though process.versions.node
  // would also be present on a Deno host.
  expect(probesDenoCommand({ Deno: { Command: class {} } })).toBeTruthy();
  // Pure-ESM Node with no Deno global -> NOT Deno.
  expect(!probesDenoCommand({})).toBeTruthy();
});

test("nodeRuntime fs.makeTempDir nests inside the OS temp dir with no prefix", async () => {
  // Regression: with no prefix, `path.join(os.tmpdir(), "")` drops the trailing
  // separator, so `mkdtemp` would create a SIBLING of the temp root instead of
  // a child. The adapter must nest the temp dir INSIDE `os.tmpdir()` to match
  // `Deno.makeTempDir()` semantics.
  const [osMod, pathMod] = await Promise.all([
    import("node:os"),
    import("node:path"),
  ]);
  const tmpRoot = osMod.tmpdir();
  const dir = await nodeRuntime.fs.makeTempDir();
  try {
    expect(pathMod.dirname(dir)).toEqual(tmpRoot);
  } finally {
    await nodeRuntime.fs.remove(dir, { recursive: true });
  }

  const prefixed = await nodeRuntime.fs.makeTempDir("takosumi-node-temp-");
  try {
    expect(pathMod.dirname(prefixed)).toEqual(tmpRoot);
    expect(pathMod.basename(prefixed).startsWith("takosumi-node-temp-")).toBeTruthy();
  } finally {
    await nodeRuntime.fs.remove(prefixed, { recursive: true });
  }
});

test("denoRuntime env reader returns process env", () => {
  const sentinel = "TAKOSUMI_RUNTIME_ADAPTER_TEST";
  Deno.env.set(sentinel, "1");
  try {
    expect(denoRuntime.env.get(sentinel)).toEqual("1");
    expect(denoRuntime.env.toObject()[sentinel] === "1").toBeTruthy();
  } finally {
    Deno.env.delete(sentinel);
  }
});

test("denoRuntime fs.isNotFoundError recognises Deno.errors.NotFound", () => {
  const error = new Deno.errors.NotFound("missing");
  expect(denoRuntime.fs.isNotFoundError(error)).toBeTruthy();
  expect(!denoRuntime.fs.isNotFoundError(new Error("other"))).toBeTruthy();
});

test("denoRuntime env.set writes a process env var", () => {
  const sentinel = "TAKOSUMI_RUNTIME_ENV_SET_TEST";
  try {
    denoRuntime.env.set(sentinel, "value-x");
    expect(Deno.env.get(sentinel)).toEqual("value-x");
    expect(denoRuntime.env.get(sentinel)).toEqual("value-x");
  } finally {
    Deno.env.delete(sentinel);
  }
});

test("denoRuntime execPath returns the Deno executable path", () => {
  expect(denoRuntime.execPath()).toEqual(Deno.execPath());
});

test("setRuntimeForTesting overrides detection", () => {
  const fakeAdapter = { ...denoRuntime, kind: "node" as const };
  setRuntimeForTesting(fakeAdapter);
  try {
    expect(currentRuntime().kind).toEqual("node");
  } finally {
    resetRuntimeForTesting();
  }
});

test.skip("nodeRuntime fs.readTextFileSync works without a global require (createRequire warm-up)", async () => {
    // Under Deno's node-compat shim (and pure-ESM Node) there is no
    // `globalThis.require`. The sync read must still work via the `require`
    // pre-warmed from `node:module#createRequire(import.meta.url)`. Yield to the
    // microtask/event loop so the warm-up `import("node:module")` has resolved.
    expect(typeof (globalThis as { require?: unknown }).require).toEqual("undefined");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const file = await Deno.makeTempFile({ suffix: ".json" });
    try {
      await Deno.writeTextFile(file, '{"ok":true}');
      const text = nodeRuntime.fs.readTextFileSync(file);
      expect(JSON.parse(text).ok).toEqual(true);
    } finally {
      await Deno.remove(file);
    }
  });

test.skip("denoRuntime serveHttp serves a fetch handler and shuts down", async () => {
    const handler = (req: Request): Response => {
      return new Response(`hello ${new URL(req.url).pathname}`, { status: 200 });
    };
    const handle = denoRuntime.serveHttp(handler, {
      port: 0,
      hostname: "127.0.0.1",
    });
    await handle.shutdown();
  });

test("denoRuntime fs.makeTempDir + remove round-trips with prefix", async () => {
  const dir = await denoRuntime.fs.makeTempDir("takosumi-runtime-test-");
  try {
    const base = dir.split(/[\\/]/).pop() ?? "";
    expect(base.startsWith("takosumi-runtime-test-")).toBeTruthy();
    await denoRuntime.fs.writeTextFile(`${dir}/file.txt`, "ok");
    expect(await denoRuntime.fs.readTextFile(`${dir}/file.txt`)).toEqual("ok");
  } finally {
    await denoRuntime.fs.remove(dir, { recursive: true });
  }
  // After recursive remove the directory is gone.
  await assertRejects(() => denoRuntime.fs.readTextFile(`${dir}/file.txt`));
});

/**
 * Build a fake SubprocessAdapter so the default git / tar runners can be tested
 * without invoking real `git` / `tar` binaries. Records the last invocation so
 * tests can assert the command / args / env / stdin the runner produced.
 */
function fakeSubprocess(
  output: SubprocessOutput,
): {
  adapter: SubprocessAdapter;
  calls: Array<{
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: Uint8Array;
  }>;
} {
  const calls: Array<{
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: Uint8Array;
  }> = [];
  const adapter: SubprocessAdapter = {
    available: true,
    run(command, options) {
      calls.push({
        command,
        ...(options?.args ? { args: options.args } : {}),
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.stdin ? { stdin: options.stdin } : {}),
      });
      return Promise.resolve(output);
    },
  };
  return { adapter, calls };
}

test("createSubprocessGitRunner routes git through SubprocessAdapter", async () => {
  const enc = new TextEncoder();
  const { adapter, calls } = fakeSubprocess({
    code: 0,
    stdout: enc.encode("HEAD\n"),
    stderr: new Uint8Array(),
  });
  const runner = createSubprocessGitRunner(adapter);
  const result = await runner.run(["rev-parse", "HEAD"], "/tmp/checkout");
  expect(result).toEqual({ ok: true, stdout: "HEAD\n", stderr: "" });
  expect(calls[0].command).toEqual("git");
  expect(calls[0].args).toEqual(["rev-parse", "HEAD"]);
  expect(calls[0].cwd).toEqual("/tmp/checkout");
});

test("createSubprocessGitRunner reports non-zero exit as ok=false", async () => {
  const enc = new TextEncoder();
  const { adapter } = fakeSubprocess({
    code: 128,
    stdout: new Uint8Array(),
    stderr: enc.encode("fatal: not a git repo\n"),
  });
  const runner = createSubprocessGitRunner(adapter);
  const result = await runner.run(["status"]);
  expect(result.ok).toEqual(false);
  expect(result.stderr).toEqual("fatal: not a git repo\n");
});

test("createSubprocessTarRunner pipes stdin and forces C locale", async () => {
  const enc = new TextEncoder();
  const { adapter, calls } = fakeSubprocess({
    code: 0,
    stdout: enc.encode("listing\n"),
    stderr: new Uint8Array(),
  });
  const runner = createSubprocessTarRunner(adapter);
  const stdin = enc.encode("archive-bytes");
  const out = await runner.run(["-tv"], stdin);
  expect(out).toEqual("listing\n");
  expect(calls[0].command).toEqual("tar");
  expect(calls[0].args).toEqual(["-tv"]);
  expect(calls[0].env).toEqual({ LC_ALL: "C", LANG: "C" });
  expect(calls[0].stdin).toEqual(stdin);
});

test("createSubprocessTarRunner throws on non-zero exit", async () => {
  const enc = new TextEncoder();
  const { adapter } = fakeSubprocess({
    code: 2,
    stdout: new Uint8Array(),
    stderr: enc.encode("tar: broken archive"),
  });
  const runner = createSubprocessTarRunner(adapter);
  await assertRejects(
    () => runner.run(["-tv"], enc.encode("x")),
    Error,
    "tar -tv failed: tar: broken archive",
  );
});
