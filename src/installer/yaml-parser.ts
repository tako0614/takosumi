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

import { parse as parseYaml } from "yaml";
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
  | "legacy-use"
  | "manifest-too-large"
  | "too-many-components"
  | "forbidden-field"
  | "invalid-metadata-id"
  | "invalid-metadata-homepage"
  | "connect-cycle";

/**
 * Hard upper bound on the size of a `.takosumi.yml` source document.
 * Larger inputs are rejected with `manifest_too_large` before parsing.
 * The limit aligns with the Installer API `413 resource_exhausted`
 * envelope for manifest size limits and keeps the parser closed against
 * pathologically large hostile inputs.
 */
const MANIFEST_BYTE_LIMIT = 1024 * 1024; // 1 MiB

/**
 * Hard upper bound on the number of components in a single AppSpec.
 * Larger inputs are rejected with `too_many_components`.
 */
const COMPONENT_COUNT_LIMIT = 256;

/**
 * Object property names that are unsafe to forward into runtime materials
 * because they map to prototype slots on plain objects in JavaScript hosts.
 * Stripped recursively from `component.spec` subtrees during validation and
 * surfaced as a `forbidden_field` closed-envelope error if encountered.
 */
const FORBIDDEN_SPEC_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Relaxed reverse-DNS-style pattern for `metadata.id`. Allows up to five
 * dot-separated segments, each starting with a lowercase letter and
 * containing lowercase letters, digits, or hyphens (up to 63 characters
 * each). NUL / tab / control characters are rejected before this regex
 * runs.
 */
const METADATA_ID_RE = /^[a-z][a-z0-9-]{0,62}(?:\.[a-z][a-z0-9-]{0,62}){0,4}$/;

/**
 * URL schemes accepted in `metadata.homepage`. `javascript:`, `data:`,
 * `file:`, and other non-network schemes are rejected to keep an
 * AppSpec from publishing an exploit vector through descriptive
 * metadata.
 */
const METADATA_HOMEPAGE_SCHEMES: ReadonlySet<string> = new Set([
  "https:",
  "http:",
]);

/**
 * System-reserved platform service path prefixes. A `listen.path` or
 * root `publish.path` whose first segment matches one of these is
 * rejected so operator distributions can reserve the namespace for
 * platform-managed publications. Reserved prefixes:
 *
 * - `takosumi.*` — reserved for Takosumi core publications.
 * - `system.*` — reserved for operator-distribution / platform
 *   publications.
 * - `_*` (any segment beginning with an underscore) — reserved for
 *   internal namespaces; the local-name pattern already forbids
 *   underscores, but we keep the check as a defense-in-depth guard.
 */
const RESERVED_PATH_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "takosumi",
  "system",
]);

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

/**
 * Optional warning sink for the parser. Used to surface non-fatal
 * diagnostics such as an open-vocabulary `inject` value that is not in
 * {@link KNOWN_LISTEN_SHAPES}. Defaults to a no-op so existing callers
 * are unaffected.
 */
export interface AppSpecParseLogger {
  warn(message: string, path: string): void;
}

export interface ParseAppSpecOptions {
  logger?: AppSpecParseLogger;
}

const NOOP_LOGGER: AppSpecParseLogger = {
  warn(_message: string, _path: string): void {
    // intentional no-op
  },
};

