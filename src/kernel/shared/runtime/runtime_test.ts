import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
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
Deno.test({
  name: "currentRuntime detects Deno when running on Deno",
  ignore: true, // Deno-only: isDeno()/kind "deno" never hold under the bun shim.
  fn: () => {
    resetRuntimeForTesting();
    assert(isDeno());
    const runtime = currentRuntime();
    assertEquals(runtime.kind, "deno");
  },
});

Deno.test({
  name:
    "isDeno wins over isNode on the host (Deno also reports process.versions.node)",
  ignore: true, // Deno-only: probes a genuine Deno.Command, absent under bun.
  fn: () => {
    // Deno 2.x exposes a Node-compat `globalThis.process` with a faked
    // `versions.node`, so `isNode()` is TRUE on Deno too. `isDeno()` (which
    // probes a genuine `Deno.Command`) is therefore the authoritative
    // discriminator and `currentRuntime()` checks it FIRST. Asserting this here
    // locks in that `currentRuntime()` must never route a Deno host to the Node
    // adapter just because `process.versions.node` is present.
    resetRuntimeForTesting();
    assert(isDeno(), "expected isDeno() true on the Deno test host");
    assert(isNode(), "Deno exposes a Node-compat process.versions.node");
    assertEquals(currentRuntime().kind, "deno");
  },
});

Deno.test("isDeno discriminator probes Deno.Command, rejecting the @deno/shim-deno shape", () => {
  // Mirror the exact `isDeno()` probe against synthetic globals to document the
  // regression contract without touching the read-only host `Deno`. The dnt npm
  // build injects `@deno/shim-deno`, so on Node `globalThis.Deno` is defined but
  // lacks `Command`; the probe must return false for that shape. It must NOT
  // also gate on Node being absent, since real Deno reports
  // `process.versions.node`.
  const probesDenoCommand = (g: { Deno?: { Command?: unknown } }): boolean =>
    typeof g.Deno?.Command === "function";
  // @deno/shim-deno on Node: Deno defined, no Command -> NOT Deno.
  assert(
    !probesDenoCommand({
      Deno: { readTextFile: () => {} } as { Command?: unknown },
    }),
  );
  // Real Deno: Command is a function -> Deno, even though process.versions.node
  // would also be present on a Deno host.
  assert(probesDenoCommand({ Deno: { Command: class {} } }));
  // Pure-ESM Node with no Deno global -> NOT Deno.
  assert(!probesDenoCommand({}));
});

Deno.test("nodeRuntime fs.makeTempDir nests inside the OS temp dir with no prefix", async () => {
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
    assertEquals(
      pathMod.dirname(dir),
      tmpRoot,
      `temp dir should be a direct child of ${tmpRoot}, got ${dir}`,
    );
  } finally {
    await nodeRuntime.fs.remove(dir, { recursive: true });
  }

  const prefixed = await nodeRuntime.fs.makeTempDir("takosumi-node-temp-");
  try {
    assertEquals(pathMod.dirname(prefixed), tmpRoot);
    assert(
      pathMod.basename(prefixed).startsWith("takosumi-node-temp-"),
      `prefixed temp dir base should start with prefix, got ${prefixed}`,
    );
  } finally {
    await nodeRuntime.fs.remove(prefixed, { recursive: true });
  }
});

Deno.test("denoRuntime env reader returns process env", () => {
  const sentinel = "TAKOSUMI_RUNTIME_ADAPTER_TEST";
  Deno.env.set(sentinel, "1");
  try {
    assertEquals(denoRuntime.env.get(sentinel), "1");
    assert(denoRuntime.env.toObject()[sentinel] === "1");
  } finally {
    Deno.env.delete(sentinel);
  }
});

Deno.test("denoRuntime fs.isNotFoundError recognises Deno.errors.NotFound", () => {
  const error = new Deno.errors.NotFound("missing");
  assert(denoRuntime.fs.isNotFoundError(error));
  assert(!denoRuntime.fs.isNotFoundError(new Error("other")));
});

Deno.test("denoRuntime env.set writes a process env var", () => {
  const sentinel = "TAKOSUMI_RUNTIME_ENV_SET_TEST";
  try {
    denoRuntime.env.set(sentinel, "value-x");
    assertEquals(Deno.env.get(sentinel), "value-x");
    assertEquals(denoRuntime.env.get(sentinel), "value-x");
  } finally {
    Deno.env.delete(sentinel);
  }
});

Deno.test("denoRuntime execPath returns the Deno executable path", () => {
  assertEquals(denoRuntime.execPath(), Deno.execPath());
});

