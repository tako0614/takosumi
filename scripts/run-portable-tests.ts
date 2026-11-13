import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

export const TEST_TIMINGS_PATH = "tests/.bun-test-timings.json";
// Native runtimes and host fixtures must not inherit leaked globals or handles
// from earlier files in the long local sweep. Keep inventory and shards intact.
export const PORTABLE_TEST_COMMAND = [
  "bun", "test", "--isolate", "--only-failures", "./tests",
  "--path-ignore-patterns=tests/dashboard/e2e/**",
  "--path-ignore-patterns=tests/runner/compatibility_check_test.ts",
  "--path-ignore-patterns=tests/core/domains/deploy-control/capsule_execution_authority_test.ts",
] as const;

function outsideCheckout(path: string): string {
  const result = resolve(path);
  const fromRoot = relative(ROOT, result);
  if (!isAbsolute(path) || !(fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))) {
    throw new Error("private timing output must be absolute and outside the checkout");
  }
  return result;
}

/** The CI caller creates a fresh, owner-private directory before tests start. */
export function preparePrivateTimingOutput(path: string): string {
  const output = outsideCheckout(path);
  const parent = dirname(output);
  const info = lstatSync(parent);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new Error("private timing output requires an owned 0700 directory");
  }
  outsideCheckout(join(realpathSync(parent), basename(output)));
  for (const target of [output, join(parent, "provenance.json")]) {
    try {
      lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("private timing output must not already exist");
  }
  return output;
}

/** Bun partitions discovered files; timings affect balance, never membership. */
export function portableTestCommands(options: {
  shard?: string;
  updateTimings?: boolean;
  timingsOutput?: string;
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
  const output = options.timingsOutput;
  if (output !== undefined) {
    if (!shard) throw new Error("private timing output requires a shard");
    outsideCheckout(output);
  }
  return [
    ...(index === 1 ? [["bun", "run", "test:workerd"]] : []),
    [
      ...PORTABLE_TEST_COMMAND,
      ...(shard ? [`--shard=${shard}`] : []),
      ...(output !== undefined ? [`--timings=${output}`] : []),
      ...(shard || options.updateTimings ? [`--timings=${TEST_TIMINGS_PATH}`] : []),
      ...(options.updateTimings || output !== undefined ? ["--update-timings"] : []),
    ],
  ];
}

export async function runPortableTestCommands(
  commands: readonly (readonly string[])[], cwd = ROOT,
): Promise<number> {
  for (const command of commands) {
    console.error(`[portable-tests] ${command.join(" ")}`);
    const child = Bun.spawn([...command], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0) return code;
  }
  return 0;
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function writeTimingProvenance(
  output: string, shard: string, inputSha256: string, exitCode: number,
  commands: readonly (readonly string[])[],
): void {
  if (digest(resolve(ROOT, TEST_TIMINGS_PATH)) !== inputSha256) throw new Error("common timing input changed");
  let measurements = null;
  try {
    const data = JSON.parse(readFileSync(output, "utf8")) as { version: number; files: Record<string, number> };
    if (data.version !== 1 || !data.files || typeof data.files !== "object" || Array.isArray(data.files) ||
      !Object.values(data.files).every((ms) => Number.isFinite(ms) && ms >= 0)) throw new Error("invalid measured timings");
    chmodSync(output, 0o600);
    measurements = { path: basename(output), sha256: digest(output), files: Object.keys(data.files).length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exitCode === 0 && !measurements?.files) throw new Error("successful shard produced no timing measurements");
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD", "HEAD^{tree}"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (git.exitCode !== 0) throw new Error("could not identify timing checkout");
  const [commit, tree] = new TextDecoder().decode(git.stdout).trim().split("\n");
  const receipt = {
    version: 1, shard, exitCode, complete: exitCode === 0, commands,
    source: { commit, tree },
    toolchain: { bunVersion: Bun.version, bunRevision: Bun.revision, platform: process.platform, arch: process.arch },
    input: { path: TEST_TIMINGS_PATH, sha256: inputSha256 }, measurements,
    github: { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, event: process.env.GITHUB_EVENT_NAME },
  };
  writeFileSync(join(dirname(output), "provenance.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--update-timings")) {
      throw new Error("usage: bun scripts/run-portable-tests.ts [--update-timings]");
    }
    const shard = process.env.TAKOSUMI_TEST_SHARD;
    const output = process.env.TAKOSUMI_TEST_TIMINGS_OUTPUT;
    const commands = portableTestCommands({
      shard,
      updateTimings: args[0] === "--update-timings",
      timingsOutput: output,
    });
    const inputSha256 = output === undefined ? undefined : digest(resolve(ROOT, TEST_TIMINGS_PATH));
    if (output !== undefined) preparePrivateTimingOutput(output);
    let code = await runPortableTestCommands(commands);
    if (output !== undefined) {
      try {
        writeTimingProvenance(output, shard!, inputSha256!, code, commands);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        // A receipt failure cannot replace the original test failure status.
        if (code === 0) code = 1;
      }
    }
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
