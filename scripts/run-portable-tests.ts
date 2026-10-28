import { resolve } from "node:path";

export const TEST_TIMINGS_PATH = "tests/.bun-test-timings.json";
export const PORTABLE_TEST_COMMAND = [
  "bun", "test", "--only-failures", "./tests",
  "--path-ignore-patterns=tests/dashboard/e2e/**",
  "--path-ignore-patterns=tests/runner/compatibility_check_test.ts",
  "--path-ignore-patterns=tests/core/domains/deploy-control/capsule_execution_authority_test.ts",
] as const;

/** Bun partitions discovered files; timings affect balance, never membership. */
export function portableTestCommands(options: {
  shard?: string;
  updateTimings?: boolean;
} = {}): readonly (readonly string[])[] {
  const shard = options.shard;
  let index = 1;
  if (shard !== undefined) {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(shard);
    index = Number(match?.[1]);
    const count = Number(match?.[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) {
      throw new Error("TAKOSUMI_TEST_SHARD must be i/N with 1 <= i <= N");
    }
  }
  if (shard && options.updateTimings) {
    throw new Error("refresh timings with a full unsharded run");
  }
  return [
    ...(index === 1 ? [["bun", "run", "test:workerd"]] : []),
    [
      ...PORTABLE_TEST_COMMAND,
      ...(shard ? [`--shard=${shard}`] : []),
      ...(shard || options.updateTimings ? [`--timings=${TEST_TIMINGS_PATH}`] : []),
      ...(options.updateTimings ? ["--update-timings"] : []),
    ],
  ];
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--update-timings")) {
      throw new Error("usage: bun scripts/run-portable-tests.ts [--update-timings]");
    }
    const commands = portableTestCommands({
      shard: process.env.TAKOSUMI_TEST_SHARD,
      updateTimings: args[0] === "--update-timings",
    });
    for (const command of commands) {
      console.error(`[portable-tests] ${command.join(" ")}`);
      const child = Bun.spawn([...command], {
        cwd: resolve(import.meta.dir, ".."),
        stdin: "inherit", stdout: "inherit", stderr: "inherit",
      });
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        process.exitCode = exitCode;
        break;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