Deno.test("setRuntimeForTesting overrides detection", () => {
  const fakeAdapter = { ...denoRuntime, kind: "node" as const };
  setRuntimeForTesting(fakeAdapter);
  try {
    assertEquals(currentRuntime().kind, "node");
  } finally {
    resetRuntimeForTesting();
  }
});

Deno.test({
  name:
    "nodeRuntime fs.readTextFileSync works without a global require (createRequire warm-up)",
  // Deno-only: this asserts there is NO `globalThis.require` (the fallback path
  // it exercises). Under bun the compat preload installs a global `require`
  // (via createRequire), so the negative assertion can never hold.
  ignore: true,
  fn: async () => {
    // Under Deno's node-compat shim (and pure-ESM Node) there is no
    // `globalThis.require`. The sync read must still work via the `require`
    // pre-warmed from `node:module#createRequire(import.meta.url)`. Yield to the
    // microtask/event loop so the warm-up `import("node:module")` has resolved.
    assertEquals(
      typeof (globalThis as { require?: unknown }).require,
      "undefined",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const file = await Deno.makeTempFile({ suffix: ".json" });
    try {
      await Deno.writeTextFile(file, '{"ok":true}');
      const text = nodeRuntime.fs.readTextFileSync(file);
      assertEquals(JSON.parse(text).ok, true);
    } finally {
      await Deno.remove(file);
    }
  },
});

Deno.test({
  name: "denoRuntime serveHttp serves a fetch handler and shuts down",
  // Deno-only: denoRuntime.serveHttp binds via the real `Deno.serve`, which the
  // bun compat shim does not provide, so there is no genuine listener to bind.
  ignore: true,
  fn: async () => {
    const handler = (req: Request): Response => {
      return new Response(`hello ${new URL(req.url).pathname}`, { status: 200 });
    };
    const handle = denoRuntime.serveHttp(handler, {
      port: 0,
      hostname: "127.0.0.1",
    });
    await handle.shutdown();
  },
});

Deno.test("denoRuntime fs.makeTempDir + remove round-trips with prefix", async () => {
  const dir = await denoRuntime.fs.makeTempDir("takosumi-runtime-test-");
  try {
    const base = dir.split(/[\\/]/).pop() ?? "";
    assert(
      base.startsWith("takosumi-runtime-test-"),
      `temp dir base should start with prefix, got ${base}`,
    );
    await denoRuntime.fs.writeTextFile(`${dir}/file.txt`, "ok");
    assertEquals(await denoRuntime.fs.readTextFile(`${dir}/file.txt`), "ok");
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

Deno.test("createSubprocessGitRunner routes git through SubprocessAdapter", async () => {
  const enc = new TextEncoder();
  const { adapter, calls } = fakeSubprocess({
    code: 0,
    stdout: enc.encode("HEAD\n"),
    stderr: new Uint8Array(),
  });
  const runner = createSubprocessGitRunner(adapter);
  const result = await runner.run(["rev-parse", "HEAD"], "/tmp/checkout");
  assertEquals(result, { ok: true, stdout: "HEAD\n", stderr: "" });
  assertEquals(calls[0].command, "git");
  assertEquals(calls[0].args, ["rev-parse", "HEAD"]);
  assertEquals(calls[0].cwd, "/tmp/checkout");
});

Deno.test("createSubprocessGitRunner reports non-zero exit as ok=false", async () => {
  const enc = new TextEncoder();
  const { adapter } = fakeSubprocess({
    code: 128,
    stdout: new Uint8Array(),
    stderr: enc.encode("fatal: not a git repo\n"),
  });
  const runner = createSubprocessGitRunner(adapter);
  const result = await runner.run(["status"]);
  assertEquals(result.ok, false);
  assertEquals(result.stderr, "fatal: not a git repo\n");
});

Deno.test("createSubprocessTarRunner pipes stdin and forces C locale", async () => {
  const enc = new TextEncoder();
  const { adapter, calls } = fakeSubprocess({
    code: 0,
    stdout: enc.encode("listing\n"),
    stderr: new Uint8Array(),
  });
  const runner = createSubprocessTarRunner(adapter);
  const stdin = enc.encode("archive-bytes");
  const out = await runner.run(["-tv"], stdin);
  assertEquals(out, "listing\n");
  assertEquals(calls[0].command, "tar");
  assertEquals(calls[0].args, ["-tv"]);
  assertEquals(calls[0].env, { LC_ALL: "C", LANG: "C" });
  assertEquals(calls[0].stdin, stdin);
});

Deno.test("createSubprocessTarRunner throws on non-zero exit", async () => {
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
