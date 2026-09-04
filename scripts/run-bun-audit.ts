/**
 * Run Bun's registry-backed dependency audit with a short, bounded retry for
 * transport failures.
 *
 * A vulnerability result is authoritative and is never retried. Registry
 * timeouts and connection failures are not vulnerability results, but they
 * must still fail the job after the bounded attempts are exhausted.
 */

import { resolve } from "node:path";

export interface AuditAttemptResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface AuditRunOptions {
  readonly cwd: string;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly execute?: (
    cwd: string,
    timeoutMs: number,
  ) => Promise<AuditAttemptResult>;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

export interface AuditRunOutcome {
  readonly exitCode: number;
  readonly attempts: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const FORCE_KILL_GRACE_MS = 1_000;

const TRANSIENT_FAILURE =
  /(?:audit request failed|connectionclosed|connectionreset|connectionrefused|econnreset|econnrefused|etimedout|fetch failed|network error|timed?\s*out)/iu;

export function isTransientAuditFailure(result: AuditAttemptResult): boolean {
  if (result.timedOut) return true;
  if (result.exitCode === 0) return false;
  return TRANSIENT_FAILURE.test(`${result.stdout}\n${result.stderr}`);
}

export async function runBunAudit(
  options: AuditRunOptions,
): Promise<AuditRunOutcome> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const execute = options.execute ?? executeBunAudit;
  const sleep = options.sleep ?? wait;
  const writeStdout = options.writeStdout ?? ((text) => process.stdout.write(text));
  const writeStderr = options.writeStderr ?? ((text) => process.stderr.write(text));

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("retryDelayMs must be a non-negative integer");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await execute(options.cwd, timeoutMs);
    if (result.exitCode === 0 && !result.timedOut) {
      writeCapturedOutput(result, writeStdout, writeStderr);
      return { exitCode: 0, attempts: attempt };
    }

    const transient = isTransientAuditFailure(result);
    if (!transient || attempt === maxAttempts) {
      writeCapturedOutput(result, writeStdout, writeStderr);
      if (result.timedOut) {
        writeStderr(
          `bun audit timed out after ${timeoutMs}ms (attempt ${attempt}/${maxAttempts})\n`,
        );
      }
      return {
        exitCode: result.timedOut ? 124 : result.exitCode,
        attempts: attempt,
      };
    }

    writeStderr(
      `bun audit transport failure; retrying attempt ${attempt + 1}/${maxAttempts}\n`,
    );
    await sleep(retryDelayMs * attempt);
  }

  throw new Error("unreachable audit retry state");
}

async function executeBunAudit(
  cwd: string,
  timeoutMs: number,
): Promise<AuditAttemptResult> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([process.execPath, "audit", "--json"], {
      cwd,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: `failed to start bun audit: ${safeErrorMessage(error)}\n`,
      timedOut: false,
    };
  }

  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited between the grace timer and this call.
      }
    }, FORCE_KILL_GRACE_MS);
  }, timeoutMs);

  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const exitCode = await child.exited.finally(() => {
    clearTimeout(timer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  return { exitCode, stdout, stderr, timedOut };
}

function writeCapturedOutput(
  result: AuditAttemptResult,
  writeStdout: (text: string) => void,
  writeStderr: (text: string) => void,
): void {
  if (result.stdout.length > 0) writeStdout(result.stdout);
  if (result.stderr.length > 0) writeStderr(result.stderr);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCwd(argv: readonly string[]): string {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === "--cwd" && argv[1]?.length > 0) {
    return resolve(process.cwd(), argv[1]);
  }
  throw new Error("usage: bun scripts/run-bun-audit.ts [--cwd <directory>]");
}

if (import.meta.main) {
  try {
    const outcome = await runBunAudit({ cwd: parseCwd(process.argv.slice(2)) });
    process.exitCode = outcome.exitCode;
  } catch (error) {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