export function parseAppSpec(
  yamlBytes: string | Uint8Array,
  options: ParseAppSpecOptions = {},
): AppSpec {
  const logger = options.logger ?? NOOP_LOGGER;

  // Enforce the manifest byte-size guard before decoding so the parser
  // never has to allocate a multi-MiB string for a hostile input. Length
  // is checked against the raw UTF-8 byte count (string inputs are
  // re-measured below via TextEncoder).
  const byteLength = typeof yamlBytes === "string"
    ? new TextEncoder().encode(yamlBytes).byteLength
    : yamlBytes.byteLength;
  if (byteLength > MANIFEST_BYTE_LIMIT) {
    throw new AppSpecParseError(
      `manifest_too_large: AppSpec source is ${byteLength} bytes; limit is ` +
        `${MANIFEST_BYTE_LIMIT} bytes`,
      "manifest-too-large",
      "$",
    );
  }

  const text = typeof yamlBytes === "string"
    ? yamlBytes
    : decodeUtf8(yamlBytes);
  if (text.includes("\0")) {
    throw new AppSpecParseError(
      "YAML syntax error: AppSpec source must not contain raw NUL bytes",
      "syntax",
      "$",
    );
  }

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

  return validateAppSpec(raw, logger);
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

function validateAppSpec(
  raw: unknown,
  logger: AppSpecParseLogger,
): AppSpec {
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
  const components = validateComponents(root.components, logger);
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
  validateMetadataId(m.id as string, "$.metadata.id");
  requireString(m.name, "$.metadata.name");
  if (m.description !== undefined) {
    requireString(m.description, "$.metadata.description");
  }
  if (m.publisher !== undefined) {
    requireString(m.publisher, "$.metadata.publisher");
  }
  if (m.homepage !== undefined) {
    requireString(m.homepage, "$.metadata.homepage");
    validateMetadataHomepage(m.homepage as string, "$.metadata.homepage");
  }
  return {
    id: m.id as string,
    name: m.name as string,
    description: m.description as string | undefined,
    publisher: m.publisher as string | undefined,
    homepage: m.homepage as string | undefined,
  };
}

/**
 * Validate `metadata.id` against the relaxed reverse-DNS-style pattern and
 * reject NUL / tab / control characters. The pattern allows operator
 * publishers to use a wider domain space than the strict 2-segment local
 * name pattern while still preventing namespace abuse.
 */
function validateMetadataId(value: string, path: string): void {
  // Reject NUL, tab, and any other ASCII control character before the
  // regex check, so a hostile id like "com.example " is closed off
  // even if the regex would otherwise pass on the visible prefix.
  if (containsControlChar(value)) {
    throw new AppSpecParseError(
      `invalid_metadata_id: ${path} must not contain NUL, tab, or other ` +
        `control characters`,
      "invalid-metadata-id",
      path,
    );
  }
  if (!METADATA_ID_RE.test(value)) {
    throw new AppSpecParseError(
      `invalid_metadata_id: ${path} must match relaxed reverse-DNS pattern ` +
        `[a-z][a-z0-9-]{0,62}(\\.[a-z][a-z0-9-]{0,62}){0,4}`,
      "invalid-metadata-id",
      path,
    );
  }
}

/**
 * Validate `metadata.homepage` is a parseable URL with an http(s) scheme.
 * `javascript:`, `data:`, `file:`, and other non-network schemes are
 * rejected so AppSpec metadata cannot smuggle an exploit vector through
 * downstream dashboards or descriptor catalogs.
 */
function validateMetadataHomepage(value: string, path: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppSpecParseError(
      `invalid_metadata_homepage: ${path} must be a valid absolute URL`,
      "invalid-metadata-homepage",
      path,
    );
  }
  if (!METADATA_HOMEPAGE_SCHEMES.has(url.protocol)) {
    throw new AppSpecParseError(
      `invalid_metadata_homepage: ${path} must use scheme https: or http:, ` +
        `got ${JSON.stringify(url.protocol)}`,
      "invalid-metadata-homepage",
      path,
    );
  }
}

function containsControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateComponents(
  raw: unknown,
  logger: AppSpecParseLogger,
): Readonly<Record<string, Component>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppSpecParseError(
      "components must be a mapping",
      "schema",
      "$.components",
    );
  }
  const entries = Object.entries(raw);
  if (entries.length > COMPONENT_COUNT_LIMIT) {
    throw new AppSpecParseError(
      `too_many_components: components has ${entries.length} entries; ` +
        `limit is ${COMPONENT_COUNT_LIMIT}`,
      "too-many-components",
      "$.components",
    );
  }
  const result: Record<string, Component> = {};
  for (const [name, value] of entries) {
    validateLocalName(name, `$.components.${JSON.stringify(name)}`);
    result[name] = validateComponent(name, value, logger);
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

function validateComponent(
  name: string,
  raw: unknown,
  logger: AppSpecParseLogger,
): Component {
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
      : validateConnect(c.connect, `${path}.connect`, logger),
    listen: c.listen === undefined
      ? undefined
      : validateListen(c.listen, `${path}.listen`, logger),
    spec: c.spec === undefined
      ? undefined
      : validateSpecObject(c.spec, `${path}.spec`),
  };
  rejectDuplicateBindingNames(component, path);
  return component;
}

function rejectDuplicateBindingNames(component: Component, path: string): void {
  if (!component.connect || !component.listen) return;
  for (const bindingName of Object.keys(component.listen)) {
    if (component.connect[bindingName] === undefined) continue;
    throw new AppSpecParseError(
      `${path}.listen.${JSON.stringify(bindingName)} duplicates a connect binding name on the same component`,
      "connection-resolution",
      `${path}.listen.${JSON.stringify(bindingName)}`,
    );
  }
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
  logger: AppSpecParseLogger,
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
    validateInjectShape(opts.inject, `${entryPath}.inject`, logger);
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
  logger: AppSpecParseLogger,
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
    validateInjectShape(opts.inject, `${entryPath}.inject`, logger);
    // `listen.kind` is the discovered material KIND (e.g. `mcp-server@v1`),
    // not an `inject` material SHAPE. It is intentionally open vocabulary —
    // operators publish their own kinds — and there is no known-kinds set to
    // compare against here, so we do not warn. (Previously this was compared
    // against KNOWN_LISTEN_SHAPES, an unrelated inject-shape set, which fired
    // a misleading warning for essentially every legitimate kind.)
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

/**
 * Validate an `inject` material-shape value. The string itself is open
 * vocabulary, but the parser rejects values that conflict with the
 * typing of {@link KNOWN_LISTEN_SHAPES} (whitespace / control chars
 * inside the token, leading/trailing whitespace) and warns when the
 * value is not one of the built-in shapes so operators can audit
 * unfamiliar entries.
 */
function validateInjectShape(
  value: string,
  path: string,
  logger: AppSpecParseLogger,
): void {
  if (containsControlChar(value) || /\s/.test(value)) {
    throw new AppSpecParseError(
      `${path} must be a single token without whitespace or control ` +
        `characters; conflicts with KNOWN_LISTEN_SHAPES typing`,
      "connection-resolution",
      path,
    );
  }
  if (!KNOWN_LISTEN_SHAPES.has(value)) {
    logger.warn(
      `inject value ${
        JSON.stringify(value)
      } is not a Takosumi known shape (env / secret-env / config-mount / ` +
        `upstream); treating as open-vocabulary operator shape`,
      path,
    );
  }
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
  // Recursively scan the spec subtree for forbidden prototype-pollution
  // keys (`__proto__`, `constructor`, `prototype`). Any occurrence is
  // surfaced as a closed-envelope `forbidden_field` error rather than
  // silently dropped, so authors learn the spec rejected the key.
  rejectForbiddenSpecKeys(raw, path);
  return raw as NonNullable<Component["spec"]>;
}

/**
 * Recursively walk `value` and throw if a forbidden prototype-pollution
 * key is present. Arrays and plain objects are descended; primitives
 * are ignored. Cycles in the YAML graph are not possible under
 * `@std/yaml` v1 default options, but we still guard with a visited
 * set to keep the check robust if upstream changes that.
 */
function rejectForbiddenSpecKeys(value: unknown, path: string): void {
  const visited = new WeakSet<object>();
  const walk = (node: unknown, nodePath: string): void => {
    if (node === null || typeof node !== "object") return;
    if (visited.has(node as object)) return;
    visited.add(node as object);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], `${nodePath}[${i}]`);
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    // Use Object.keys + hasOwnProperty.call to avoid inheriting any
    // prototype-tagged keys from a hostile parser output.
    for (const key of Object.keys(obj)) {
      if (FORBIDDEN_SPEC_KEYS.has(key)) {
        throw new AppSpecParseError(
          `forbidden_field: ${nodePath} contains forbidden key ${
            JSON.stringify(key)
          }`,
          "forbidden-field",
          `${nodePath}.${key}`,
        );
      }
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        walk(obj[key], `${nodePath}.${key}`);
      }
    }
  };
  walk(value, path);
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

