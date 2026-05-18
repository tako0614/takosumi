/**
 * `.takosumi.yml` (AppSpec) parser.
 *
 * Reads YAML bytes and returns a validated `AppSpec`. Throws
 * `AppSpecParseError` with `validationPhase` / `validationPath` on
 * syntax / schema violations.
 *
 * Phase B: the public AppSpec contract uses the namespace pub/sub model.
 * Components declare what they `publish` to the namespace registry and
 * which paths they `listen` to. The prior `use:` edge model is removed;
 * encountering `use:` is rejected with `AppSpecParseError`.
 */

import { parse as parseYaml } from "jsr:@std/yaml@^1.0.5";
import {
  APP_SPEC_API_VERSION,
  APP_SPEC_KIND,
  type AppSpec,
  type Component,
  COMPONENT_KINDS,
  type ComponentKindRef,
  isComponentKind,
  isKindUri,
  type ListenOptions,
  type NamespacePath,
} from "@takos/takosumi-contract/app-spec";

const ROOT_KEYS = new Set([
  "apiVersion",
  "kind",
  "metadata",
  "components",
  "interfaces",
  "permissions",
]);

const METADATA_KEYS = new Set([
  "id",
  "name",
  "description",
  "publisher",
  "homepage",
]);

const COMPONENT_KEYS = new Set([
  "kind",
  "build",
  "publish",
  "listen",
  "routes",
  "spec",
  "name",
  "target",
]);

const BUILD_KEYS = new Set(["command", "output"]);
const LISTEN_OPTIONS_KEYS = new Set(["as", "prefix", "mount"]);
const INTERFACE_KEYS = new Set(["target", "path", "required"]);

/**
 * Built-in {@link ListenOptions} `as` values the parser knows about. The
 * parser still accepts arbitrary non-empty strings so operator-defined
 * material shapes are forward-compatible — this set is documentary.
 */
const KNOWN_LISTEN_SHAPES: ReadonlySet<string> = new Set([
  "env",
  "mount",
  "target",
]);

export type ValidationPhase =
  | "syntax"
  | "schema"
  | "publish-listen"
  | "kind-catalog"
  | "legacy-use";

export class AppSpecParseError extends Error {
  readonly validationPhase: ValidationPhase;
  readonly validationPath: string;

  constructor(
    message: string,
    validationPhase: ValidationPhase,
    validationPath: string,
  ) {
    super(message);
    this.name = "AppSpecParseError";
    this.validationPhase = validationPhase;
    this.validationPath = validationPath;
  }
}

export function parseAppSpec(yamlBytes: string | Uint8Array): AppSpec {
  const text = typeof yamlBytes === "string"
    ? yamlBytes
    : new TextDecoder().decode(yamlBytes);

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new AppSpecParseError(
      `YAML syntax error: ${cause}`,
      "syntax",
      "$",
    );
  }

  return validateAppSpec(raw);
}

function validateAppSpec(raw: unknown): AppSpec {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      "AppSpec must be a YAML mapping",
      "schema",
      "$",
    );
  }

  const root = raw as Record<string, unknown>;
  rejectUnknownKeys(root, ROOT_KEYS, "$");

  if (root.apiVersion !== APP_SPEC_API_VERSION) {
    throw new AppSpecParseError(
      `apiVersion must be "${APP_SPEC_API_VERSION}", got ${
        JSON.stringify(root.apiVersion)
      }`,
      "schema",
      "$.apiVersion",
    );
  }

  if (root.kind !== APP_SPEC_KIND) {
    throw new AppSpecParseError(
      `kind must be "${APP_SPEC_KIND}", got ${JSON.stringify(root.kind)}`,
      "schema",
      "$.kind",
    );
  }

  const metadata = validateMetadata(root.metadata);
  const components = validateComponents(root.components);
  validatePublishListenGraph(components);

  const interfaces = root.interfaces === undefined
    ? undefined
    : validateInterfaces(root.interfaces);
  const permissions = root.permissions === undefined
    ? undefined
    : validatePermissions(root.permissions);

  return {
    apiVersion: APP_SPEC_API_VERSION,
    kind: APP_SPEC_KIND,
    metadata,
    components,
    interfaces,
    permissions,
  };
}

