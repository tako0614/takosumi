/**
 * `.takosumi.yml` (AppSpec) parser.
 *
 * Reads YAML bytes and returns a validated `AppSpec`. Throws
 * `AppSpecParseError` with `validationPhase` / `validationPath` on
 * syntax / schema violations.
 *
 * Components declare deterministic same-AppSpec wiring with `connect.<name>`
 * and platform-service wiring with `listen.<name>`. A listener can select an
 * exact publication path or discover visible publications by material kind and
 * labels. Root `publish` declares a selected component output as an
 * Installation output declaration.
 * The prior `use:` and component-local `publish:` edge models are removed;
 * encountering them is rejected with `AppSpecParseError`.
 */

import { parse as parseYaml } from "jsr:@std/yaml@^1.0.5";
import {
  APP_SPEC_API_VERSION,
  type AppSpec,
  type BindingName,
  type Component,
  type ComponentKindRef,
  type ComponentOutputRef,
  type ConnectOptions,
  type ExternalServiceName,
  isAppSpecLocalNameSegment,
  isComponentOutputRef,
  isPlatformServicePath,
  type ListenOptions,
  type PublishOptions,
} from "@takos/takosumi-contract/app-spec";

const ROOT_KEYS = new Set([
  "apiVersion",
  "metadata",
  "components",
  "publish",
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
  "connect",
  "listen",
  "spec",
]);

const CONNECT_OPTIONS_KEYS = new Set([
  "output",
  "inject",
  "prefix",
  "mount",
]);
const ROOT_PUBLISH_OPTIONS_KEYS = new Set([
  "output",
  "kind",
  "path",
  "labels",
]);
const LISTEN_OPTIONS_KEYS = new Set([
  "path",
  "kind",
  "labels",
  "many",
  "inject",
  "prefix",
  "mount",
  "required",
]);

/**
 * Built-in {@link ListenOptions} `inject` values the parser knows about. The
 * parser still accepts arbitrary non-empty strings so operator-defined
 * material shapes are forward-compatible — this set is documentary.
 */
const KNOWN_LISTEN_SHAPES: ReadonlySet<string> = new Set([
  "env",
  "secret-env",
  "config-mount",
  "upstream",
]);

