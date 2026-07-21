/** Portable, data-only Takoform Capsule Composition Manifest reader. */

export const CAPSULE_COMPOSITION_API_VERSION =
  "compositions.takoform.com/v1alpha1" as const;
export const CAPSULE_COMPOSITION_KIND = "CapsuleComposition" as const;

export interface CapsuleCompositionManifest {
  readonly apiVersion: typeof CAPSULE_COMPOSITION_API_VERSION;
  readonly kind: typeof CAPSULE_COMPOSITION_KIND;
  readonly metadata: {
    readonly name: string;
    readonly version: string;
    readonly title: string;
    readonly description?: string;
  };
  readonly components: readonly CapsuleCompositionComponent[];
  readonly connections?: readonly CapsuleCompositionConnection[];
}

export interface CapsuleCompositionComponent {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly source: {
    readonly url: string;
    readonly ref: string;
    readonly path: string;
  };
}

export interface CapsuleCompositionConnection {
  readonly from: CapsuleCompositionEndpoint;
  readonly to: CapsuleCompositionEndpoint;
}

export interface CapsuleCompositionEndpoint {
  readonly component: string;
  readonly interface: string;
}

export interface CompositionSourceSelector {
  readonly git: string;
  readonly ref: string;
  /** File path within the pinned Git SourceSnapshot, not a module path. */
  readonly path: string;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/u;
const VERSION_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const INTERFACE_RE = /^[a-z][a-z0-9._-]{0,127}$/u;
export function parseCompositionInstallLink(
  search: string,
): CompositionSourceSelector | undefined {
  const params = new URLSearchParams(search);
  if (params.get("kind") !== "composition") return undefined;
  const git = params.get("git")?.trim();
  const ref = params.get("ref")?.trim();
  const path = params.get("path")?.trim();
  if (
    !git ||
    !isSafeGitUrl(git) ||
    !ref ||
    ref.length > 128 ||
    /[\r\n\0]/u.test(ref) ||
    !path ||
    !isSafeManifestPath(path)
  )
    return undefined;
  return { git, ref, path };
}

export function hasCompositionInstallLink(search: string): boolean {
  return new URLSearchParams(search).get("kind") === "composition";
}

export async function parseCompositionManifestText(text: string): Promise<{
  readonly manifest: CapsuleCompositionManifest;
  readonly digest: string;
}> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Composition manifest is not valid JSON");
  }
  const manifest = parseCompositionManifest(value);
  const digest = await digestCanonicalManifest(manifest);
  return { manifest, digest };
}

export function parseCompositionManifest(
  value: unknown,
): CapsuleCompositionManifest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "apiVersion",
      "kind",
      "metadata",
      "components",
      "connections",
    ])
  )
    throw new Error("Composition manifest must be a closed object");
  if (
    value.apiVersion !== CAPSULE_COMPOSITION_API_VERSION ||
    value.kind !== CAPSULE_COMPOSITION_KIND
  )
    throw new Error(
      "Composition manifest has an unsupported apiVersion or kind",
    );
  const metadata = parseMetadata(value.metadata);
  if (
    !Array.isArray(value.components) ||
    value.components.length < 1 ||
    value.components.length > 32
  )
    throw new Error(
      "Composition manifest must contain between 1 and 32 components",
    );
  const components = value.components.map(parseComponent);
  const ids = new Set<string>();
  for (const component of components) {
    if (ids.has(component.id))
      throw new Error(
        `Composition contains duplicate component ${component.id}`,
      );
    ids.add(component.id);
  }
  const connections =
    value.connections === undefined
      ? undefined
      : parseConnections(value.connections, ids);
  return {
    apiVersion: CAPSULE_COMPOSITION_API_VERSION,
    kind: CAPSULE_COMPOSITION_KIND,
    metadata,
    components,
    ...(connections ? { connections } : {}),
  };
}

async function digestCanonicalManifest(
  manifest: CapsuleCompositionManifest,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseMetadata(value: unknown): CapsuleCompositionManifest["metadata"] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["name", "version", "title", "description"])
  )
    throw new Error("Composition metadata must be a closed object");
  if (
    !isString(value.name) ||
    !NAME_RE.test(value.name) ||
    !isString(value.version) ||
    !VERSION_RE.test(value.version) ||
    !isString(value.title) ||
    !value.title.trim()
  )
    throw new Error("Composition metadata is invalid");
  if (value.description !== undefined && !isString(value.description))
    throw new Error("Composition metadata description is invalid");
  return {
    name: value.name,
    version: value.version,
    title: value.title,
    ...(value.description ? { description: value.description } : {}),
  };
}

function parseComponent(value: unknown): CapsuleCompositionComponent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "title", "description", "source"])
  )
    throw new Error("Composition component must be a closed object");
  if (
    !isString(value.id) ||
    !NAME_RE.test(value.id) ||
    !isString(value.title) ||
    !value.title.trim()
  )
    throw new Error("Composition component identity is invalid");
  if (value.description !== undefined && !isString(value.description))
    throw new Error("Composition component description is invalid");
  const source = parseSource(value.source);
  return {
    id: value.id,
    title: value.title,
    ...(value.description ? { description: value.description } : {}),
    source,
  };
}

function parseSource(value: unknown): CapsuleCompositionComponent["source"] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["url", "ref", "path"]) ||
    !isString(value.url) ||
    !isSafeGitUrl(value.url) ||
    !isString(value.ref) ||
    !value.ref.trim() ||
    value.ref.length > 128 ||
    /[\r\n\0]/u.test(value.ref) ||
    !isString(value.path) ||
    !isSafeModulePath(value.path)
  )
    throw new Error("Composition component source is invalid");
  return { url: value.url, ref: value.ref, path: value.path };
}

function parseConnections(
  value: unknown,
  ids: ReadonlySet<string>,
): readonly CapsuleCompositionConnection[] {
  if (!Array.isArray(value))
    throw new Error("Composition connections must be an array");
  return value.map((connection) => {
    if (!isRecord(connection) || !hasOnlyKeys(connection, ["from", "to"]))
      throw new Error("Composition connection must be a closed object");
    const from = parseEndpoint(connection.from, ids);
    const to = parseEndpoint(connection.to, ids);
    if (from.component === to.component)
      throw new Error("Composition connections must span distinct components");
    return { from, to };
  });
}

function parseEndpoint(
  value: unknown,
  ids: ReadonlySet<string>,
): CapsuleCompositionEndpoint {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["component", "interface"]) ||
    !isString(value.component) ||
    !ids.has(value.component) ||
    !isString(value.interface) ||
    !INTERFACE_RE.test(value.interface)
  )
    throw new Error("Composition connection endpoint is invalid");
  return { component: value.component, interface: value.interface };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  throw new Error("Composition manifest contains an unsupported JSON value");
}

function isSafeGitUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.host) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isSafeManifestPath(value: string): boolean {
  return isSafeModulePath(value) && value.endsWith(".json");
}

function isSafeModulePath(value: string): boolean {
  return (
    Boolean(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value !== ".." &&
    !value.startsWith("../") &&
    !value.split("/").includes("..")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
