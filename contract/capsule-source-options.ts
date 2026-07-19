/**
 * Optional, public install-link document for choosing one ordinary Git Capsule
 * source. This is presentation data only: it is not a Takosumi source manifest,
 * a composition/dependency graph, or install authority. A selected option is
 * handed to the normal `/new` flow where source auth, compatibility review,
 * Provider Bindings, plan, and apply remain authoritative.
 */

export const CAPSULE_SOURCE_OPTIONS_API_VERSION =
  "install.takosumi.com/v1alpha1" as const;
export const CAPSULE_SOURCE_OPTIONS_KIND = "CapsuleSourceOptions" as const;
export const CAPSULE_SOURCE_OPTIONS_INSTALL_KIND =
  "capsule-source-options" as const;
export const CAPSULE_SOURCE_OPTIONS_MAX_BYTES = 128 * 1024;
export const CAPSULE_SOURCE_OPTIONS_MAX_OPTIONS = 32;

export interface CapsuleSourceOptionSource {
  readonly url: string;
  readonly ref?: string;
  readonly path: string;
}

export interface CapsuleSourceOption {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly source: CapsuleSourceOptionSource;
}

export interface CapsuleSourceOptions {
  readonly apiVersion: typeof CAPSULE_SOURCE_OPTIONS_API_VERSION;
  readonly kind: typeof CAPSULE_SOURCE_OPTIONS_KIND;
  readonly metadata: {
    readonly name: string;
    readonly title: string;
    readonly description?: string;
  };
  readonly options: readonly CapsuleSourceOption[];
}

export interface CapsuleSourceOptionsInstallLink {
  readonly git: string;
  readonly path: string;
  readonly ref?: string;
}

export type CapsuleSourceOptionsParseResult =
  | { readonly ok: true; readonly document: CapsuleSourceOptions }
  | { readonly ok: false; readonly error: string };

export function parseCapsuleSourceOptionsText(
  text: string,
): CapsuleSourceOptionsParseResult {
  if (
    new TextEncoder().encode(text).byteLength > CAPSULE_SOURCE_OPTIONS_MAX_BYTES
  ) {
    return { ok: false, error: "CapsuleSourceOptions exceeds 128 KiB" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "CapsuleSourceOptions must be valid JSON" };
  }
  if (!isPlainRecord(value)) return invalid("document must be an object");
  const rootKeys = exactKeys(value, [
    "apiVersion",
    "kind",
    "metadata",
    "options",
  ]);
  if (rootKeys) return invalid(rootKeys);
  if (value.apiVersion !== CAPSULE_SOURCE_OPTIONS_API_VERSION) {
    return invalid(`apiVersion must be ${CAPSULE_SOURCE_OPTIONS_API_VERSION}`);
  }
  if (value.kind !== CAPSULE_SOURCE_OPTIONS_KIND) {
    return invalid(`kind must be ${CAPSULE_SOURCE_OPTIONS_KIND}`);
  }
  const metadata = parseMetadata(value.metadata);
  if (typeof metadata === "string") return invalid(metadata);
  if (!Array.isArray(value.options)) return invalid("options must be an array");
  if (
    value.options.length < 1 ||
    value.options.length > CAPSULE_SOURCE_OPTIONS_MAX_OPTIONS
  ) {
    return invalid("options must contain between 1 and 32 entries");
  }
  const ids = new Set<string>();
  const options: CapsuleSourceOption[] = [];
  for (let index = 0; index < value.options.length; index += 1) {
    const option = parseOption(value.options[index], index);
    if (typeof option === "string") return invalid(option);
    if (ids.has(option.id))
      return invalid(`options[${index}].id must be unique`);
    ids.add(option.id);
    options.push(option);
  }
  return {
    ok: true,
    document: {
      apiVersion: CAPSULE_SOURCE_OPTIONS_API_VERSION,
      kind: CAPSULE_SOURCE_OPTIONS_KIND,
      metadata,
      options,
    },
  };
}

export function parseCapsuleSourceOptionsInstallLink(
  search: string,
): CapsuleSourceOptionsInstallLink | undefined {
  const params = new URLSearchParams(search);
  if (params.get("kind") !== CAPSULE_SOURCE_OPTIONS_INSTALL_KIND)
    return undefined;
  const git = params.get("git")?.trim() ?? "";
  const path = normalizeRelativePath(params.get("path") ?? "");
  const ref = optionalSelector(params.get("ref"));
  if (
    !isSafeHttpsGitUrl(git) ||
    !path ||
    !path.toLowerCase().endsWith(".json")
  ) {
    return undefined;
  }
  if (params.has("ref") && !ref) return undefined;
  return { git, path, ...(ref ? { ref } : {}) };
}