function validateMetadata(raw: unknown): AppSpec["metadata"] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      "metadata must be a mapping",
      "schema",
      "$.metadata",
    );
  }
  const m = raw as Record<string, unknown>;
  rejectUnknownKeys(m, METADATA_KEYS, "$.metadata");
  requireString(m.id, "$.metadata.id");
  requireString(m.name, "$.metadata.name");
  if (m.description !== undefined) {
    requireString(m.description, "$.metadata.description");
  }
  if (m.publisher !== undefined) {
    requireString(m.publisher, "$.metadata.publisher");
  }
  if (m.homepage !== undefined) {
    requireString(m.homepage, "$.metadata.homepage");
  }
  return {
    id: m.id as string,
    name: m.name as string,
    description: m.description as string | undefined,
    publisher: m.publisher as string | undefined,
    homepage: m.homepage as string | undefined,
  };
}

function validateComponents(
  raw: unknown,
): Readonly<Record<string, Component>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      "components must be a mapping",
      "schema",
      "$.components",
    );
  }
  const result: Record<string, Component> = {};
  for (const [name, value] of Object.entries(raw)) {
    result[name] = validateComponent(name, value);
  }
  if (Object.keys(result).length === 0) {
    throw new AppSpecParseError(
      "components must declare at least one component",
      "schema",
      "$.components",
    );
  }
  return result;
}

function validateComponent(name: string, raw: unknown): Component {
  const path = `$.components.${name}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(`${path} must be a mapping`, "schema", path);
  }
  const c = raw as Record<string, unknown>;
  // Reject legacy `use:` before generic unknown-key check so the operator
  // gets a precise diagnostic mentioning the new model.
  if ("use" in c) {
    throw new AppSpecParseError(
      `${path}.use is no longer supported — the AppSpec model now uses ` +
        `\`publish:\` and \`listen:\` for namespace pub/sub. See ` +
        `https://takosumi.com/docs/reference/app-spec.`,
      "legacy-use",
      `${path}.use`,
    );
  }
  rejectUnknownKeys(c, COMPONENT_KEYS, path);
  const kind = validateComponentKind(c.kind, `${path}.kind`);
  const component: Component = {
    kind,
    build: c.build === undefined
      ? undefined
      : validateBuild(c.build, `${path}.build`),
    publish: c.publish === undefined
      ? undefined
      : validatePublish(c.publish, `${path}.publish`),
    listen: c.listen === undefined
      ? undefined
      : validateListen(c.listen, `${path}.listen`),
    routes: c.routes === undefined
      ? undefined
      : validateStringArray(c.routes, `${path}.routes`),
    spec: c.spec as Component["spec"],
    name: c.name as string | undefined,
    target: c.target as string | undefined,
  };
  return component;
}

/**
 * Validate the `kind` field of a component. Accepts either:
 *   - a built-in short name (`worker` / `postgres` / ...);
 *   - the canonical URI of a built-in kind
 *     (e.g. `https://takosumi.com/kinds/v1/worker`); or
 *   - an operator-defined kind URI (any `https://` / `http://` URI).
 *
 * Returns the original authoring form (= preserves short name vs URI as
 * written). Use `normalizeComponentKind()` to map built-in URIs back to
 * the short name when downstream logic needs identity checks.
 */
function validateComponentKind(value: unknown, path: string): ComponentKindRef {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppSpecParseError(
      `${path} must be a non-empty string (built-in short name or kind URI)`,
      "kind-catalog",
      path,
    );
  }
  if (isComponentKind(value)) return value;
  if (isKindUri(value)) return value;
  throw new AppSpecParseError(
    `${path} must be one of ${COMPONENT_KINDS.join(", ")} or a kind URI ` +
      `(https://... or http://...); got ${JSON.stringify(value)}`,
    "kind-catalog",
    path,
  );
}

function validateBuild(raw: unknown, path: string) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(`${path} must be a mapping`, "schema", path);
  }
  const b = raw as Record<string, unknown>;
  rejectUnknownKeys(b, BUILD_KEYS, path);
  requireString(b.command, `${path}.command`);
  requireString(b.output, `${path}.output`);
  return { command: b.command as string, output: b.output as string };
}

