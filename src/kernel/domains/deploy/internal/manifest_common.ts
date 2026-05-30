// Small shape predicates and validators shared across the manifest compile,
// validate, and override-merge phases. Keeping them in one module avoids
// circular imports between the validation phase and the override-merge phase.

import type { PublicOutputSpec, PublicRouteSpec } from "../types.ts";

export const PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR =
  "authoring.public-manifest-expansion@v1";

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const IMAGE_DIGEST_PATTERN = /@sha256:[a-fA-F0-9]{64}$/;
export const HTTP_METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const item = value[field];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

export function assertKnownFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new TypeError(`${path} must not include '${field}'`);
    }
  }
}

export function validateStringRecord(
  value: unknown,
  path: string,
): asserts value is Record<string, string> | undefined {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be object`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new TypeError(`${path}.${key} must be string`);
    }
  }
}

export function normalizeEnvName(value: string, path: string): string {
  if (!ENV_NAME_PATTERN.test(value)) {
    throw new TypeError(`${path} must match [A-Za-z_][A-Za-z0-9_]*`);
  }
  return value.toUpperCase();
}

export function normalizedEnvNameSet(
  value: Record<string, string>,
  path: string,
): Set<string> {
  const names = new Set<string>();
  for (const name of Object.keys(value)) {
    const normalized = normalizeEnvName(name, path);
    if (names.has(normalized)) {
      throw new TypeError(`${path} contains duplicate env '${normalized}'`);
    }
    names.add(normalized);
  }
  return names;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0);
}

export function namedCollectionEntries<
  T extends { id?: string; name?: string },
>(
  value: Record<string, T> | T[],
  kind: "route" | "output",
): [string, T][] {
  return Array.isArray(value)
    ? value.map((item, index) => [arrayEntryName(item, kind, index), item])
    : Object.entries(value);
}

export function arrayEntryName(
  item: PublicRouteSpec | PublicOutputSpec,
  kind: "route" | "output",
  index: number,
): string {
  const explicitName = kind === "route"
    ? (item as PublicRouteSpec).id
    : (item as PublicOutputSpec).name;
  return typeof explicitName === "string" && explicitName.length > 0
    ? explicitName
    : `${kind}-${index + 1}`;
}

export function isSafeRepositoryRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.startsWith("\\")) {
    return false;
  }
  return !value.split(/[\\/]+/).some((part) => part === ".." || part === "");
}
