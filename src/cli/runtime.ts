import { currentRuntime, type Signal } from "../service/shared/runtime/index.ts";

export function readEnv(name: string): string | undefined {
  return currentRuntime().env.get(name);
}

export function setEnv(name: string, value: string): void {
  currentRuntime().env.set(name, value);
}

export async function readTextFile(path: string): Promise<string> {
  return await currentRuntime().fs.readTextFile(path);
}

export async function readFile(path: string): Promise<Uint8Array> {
  return await currentRuntime().fs.readFile(path);
}

export async function writeTextFile(
  path: string,
  content: string,
): Promise<void> {
  await currentRuntime().fs.writeTextFile(path, content);
}

export function isNotFoundError(error: unknown): boolean {
  return currentRuntime().fs.isNotFoundError(error);
}

export function exitCli(code: number): never {
  return currentRuntime().exit(code);
}

export function onCliSignal(signal: Signal, handler: () => void): void {
  currentRuntime().onSignal(signal, handler);
}