export function hasCapsuleSourceOptionsInstallLink(search: string): boolean {
  return (
    new URLSearchParams(search).get("kind") ===
    CAPSULE_SOURCE_OPTIONS_INSTALL_KIND
  );
}

export function capsuleSourceOptionInstallSearch(
  option: CapsuleSourceOption,
  resolvedRef?: string,
): string {
  const params = new URLSearchParams({
    git: option.source.url,
    ref: option.source.ref ?? resolvedRef ?? "",
    path: option.source.path === "." ? "" : option.source.path,
    name: option.title,
  });
  return `?${params.toString()}`;
}

function parseMetadata(
  value: unknown,
): CapsuleSourceOptions["metadata"] | string {
  if (!isPlainRecord(value)) return "metadata must be an object";
  const keys = exactKeys(value, ["name", "title", "description"]);
  if (keys) return `metadata.${keys}`;
  const name = boundedString(value.name, 1, 96);
  const title = boundedString(value.title, 1, 160);
  const description = optionalBoundedString(value.description, 1, 2_000);
  if (!name || !/^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u.test(name)) {
    return "metadata.name must be a lowercase stable identifier";
  }
  if (!title) return "metadata.title must be a non-empty string";
  if (value.description !== undefined && !description) {
    return "metadata.description must be a non-empty bounded string";
  }
  return { name, title, ...(description ? { description } : {}) };
}

function parseOption(
  value: unknown,
  index: number,
): CapsuleSourceOption | string {
  const prefix = `options[${index}]`;
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, ["id", "title", "description", "source"]);
  if (keys) return `${prefix}.${keys}`;
  const id = boundedString(value.id, 1, 96);
  const title = boundedString(value.title, 1, 160);
  const description = optionalBoundedString(value.description, 1, 2_000);
  if (!id || !/^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u.test(id)) {
    return `${prefix}.id must be a lowercase stable identifier`;
  }
  if (!title) return `${prefix}.title must be a non-empty string`;
  if (value.description !== undefined && !description) {
    return `${prefix}.description must be a non-empty bounded string`;
  }
  const source = parseSource(value.source, prefix);
  if (typeof source === "string") return source;
  return { id, title, ...(description ? { description } : {}), source };
}

function parseSource(
  value: unknown,
  prefix: string,
): CapsuleSourceOptionSource | string {
  if (!isPlainRecord(value)) return `${prefix}.source must be an object`;
  const keys = exactKeys(value, ["url", "ref", "path"]);
  if (keys) return `${prefix}.source.${keys}`;
  const url = boundedString(value.url, 1, 2_048);
  const path = normalizeRelativePath(value.path);
  const ref = optionalSelector(value.ref);
  if (!url || !isSafeHttpsGitUrl(url)) {
    return `${prefix}.source.url must be an HTTPS Git URL without embedded credentials`;
  }
  if (!path) return `${prefix}.source.path must be a safe relative module path`;
  if (value.ref !== undefined && !ref) {
    return `${prefix}.source.ref must be a safe bounded Git ref`;
  }
  return { url, path, ...(ref ? { ref } : {}) };
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  return unexpected ? `contains unsupported field ${unexpected}` : undefined;
}

function boundedString(
  value: unknown,
  min: number,
  max: number,
): string | undefined {
  if (typeof value !== "string" || /[\r\n\0]/u.test(value)) return undefined;
  const result = value.trim();
  return result.length >= min && result.length <= max ? result : undefined;
}

function optionalBoundedString(
  value: unknown,
  min: number,
  max: number,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, min, max);
}

function optionalSelector(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const selector = boundedString(value, 1, 256);
  return selector && !selector.startsWith("-") ? selector : undefined;
}

function normalizeRelativePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    /[\r\n\0\\]/u.test(value)
  ) {
    return undefined;
  }
  const input = value.trim();
  if (input.startsWith("/") || /^[A-Za-z]:/u.test(input)) return undefined;
  const raw = input.replace(/^\.\/+|\/+$/gu, "");
  if (!raw || raw === ".") return ".";
  const segments = raw.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments.join("/");
}

function isSafeHttpsGitUrl(raw: string): boolean {
  if (/[\s\0]/u.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(error: string): CapsuleSourceOptionsParseResult {
  return { ok: false, error };
}
