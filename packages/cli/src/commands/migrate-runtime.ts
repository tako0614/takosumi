/**
 * Runtime primitives for the `migrate` command (Deno implementation).
 *
 * Canonical Deno runtime path: spawns the kernel migration script through
 * `Deno.Command`, resolves the script path with `Deno.statSync`, reads env
 * with `Deno.env`, and exits with `Deno.exit`, exactly as before. The npm
 * build swaps this module for the Node sibling (`migrate-runtime.node.ts`)
 * via a dnt `mappings` entry in `scripts/build-npm.ts`, so the Deno runtime
 * behaviour is unchanged while the npm CLI runs on Node. Keep the exported
 * shape identical between the two modules.
 */

export async function spawnMigrate(
  cmd: string,
  args: readonly string[],
): Promise<{ readonly code: number }> {
  const out = await new Deno.Command(cmd, { args: [...args] }).output();
  return { code: out.code };
}

export function statIsFile(path: string): boolean {
  return Deno.statSync(path).isFile;
}

export function readEnv(key: string): string | undefined {
  return Deno.env.get(key);
}

export function exitProcess(code: number): never {
  return Deno.exit(code);
}
