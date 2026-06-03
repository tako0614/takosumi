import { mkdtemp, readFile as nodeReadFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export function readRuntimeEnv(name: string): string | undefined {
  return process.env[name];
}

export function setRuntimeEnv(name: string, value: string): void {
  process.env[name] = value;
}

export async function makeRuntimeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function removeRuntimePath(
  path: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  await rm(path, { recursive: options.recursive === true, force: true });
}

export async function readRuntimeFile(path: string): Promise<Uint8Array> {
  return await nodeReadFile(path);
}
