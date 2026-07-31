/**
 * Optional, repository-owned metadata proposed by the exact Git commit captured
 * in a SourceSnapshot.
 *
 * The manifest is an extensible envelope, but every API version is a closed
 * object. The current version carries only install presentation. It is never
 * execution authority: Takosumi validates and compiles an accepted module
 * declaration into its DB-owned InstallConfig before a reviewed Plan can use
 * it.
 */

export const TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION =
  "takosumi.com/v1" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_KIND = "Repository" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_PATH =
  ".well-known/takosumi.json" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_MAX_BYTES = 128 * 1024;
export const TAKOSUMI_INSTALL_UX_MAX_MODULES = 32;
export const TAKOSUMI_INSTALL_UX_MAX_INPUTS = 128;
export const TAKOSUMI_INSTALL_UX_MAX_REQUIREMENTS = 16;
export const TAKOSUMI_INSTALL_UX_MAX_FEATURES = 32;
/** Bounds on a repository-requested generated secret. */
export const TAKOSUMI_GENERATED_SECRET_MIN_BYTES = 16;
export const TAKOSUMI_GENERATED_SECRET_MAX_BYTES = 64;
export const TAKOSUMI_MAX_GENERATED_SECRETS_PER_MODULE = 8;

export interface RepositoryInstallUxText {
  readonly ja: string;
  readonly en: string;
}

export type RepositoryInstallUxInputSource =
  | { readonly kind: "user" }
  | { readonly kind: "capsule_name" }
  | { readonly kind: "workspace_scoped_capsule_name" }
  | { readonly kind: "module_default" };

/**
 * Semantic role of one declared input. The role names what a field *is* so the
 * installer can present it; it never changes how the value is sourced.
 */
export type RepositoryInstallUxInputRole = "service_name" | "initial_secret";

export interface RepositoryInstallUxInput {
  readonly name: string;
  readonly source: RepositoryInstallUxInputSource;
  readonly role?: RepositoryInstallUxInputRole;
  readonly type?: "string" | "number" | "boolean" | "json";
  readonly format?: string;
  readonly required?: boolean;
  readonly label: RepositoryInstallUxText;
  readonly helper?: RepositoryInstallUxText;
  readonly placeholder?: string;
  readonly advanced?: boolean;
  readonly secret?: boolean;
}

/**
 * Where a satisfied requirement is delivered.
 *
 * Exactly one target is chosen. `variables` suits a module system whose surface
 * is input variables; `bindings` suits a portable runtime whose surface is
 * named bindings and which therefore has no variable to receive the value.
 * The requirement itself is identical either way — only delivery differs.
 */
export type RepositoryRuntimeDelivery<K extends string> =
  | { readonly variables: Readonly<Partial<Record<K, string>>> }
  | { readonly bindings: Readonly<Partial<Record<K, string>>> };

export type RepositoryOidcSlot =
  | "issuerUrl"
  | "accountsUrl"
  | "clientId"
  | "redirectUri"
  | "ownerSubject";
export type RepositoryEndpointSlot = "url" | "subdomain" | "routePattern";
export type RepositorySecretSlot = "value";

/**
 * What the repository needs the host to provide before the app can run.
 *
 * A requirement is a request, never a value: the manifest is a public
 * repository file, so a resolved secret or credential must never appear in it.
 * Takosumi validates each requirement against operator policy and compiles it
 * into its own DB-owned InstallConfig before any Plan can use it.
 */
export type RepositoryRuntimeRequirement =
  | {
      readonly kind: "identity.oidc";
      readonly callbackPath: string;
      readonly scopes?: readonly string[];
      readonly deliver: RepositoryRuntimeDelivery<RepositoryOidcSlot>;
    }
  | {
      readonly kind: "secret.generated";
      readonly bytes?: number;
      readonly encoding?: "hex" | "base64url";
      readonly deliver: RepositoryRuntimeDelivery<RepositorySecretSlot>;
    }
  | {
      readonly kind: "http.endpoint";
      readonly deliver: RepositoryRuntimeDelivery<RepositoryEndpointSlot>;
    };

