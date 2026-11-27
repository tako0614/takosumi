import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
import {
  ENCRYPTED_STATE_NATIVE_TEST,
  captureEncryptedStateNativeOutput,
  encryptedStateNativeCommand,
  encryptedStateNativeEnvironment,
  writeEncryptedStateNativeDiagnostics,
} from "../../scripts/check-encrypted-state-native.ts";

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
      "--path-ignore-patterns=tests/native/node-postgres/**",
      "--path-ignore-patterns=tests/runner/compatibility_check_test.ts",
      "--path-ignore-patterns=tests/core/domains/deploy-control/capsule_execution_authority_test.ts"],
  ]);
});

test("encrypted state native entry selects its exact separate subgroup", async () => {
  const command = encryptedStateNativeCommand({
    bun: process.execPath, tofu: "/fixture/tofu", tar: "/fixture/tar", zstd: "/fixture/zstd",
  });
  expect(command).toEqual([process.execPath, "--no-env-file", "test", ENCRYPTED_STATE_NATIVE_TEST]);
  expect(ENCRYPTED_STATE_NATIVE_TEST)
    .toBe("./tests/native/node-postgres/encrypted-state-update-reconstruction_test.ts");
  const packageJson = JSON.parse(await readFile(resolve(import.meta.dir, "../../package.json"), "utf8"));
  expect(packageJson.scripts["test:encrypted-state-native"])
    .toBe("bun scripts/check-encrypted-state-native.ts");
});

test("native state subgroup stays outside portable and Accounts cadences", async () => {
  expect(PORTABLE_TEST_COMMAND.filter(value => value === "--path-ignore-patterns=tests/native/node-postgres/**"))
    .toHaveLength(1);
  const packageJson = JSON.parse(await readFile(resolve(import.meta.dir, "../../package.json"), "utf8"));
  expect(packageJson.scripts["test:accounts"])
    .toBe("bun test ./tests/accounts ./tests/deploy/node-postgres ./tests/deploy/accounts-cloudflare");
  expect(packageJson.scripts.test).toBe("bun scripts/run-portable-tests.ts");
});

