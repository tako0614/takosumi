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
  options: { readonly cwd: string; readonly context?: CommandContext },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let timedOut = false;
  const subprocess = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.context?.env ?? baseCommandEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.context?.timeoutMs;
  const exit =
    timeoutMs && timeoutMs > 0
      ? Promise.race([
          subprocess.exited,
          new Promise<number>((resolve) => {
            timeout = setTimeout(() => {
              timedOut = true;
              subprocess.kill();
              resolve(124);
            }, timeoutMs);
          }),
        ])
      : subprocess.exited;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
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

export function commandFailurePayload(
  runId: string,
  action: OpenTofuRunAction,
  result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  context?: CommandContext,
): JsonRecord {
  return {
    runId,
    action,
    status: "failed",
    exitCode: result.exitCode,
    stdout: redactRunnerOutput(result.stdout, context?.redactionValues),
    stderr: redactRunnerOutput(result.stderr, context?.redactionValues),
  };
}