export interface RepositoryInstallUxFeature {
  readonly id: string;
  readonly optional: boolean;
  readonly label: RepositoryInstallUxText;
  readonly inputs: readonly string[];
}

export interface RepositoryInstallUxModule {
  readonly inputs: readonly RepositoryInstallUxInput[];
  readonly requires?: readonly RepositoryRuntimeRequirement[];
  readonly features?: readonly RepositoryInstallUxFeature[];
}

export interface RepositoryManifestInstall {
  readonly modules: Readonly<Record<string, RepositoryInstallUxModule>>;
}

export interface RepositoryManifestDocument {
  readonly apiVersion: typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION;
  readonly kind: typeof TAKOSUMI_REPOSITORY_MANIFEST_KIND;
  readonly install: RepositoryManifestInstall;
}

export type RepositoryManifestParseResult =
  | { readonly ok: true; readonly document: RepositoryManifestDocument }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a complete `.well-known/takosumi.json` document.
 *
 * The parser is deliberately exact: unknown fields and semantic kinds fail,
 * and all collections/strings are bounded. A later API version, rather than
 * permissive interpretation, is the forward-compatibility mechanism.
 */
export function parseRepositoryManifestText(
  text: string,
): RepositoryManifestParseResult {
  if (
    new TextEncoder().encode(text).byteLength >
      TAKOSUMI_REPOSITORY_MANIFEST_MAX_BYTES
  ) {
    return invalid("document exceeds 128 KiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("document must be valid JSON");
  }
  if (!isPlainRecord(value)) return invalid("document must be an object");
  const rootKeys = exactKeys(value, ["apiVersion", "kind", "install"]);
  if (rootKeys) return invalid(rootKeys);
  if (value.apiVersion !== TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION) {
    return invalid(
      `apiVersion must be ${TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION}`,
    );
  }
  if (value.kind !== TAKOSUMI_REPOSITORY_MANIFEST_KIND) {
    return invalid(`kind must be ${TAKOSUMI_REPOSITORY_MANIFEST_KIND}`);
  }
  if (!isPlainRecord(value.install)) {
    return invalid("install must be an object");
  }
  const installKeys = exactKeys(value.install, ["modules"]);
  if (installKeys) return invalid(`install.${installKeys}`);
  if (!isPlainRecord(value.install.modules)) {
    return invalid("install.modules must be an object");
  }
  const moduleEntries = Object.entries(value.install.modules);
  if (
    moduleEntries.length < 1 ||
    moduleEntries.length > TAKOSUMI_INSTALL_UX_MAX_MODULES
  ) {
    return invalid("install.modules must contain between 1 and 32 entries");
  }
  const modules: Record<string, RepositoryInstallUxModule> =
    Object.create(null);
  for (const [modulePath, rawModule] of moduleEntries) {
    if (!isCanonicalModulePath(modulePath)) {
      return invalid(
        `install.modules.${JSON.stringify(modulePath)} must be a canonical safe relative module path`,
      );
    }
    const parsed = parseModule(rawModule, modulePath);
    if (typeof parsed === "string") return invalid(parsed);
    modules[modulePath] = parsed;
  }
  return {
    ok: true,
    document: {
      apiVersion: TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION,
      kind: TAKOSUMI_REPOSITORY_MANIFEST_KIND,
      install: { modules },
    },
  };
}

function parseModule(
  value: unknown,
  modulePath: string,
): RepositoryInstallUxModule | string {
  const prefix = `install.modules.${JSON.stringify(modulePath)}`;
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, ["inputs", "requires", "features"]);
  if (keys) return `${prefix}.${keys}`;
  if (!Array.isArray(value.inputs)) return `${prefix}.inputs must be an array`;
  if (value.inputs.length > TAKOSUMI_INSTALL_UX_MAX_INPUTS) {
    return `${prefix}.inputs must contain no more than 128 entries`;
  }
  const inputs: RepositoryInstallUxInput[] = [];
  const inputNames = new Set<string>();
  for (let index = 0; index < value.inputs.length; index += 1) {
    const parsed = parseInput(value.inputs[index], `${prefix}.inputs[${index}]`);
    if (typeof parsed === "string") return parsed;
    if (inputNames.has(parsed.name)) {
      return `${prefix}.inputs[${index}].name must be unique`;
    }
    inputNames.add(parsed.name);
    inputs.push(parsed);
  }

  const requires = parseRequirements(value.requires, prefix);
  if (typeof requires === "string") return requires;
  const features = parseFeatures(value.features, prefix, inputNames);
  if (typeof features === "string") return features;

  const roles = new Set<string>();
  for (const input of inputs) {
    if (!input.role) continue;
    if (roles.has(input.role)) {
      return `${prefix}.inputs declares role ${input.role} more than once`;
    }
    roles.add(input.role);
  }

  return {
    inputs,
    ...(requires ? { requires } : {}),
    ...(features ? { features } : {}),
  };
}

