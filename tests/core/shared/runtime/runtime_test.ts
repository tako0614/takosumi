import { expect, test } from "bun:test";
import {
  currentRuntime,
  resetRuntimeForTesting,
  setRuntimeForTesting,
} from "../../../../core/shared/runtime/index.ts";
import { createWorkersRuntime } from "../../../../core/shared/runtime/workers.ts";
import { nodeRuntime } from "../../../../core/shared/runtime/node.ts";
import {
  unavailableFsAdapter,
  unavailableSubprocessAdapter,
} from "../../../../core/shared/runtime/runtime.ts";

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