/**
 * Iterative DFS cycle detector. We use an explicit work stack of
 * `{ node, iter }` frames instead of recursion so deep connect graphs
 * cannot overflow the V8 call stack on hostile inputs. The closed
 * `connect_cycle` envelope shape is preserved: phase
 * `connection-resolution`, message `connect cycle: a → b → ... → a`,
 * path `$.components.<offending-node>`.
 */
function detectCycles(adjacency: Map<string, string[]>): void {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const node of adjacency.keys()) color.set(node, WHITE);

  type Frame = { node: string; iter: Iterator<string> };
  const pathStack: string[] = [];

  for (const root of adjacency.keys()) {
    if (color.get(root) !== WHITE) continue;

    // Each work-stack frame owns an iterator over the node's
    // remaining out-edges. When the iterator is exhausted we pop the
    // frame and mark the node BLACK.
    const workStack: Frame[] = [];
    color.set(root, GRAY);
    pathStack.push(root);
    workStack.push({
      node: root,
      iter: (adjacency.get(root) ?? [])[Symbol.iterator](),
    });

    while (workStack.length > 0) {
      const frame = workStack[workStack.length - 1]!;
      const next = frame.iter.next();
      if (next.done) {
        color.set(frame.node, BLACK);
        pathStack.pop();
        workStack.pop();
        continue;
      }
      const dep = next.value;
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        const cycleStart = pathStack.indexOf(dep);
        throw new AppSpecParseError(
          `connect cycle: ${pathStack.slice(cycleStart).join(" → ")} → ${dep}`,
          "connection-resolution",
          `$.components.${dep}`,
        );
      }
      if (depColor === WHITE) {
        color.set(dep, GRAY);
        pathStack.push(dep);
        workStack.push({
          node: dep,
          iter: (adjacency.get(dep) ?? [])[Symbol.iterator](),
        });
      }
      // depColor === BLACK: already fully explored; skip silently.
    }
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
  if (!isPlatformServicePath(value)) {
    throw new AppSpecParseError(
      `${path} must be a platform service path with 3 to 8 dot-separated local-name segments`,
      "connection-resolution",
      path,
    );
  }
  // Reserved namespace guard. The first segment may not collide with
  // operator-distribution / platform reservations:
  //
  //   - `takosumi.*` — reserved for Takosumi core publications.
  //   - `system.*`   — reserved for operator-distribution / platform
  //                    publications.
  //   - `_*`         — reserved for internal namespaces. The
  //                    local-name pattern in the contract already
  //                    forbids underscore-prefixed segments, but the
  //                    explicit guard keeps the rule documented at the
  //                    parser boundary too.
  const firstSegment = value.split(".")[0]!;
  if (
    RESERVED_PATH_FIRST_SEGMENTS.has(firstSegment) ||
    firstSegment.startsWith("_")
  ) {
    throw new AppSpecParseError(
      `${path} uses reserved namespace prefix ${
        JSON.stringify(firstSegment)
      }; reserved prefixes are takosumi.*, system.*, and underscore-prefixed`,
      "connection-resolution",
      path,
    );
  }
  return value;
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
