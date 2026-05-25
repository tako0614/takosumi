/**
 * `.takosumi.yml` (AppSpec) parser.
 *
 * Reads YAML bytes and returns a validated `AppSpec`. Throws
 * `AppSpecParseError` with `validationPhase` / `validationPath` on
 * syntax / schema violations.
 *
 * Components declare local publications (`publish.<name>`) and local
 * bindings (`listen.<name>`). A binding's `from` field points at either a
 * same-AppSpec publication (`component.publication`) or an operator-owned
 * external publication path (`publisher.area.name`). The prior `use:` edge model is
 * removed; encountering `use:` is rejected with `AppSpecParseError`.
 */

import { parse as parseYaml } from "jsr:@std/yaml@^1.0.5";
import {
  APP_SPEC_API_VERSION,
  type AppSpec,
  type BindingName,
  type Component,
  type ComponentKindRef,
  type ListenOptions,
  type ListenSourceRef,
  type PublicationName,
  type PublishOptions,
} from "@takos/takosumi-contract/app-spec";

const ROOT_KEYS = new Set([
  "apiVersion",
  "metadata",
  "components",
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
  "publish",
  "listen",
  "spec",
]);

const PUBLISH_OPTIONS_KEYS = new Set(["as"]);
const LISTEN_OPTIONS_KEYS = new Set([
  "from",
  "as",
  "prefix",
  "mount",
  "required",
]);

/**
 * Built-in {@link ListenOptions} `as` values the parser knows about. The
 * parser still accepts arbitrary non-empty strings so operator-defined
 * material shapes are forward-compatible — this set is documentary.
 */
const KNOWN_LISTEN_SHAPES: ReadonlySet<string> = new Set([
  "env",
  "secret-env",
  "mount",
  "upstream",
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
    : decodeUtf8(yamlBytes);

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

function decodeUtf8(yamlBytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(yamlBytes);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new AppSpecParseError(
      `AppSpec YAML must be valid UTF-8: ${cause}`,
      "syntax",
      "$",
    );
  }
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

  const metadata = validateMetadata(root.metadata);
  const components = validateComponents(root.components);
  validatePublishListenGraph(components);

  return {
    apiVersion: APP_SPEC_API_VERSION,
    metadata,
    components,
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
    validateLocalName(name, `$.components.${JSON.stringify(name)}`);
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
        `\`publish:\` and \`listen:\` for publication/listen bindings. See ` +
        `https://takosumi.com/docs/reference/app-spec.`,
      "legacy-use",
      `${path}.use`,
    );
  }
  rejectUnknownKeys(c, COMPONENT_KEYS, path);
  const kind = validateComponentKind(c.kind, `${path}.kind`);
  const component: Component = {
    kind,
    publish: c.publish === undefined
      ? undefined
      : validatePublish(c.publish, `${path}.publish`),
    listen: c.listen === undefined
      ? undefined
      : validateListen(c.listen, `${path}.listen`),
    spec: c.spec === undefined
      ? undefined
      : validateSpecObject(c.spec, `${path}.spec`),
  };
  return component;
}

/**
 * Validate the `kind` field of a component. The AppSpec parser only requires
 * a non-empty string and preserves the authoring form. Short aliases and URI
 * meanings are resolved by the operator distribution, not by the Takosumi
 * contract or parser.
 */
function validateComponentKind(value: unknown, path: string): ComponentKindRef {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppSpecParseError(
      `${path} must be a non-empty string`,
      "kind-catalog",
      path,
    );
  }
  return value;
}

function validatePublish(
  raw: unknown,
  path: string,
): Readonly<Record<PublicationName, PublishOptions>> {
  if (Array.isArray(raw)) {
    throw new AppSpecParseError(
      `${path} must be a mapping of publication name → options object; ` +
        `namespace path arrays are no longer accepted`,
      "schema",
      path,
    );
  }
  if (raw === null || typeof raw !== "object") {
    throw new AppSpecParseError(
      `${path} must be a mapping of publication name → options object`,
      "schema",
      path,
    );
  }
  const result: Record<string, PublishOptions> = {};
  for (const [publicationName, value] of Object.entries(raw)) {
    const entryPath = `${path}.${JSON.stringify(publicationName)}`;
    validateLocalName(publicationName, entryPath);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppSpecParseError(
        `${entryPath} must be an options object { as }`,
        "schema",
        entryPath,
      );
    }
    const opts = value as Record<string, unknown>;
    rejectUnknownKeys(opts, PUBLISH_OPTIONS_KEYS, entryPath);
    if (typeof opts.as !== "string" || opts.as.length === 0) {
      throw new AppSpecParseError(
        `${entryPath}.as must be a non-empty material contract alias or URI`,
        "publish-listen",
        `${entryPath}.as`,
      );
    }
    result[publicationName] = {
      as: opts.as,
    };
  }
  return result;
}

