/**
 * `git` subprocess primitive for the installer (Deno implementation).
 *
 * This is the canonical Deno runtime path: it invokes `git` through
 * `Deno.Command` exactly as before. The npm build swaps this module for the
 * Node sibling (`git-runner.node.ts`) via a dnt `mappings` entry in
 * `scripts/build-npm.ts`, so the Deno runtime behaviour is unchanged and the
 * npm package runs the same git invocations through `node:child_process`.
 *
 * Keep the exported shape identical between the Deno and Node modules.
 */

export interface GitInvocationResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runGitCommand(
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
