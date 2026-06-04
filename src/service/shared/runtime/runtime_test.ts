import { expect, test } from "bun:test";
import {
  createSubprocessGitRunner,
  createSubprocessTarRunner,
  currentRuntime,
  resetRuntimeForTesting,
  setRuntimeForTesting,
} from "./index.ts";
import { createWorkersRuntime } from "./workers.ts";
import { nodeRuntime } from "./node.ts";
import {
  unavailableFsAdapter,
  unavailableSubprocessAdapter,
} from "./runtime.ts";
import type { SubprocessAdapter, SubprocessOutput } from "./runtime.ts";

test("unavailableFsAdapter fails closed on every IO method", () => {
  const fs = unavailableFsAdapter("workers");
  expect(fs.available).toEqual(false);
  // isNotFoundError never reports true because no IO ever succeeds here.
  expect(fs.isNotFoundError(new Error("anything"))).toEqual(false);
  // Every IO method throws (synchronously), tagged with the supplied runtime.
  expect(() => fs.readTextFile("x")).toThrow(
    "fs.readTextFile is not available on the workers runtime",
  );
  expect(() => fs.readFile("x")).toThrow(
    "fs.readFile is not available on the workers runtime",
  );
  expect(() => fs.readTextFileSync("x")).toThrow(
    "fs.readTextFileSync is not available on the workers runtime",
  );
  expect(() => fs.writeTextFile("x", "y")).toThrow(
    "fs.writeTextFile is not available on the workers runtime",
  );
  expect(() => fs.mkdir("x")).toThrow(
    "fs.mkdir is not available on the workers runtime",
  );
  expect(() => fs.makeTempDir()).toThrow(
    "fs.makeTempDir is not available on the workers runtime",
  );
  expect(() => fs.remove("x")).toThrow(
    "fs.remove is not available on the workers runtime",
  );
});

test("unavailableFsAdapter tags errors with the supplied runtime kind", () => {
  const fs = unavailableFsAdapter("unknown");
  expect(() => fs.readTextFile("x")).toThrow(
    "fs.readTextFile is not available on the unknown runtime",
  );
});

test("unavailableSubprocessAdapter fails closed on run", () => {
  const subprocess = unavailableSubprocessAdapter("workers");
  expect(subprocess.available).toEqual(false);
  expect(() => subprocess.run("git")).toThrow(
    "subprocess.run is not available on the workers runtime",
  );
});

test("createWorkersRuntime wires the shared fail-closed fs/subprocess surface", () => {
  const runtime = createWorkersRuntime({});
  expect(runtime.fs.available).toEqual(false);
  expect(runtime.subprocess.available).toEqual(false);
  expect(() => runtime.fs.makeTempDir()).toThrow(
    "fs.makeTempDir is not available on the workers runtime",
  );
  expect(() => runtime.subprocess.run("git")).toThrow(
    "subprocess.run is not available on the workers runtime",
  );
});

test("nodeRuntime fs.makeTempDir nests inside the OS temp dir with no prefix", async () => {
  // Regression: with no prefix, `path.join(os.tmpdir(), "")` drops the trailing
  // separator, so `mkdtemp` would create a SIBLING of the temp root instead of
  // a child. The adapter must nest the temp dir INSIDE `os.tmpdir()`.
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

test("setRuntimeForTesting overrides detection", () => {
  const fakeAdapter = { ...nodeRuntime, kind: "node" as const };
  setRuntimeForTesting(fakeAdapter);
  try {
    expect(currentRuntime().kind).toEqual("node");
  } finally {
    resetRuntimeForTesting();
  }
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
  await expect(runner.run(["-tv"], enc.encode("x"))).rejects.toThrow(
    "tar -tv failed: tar: broken archive",
  );
});
