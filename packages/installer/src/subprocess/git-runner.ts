/**
 * Installer-local default `git` capability (Deno implementation).
 *
 * This is the fallback `GitRunner` used when no runner is injected — for
 * example the installer's own standalone Deno tests. It invokes `git` through
 * `Deno.Command` exactly as before. The npm build swaps this module for the
 * Node sibling (`git-runner.node.ts`) via a dnt `mappings` entry in
 * `scripts/build-npm.ts`, so the Deno runtime behaviour is unchanged and the
 * npm package runs the same git invocations through `node:child_process`.
 *
 * In production the reference kernel injects a `GitRunner` routed through
 * `currentRuntime().subprocess`, so callers no longer reference `Deno.Command`
 * directly. Keep the exported shape identical between the Deno and Node
 * modules.
 */

import type {
  GitInvocationResult,
  GitRunner,
} from "@takos/takosumi-contract/reference/runtime-capability";

export type { GitInvocationResult };

async function runGitCommand(
  args: readonly string[],
  cwd?: string,
): Promise<GitInvocationResult> {
  const command = new Deno.Command("git", {
    args: [...args],
    cwd,
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

/**
 * Default `GitRunner` over the installer's Deno-runtime `git` primitive. Wraps
 * {@link runGitCommand} so the source fetcher consumes the injected
 * {@link GitRunner} interface without referencing `Deno.Command`.
 */
export const defaultGitRunner: GitRunner = {
  run(args, cwd) {
    return runGitCommand(args, cwd);
  },
};
