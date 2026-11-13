import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import {
  PORTABLE_TEST_COMMAND,
  TEST_TIMINGS_PATH,
  portableTestCommands,
  preparePrivateTimingOutput,
  runPortableTestCommands,
} from "../../scripts/run-portable-tests.ts";

test("committed timing data is a non-empty Bun timing table", async () => {
  const timings = JSON.parse(await readFile(
    resolve(import.meta.dir, "../..", TEST_TIMINGS_PATH), "utf8",
  )) as { version: number; files: Record<string, number> };
  expect(timings.version).toBe(1);
  expect(Object.keys(timings.files).length).toBeGreaterThan(0);
  for (const [path, duration] of Object.entries(timings.files)) {
    expect(path.startsWith("tests/")).toBe(true);
    expect(Number.isFinite(duration) && duration >= 0).toBe(true);
  }
});

test("unsharded test preserves both original sweeps and exclusions", () => {
  expect(portableTestCommands()).toEqual([
    ["bun", "run", "test:workerd"],
    ["bun", "test", "--isolate", "--only-failures", "./tests",
      "--path-ignore-patterns=tests/dashboard/e2e/**",
      "--path-ignore-patterns=tests/runner/compatibility_check_test.ts",
      "--path-ignore-patterns=tests/core/domains/deploy-control/capsule_execution_authority_test.ts"],
  ]);
});

test("shards run workerd exactly once and use immutable common timings", () => {
  const commands = Array.from({ length: 6 }, (_, i) => portableTestCommands({ shard: `${i + 1}/6` }));
  expect(commands.flat().filter((command) => command[2] === "test:workerd")).toHaveLength(1);
  expect(commands[0]![0]).toEqual(["bun", "run", "test:workerd"]);
  for (const [index, shard] of commands.entries()) {
    expect(shard.at(-1)).toEqual([
      ...PORTABLE_TEST_COMMAND, `--shard=${index + 1}/6`, `--timings=${TEST_TIMINGS_PATH}`,
    ]);
  }
  expect(portableTestCommands({ updateTimings: true }).at(-1))
    .toEqual([...PORTABLE_TEST_COMMAND, `--timings=${TEST_TIMINGS_PATH}`, "--update-timings"]);
});

test("malformed shards and partial timing refresh fail closed", () => {
  for (const shard of ["", "0/6", "7/6", "1/0", "1", "1.5/6", "01/6", "1/6/7", "1/9007199254740992"]) {
    expect(() => portableTestCommands({ shard })).toThrow("TAKOSUMI_TEST_SHARD");
  }
  expect(() => portableTestCommands({ shard: "1/6", updateTimings: true })).toThrow("unsharded");
});

test("private shard measurements preserve the immutable timing input and original guards", () => {
  const output = join(tmpdir(), "takosumi-private-measurements", "timings.json");
  expect(portableTestCommands({ shard: "2/6", timingsOutput: output })).toEqual([
    [...PORTABLE_TEST_COMMAND, "--shard=2/6", `--timings=${output}`,
      `--timings=${TEST_TIMINGS_PATH}`, "--update-timings"],
  ]);
  expect(() => portableTestCommands({ timingsOutput: output })).toThrow("requires a shard");
  expect(() => portableTestCommands({ shard: "2/6", updateTimings: true, timingsOutput: output })).toThrow("unsharded");
  for (const invalid of ["", TEST_TIMINGS_PATH, resolve(import.meta.dir, "../..", TEST_TIMINGS_PATH)]) {
    expect(() => portableTestCommands({ shard: "2/6", timingsOutput: invalid })).toThrow("outside the checkout");
  }
});

