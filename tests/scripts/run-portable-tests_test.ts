import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  PORTABLE_TEST_COMMAND,
  TEST_TIMINGS_PATH,
  portableTestCommands,
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
