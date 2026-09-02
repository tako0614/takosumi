// runner/lib/exec.ts
//
// Subprocess execution + OpenTofu plan/output readers + capped HTTP body reader.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  OpenTofuRunAction,
  JsonRecord,
  RunWorkspace,
  CommandContext,
} from "./types.ts";
import {
  isRecord,
} from "./util.ts";
import {
  redactRunnerOutput,
} from "./redaction.ts";
import {
  baseCommandEnv,
} from "./credentials.ts";

export async function readResponseBytesWithCap(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number.parseInt(declared, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new Error(`${label} declares ${parsed} bytes, cap is ${maxBytes}`);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function runRequiredCommand(
  command: readonly string[],
  options: { readonly cwd: string; readonly context: CommandContext },
): Promise<void> {
  const result = await runCommand(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command[0]} failed with ${result.exitCode}: ${redactRunnerOutput(
        result.stderr || result.stdout,
        options.context.redactionValues,
      )}`,
    );
  }
}

export async function readOpenTofuPlanJson(
  moduleDir: string,
  workspace: RunWorkspace,
  context: CommandContext,
): Promise<string | undefined> {
  const result = await runCommand(
    ["tofu", "show", "-json", workspace.planPath],
    { cwd: moduleDir, context, isolateProcessGroup: true },
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0
    ? result.stdout
    : undefined;
}

export async function readOpenTofuOutputsIn(
  moduleDir: string,
  context: CommandContext,
): Promise<Record<string, unknown> | undefined> {
  const result = await runCommand(["tofu", "output", "-json"], {
    cwd: moduleDir,
    context,
    isolateProcessGroup: true,
  });
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length > 0
    ) {
      return parsed as Record<string, unknown>;
    }
  }
  return await readOpenTofuOutputsFromStateFile(moduleDir);
}

export async function readOpenTofuOutputsFromStateFile(
  moduleDir: string,
): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(moduleDir, "terraform.tfstate"), "utf8"),
    ) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const outputs = parsed.outputs;
  if (!isRecord(outputs) || Object.keys(outputs).length === 0) {
    return undefined;
  }
  return outputs;
}

/** The live child a {@link runCommand} caller may observe, but not write to. */
export interface SpawnedCommand {
  readonly pid: number;
  readonly exited: Promise<number>;
}

export async function runCommand(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly context?: CommandContext;
    /**
     * Runs the command in its own process group and kills the whole group on
     * direct exit, timeout, or cancellation. Reviewed app/build commands may
     * spawn descendants; their lifecycle must end before later credential
     * phases or cleanup can proceed.
     */
    readonly isolateProcessGroup?: boolean;
    /**
     * Invoked the instant the child process exists.
     *
     * The run-scoped sensitive input lane uses it to open the write end of its
     * FIFO variable file only once a reader can exist, and to stop waiting if
     * the child dies first. Standard input is deliberately never written: it
     * stays Bun's default `ignore`, so every provider plugin OpenTofu spawns
     * inherits `/dev/null` on fd 0 instead of a re-readable var-file body.
     */
    readonly onSpawn?: (child: SpawnedCommand) => void;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const signal = options.context?.signal;
  if (signal?.aborted) {
    return { exitCode: 130, stdout: "", stderr: "command aborted" };
  }
  const isolate = options.isolateProcessGroup === true;
  const subprocess = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.context?.env ?? baseCommandEnv(),
    stdout: "pipe",
    stderr: "pipe",
    ...(isolate ? { detached: true } : {}),
  });
  options.onSpawn?.({
    pid: subprocess.pid,
    exited: subprocess.exited,
  });
  const stdoutPromise = new Response(subprocess.stdout).text();
  const stderrPromise = new Response(subprocess.stderr).text();
  type Termination =
    | { readonly kind: "exit"; readonly exitCode: number }
    | { readonly kind: "timeout"; readonly exitCode: 124 }
    | { readonly kind: "abort"; readonly exitCode: 130 };
  const terminations: Promise<Termination>[] = [
    subprocess.exited.then((exitCode) => ({ kind: "exit", exitCode })),
  ];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.context?.timeoutMs;
  if (timeoutMs && timeoutMs > 0) {
    terminations.push(
      new Promise<Termination>((resolve) => {
        timeout = setTimeout(
          () => resolve({ kind: "timeout", exitCode: 124 }),
          timeoutMs,
        );
      }),
    );
  }
  let abortListener: (() => void) | undefined;
  if (signal) {
    terminations.push(
      new Promise<Termination>((resolve) => {
        abortListener = () =>
          resolve({ kind: "abort", exitCode: 130 });
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      }),
    );
  }

  try {
    const termination = await Promise.race(terminations);
    if (isolate) {
      // On direct exit this kills any descendant still holding inherited
      // output pipes. On timeout/abort it also kills the direct child.
      killProcessGroup(subprocess.pid);
    }
    if (termination.kind !== "exit") {
      // Keep direct-child timeout/cancel semantics even on a platform where
      // negative-pid process-group signalling is unavailable.
      killProcess(subprocess.pid);
    }
    // Await the direct child even after a timeout/abort kill. Runtime/provider
    // cleanup must not start while its process or output streams are live.
    await subprocess.exited;
    const [stdout, stderr] = await Promise.all([
      stdoutPromise,
      stderrPromise,
    ]);
    const terminationDiagnostic =
      termination.kind === "timeout"
        ? `command timed out after ${timeoutMs}ms`
        : termination.kind === "abort"
          ? "command aborted"
          : undefined;
    return {
      exitCode: termination.exitCode,
      stdout,
      stderr: terminationDiagnostic
        ? [stderr, terminationDiagnostic].filter(Boolean).join("\n")
        : stderr,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

/** SIGKILLs a whole process group; an already-empty group is not an error. */
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

/** SIGKILLs one direct child; an already-exited process is not an error. */
function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process is already gone.
  }
}

export function commandFailurePayload(
  runId: string,
  action: OpenTofuRunAction,
  result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  context?: CommandContext,
  phase?: "init" | "plan" | "apply",
): JsonRecord {
  const stderr = redactRunnerOutput(
    result.stderr,
    context?.redactionValues,
  );
  const stdout = redactRunnerOutput(
    result.stdout,
    context?.redactionValues,
  );
  const errorCode = classifyOpenTofuFailure(
    [stderr, stdout].filter(Boolean).join("\n"),
    phase,
  );
  return {
    runId,
    action,
    status: "failed",
    exitCode: result.exitCode,
    stdout,
    stderr,
    ...(errorCode ? { errorCode } : {}),
  };
}

export type OpenTofuFailureCode =
  | "provider_source_invalid"
  | "provider_package_unavailable"
  | "provider_platform_binary_unavailable"
  | "provider_protocol_mismatch"
  | "provider_policy_denied"
  | "runner_capability_missing"
  | "provider_checksum_mismatch"
  | "opentofu_init_failed"
  | "source_build_failed"
  | "opentofu_plan_failed";

export function classifyOpenTofuFailure(
  text: string,
  phase?: "init" | "plan" | "apply" | "runtime",
): OpenTofuFailureCode | undefined {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("is denied before opentofu init") ||
    normalized.includes("is not allowed before opentofu init") ||
    normalized.includes("provider is denied by policy")
  ) {
    return "provider_policy_denied";
  }
  if (
    normalized.includes("invalid provider source") ||
    normalized.includes("invalid provider address") ||
    normalized.includes("invalid provider registry host") ||
    normalized.includes("must have three slash-separated segments")
  ) {
    return "provider_source_invalid";
  }
  if (
    normalized.includes("does not have a package available for your current platform") ||
    normalized.includes("incompatible provider version") ||
    normalized.includes("no available releases match the given constraints for this platform")
  ) {
    return "provider_platform_binary_unavailable";
  }
  if (
    normalized.includes("incompatible api version with plugin") ||
    normalized.includes("unrecognized remote plugin message") ||
    normalized.includes("failed to instantiate provider") ||
    normalized.includes("incompatible provider api")
  ) {
    return "provider_protocol_mismatch";
  }
  if (
    normalized.includes("doesn't match the checksums") ||
    normalized.includes("does not match the checksum") ||
    normalized.includes("checksum list has no sha-256 hash") ||
    normalized.includes("failed to verify provider package")
  ) {
    return "provider_checksum_mismatch";
  }
  if (
    normalized.includes("failed to query available provider packages") ||
    normalized.includes("could not retrieve the list of available versions") ||
    (normalized.includes("provider registry") &&
      normalized.includes("does not have a provider named")) ||
    normalized.includes("provider package is not available")
  ) {
    return "provider_package_unavailable";
  }
  if (
    normalized.includes("runner capability") ||
    normalized.includes("no runner is configured") ||
    normalized.includes("runner profile") &&
      normalized.includes("requires") &&
      normalized.includes("capability")
  ) {
    return "runner_capability_missing";
  }
  if (
    phase === "runtime" &&
    (normalized.includes("source build") ||
      normalized.includes("sourcebuild output"))
  ) {
    return "source_build_failed";
  }
  if (phase === "init") return "opentofu_init_failed";
  if (phase === "plan") return "opentofu_plan_failed";
  return undefined;
}