function validatePublish(
  raw: unknown,
  path: string,
): readonly NamespacePath[] {
  if (!Array.isArray(raw)) {
    throw new AppSpecParseError(
      `${path} must be an array of namespace paths`,
      "schema",
      path,
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new AppSpecParseError(
        `${path}[${i}] must be a non-empty namespace path`,
        "publish-listen",
        `${path}[${i}]`,
      );
    }
    if (!isValidNamespacePath(entry)) {
      throw new AppSpecParseError(
        `${path}[${i}] is not a well-formed namespace path ` +
          `(dot-separated non-empty segments); got ${JSON.stringify(entry)}`,
        "publish-listen",
        `${path}[${i}]`,
      );
    }
    if (seen.has(entry)) {
      throw new AppSpecParseError(
        `${path}[${i}] duplicates a previously declared namespace path: ` +
          JSON.stringify(entry),
        "publish-listen",
        `${path}[${i}]`,
      );
    }
    seen.add(entry);
  }
  return raw as readonly string[];
}

function validateListen(
  raw: unknown,
  path: string,
): Readonly<Record<NamespacePath, ListenOptions>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      `${path} must be a mapping of namespace path → options object`,
      "schema",
      path,
    );
  }
  const result: Record<string, ListenOptions> = {};
  for (const [nsPath, value] of Object.entries(raw)) {
    const entryPath = `${path}.${JSON.stringify(nsPath)}`;
    if (!isValidNamespacePath(nsPath)) {
      throw new AppSpecParseError(
        `${entryPath} is not a well-formed namespace path ` +
          `(dot-separated non-empty segments)`,
        "publish-listen",
        entryPath,
      );
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppSpecParseError(
        `${entryPath} must be an options object { as, prefix?, mount? }`,
        "schema",
        entryPath,
      );
    }
    const opts = value as Record<string, unknown>;
    rejectUnknownKeys(opts, LISTEN_OPTIONS_KEYS, entryPath);
    if (typeof opts.as !== "string" || opts.as.length === 0) {
      throw new AppSpecParseError(
        `${entryPath}.as must be a non-empty string ` +
          `(e.g. "env", "mount", "target", or an operator-defined shape)`,
        "publish-listen",
        `${entryPath}.as`,
      );
    }
    if (opts.prefix !== undefined && typeof opts.prefix !== "string") {
      throw new AppSpecParseError(
        `${entryPath}.prefix must be a string when present`,
        "publish-listen",
        `${entryPath}.prefix`,
      );
    }
    if (opts.mount !== undefined && typeof opts.mount !== "string") {
      throw new AppSpecParseError(
        `${entryPath}.mount must be a string when present`,
        "publish-listen",
        `${entryPath}.mount`,
      );
    }
    result[nsPath] = {
      as: opts.as,
      prefix: opts.prefix as string | undefined,
      mount: opts.mount as string | undefined,
    };
  }
  return result;
}

function validateInterfaces(raw: unknown): AppSpec["interfaces"] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      "interfaces must be a mapping",
      "schema",
      "$.interfaces",
    );
  }
  const i = raw as Record<string, unknown>;
  const result: Record<
    string,
    { target: string; path: string; required?: boolean }
  > = {};
  for (const key of ["launch", "mcp", "health"] as const) {
    if (i[key] === undefined) continue;
    const entry = i[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AppSpecParseError(
        `interfaces.${key} must be a mapping`,
        "schema",
        `$.interfaces.${key}`,
      );
    }
    const e = entry as Record<string, unknown>;
    rejectUnknownKeys(e, INTERFACE_KEYS, `$.interfaces.${key}`);
    requireString(e.target, `$.interfaces.${key}.target`);
    requireString(e.path, `$.interfaces.${key}.path`);
    result[key] = {
      target: e.target as string,
      path: e.path as string,
      required: e.required as boolean | undefined,
    };
  }
  return result as AppSpec["interfaces"];
}

function validatePermissions(raw: unknown): AppSpec["permissions"] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      "permissions must be a mapping",
      "schema",
      "$.permissions",
    );
  }
  const p = raw as Record<string, unknown>;
  if (p.requested === undefined) return { requested: [] };
  return {
    requested: validateStringArray(p.requested, "$.permissions.requested"),
  };
}

