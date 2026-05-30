/**
 * Installer-local default `tar` capability (Deno implementation).
 *
 * This is the fallback `TarRunner` used when no runner is injected — for
 * example the installer's own standalone Deno tests. It invokes `tar` through
 * `Deno.Command` exactly as before, piping the archive bytes to stdin. The npm
 * build swaps this module for the Node sibling (`tar-runner.node.ts`) via a dnt
 * `mappings` entry in `scripts/build-npm.ts`. In production the reference
 * kernel injects a `TarRunner` routed through `currentRuntime().subprocess`, so
 * callers no longer reference `Deno.Command` directly. Keep the exported shape
 * identical between the two modules.
 */

import type { TarRunner } from "@takos/takosumi-contract/reference/runtime-capability";

async function runTarCommand(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  // Force a deterministic C locale so the `tar -tv` column format (mode,
  // owner, size, date, time, path) does not shift with the operator's
  // LANG / LC_TIME settings. Without this, locale-specific date / time
  // columns can introduce extra whitespace runs that confuse the column
  // parser.
  const child = new Deno.Command("tar", {
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

/**
 * Default `TarRunner` over the installer's Deno-runtime `tar` primitive. Wraps
 * {@link runTarCommand} so the prepared-source fetcher consumes the injected
 * {@link TarRunner} interface without referencing `Deno.Command`.
 */
export const defaultTarRunner: TarRunner = {
  run(args, stdin) {
    return runTarCommand(args, stdin);
  },
};