function parseInput(
  value: unknown,
  prefix: string,
): RepositoryInstallUxInput | string {
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, [
    "name",
    "source",
    "role",
    "type",
    "format",
    "required",
    "label",
    "helper",
    "placeholder",
    "advanced",
    "secret",
  ]);
  if (keys) return `${prefix}.${keys}`;
  const name = variableName(value.name);
  if (!name) return `${prefix}.name must be a valid OpenTofu variable name`;
  const role =
    value.role === undefined
      ? undefined
      : oneOf(value.role, ["service_name", "initial_secret"] as const);
  if (value.role !== undefined && !role) {
    return `${prefix}.role is unsupported`;
  }
  if (role === "initial_secret" && name === "env") {
    return `${prefix}.role initial_secret requires a secret-specific variable`;
  }
  if (name === "env" && value.secret === true) {
    return `${prefix}.secret must not target the plain env variable`;
  }
  const source = parseInputSource(value.source, prefix);
  if (typeof source === "string") return source;
  const type =
    value.type === undefined
      ? undefined
      : oneOf(value.type, ["string", "number", "boolean", "json"] as const);
  if (value.type !== undefined && !type) {
    return `${prefix}.type is unsupported`;
  }
  const format = optionalToken(value.format, 64);
  if (value.format !== undefined && !format) {
    return `${prefix}.format must be a bounded format token`;
  }
  const required = optionalBoolean(value.required);
  if (value.required !== undefined && required === undefined) {
    return `${prefix}.required must be a boolean`;
  }
  const advanced = optionalBoolean(value.advanced);
  if (value.advanced !== undefined && advanced === undefined) {
    return `${prefix}.advanced must be a boolean`;
  }
  const secret = optionalBoolean(value.secret);
  if (value.secret !== undefined && secret === undefined) {
    return `${prefix}.secret must be a boolean`;
  }
  if (secret && source.kind !== "user") {
    return `${prefix}.secret is supported only for user input`;
  }
  if (source.kind === "module_default" && required === true) {
    return `${prefix}.required cannot be true for module_default`;
  }
  const label = localizedText(value.label, `${prefix}.label`, 160);
  if (typeof label === "string") return label;
  const helper =
    value.helper === undefined
      ? undefined
      : localizedText(value.helper, `${prefix}.helper`, 2_000);
  if (typeof helper === "string") return helper;
  const placeholder = optionalText(value.placeholder, 256);
  if (value.placeholder !== undefined && !placeholder) {
    return `${prefix}.placeholder must be a non-empty bounded string`;
  }
  return {
    name,
    source,
    ...(role ? { role } : {}),
    ...(type ? { type } : {}),
    ...(format ? { format } : {}),
    ...(required !== undefined ? { required } : {}),
    label,
    ...(helper ? { helper } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(advanced !== undefined ? { advanced } : {}),
    ...(secret !== undefined ? { secret } : {}),
  };
}