/**
 * Validate publish / listen edges and detect cycles.
 *
 * Each namespace path is owned by at most one publisher; multiple
 * components cannot publish to the same path (the registry has no
 * conflict-resolution policy at the AppSpec layer). A listen edge with
 * no publisher is permitted in this layer — it is conceivable for an
 * external system (e.g. Takosumi Accounts emitting an OIDC material)
 * to publish to a path the AppSpec does not own. Cycle detection
 * therefore operates on **AppSpec-internal** edges only: A publishes X,
 * B listens X and publishes Y, A listens Y → cycle.
 */
function validatePublishListenGraph(
  components: Readonly<Record<string, Component>>,
): void {
  // Build publisher index: namespace path → publisher component name.
  const publisherByPath = new Map<NamespacePath, string>();
  for (const [name, component] of Object.entries(components)) {
    if (!component.publish) continue;
    for (const nsPath of component.publish) {
      const prior = publisherByPath.get(nsPath);
      if (prior !== undefined && prior !== name) {
        throw new AppSpecParseError(
          `namespace path ${JSON.stringify(nsPath)} is published by both ` +
            `${JSON.stringify(prior)} and ${JSON.stringify(name)}; ` +
            `each path may be owned by at most one component`,
          "publish-listen",
          `$.components.${name}.publish`,
        );
      }
      publisherByPath.set(nsPath, name);
    }
  }

  // Build adjacency: edges go from listener → publisher (= "depends on").
  const adjacency = new Map<string, string[]>();
  for (const name of Object.keys(components)) adjacency.set(name, []);
  for (const [name, component] of Object.entries(components)) {
    if (!component.listen) continue;
    for (const nsPath of Object.keys(component.listen)) {
      const publisher = publisherByPath.get(nsPath);
      // External publisher (= no AppSpec component owns this path) is
      // not an AppSpec-internal edge for cycle purposes.
      if (publisher === undefined) continue;
      if (publisher === name) {
        throw new AppSpecParseError(
          `${name} listens to a namespace path it publishes itself ` +
            `(${JSON.stringify(nsPath)}); self-loops are not permitted`,
          "publish-listen",
          `$.components.${name}.listen`,
        );
      }
      adjacency.get(name)!.push(publisher);
    }
  }

  detectCycles(adjacency);
}

function detectCycles(adjacency: Map<string, string[]>): void {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const node of adjacency.keys()) color.set(node, WHITE);
  const stack: string[] = [];
  for (const node of adjacency.keys()) {
    if (color.get(node) === WHITE) dfs(node);
  }
  function dfs(node: string) {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of adjacency.get(node) ?? []) {
      if (color.get(dep) === GRAY) {
        const cycleStart = stack.indexOf(dep);
        throw new AppSpecParseError(
          `publish/listen cycle: ${
            stack.slice(cycleStart).join(" → ")
          } → ${dep}`,
          "publish-listen",
          `$.components.${dep}`,
        );
      }
      if (color.get(dep) === WHITE) dfs(dep);
    }
    color.set(node, BLACK);
    stack.pop();
  }
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new AppSpecParseError(
        `${path} has unknown field "${key}"`,
        "schema",
        `${path}.${key}`,
      );
    }
  }
}

function requireString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppSpecParseError(
      `${path} must be a non-empty string`,
      "schema",
      path,
    );
  }
}

function validateStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AppSpecParseError(`${path} must be an array`, "schema", path);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new AppSpecParseError(
        `${path}[${i}] must be a string`,
        "schema",
        `${path}[${i}]`,
      );
    }
  }
  return value as readonly string[];
}

/**
 * Namespace paths are dot-separated sequences of non-empty segments.
 * No segment may be empty (so `"a..b"` and `".x"` and `"x."` are
 * rejected); whitespace inside a segment is permitted but discouraged.
 * The grammar is intentionally permissive — operators may publish
 * arbitrary domain-shaped paths (`com.example.app.web`,
 * `tenant-1.queues.events`, etc.).
 */
function isValidNamespacePath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const segments = value.split(".");
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (segment.length === 0) return false;
  }
  return true;
}

// Used by `KNOWN_LISTEN_SHAPES` introspection in tests / docs.
export { KNOWN_LISTEN_SHAPES };