export type ValidationPhase =
  | "syntax"
  | "schema"
  | "connection-resolution"
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
  const publish = root.publish === undefined
    ? undefined
    : validateRootPublish(root.publish, "$.publish", components);
  validateConnectGraph(components);

  return {
    apiVersion: APP_SPEC_API_VERSION,
    metadata,
    components,
    ...(publish ? { publish } : {}),
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
        `\`connect:\` for same-AppSpec wiring and \`listen:\` for platform services. See ` +
        `https://takosumi.com/docs/reference/app-spec.`,
      "legacy-use",
      `${path}.use`,
    );
  }
  if ("publish" in c) {
    throw new AppSpecParseError(
      `${path}.publish is no longer component-local; use ` +
        `connect.<binding>.output for same-AppSpec wiring or root publish for an Installation output declaration`,
      "schema",
      `${path}.publish`,
    );
  }
  rejectUnknownKeys(c, COMPONENT_KEYS, path);
  const kind = validateComponentKind(c.kind, `${path}.kind`);
  const component: Component = {
    kind,
    connect: c.connect === undefined
      ? undefined
      : validateConnect(c.connect, `${path}.connect`),
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

function validateConnect(
  raw: unknown,
  path: string,
): Readonly<Record<BindingName, ConnectOptions>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      `${path} must be a mapping of binding name → options object`,
      "schema",
      path,
    );
  }
  const result: Record<string, ConnectOptions> = {};
  for (const [bindingName, value] of Object.entries(raw)) {
    const entryPath = `${path}.${JSON.stringify(bindingName)}`;
    validateLocalName(bindingName, entryPath);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppSpecParseError(
        `${entryPath} must be an options object { output, inject, prefix?, mount? }`,
        "schema",
        entryPath,
      );
    }
    const opts = value as Record<string, unknown>;
    rejectUnknownKeys(opts, CONNECT_OPTIONS_KEYS, entryPath);
    if (typeof opts.output !== "string" || opts.output.length === 0) {
      throw new AppSpecParseError(
        `${entryPath}.output must be a non-empty component output ref ` +
          `(<component>.<outputSlot>)`,
        "connection-resolution",
        `${entryPath}.output`,
      );
    }
    const output = validateComponentOutputRef(
      opts.output,
      `${entryPath}.output`,
    );
    if (typeof opts.inject !== "string" || opts.inject.length === 0) {
      throw new AppSpecParseError(
        `${entryPath}.inject must be a non-empty string ` +
          `(e.g. "env", "secret-env", "config-mount", "upstream", or an operator-defined shape)`,
        "connection-resolution",
        `${entryPath}.inject`,
      );
    }
    if (opts.prefix !== undefined && typeof opts.prefix !== "string") {
      throw new AppSpecParseError(
        `${entryPath}.prefix must be a string when present`,
        "connection-resolution",
        `${entryPath}.prefix`,
      );
    }
    if (opts.mount !== undefined && typeof opts.mount !== "string") {
      throw new AppSpecParseError(
        `${entryPath}.mount must be a string when present`,
        "connection-resolution",
        `${entryPath}.mount`,
      );
    }
    result[bindingName] = {
      output,
      inject: opts.inject,
      prefix: opts.prefix as string | undefined,
      mount: opts.mount as string | undefined,
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
        `${entryPath} must be an options object { path?, kind?, labels?, many?, inject, prefix?, mount?, required? }`,
        "schema",
        entryPath,
      );
    }
    const opts = value as Record<string, unknown>;
    rejectUnknownKeys(opts, LISTEN_OPTIONS_KEYS, entryPath);
    const servicePath = opts.path === undefined
      ? undefined
      : validatePlatformServicePathOption(opts.path, `${entryPath}.path`);
    const kind = opts.kind === undefined
      ? undefined
      : validateMaterialKind(opts.kind, `${entryPath}.kind`);
    if (servicePath === undefined && kind === undefined) {
      throw new AppSpecParseError(
        `${entryPath} must declare either path for exact resolution or kind for discovery`,
        "connection-resolution",
        entryPath,
      );
    }
    const labels = opts.labels === undefined
      ? undefined
      : validateLabels(opts.labels, `${entryPath}.labels`);
    if (opts.many !== undefined && typeof opts.many !== "boolean") {
      throw new AppSpecParseError(
        `${entryPath}.many must be a boolean when present`,
        "connection-resolution",
        `${entryPath}.many`,
      );
    }
    if (opts.many === true && servicePath !== undefined) {
      throw new AppSpecParseError(
        `${entryPath}.many can only be used with kind/labels discovery, not exact path resolution`,
        "connection-resolution",
        `${entryPath}.many`,
      );
    }
    if (typeof opts.inject !== "string" || opts.inject.length === 0) {
      throw new AppSpecParseError(
        `${entryPath}.inject must be a non-empty string ` +
          `(e.g. "env", "secret-env", "config-mount", "upstream", or an operator-defined shape)`,
        "connection-resolution",
        `${entryPath}.inject`,
      );
    }
    if (opts.prefix !== undefined && typeof opts.prefix !== "string") {
      throw new AppSpecParseError(
        `${entryPath}.prefix must be a string when present`,
        "connection-resolution",
        `${entryPath}.prefix`,
      );
    }
    if (opts.mount !== undefined && typeof opts.mount !== "string") {
      throw new AppSpecParseError(
        `${entryPath}.mount must be a string when present`,
        "connection-resolution",
        `${entryPath}.mount`,
      );
    }
    if (opts.required !== undefined && typeof opts.required !== "boolean") {
      throw new AppSpecParseError(
        `${entryPath}.required must be a boolean when present`,
        "connection-resolution",
        `${entryPath}.required`,
      );
    }
    result[bindingName] = {
      path: servicePath,
      kind,
      labels,
      many: opts.many as boolean | undefined,
      inject: opts.inject,
      prefix: opts.prefix as string | undefined,
      mount: opts.mount as string | undefined,
      required: opts.required as boolean | undefined,
    };
  }
  return result;
}