test("native state entry fails when a required capability is absent", async () => {
  const available = { bun: process.execPath, tofu: "/fixture/tofu", tar: "/fixture/tar", zstd: "/fixture/zstd" };
  for (const missing of ["bun", "tofu", "tar", "zstd"] as const) {
    expect(() => encryptedStateNativeCommand({ ...available, [missing]: "" }))
      .toThrow(`encrypted-state native prerequisite unavailable: ${missing}`);
  }
  const emptyPath = await mkdtemp(join(tmpdir(), "takosumi-native-missing-tools-"));
  try {
    const child = Bun.spawn([
      process.execPath, "--no-env-file", resolve(import.meta.dir, "../../scripts/check-encrypted-state-native.ts"),
    ], {
      cwd: emptyPath, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: emptyPath, HOME: emptyPath, TMPDIR: emptyPath },
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(1);
    expect(output).toBe("");
    expect(error).toContain("encrypted-state native prerequisite unavailable: tofu");
  } finally {
    await rm(emptyPath, { recursive: true, force: true });
  }
});

test("native entry resets an ambient internal child flag for its outer process", () => {
  const ambient = { PATH: "/fixture/bin", TAKOSUMI_TEST_ENCRYPTED_UPDATE_CHILD: "1" };
  expect(encryptedStateNativeEnvironment(ambient)).toEqual({
    PATH: ambient.PATH, TAKOSUMI_TEST_ENCRYPTED_UPDATE_CHILD: "0",
  });
  expect(ambient.TAKOSUMI_TEST_ENCRYPTED_UPDATE_CHILD).toBe("1");
});

test("native failure diagnostics retain bounded actual child streams privately", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-native-child-failure-"));
  await chmod(root, 0o700);
  try {
    const raw = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    const child = Bun.spawn([process.execPath, "--eval",
      'process.stdout.write("fixture stdout\\n"); process.stderr.write("fixture stderr\\n"); process.exitCode = 9;'],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: root, HOME: root, TMPDIR: root } });
    const [output, error, code] = await Promise.all([
      captureEncryptedStateNativeOutput(child.stdout, raw.stdout),
      captureEncryptedStateNativeOutput(child.stderr, raw.stderr), child.exited,
    ]);
    expect(code).toBe(9);
    await writeEncryptedStateNativeDiagnostics(root, raw);
    expect(await readFile(join(root, "child.stdout.log"), "utf8")).toBe(output);
    expect(await readFile(join(root, "child.stderr.log"), "utf8")).toBe(error);
    expect(output).toBe("fixture stdout\n");
    expect(error).toBe("fixture stderr\n");
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    for (const name of ["stdout", "stderr"]) {
      expect((await stat(join(root, `child.${name}.log`))).mode & 0o777).toBe(0o600);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native diagnostic overflow and save errors preserve custody and original failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-native-diagnostic-failure-"));
  await chmod(root, 0o700);
  try {
    const raw = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 + 8).fill(0x61)); controller.close();
    } });
    await expect(captureEncryptedStateNativeOutput(stream, raw.stdout)).rejects.toThrow("exceeded bound");
    expect(stream.locked).toBe(false);
    await writeEncryptedStateNativeDiagnostics(root, raw);
    const protectedBytes = await readFile(join(root, "child.stdout.log"));
    expect(protectedBytes.byteLength).toBe(64 * 1024);
    const target = join(root, "protected-target");
    await writeFile(target, "unchanged");
    await rm(join(root, "child.stderr.log"));
    await symlink(target, join(root, "child.stderr.log"));
    const original = new Error("fixture original child failure");
    const failed = async () => {
      try { throw original; }
      finally { await writeEncryptedStateNativeDiagnostics(root, raw, () => { throw new Error("diagnostic reporter failure"); }); }
    };
    await expect(failed()).rejects.toBe(original);
    expect(await readFile(join(root, "child.stdout.log"))).toEqual(protectedBytes);
    expect(await readFile(target, "utf8")).toBe("unchanged");
  } finally { await rm(root, { recursive: true, force: true }); }
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
    [...PORTABLE_TEST_COMMAND.filter((arg) => arg !== "--only-failures"), "--shard=2/6", `--timings=${output}`,
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
    for (const name of ["last-announced-test-file.json", "last-announced-test-file.json.tmp"]) {
      const staleProgress = join(root, name);
      await symlink(join(root, "missing"), staleProgress);
      expect(() => preparePrivateTimingOutput(output)).toThrow("already exist");
      await rm(staleProgress);
    }
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

test("portable test children disable Miniflare request metadata fetching", async () => {
  const original = process.env.CLOUDFLARE_CF_FETCH_ENABLED;
  process.env.CLOUDFLARE_CF_FETCH_ENABLED = "true";
  try {
    expect(await runPortableTestCommands([
      [process.execPath, "--eval", 'process.exit(process.env.CLOUDFLARE_CF_FETCH_ENABLED === "false" ? 0 : 19)'],
    ])).toBe(0);
    expect(process.env.CLOUDFLARE_CF_FETCH_ENABLED).toBe("true");
  } finally {
    if (original === undefined) delete process.env.CLOUDFLARE_CF_FETCH_ENABLED;
    else process.env.CLOUDFLARE_CF_FETCH_ENABLED = original;
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

test("an actual Bun file blocked in beforeAll leaves a private file checkpoint before exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-shard-file-progress-"));
  try {
    const tests = join(root, "tests");
    const artifacts = join(root, "artifacts");
    await mkdir(tests);
    await mkdir(artifacts, { mode: 0o700 });
    await writeFile(join(tests, "paused_test.ts"), `
      import { beforeAll, test } from "bun:test";
      beforeAll(async () => {
        const released = Bun.file("release");
        const deadline = Date.now() + 8_000;
        while (!await released.exists()) {
          if (Date.now() >= deadline) throw new Error("fixture release missing");
          await Bun.sleep(10);
        }
      });
      test("fixture failure after release", () => { throw new Error("isolated fixture failure"); });
    `);
    const output = preparePrivateTimingOutput(join(artifacts, "timings.json"));
    const checkpoint = join(artifacts, "last-announced-test-file.json");
    let exited = false;
    const running = runPortableTestCommands(
      [[process.execPath, "test", "--isolate", "./tests"]],
      root,
      output,
    ).then((status) => { exited = true; return status; });
    try {
      const deadline = Date.now() + 4_000;
      while (!exited && !await Bun.file(checkpoint).exists() && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(exited).toBe(false);
      expect(JSON.parse(await readFile(checkpoint, "utf8"))).toEqual({
        version: 1,
        file: "tests/paused_test.ts",
        announcedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect((await stat(checkpoint)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(output).exists()).toBe(false);
    } finally {
      await writeFile(join(root, "release"), "");
      expect(await running).toBe(1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);

test("CI preserves failed-run artifacts without changing shard count or job guards", async () => {
  const workflow = parse(await readFile(resolve(import.meta.dir, "../../.github/workflows/quality.yml"), "utf8")) as {
    permissions: { contents: string };
    jobs: { tests: { "timeout-minutes": number; strategy: { "fail-fast": boolean; matrix: { shard: number[] } }; steps: { name: string; if?: string; run?: string; "timeout-minutes"?: number; "continue-on-error"?: boolean; with?: Record<string, unknown> }[] } };
  };
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = workflow.jobs.tests;
  expect(job.strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6]);
  expect(job.strategy["fail-fast"]).toBe(false);
  expect(job["timeout-minutes"]).toBe(40);
  const testIndex = job.steps.findIndex((step) => step.name === "Run test phase shard");
  expect(testIndex).toBeGreaterThan(job.steps.findIndex((step) => step.name === "Prepare private timing output"));
  expect(job.steps.find((step) => step.name === "Mark test shard started")).toBeUndefined();
  const run = job.steps[testIndex]!;
  const lines = run.run?.trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines?.[0]).toBe("umask 077");
  const markerPayload = lines?.[1]?.match(/printf '%s\\n' '([^']+)' >/u)?.[1];
  expect(markerPayload).toBeDefined();
  expect(lines?.[1]).toBe(
    `printf '%s\\n' '${markerPayload}' > "\${RUNNER_TEMP}/takosumi-test-timings/started.json"`,
  );
  const started = JSON.parse(markerPayload!) as Record<string, unknown>;
  expect(started).toEqual({ version: 1, phase: "started", complete: false });
  expect(lines?.[2]).toBe("exec bun run check --only tests");
  expect(run["timeout-minutes"]).toBe(35);
  expect(run["timeout-minutes"]!).toBeLessThan(job["timeout-minutes"]);
  expect(run["continue-on-error"]).toBeUndefined();
  expect(job.steps.findIndex((step) => step.name === "Save measured shard timings")).toBeGreaterThan(testIndex);
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
