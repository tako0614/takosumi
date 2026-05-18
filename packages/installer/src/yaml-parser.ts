/**
 * `.takosumi.yml` (AppSpec) parser.
 *
 * Reads YAML bytes and returns a validated `AppSpec`. Throws
 * `AppSpecParseError` with `validationPhase` / `validationPath` on
 * syntax / schema violations.
 *
 * This module replaces the prior multi-file project layout parser with the
 * single-file AppSpec contract.
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
  isReservedMount,
  normalizeComponentKind,
  type UseEdge,
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
  "use",
  "routes",
  "spec",
  "redirectPaths",
  "scopes",
  "name",
  "target",
]);

const BUILD_KEYS = new Set(["command", "output"]);
const USE_EDGE_KEYS = new Set(["env", "envPrefix", "mount", "target"]);
const INTERFACE_KEYS = new Set(["target", "path", "required"]);

export type ValidationPhase =
  | "syntax"
  | "schema"
  | "use-edge"
  | "kind-catalog";

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
  validateUseEdges(components);

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
  rejectUnknownKeys(c, COMPONENT_KEYS, path);
  const kind = validateComponentKind(c.kind, `${path}.kind`);
  const component: Component = {
    kind,
    build: c.build === undefined
      ? undefined
      : validateBuild(c.build, `${path}.build`),
    use: c.use === undefined ? undefined : validateUse(c.use, `${path}.use`),
    routes: c.routes === undefined
      ? undefined
      : validateStringArray(c.routes, `${path}.routes`),
    spec: c.spec as Component["spec"],
    redirectPaths: c.redirectPaths === undefined
      ? undefined
      : validateStringArray(c.redirectPaths, `${path}.redirectPaths`),
    scopes: c.scopes === undefined
      ? undefined
      : validateStringArray(c.scopes, `${path}.scopes`),
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

function validateUse(raw: unknown, path: string) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(`${path} must be a mapping`, "schema", path);
  }
  const result: Record<string, UseEdge> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppSpecParseError(
        `${path}.${name} must be a mapping`,
        "schema",
        `${path}.${name}`,
      );
    }
    const edge = value as Record<string, unknown>;
    rejectUnknownKeys(edge, USE_EDGE_KEYS, `${path}.${name}`);
    if (edge.mount !== undefined) {
      if (typeof edge.mount !== "string" || !isReservedMount(edge.mount)) {
        throw new AppSpecParseError(
          `${path}.${name}.mount must be a reserved mount`,
          "schema",
          `${path}.${name}.mount`,
        );
      }
    }
    result[name] = {
      env: edge.env as string | undefined,
      envPrefix: edge.envPrefix as string | undefined,
      mount: edge.mount as UseEdge["mount"],
      target: edge.target as string | undefined,
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

function validateUseEdges(
  components: Readonly<Record<string, Component>>,
): void {
  for (const [name, component] of Object.entries(components)) {
    if (!component.use) continue;
    for (const [edgeName, edge] of Object.entries(component.use)) {
      const target = edgeName;
      if (!(target in components)) {
        throw new AppSpecParseError(
          `components.${name}.use.${edgeName} references unknown component "${target}"`,
          "use-edge",
          `$.components.${name}.use.${edgeName}`,
        );
      }
      if (edge.mount === "oidc") {
        const targetKind = normalizeComponentKind(components[target].kind);
        if (targetKind !== "oidc") {
          throw new AppSpecParseError(
            `components.${name}.use.${edgeName} requests mount=oidc but target component is kind=${
              components[target].kind
            }`,
            "use-edge",
            `$.components.${name}.use.${edgeName}.mount`,
          );
        }
      }
    }
  }
  detectCycles(components);
}

function detectCycles(components: Readonly<Record<string, Component>>): void {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(
    Object.keys(components).map((n) => [n, WHITE]),
  );
  const stack: string[] = [];
  for (const name of Object.keys(components)) {
    if (color.get(name) === WHITE) dfs(name);
  }
  function dfs(node: string) {
    color.set(node, GRAY);
    stack.push(node);
    const use = components[node].use;
    if (use) {
      for (const dep of Object.keys(use)) {
        if (color.get(dep) === GRAY) {
          const cycleStart = stack.indexOf(dep);
          throw new AppSpecParseError(
            `use-edge cycle: ${stack.slice(cycleStart).join(" → ")} → ${dep}`,
            "use-edge",
            `$.components.${dep}`,
          );
        }
        if (color.get(dep) === WHITE) dfs(dep);
      }
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
