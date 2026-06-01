import { mkdtemp, readFile as nodeReadFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

interface DenoLike {
  readonly env?: {
    get(name: string): string | undefined;
    set(name: string, value: string): void;
  };
  makeTempDir(options?: { prefix?: string }): Promise<string>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
}

function denoLike(): DenoLike | undefined {
  const candidate = (globalThis as { Deno?: Partial<DenoLike> }).Deno;
  if (
    typeof candidate?.makeTempDir === "function" &&
    typeof candidate.remove === "function" &&
    typeof candidate.readFile === "function"
  ) {
    return candidate as DenoLike;
  }
  return undefined;
}

export function readRuntimeEnv(name: string): string | undefined {
  return process.env[name] ?? denoLike()?.env?.get(name);
}

export function setRuntimeEnv(name: string, value: string): void {
  process.env[name] = value;
  denoLike()?.env?.set(name, value);
}

export async function makeRuntimeTempDir(prefix: string): Promise<string> {
  const runtime = denoLike();
  if (runtime) return await runtime.makeTempDir({ prefix });
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function removeRuntimePath(
  path: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  const runtime = denoLike();
  if (runtime) {
    await runtime.remove(path, options);
    return;
  }
  await rm(path, { recursive: options.recursive === true, force: true });
}

export async function readRuntimeFile(path: string): Promise<Uint8Array> {
  const runtime = denoLike();
  if (runtime) return await runtime.readFile(path);
  return await nodeReadFile(path);
}
