/**
 * Runtime primitives for the `migrate` command.
 *
 * These route through the kernel `RuntimeAdapter`
 * (`@takos/takosumi-kernel/runtime`) instead of touching `Deno.*` directly,
 * so the same source runs unchanged on Deno (`currentRuntime()` resolves the
 * Deno adapter: `Deno.Command` / `Deno.statSync`-equivalent / `Deno.env` /
 * `Deno.exit`) and on the npm/Node build (the Node adapter resolves
 * `node:child_process` / `node:fs` / `process.*`). No dnt module mapping is
 * required: the adapter selection is the runtime-neutral boundary.
 */

import { currentRuntime } from "@takos/takosumi-kernel/runtime";

export async function spawnMigrate(
  cmd: string,
  args: readonly string[],
): Promise<{ readonly code: number }> {
  const out = await currentRuntime().subprocess.run(cmd, { args });
  return { code: out.code };
}

export function statIsFile(path: string): boolean {
  // The adapter has no sync `stat`, but `readTextFileSync` throws a
  // NotFound-classified error when the path is absent and a different error
  // (e.g. EISDIR) for directories. Treat a successful read as "regular file
  // present" and any failure as "not a usable file", matching the prior
  // `Deno.statSync(path).isFile` gate used to locate the kernel migration
  // script.
  try {
    currentRuntime().fs.readTextFileSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readEnv(key: string): string | undefined {
  return currentRuntime().env.get(key);
}

export function exitProcess(code: number): never {
  return currentRuntime().exit(code);
}
