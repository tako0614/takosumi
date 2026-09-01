// runner/lib/exec.ts
//
// Subprocess execution + OpenTofu plan/output readers.
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
    { cwd: moduleDir, context },
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

export async function runCommand(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly context?: CommandContext;
    /**
     * Runs the command in its own process group and kills the whole group once
     * it returns. Source-build commands are user-supplied and run before the
     * run's provider credentials are written to disk, so a descendant left
     * behind by a build command would still be alive — as the same uid — while
     * those credential files exist.
     */
    readonly isolateProcessGroup?: boolean;
    /**
     * Receives stdout as it arrives, in addition to the buffered return. Used
     * by the apply lane to track live resource progress without changing the
     * command, its output, or the buffered result any other caller sees.
     */
    readonly onStdoutChunk?: (chunk: string) => void;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let timedOut = false;
  const isolate = options.isolateProcessGroup === true;
  const subprocess = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.context?.env ?? baseCommandEnv(),
    stdout: "pipe",
    stderr: "pipe",
    ...(isolate ? { detached: true } : {}),
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.context?.timeoutMs;
  const exited =
    timeoutMs && timeoutMs > 0
      ? Promise.race([
          subprocess.exited,
          new Promise<number>((resolve) => {
            timeout = setTimeout(() => {
              timedOut = true;
              if (isolate) killProcessGroup(subprocess.pid);
              subprocess.kill();
              resolve(124);
            }, timeoutMs);
          }),
        ])
      : subprocess.exited;
  // Reaping the group as soon as the direct child is done also closes the
  // inherited stdout/stderr pipes, so a surviving descendant cannot hold the
  // output readers open.
  const exit = isolate
    ? exited.then((code) => {
        killProcessGroup(subprocess.pid);
        return code;
      })
    : exited;
  const [stdout, stderr, exitCode] = await Promise.all([
    options.onStdoutChunk
      ? readStreamText(subprocess.stdout, options.onStdoutChunk)
      : new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    exit,
  ]);
  if (timeout) clearTimeout(timeout);
  return {
    exitCode,
    stdout,
    stderr: timedOut
      ? [stderr, `command timed out after ${timeoutMs}ms: ${command[0]}`]
          .filter(Boolean)
          .join("\n")
      : stderr,
  };
}

/**
 * Buffers a stream to text exactly like `Response.text()` while handing each
 * decoded chunk to `onChunk` as it arrives. An observer that throws must not
 * break the command, so its failures are swallowed.
 */
async function readStreamText(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = decoder.decode(next.value, { stream: true });
      if (chunk.length === 0) continue;
      text += chunk;
      try {
        onChunk(chunk);
      } catch {
        // Progress observation is best-effort; never fail the command for it.
      }
    }
  } finally {
    reader.releaseLock();
  }
  const tail = decoder.decode();
  if (tail.length > 0) {
    text += tail;
    try {
      onChunk(tail);
    } catch {
      // Same: observation failures never reach the caller.
    }
  }
  return text;
}

/** SIGKILLs a whole process group; an already-empty group is not an error. */
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
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
  | "opentofu_init_failed";

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
  return phase === "init" ? "opentofu_init_failed" : undefined;
}