function parseInputSource(
  value: unknown,
  prefix: string,
): RepositoryInstallUxInputSource | string {
  if (!isPlainRecord(value)) return `${prefix}.source must be an object`;
  const keys = exactKeys(value, ["kind"]);
  if (keys) return `${prefix}.source.${keys}`;
  const kind = oneOf(value.kind, [
    "user",
    "capsule_name",
    "workspace_scoped_capsule_name",
    "module_default",
  ] as const);
  return kind ? { kind } : `${prefix}.source.kind is unsupported`;
}

function parseRequirements(
  value: unknown,
  prefix: string,
): readonly RepositoryRuntimeRequirement[] | string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return `${prefix}.requires must be an array`;
  if (value.length > TAKOSUMI_INSTALL_UX_MAX_REQUIREMENTS) {
    return `${prefix}.requires must contain no more than 16 entries`;
  }
  const requirements: RepositoryRuntimeRequirement[] = [];
  const singletons = new Set<string>();
  const deliveredNames = new Set<string>();
  let generatedSecrets = 0;
  for (let index = 0; index < value.length; index += 1) {
    const entryPrefix = `${prefix}.requires[${index}]`;
    const parsed = parseRequirement(value[index], entryPrefix);
    if (typeof parsed === "string") return parsed;
    // Only a generated secret is plural: an app may need several, but one
    // identity and one endpoint are the whole of what a module can hold.
    if (parsed.kind === "secret.generated") {
      generatedSecrets += 1;
      if (generatedSecrets > TAKOSUMI_MAX_GENERATED_SECRETS_PER_MODULE) {
        return `${prefix}.requires declares more than 8 generated secrets`;
      }
    } else if (singletons.has(parsed.kind)) {
      return `${entryPrefix}.kind must be unique`;
    } else {
      singletons.add(parsed.kind);
    }
    for (const name of Object.values(deliveryTargets(parsed.deliver))) {
      if (deliveredNames.has(name)) {
        return `${entryPrefix} delivers to ${name}, which another requirement already claims`;
      }
      deliveredNames.add(name);
    }
    requirements.push(parsed);
  }
  return requirements;
}

function parseRequirement(
  value: unknown,
  prefix: string,
): RepositoryRuntimeRequirement | string {
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  switch (value.kind) {
    case "identity.oidc": {
      const keys = exactKeys(value, [
        "kind",
        "callbackPath",
        "scopes",
        "deliver",
      ]);
      if (keys) return `${prefix}.${keys}`;
      const deliver = parseDelivery(value.deliver, `${prefix}.deliver`, [
        "issuerUrl",
        "accountsUrl",
        "clientId",
        "redirectUri",
        "ownerSubject",
      ] as const);
      if (typeof deliver === "string") return deliver;
      const callbackPath = rootRelativePath(value.callbackPath);
      if (!callbackPath) {
        return `${prefix}.callbackPath must be a bounded root-relative path without an origin, query, or fragment`;
      }
      const scopes = parseScopes(value.scopes, prefix);
      if (typeof scopes === "string") return scopes;
      return {
        kind: "identity.oidc",
        callbackPath,
        ...(scopes ? { scopes } : {}),
        deliver,
      };
    }
    case "secret.generated": {
      const keys = exactKeys(value, ["kind", "bytes", "encoding", "deliver"]);
      if (keys) return `${prefix}.${keys}`;
      const deliver = parseDelivery(value.deliver, `${prefix}.deliver`, [
        "value",
      ] as const);
      if (typeof deliver === "string") return deliver;
      let bytes: number | undefined;
      if (value.bytes !== undefined) {
        if (
          typeof value.bytes !== "number" ||
          !Number.isSafeInteger(value.bytes) ||
          value.bytes < TAKOSUMI_GENERATED_SECRET_MIN_BYTES ||
          value.bytes > TAKOSUMI_GENERATED_SECRET_MAX_BYTES
        ) {
          return `${prefix}.bytes must be an integer between 16 and 64`;
        }
        bytes = value.bytes;
      }
      const encoding =
        value.encoding === undefined
          ? undefined
          : oneOf(value.encoding, ["hex", "base64url"] as const);
      if (value.encoding !== undefined && !encoding) {
        return `${prefix}.encoding is unsupported`;
      }
      return {
        kind: "secret.generated",
        ...(bytes !== undefined ? { bytes } : {}),
        ...(encoding ? { encoding } : {}),
        deliver,
      };
    }
    case "http.endpoint": {
      const keys = exactKeys(value, ["kind", "deliver"]);
      if (keys) return `${prefix}.${keys}`;
      const deliver = parseDelivery(value.deliver, `${prefix}.deliver`, [
        "url",
        "subdomain",
        "routePattern",
      ] as const);
      return typeof deliver === "string"
        ? deliver
        : { kind: "http.endpoint", deliver };
    }
    default:
      return `${prefix}.kind is unsupported`;
  }
}