function validateRootPublish(
  raw: unknown,
  path: string,
  components: Readonly<Record<string, Component>>,
): Readonly<Record<ExternalServiceName, PublishOptions>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      `${path} must be a mapping of publish name → options object`,
      "schema",
      path,
    );
  }
  const result: Record<string, PublishOptions> = {};
  const paths = new Map<string, string>();
  for (const [publishName, value] of Object.entries(raw)) {
    const entryPath = `${path}.${JSON.stringify(publishName)}`;
    validateLocalName(publishName, entryPath);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppSpecParseError(
        `${entryPath} must be an options object { output, kind?, path?, labels? }`,
        "schema",
        entryPath,
      );
    }
    const opts = value as Record<string, unknown>;
    rejectUnknownKeys(opts, ROOT_PUBLISH_OPTIONS_KEYS, entryPath);
    if (typeof opts.output !== "string" || opts.output.length === 0) {
      throw new AppSpecParseError(
        `${entryPath}.output must be a non-empty component output ref ` +
          `(<component>.<outputSlot>)`,
        "connection-resolution",
        `${entryPath}.output`,
      );
    }
    const output = validateComponentOutputRef(
      opts.output,
      `${entryPath}.output`,
    );
    const componentName = output.split(".")[0]!;
    if (!(componentName in components)) {
      throw new AppSpecParseError(
        `${entryPath}.output refers to unknown component ${
          JSON.stringify(componentName)
        }`,
        "connection-resolution",
        `${entryPath}.output`,
      );
    }
    const kind = opts.kind === undefined
      ? undefined
      : validateMaterialKind(opts.kind, `${entryPath}.kind`);
    const servicePath = opts.path === undefined
      ? undefined
      : validatePlatformServicePathOption(opts.path, `${entryPath}.path`);
    const labels = opts.labels === undefined
      ? undefined
      : validateLabels(opts.labels, `${entryPath}.labels`);
    if (servicePath !== undefined) {
      const existing = paths.get(servicePath);
      if (existing !== undefined) {
        throw new AppSpecParseError(
          `${entryPath}.path duplicates $.publish.${
            JSON.stringify(existing)
          }.path`,
          "connection-resolution",
          `${entryPath}.path`,
        );
      }
      paths.set(servicePath, publishName);
    }
    result[publishName] = {
      output,
      kind,
      path: servicePath,
      labels,
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
 * Validate deterministic connect edges and detect cycles.
 *
 * Same-AppSpec refs use `<component>.<output>` and must resolve inside this
 * AppSpec. Platform service refs are handled by `listen.path` and do not create
 * AppSpec-internal graph edges.
 */
function validateConnectGraph(
  components: Readonly<Record<string, Component>>,
): void {
  // Build adjacency: edges go from listener → publisher (= "depends on").
  const adjacency = new Map<string, string[]>();
  for (const name of Object.keys(components)) adjacency.set(name, []);
  for (const [name, component] of Object.entries(components)) {
    if (!component.connect) continue;
    for (const [bindingName, options] of Object.entries(component.connect)) {
      const [publisher] = options.output.split(".");
      if (publisher === undefined || !(publisher in components)) {
        throw new AppSpecParseError(
          `${name}.connect.${bindingName}.output refers to unknown component ` +
            JSON.stringify(publisher),
          "connection-resolution",
          `$.components.${name}.connect.${bindingName}.output`,
        );
      }
      if (publisher === name) {
        throw new AppSpecParseError(
          `${name} connects to its own output ` +
            `(${JSON.stringify(options.output)}); self-loops are not permitted`,
          "connection-resolution",
          `$.components.${name}.connect.${bindingName}.output`,
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
          `connect cycle: ${stack.slice(cycleStart).join(" → ")} → ${dep}`,
          "connection-resolution",
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

function validateComponentOutputRef(
  value: string,
  path: string,
): ComponentOutputRef {
  const parts = value.split(".");
  if (isComponentOutputRef(value)) {
    return value as ComponentOutputRef;
  }
  if (parts.length === 2) {
    throw new AppSpecParseError(
      `${path} must use valid component/output names`,
      "connection-resolution",
      path,
    );
  }
  throw new AppSpecParseError(
    `${path} must be <component>.<outputSlot>`,
    "connection-resolution",
    path,
  );
}

function validatePlatformServicePath(
  value: string,
  path: string,
): string {
  if (isPlatformServicePath(value)) return value;
  throw new AppSpecParseError(
    `${path} must be a platform service path with 3 to 8 dot-separated local-name segments`,
    "connection-resolution",
    path,
  );
}

function validatePlatformServicePathOption(
  value: unknown,
  path: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppSpecParseError(
      `${path} must be a non-empty platform service path`,
      "connection-resolution",
      path,
    );
  }
  return validatePlatformServicePath(value, path);
}

function validateMaterialKind(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppSpecParseError(
      `${path} must be a non-empty material kind string`,
      "connection-resolution",
      path,
    );
  }
  return value;
}

function validateLabels(
  value: unknown,
  path: string,
): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppSpecParseError(
      `${path} must be a mapping of label name to string value`,
      "connection-resolution",
      path,
    );
  }
  const labels: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(value)) {
    validateLocalName(key, `${path}.${JSON.stringify(key)}`);
    if (typeof labelValue !== "string" || labelValue.length === 0) {
      throw new AppSpecParseError(
        `${path}.${JSON.stringify(key)} must be a non-empty string`,
        "connection-resolution",
        `${path}.${JSON.stringify(key)}`,
      );
    }
    labels[key] = labelValue;
  }
  return labels;
}

function isValidLocalName(value: string): boolean {
  return isAppSpecLocalNameSegment(value);
}

// Used by `KNOWN_LISTEN_SHAPES` introspection in tests / docs.
export { KNOWN_LISTEN_SHAPES };
