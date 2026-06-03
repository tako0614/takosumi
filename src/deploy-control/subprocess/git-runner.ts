/**
 * Deploy control local default `git` capability.
 *
 * This is the fallback `GitRunner` used when no runner is injected. It runs
 * `git` through `node:child_process`, which is available in Node and Bun.
 *
 * In production the reference service injects a `GitRunner` routed through
 * `currentRuntime().subprocess`, so callers no longer reference this fallback
 * at all.
 */

import { spawn } from "node:child_process";
import type {
  GitInvocationResult,
  GitRunner,
} from "takosumi-contract/reference/runtime-capability";

export type { GitInvocationResult };

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
  return runGitCommandNode(args, cwd);
}

/**
 * Default `GitRunner` over the deploy control runtime-detecting `git` primitive.
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