/**
 * A delivery names exactly one target surface. Accepting both at once would
 * let one requirement be satisfied twice through different authorities.
 */
function parseDelivery<const K extends string>(
  value: unknown,
  prefix: string,
  allowed: readonly K[],
): RepositoryRuntimeDelivery<K> | string {
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, ["variables", "bindings"]);
  if (keys) return `${prefix}.${keys}`;
  const hasVariables = value.variables !== undefined;
  const hasBindings = value.bindings !== undefined;
  if (hasVariables === hasBindings) {
    return `${prefix} must declare exactly one of variables or bindings`;
  }
  if (hasVariables) {
    const variables = parseTargets(
      value.variables,
      `${prefix}.variables`,
      allowed,
      variableName,
      "a valid OpenTofu variable name",
    );
    return typeof variables === "string" ? variables : { variables };
  }
  const bindings = parseTargets(
    value.bindings,
    `${prefix}.bindings`,
    allowed,
    bindingName,
    "a valid runtime binding name",
  );
  return typeof bindings === "string" ? bindings : { bindings };
}

function parseTargets<const K extends string>(
  value: unknown,
  prefix: string,
  allowed: readonly K[],
  parse: (value: unknown) => string | undefined,
  expectation: string,
): Readonly<Partial<Record<K, string>>> | string {
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, allowed);
  if (keys) return `${prefix}.${keys}`;
  const targets: Partial<Record<K, string>> = {};
  for (const key of allowed) {
    if (value[key] === undefined) continue;
    const parsed = parse(value[key]);
    if (!parsed) return `${prefix}.${key} must be ${expectation}`;
    targets[key] = parsed;
  }
  if (Object.keys(targets).length === 0) {
    return `${prefix} must name at least one target`;
  }
  return targets;
}

/** The names one requirement writes, whichever surface it delivers to. */
export function deliveryTargets(
  deliver: RepositoryRuntimeRequirement["deliver"],
): Readonly<Record<string, string>> {
  return ("variables" in deliver ? deliver.variables : deliver.bindings) as
    Readonly<Record<string, string>>;
}

/** True when a requirement is satisfied by writing module input variables. */
export function deliversToVariables(
  deliver: RepositoryRuntimeRequirement["deliver"],
): boolean {
  return "variables" in deliver;
}

function parseScopes(
  value: unknown,
  prefix: string,
): readonly string[] | string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    return `${prefix}.scopes must contain between 1 and 16 entries`;
  }
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const scope = token(value[index], 128);
    if (!scope) return `${prefix}.scopes[${index}] must be a bounded token`;
    if (seen.has(scope)) return `${prefix}.scopes[${index}] must be unique`;
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes;
}

