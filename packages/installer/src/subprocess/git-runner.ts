/**
 * Installer-local default `git` capability (runtime-detecting).
 *
 * This is the fallback `GitRunner` used when no runner is injected — for
 * example the installer's own standalone Deno tests. It runs `git` through
 * `Deno.Command` on Deno and through `node:child_process` on Node, selecting
 * the path at call time. No dnt module mapping is required: the local
 * `declare const Deno` type keeps the npm build typeable without referencing
 * the `@deno/shim-deno` surface, and the runtime check picks the Node path
 * where `globalThis.Deno` is absent.
 *
 * In production the reference kernel injects a `GitRunner` routed through
 * `currentRuntime().subprocess`, so callers no longer reference this fallback
 * at all.
 */

import { spawn } from "node:child_process";
import type {
  GitInvocationResult,
  GitRunner,
} from "@takos/takosumi-contract/reference/runtime-capability";

export type { GitInvocationResult };

declare const Deno: {
  Command: new (
    command: string,
    options?: {
      args?: readonly string[];
      cwd?: string;
      stdout?: "piped" | "inherit" | "null";
      stderr?: "piped" | "inherit" | "null";
    },
  ) => {
    output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
  };
};

function hasDeno(): boolean {
  return typeof (globalThis as { Deno?: unknown }).Deno !== "undefined";
}

async function runGitCommandDeno(
  args: readonly string[],
  cwd?: string,
): Promise<GitInvocationResult> {
  const command = new Deno.Command("git", {
    args: [...args],
    ...(cwd ? { cwd } : {}),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  return {
    ok: code === 0,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}

function runGitCommandNode(
  args: readonly string[],
  cwd?: string,
): Promise<GitInvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      ...(cwd ? { cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    child.stdout?.on("data", (chunk: Uint8Array) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      const decoder = new TextDecoder();
      resolve({
        ok: (code ?? 0) === 0,
        stdout: decoder.decode(concatChunks(stdoutChunks)),
        stderr: decoder.decode(concatChunks(stderrChunks)),
      });
    });
  });
}

function runGitCommand(
  args: readonly string[],
  cwd?: string,
): Promise<GitInvocationResult> {
  return hasDeno()
    ? runGitCommandDeno(args, cwd)
    : runGitCommandNode(args, cwd);
}

/**
 * Default `GitRunner` over the installer's runtime-detecting `git` primitive.
 * Wraps {@link runGitCommand} so the source fetcher consumes the injected
 * {@link GitRunner} interface.
 */
export const defaultGitRunner: GitRunner = {
  run(args, cwd) {
    return runGitCommand(args, cwd);
  },
};

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
