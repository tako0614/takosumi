/**
 * Runtime primitives for the `migrate` command (Node implementation).
 *
 * dnt swaps `migrate-runtime.ts` (Deno) for this module in the npm output via
 * a `mappings` entry in `scripts/build-npm.ts`. The Deno runtime never loads
 * this file. The exported shape must match `migrate-runtime.ts` exactly.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";

export function spawnMigrate(
  cmd: string,
  args: readonly string[],
): Promise<{ readonly code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code: number | null) => resolve({ code: code ?? 0 }));
  });
}

export function statIsFile(path: string): boolean {
  return statSync(path).isFile();
}

export function readEnv(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" ? value : undefined;
}

export function exitProcess(code: number): never {
  process.exit(code);
  throw new Error(`exit(${code}) returned`);
}