function validateListen(
  raw: unknown,
  path: string,
): Readonly<Record<BindingName, ListenOptions>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      `${path} must be a mapping of binding name → options object`,
      "schema",
      path,
    );
  }
  const result: Record<string, ListenOptions> = {};
  for (const [bindingName, value] of Object.entries(raw)) {
    const entryPath = `${path}.${JSON.stringify(bindingName)}`;
    validateLocalName(bindingName, entryPath);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppSpecParseError(
        `${entryPath} must be an options object { from, as, prefix?, mount? }`,
        "schema",
        entryPath,
      );
    }
    const opts = value as Record<string, unknown>;
    rejectUnknownKeys(opts, LISTEN_OPTIONS_KEYS, entryPath);
    if (typeof opts.from !== "string" || opts.from.length === 0) {
      throw new AppSpecParseError(
        `${entryPath}.from must be a non-empty source ref ` +
          `(<component>.<publication> or publisher.area.name)`,
        "publish-listen",
        `${entryPath}.from`,
      );
    }
    const from = validateListenSourceRef(opts.from, `${entryPath}.from`);
    if (typeof opts.as !== "string" || opts.as.length === 0) {
      throw new AppSpecParseError(
        `${entryPath}.as must be a non-empty string ` +
          `(e.g. "env", "mount", "upstream", or an operator-defined shape)`,
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
    if (opts.required !== undefined && typeof opts.required !== "boolean") {
      throw new AppSpecParseError(
        `${entryPath}.required must be a boolean when present`,
        "publish-listen",
        `${entryPath}.required`,
      );
    }
    if (opts.required !== undefined && !isExternalPublicationRef(from)) {
      throw new AppSpecParseError(
        `${entryPath}.required is only valid for external publication refs`,
        "publish-listen",
        `${entryPath}.required`,
      );
    }
    result[bindingName] = {
      from,
      as: opts.as,
      prefix: opts.prefix as string | undefined,
      mount: opts.mount as string | undefined,
      required: opts.required as boolean | undefined,
    };
  }
  return result;
}

function validateSpecObject(
  raw: unknown,
  path: string,
): NonNullable<Component["spec"]> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      `${path} must be a YAML mapping`,
      "schema",
      path,
    );
  }
  return raw as NonNullable<Component["spec"]>;
}

/**
 * Validate local publish / listen edges and detect cycles.
 *
 * Same-AppSpec refs use `<component>.<publication>` and must resolve inside
 * this AppSpec. External publication refs use a dotted path with three or more
 * segments and do not create AppSpec-internal graph edges.
 */
function validatePublishListenGraph(
  components: Readonly<Record<string, Component>>,
): void {
  // Build publisher index: component.publication → publisher component name.
  const publisherByRef = new Map<string, string>();
  for (const [name, component] of Object.entries(components)) {
    if (!component.publish) continue;
    for (const publicationName of Object.keys(component.publish)) {
      publisherByRef.set(`${name}.${publicationName}`, name);
    }
  }

  // Build adjacency: edges go from listener → publisher (= "depends on").
  const adjacency = new Map<string, string[]>();
  for (const name of Object.keys(components)) adjacency.set(name, []);
  for (const [name, component] of Object.entries(components)) {
    if (!component.listen) continue;
    for (const [bindingName, options] of Object.entries(component.listen)) {
      const from = options.from;
      if (isExternalPublicationRef(from)) continue;
      const publisher = publisherByRef.get(from);
      if (publisher === undefined) {
        throw new AppSpecParseError(
          `${name}.listen.${bindingName}.from refers to unknown publication ` +
            JSON.stringify(from),
          "publish-listen",
          `$.components.${name}.listen.${bindingName}.from`,
        );
      }
      if (publisher === name) {
        throw new AppSpecParseError(
          `${name} listens to its own publication ` +
            `(${JSON.stringify(from)}); self-loops are not permitted`,
          "publish-listen",
          `$.components.${name}.listen.${bindingName}.from`,
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

function validateLocalName(value: string, path: string): void {
  if (!isValidLocalName(value)) {
    throw new AppSpecParseError(
      `${path} must match [a-z][a-z0-9-]{0,62}`,
      "schema",
      path,
    );
  }
}

function validateListenSourceRef(
  value: string,
  path: string,
): ListenSourceRef {
  const parts = value.split(".");
  if (parts.length === 2 && parts.every((part) => isValidLocalName(part))) {
    return value as ListenSourceRef;
  }
  if (parts.length >= 3 && isValidExternalPublicationPath(value)) {
    return value as ListenSourceRef;
  }
  if (parts.length === 2) {
    throw new AppSpecParseError(
      `${path} must use valid component/publication names`,
      "publish-listen",
      path,
    );
  }
  throw new AppSpecParseError(
    `${path} must be <component>.<publication> or publisher.area.name`,
    "publish-listen",
    path,
  );
}

function isExternalPublicationRef(value: string): boolean {
  return value.split(".").length >= 3 && isValidExternalPublicationPath(value);
}

function isValidLocalName(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/.test(value);
}

/**
 * External publication paths are dot-separated sequences of local-name
 * segments. `default` is an ordinary segment; Takosumi v1 does not perform
 * hidden default-path expansion.
 */
function isValidExternalPublicationPath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > 255) return false;
  const segments = value.split(".");
  if (segments.length === 0 || segments.length > 8) return false;
  for (const segment of segments) {
    if (!isValidLocalName(segment)) return false;
  }
  return true;
}

// Used by `KNOWN_LISTEN_SHAPES` introspection in tests / docs.
export { KNOWN_LISTEN_SHAPES };
