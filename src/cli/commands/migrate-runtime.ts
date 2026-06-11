/**
 * Runtime primitives for the `migrate` command.
 *
 * These route through the Takosumi service `RuntimeAdapter`
 * (`src/service/shared/runtime`) instead of touching host globals directly,
 * so the same source runs unchanged on Bun, Node, and the compatibility
 * adapters. No module mapping is required: adapter selection is the
 * runtime-neutral boundary.
 */

import { currentRuntime } from "../../../core/shared/runtime/index.ts";

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
  // sync file stat gate used to locate the service migration script.
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
