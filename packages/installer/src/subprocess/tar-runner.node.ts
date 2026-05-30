/**
 * Installer-local default `tar` capability (Node implementation).
 *
 * dnt swaps `tar-runner.ts` (Deno) for this module in the npm output via a
 * `mappings` entry in `scripts/build-npm.ts`. The Deno runtime never loads
 * this file. The exported shape must match `tar-runner.ts` exactly.
 */

import { spawn } from "node:child_process";
import type { TarRunner } from "@takos/takosumi-contract/reference/runtime-capability";

function runTarCommand(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Force a deterministic C locale so the `tar -tv` column format does not
    // shift with the operator's LANG / LC_TIME settings (matches the Deno
    // implementation).
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

/**
 * Default `TarRunner` over the installer's Node-runtime `tar` primitive. Wraps
 * {@link runTarCommand} so the prepared-source fetcher consumes the injected
 * {@link TarRunner} interface.
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
