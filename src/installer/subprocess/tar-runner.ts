/**
 * Installer-local default `tar` capability (runtime-detecting).
 *
 * This is the fallback `TarRunner` used when no runner is injected — for
 * example the installer's own standalone Deno tests. It runs `tar` through
 * `Deno.Command` on Deno and through `node:child_process` on Node, piping the
 * archive bytes to stdin and selecting the path at call time. No build-time
 * module mapping is required.
 *
 * Runtime detection: {@link denoCommand} returns the genuine `Deno.Command`
 * constructor only when it is actually a function, so Node / Bun / Workers
 * select the Node path instead of mistaking a partial `globalThis.Deno` shape
 * for real Deno. The Deno API is reached through `globalThis.Deno` (not a bare
 * `declare const Deno` identifier) so the emitted npm code contains no unbound
 * `Deno.Command` reference.
 *
 * In production the reference service injects a `TarRunner` routed through
 * `currentRuntime().subprocess`, so callers no longer reference this fallback.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import type { TarRunner } from "takosumi-contract/reference/runtime-capability";

type DenoCommandCtor = new (
  command: string,
  options?: {
    args?: readonly string[];
    stdin?: "piped" | "inherit" | "null";
    stdout?: "piped" | "inherit" | "null";
    stderr?: "piped" | "inherit" | "null";
    env?: Record<string, string>;
  },
) => {
  spawn(): {
    stdin: WritableStream<Uint8Array>;
    output(): Promise<{
      code: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }>;
  };
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

async function runTarCommandDeno(
  Command: DenoCommandCtor,
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  // Force a deterministic C locale so the `tar -tv` column format (mode,
  // owner, size, date, time, path) does not shift with the operator's
  // LANG / LC_TIME settings. Without this, locale-specific date / time
  // columns can introduce extra whitespace runs that confuse the column
  // parser.
  const child = new Command("tar", {
    args: [...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      LC_ALL: "C",
      LANG: "C",
    },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(stdin);
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(
      `tar ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

function runTarCommandNode(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Force a deterministic C locale so the `tar -tv` column format does not
    // shift with the operator's LANG / LC_TIME settings (matches the Deno
    // path).
    const child = spawn("tar", [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    child.stdout?.on("data", (chunk: Uint8Array) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      const decoder = new TextDecoder();
      if ((code ?? 0) !== 0) {
        reject(
          new Error(
            `tar ${args.join(" ")} failed: ${
              decoder.decode(concatChunks(stderrChunks))
            }`,
          ),
        );
        return;
      }
      resolve(decoder.decode(concatChunks(stdoutChunks)));
    });
    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function runTarCommand(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  const Command = denoCommand();
  return Command
    ? runTarCommandDeno(Command, args, stdin)
    : runTarCommandNode(args, stdin);
}

/**
 * Default `TarRunner` over the installer's runtime-detecting `tar` primitive.
 * Wraps {@link runTarCommand} so the prepared-source fetcher consumes the
 * injected {@link TarRunner} interface.
 */
export const defaultTarRunner: TarRunner = {
  run(args, stdin) {
    return runTarCommand(args, stdin);
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
