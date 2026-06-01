/**
 * Installer-local default `git` capability (runtime-detecting).
 *
 * This is the fallback `GitRunner` used when no runner is injected — for
 * example the installer's own standalone Deno tests. It runs `git` through
 * `Deno.Command` on Deno and through `node:child_process` on Node, selecting
 * the path at call time. No build-time module mapping is required.
 *
 * Runtime detection: {@link denoCommand} returns the genuine `Deno.Command`
 * constructor only when it is actually a function, so Node / Bun / Workers
 * select the Node path instead of mistaking a partial `globalThis.Deno` shape
 * for real Deno. The Deno API is reached through `globalThis.Deno` (not a bare
 * `declare const Deno` identifier) so the emitted npm code contains no unbound
 * `Deno.Command` reference.
 *
 * In production the reference kernel injects a `GitRunner` routed through
 * `currentRuntime().subprocess`, so callers no longer reference this fallback
 * at all.
 */

import { spawn } from "node:child_process";
import type {
  GitInvocationResult,
  GitRunner,
} from "takosumi-contract/reference/runtime-capability";

export type { GitInvocationResult };

type DenoCommandCtor = new (
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

/**
 * The genuine `Deno.Command` constructor, or `undefined` on Node / Bun /
 * Workers / partial compatibility globals that do not implement `Command`.
 * Reached through `globalThis` so the npm build emits no unbound `Deno`
 * identifier. Probing `Deno.Command === "function"` (a function only on real
 * Deno) is the reliable discriminator. It does NOT also gate on Node being
 * absent — Deno 2.x exposes a Node-compat `process.versions.node`, so such a
 * clause would reject real Deno.
 */
function denoCommand(): DenoCommandCtor | undefined {
  const deno = (globalThis as { Deno?: { Command?: unknown } }).Deno;
  if (typeof deno?.Command === "function") {
    return deno.Command as DenoCommandCtor;
  }
  return undefined;
}

async function runGitCommandDeno(
  Command: DenoCommandCtor,
  args: readonly string[],
  cwd?: string,
): Promise<GitInvocationResult> {
  const command = new Command("git", {
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
  const Command = denoCommand();
  return Command
    ? runGitCommandDeno(Command, args, cwd)
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