function parseFeatures(
  value: unknown,
  prefix: string,
  inputNames: ReadonlySet<string>,
): readonly RepositoryInstallUxFeature[] | string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > TAKOSUMI_INSTALL_UX_MAX_FEATURES) {
    return `${prefix}.features must be an array of no more than 32 entries`;
  }
  const features: RepositoryInstallUxFeature[] = [];
  const ids = new Set<string>();
  const claimedInputs = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const featurePrefix = `${prefix}.features[${index}]`;
    const raw = value[index];
    if (!isPlainRecord(raw)) return `${featurePrefix} must be an object`;
    const keys = exactKeys(raw, ["id", "optional", "label", "inputs"]);
    if (keys) return `${featurePrefix}.${keys}`;
    const id = stableId(raw.id);
    if (!id) return `${featurePrefix}.id must be a stable identifier`;
    if (ids.has(id)) return `${featurePrefix}.id must be unique`;
    ids.add(id);
    if (typeof raw.optional !== "boolean") {
      return `${featurePrefix}.optional must be a boolean`;
    }
    const label = localizedText(raw.label, `${featurePrefix}.label`, 160);
    if (typeof label === "string") return label;
    if (!Array.isArray(raw.inputs) || raw.inputs.length < 1) {
      return `${featurePrefix}.inputs must be a non-empty array`;
    }
    const featureInputs: string[] = [];
    const localInputs = new Set<string>();
    for (let inputIndex = 0; inputIndex < raw.inputs.length; inputIndex += 1) {
      const name = variableName(raw.inputs[inputIndex]);
      if (!name || !inputNames.has(name)) {
        return `${featurePrefix}.inputs[${inputIndex}] must reference a declared input`;
      }
      if (localInputs.has(name) || claimedInputs.has(name)) {
        return `${featurePrefix}.inputs[${inputIndex}] must be unique across features`;
      }
      localInputs.add(name);
      claimedInputs.add(name);
      featureInputs.push(name);
    }
    features.push({
      id,
      optional: raw.optional,
      label,
      inputs: featureInputs,
    });
  }
  return features;
}

function localizedText(
  value: unknown,
  prefix: string,
  max: number,
): RepositoryInstallUxText | string {
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, ["ja", "en"]);
  if (keys) return `${prefix}.${keys}`;
  const ja = text(value.ja, max);
  const en = text(value.en, max);
  return ja && en
    ? { ja, en }
    : `${prefix}.ja and ${prefix}.en must be non-empty bounded strings`;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  return unexpected ? `contains unsupported field ${unexpected}` : undefined;
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function text(value: unknown, max: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function optionalText(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : text(value, max);
}

function token(value: unknown, max: number): string | undefined {
  const parsed = text(value, max);
  return parsed && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(parsed)
    ? parsed
    : undefined;
}

function optionalToken(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : token(value, max);
}

function variableName(value: unknown): string | undefined {
  const parsed = text(value, 128);
  return parsed && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(parsed)
    ? parsed
    : undefined;
}

/**
 * Runtime binding names land in the application's own environment, so the
 * grammar is the conventional binding/env shape rather than a Tofu variable.
 */
function bindingName(value: unknown): string | undefined {
  const parsed = text(value, 128);
  return parsed && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(parsed)
    ? parsed
    : undefined;
}

function stableId(value: unknown): string | undefined {
  const parsed = text(value, 96);
  return parsed &&
    /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u.test(parsed)
    ? parsed
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function oneOf<const T extends string>(
  value: unknown,
  values: readonly T[],
): T | undefined {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : undefined;
}

function rootRelativePath(value: unknown): string | undefined {
  const parsed = text(value, 512);
  if (
    !parsed ||
    !parsed.startsWith("/") ||
    parsed.startsWith("//") ||
    /[?#\\]/u.test(parsed)
  ) {
    return undefined;
  }
  const segments = parsed.split("/");
  return segments.some((segment) => segment === "." || segment === "..")
    ? undefined
    : parsed;
}

function isCanonicalModulePath(value: string): boolean {
  if (
    !value ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  if (value === ".") return true;
  return !value
    .split("/")
    .some((segment) => !segment || segment === "." || segment === "..");
}

function invalid(error: string): RepositoryManifestParseResult {
  return { ok: false, error };
}
