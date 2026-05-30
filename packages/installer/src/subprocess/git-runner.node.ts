/**
 * Installer-local default `git` capability (Node implementation).
 *
 * dnt swaps `git-runner.ts` (Deno) for this module in the npm output via a
 * `mappings` entry in `scripts/build-npm.ts`. The Deno runtime never loads
 * this file. The exported shape must match `git-runner.ts` exactly so callers
 * are unchanged across runtimes.
 */

import { spawn } from "node:child_process";
import type {
  GitInvocationResult,
  GitRunner,
} from "@takos/takosumi-contract/reference/runtime-capability";

export type { GitInvocationResult };

function runGitCommand(
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

/**
 * Default `GitRunner` over the installer's Node-runtime `git` primitive. Wraps
 * {@link runGitCommand} so the source fetcher consumes the injected
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
