import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const ROOT = resolve(import.meta.dir, "..");
const TEST_FILE_PROGRESS = "last-announced-test-file.json";
const TEST_FILE_HEADER = /^(?:\.\/)?(tests\/(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*[_.-](?:test|spec)\.[cm]?[jt]sx?):$/u;
const TEST_DIAGNOSTICS_DRAIN_MS = 250;

export const TEST_TIMINGS_PATH = "tests/.bun-test-timings.json";
// Native runtimes and host fixtures must not inherit leaked globals or handles
// from earlier files in the long local sweep. Keep inventory and shards intact.
export const PORTABLE_TEST_COMMAND = [
  "bun", "test", "--isolate", "--only-failures", "./tests",
  "--path-ignore-patterns=tests/dashboard/e2e/**",
  "--path-ignore-patterns=tests/native/node-postgres/**",
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
  for (const target of [
    output, join(parent, "provenance.json"), join(parent, TEST_FILE_PROGRESS), join(parent, `${TEST_FILE_PROGRESS}.tmp`),
  ]) {
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
  // Bun's normal reporter announces each file before its hooks run.
  const command = output === undefined
    ? PORTABLE_TEST_COMMAND
    : PORTABLE_TEST_COMMAND.filter((arg) => arg !== "--only-failures");
  return [
    ...(index === 1 ? [["bun", "run", "test:workerd"]] : []),
    [
      ...command,
      ...(shard ? [`--shard=${shard}`] : []),
      ...(output !== undefined ? [`--timings=${output}`] : []),
      ...(shard || options.updateTimings ? [`--timings=${TEST_TIMINGS_PATH}`] : []),
      ...(options.updateTimings || output !== undefined ? ["--update-timings"] : []),
    ],
  ];
}

async function relayTestDiagnostics(
  stderr: ReadableStream<Uint8Array>, cwd: string, progressPath: string, signal: AbortSignal,
): Promise<boolean> {
  const input = Readable.fromWeb(stderr, { signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let progressWritten = true;
  try {
    for await (const line of lines) {
      const file = TEST_FILE_HEADER.exec(line)?.[1];
      if (file && progressWritten) {
        try {
          // Nested fixtures can print Bun headers from a different checkout.
          if (lstatSync(resolve(cwd, file), { throwIfNoEntry: false })?.isFile()) {
            const scratch = `${progressPath}.tmp`;
            const record = { version: 1, file, announcedAt: new Date().toISOString() };
            writeFileSync(scratch, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
            renameSync(scratch, progressPath);
          }
        } catch {
          console.error("[portable-tests] could not retain the last announced test file");
          progressWritten = false;
        }
      }
      // Keep failure details and file headings without expanding every passing test.
      if (!line.startsWith("(pass) ")) process.stderr.write(`${line}\n`);
    }
  } catch (error) {
    if (!signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
  }
  return progressWritten;
}

export async function runPortableTestCommands(
  commands: readonly (readonly string[])[], cwd = ROOT, timingsOutput?: string,
): Promise<number> {
  for (const command of commands) {
    console.error(`[portable-tests] ${command.join(" ")}`);
    const progress = timingsOutput && command[1] === "test"
      ? join(dirname(timingsOutput), TEST_FILE_PROGRESS) : undefined;
    const child = Bun.spawn([...command], {
      cwd,
      // Synthetic Workers need the local Request.cf fallback, not a network
      // request during each Miniflare startup.
      env: {
        ...process.env, CLOUDFLARE_CF_FETCH_ENABLED: "false",
        ...(progress ? { NO_COLOR: "1", FORCE_COLOR: "0" } : {}),
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: progress ? "pipe" : "inherit",
    });
    const stopDiagnostics = progress ? new AbortController() : undefined;
    const diagnostics = progress && child.stderr && stopDiagnostics
      ? relayTestDiagnostics(child.stderr, cwd, progress, stopDiagnostics.signal).catch(() => {
        console.error("[portable-tests] could not read test diagnostics");
        return false;
      })
      : true;
    const code = await child.exited;
    // A fixture's descendant can retain stderr after the test process exits.
    // Give buffered output a chance to arrive without waiting for its EOF.
    const drain = stopDiagnostics && setTimeout(() => stopDiagnostics.abort(), TEST_DIAGNOSTICS_DRAIN_MS);
    const diagnosticsOkay = await diagnostics;
    clearTimeout(drain);
    if (code !== 0) return code;
    if (!diagnosticsOkay) return 1;
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
    let code = await runPortableTestCommands(commands, ROOT, output);
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
