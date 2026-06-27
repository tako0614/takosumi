// runner/lib/util.ts
//
// Generic helpers: JSON-shape guards, digests, path-safety, run-id, fs probes.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  OpenTofuRunAction,
  JsonRecord,
} from "./types.ts";
export async function shredCredentialDir(credentialDir: string): Promise<void> {
  await rm(credentialDir, { recursive: true, force: true }).catch(() => {});
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export async function digestPathIfExists(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  return await digestPath(path, path);
}

export async function digestPath(path: string, root: string): Promise<string> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    return await digestBytes(await readFile(path));
  }
  const entries = await readdir(path, { withFileTypes: true });
  const childDigests: Array<{ path: string; digest: string }> = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = join(path, entry.name);
    if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    childDigests.push({
      path: child.slice(root.length + 1),
      digest: await digestPath(child, root),
    });
  }
  return await digestBytes(
    new TextEncoder().encode(JSON.stringify(childDigests)),
  );
}

export async function digestFileIfExists(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  return await digestBytes(await readFile(path));
}

export function resolveModulePath(
  sourceRoot: string,
  modulePath: string | undefined,
): string {
  const moduleDir = resolve(sourceRoot, modulePath ?? ".");
  const normalizedRoot = resolve(sourceRoot);
  if (
    moduleDir !== normalizedRoot &&
    !moduleDir.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error("source.modulePath must stay inside source root");
  }
  return moduleDir;
}

export function assertPathInsideRoot(root: string, path: string, label: string): void {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (
    normalizedPath !== normalizedRoot &&
    !normalizedPath.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error(`${label} must stay inside source root`);
  }
}

export function safeRunId(runId: string): string {
  const sanitized = runId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  // Defense-in-depth: the charset above permits `.`, so a runId that is exactly
  // `.`/`..` or contains a `..` path segment could let the workspace path escape
  // its RUN_ROOT jail. Neutralize any dot-only path segment so `join(RUN_ROOT, …)`
  // can never resolve outside the jail.
  const guarded = sanitized
    .split("/")
    .map((segment) => (segment === "." || segment === ".." ? "_" : segment))
    .join("/");
  return guarded === "." || guarded === ".." ? "_" : guarded;
}

export function recordField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

export function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

export function providerMatches(provider: string, rule: string): boolean {
  return provider === rule || provider.endsWith(`/${rule}`);
}

export function stringField(value: unknown, key: string): string | undefined {
  const field = recordField(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

export function requiredStringField(value: unknown, key: string): string {
  const field = stringField(value, key);
  if (!field) throw new Error(`${key} is required`);
  return field;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function assertDirectory(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

export async function assertRealPathInsideSourceRoot(
  path: string,
  sourceRoot: string,
  label: string,
): Promise<void> {
  const [realTarget, realRoot] = await Promise.all([
    realpath(path),
    realpath(sourceRoot),
  ]);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    throw new Error(
      `${label} must stay inside source root after symlink resolution`,
    );
  }
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("request body must be a JSON object");
}

export function parseAction(value: unknown): OpenTofuRunAction | undefined {
  if (
    value === "plan" ||
    value === "apply" ||
    value === "destroy" ||
    value === "compatibility_check" ||
    value === "backup" ||
    value === "release"
  ) {
    return value;
  }
  return undefined;
}

export async function digestBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    arrayBufferFromBytes(data),
  );
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