test("private output refuses existing entries, nonprivate parents and checkout aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-output-"));
  try {
    const output = join(root, "timings.json");
    expect(preparePrivateTimingOutput(output)).toBe(output);
    await writeFile(output, "already present");
    expect(() => preparePrivateTimingOutput(output)).toThrow("already exist");
    await rm(output);
    await symlink(join(root, "missing"), output);
    expect(() => preparePrivateTimingOutput(output)).toThrow("already exist");
    await rm(output);
    await writeFile(join(root, "provenance.json"), "old receipt");
    expect(() => preparePrivateTimingOutput(output)).toThrow("already exist");
    await rm(join(root, "provenance.json"));
    await chmod(root, 0o755);
    expect(() => preparePrivateTimingOutput(output)).toThrow("0700");
    await chmod(root, 0o700);
    const alias = join(root, "checkout");
    await symlink(resolve(import.meta.dir, "../.."), alias);
    expect(() => preparePrivateTimingOutput(join(alias, "timings.json"))).toThrow();
    const nested = join(root, "nested");
    await mkdir(nested, { mode: 0o700 });
    await symlink(nested, join(root, "alias"));
    expect(() => preparePrivateTimingOutput(join(root, "alias", "timings.json"))).toThrow("0700");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command execution preserves the original nonzero and stops later commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-test-exit-"));
  try {
    expect(await runPortableTestCommands([
      [process.execPath, "--eval", "process.exit(23)"],
      [process.execPath, "--eval", 'Bun.write("should-not-run", "unexpected")'],
    ], root)).toBe(23);
    expect(await Bun.file(join(root, "should-not-run")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CI preserves failed-run artifacts without changing shard count or job guards", async () => {
  const workflow = parse(await readFile(resolve(import.meta.dir, "../../.github/workflows/quality.yml"), "utf8")) as {
    permissions: { contents: string };
    jobs: { tests: { "timeout-minutes": number; strategy: { "fail-fast": boolean; matrix: { shard: number[] } }; steps: { name: string; if?: string; with?: Record<string, unknown> }[] } };
  };
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = workflow.jobs.tests;
  expect(job.strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6]);
  expect(job.strategy["fail-fast"]).toBe(false);
  expect(job["timeout-minutes"]).toBe(40);
  const upload = job.steps.find((step) => step.name === "Save measured shard timings");
  expect(upload?.if).toBe("always()");
  expect(upload?.with?.["if-no-files-found"]).toBe("error");
  expect(upload?.with?.overwrite).toBe(false);
});

test("actual failed Bun run retains partial measurements and its nonzero result", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-failed-timings-"));
  try {
    await writeFile(join(root, "failure.test.ts"), 'import { test } from "bun:test"; test("expected fixture failure", () => { throw new Error("fixture only"); });\n');
    const output = join(root, "timings.json");
    const child = Bun.spawn([process.execPath, "test", "./failure.test.ts", "--shard=1/1", `--timings=${output}`, "--update-timings"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    const data = JSON.parse(await readFile(output, "utf8")) as { files: Record<string, number> };
    expect(Object.keys(data.files)).toEqual(["failure.test.ts"]);
    expect(Number.isFinite(data.files["failure.test.ts"])).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual Bun writes disjoint private shard measurements without changing common input", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-timings-"));
  try {
    await mkdir(join(root, "tests"));
    for (let i = 0; i < 7; i++) {
      await writeFile(join(root, "tests", `file-${i}.test.ts`),
        `import { test } from "bun:test"; test("file ${i}", () => console.log("measured-file-${i}"));\n`);
    }
    const common = JSON.stringify({ version: 1, files: {
      "tests/file-0.test.ts": 10000, "tests/file-1.test.ts": 200, "removed.test.ts": 50000,
    } });
    await writeFile(join(root, TEST_TIMINGS_PATH), common);
    const all: string[] = [];
    for (let shard = 1; shard <= 3; shard++) {
      const directory = join(root, `output-${shard}`);
      await mkdir(directory, { mode: 0o700 });
      const output = join(directory, "timings.json");
      const command = portableTestCommands({ shard: `${shard}/3`, timingsOutput: output }).at(-1)!;
      const child = Bun.spawn([process.execPath, ...command.slice(1)], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code, stderr).toBe(0);
      const measured = JSON.parse(await readFile(output, "utf8")) as { version: number; files: Record<string, number> };
      expect(measured.version).toBe(1);
      const executed = (stdout.match(/measured-file-\d+/gu) ?? [])
        .map((marker) => `tests/file-${marker.split("-").at(-1)}.test.ts`).sort();
      expect(Object.keys(measured.files).sort()).toEqual(executed);
      expect(Object.values(measured.files).every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
      expect(await readFile(join(root, TEST_TIMINGS_PATH), "utf8")).toBe(common);
      all.push(...Object.keys(measured.files));
    }
    expect(all.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `tests/file-${i}.test.ts`));
    expect(new Set(all).size).toBe(7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bun shards partition discovered files even with stale timings and new files", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-shard-partition-"));
  try {
    for (let i = 0; i < 7; i++) {
      await writeFile(join(root, `file-${i}.test.ts`),
        `import { test } from "bun:test"; test("file ${i}", () => console.log("partition-file-${i}"));\n`);
    }
    await writeFile(join(root, "timings.json"), JSON.stringify({ version: 1, files: {
      "file-0.test.ts": 10000, "file-1.test.ts": 200, "removed.test.ts": 50000,
    } }));
    const files = async (shard?: string) => {
      const child = Bun.spawn([process.execPath, "test", ".", "--timings=timings.json", ...(shard ? [`--shard=${shard}`] : [])], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code, stderr).toBe(0);
      return stdout.match(/partition-file-\d+/gu) ?? [];
    };
    const unsharded = await files();
    const partition: string[] = [];
    for (let i = 1; i <= 3; i++) partition.push(...await files(`${i}/3`));
    expect(unsharded).toHaveLength(7);
    expect(partition.sort()).toEqual(unsharded.sort());
    expect(new Set(partition).size).toBe(7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
