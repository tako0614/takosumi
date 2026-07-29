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
  "takosumi.com/v1alpha1" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_KIND = "Repository" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_PATH =
  ".well-known/takosumi.json" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_MAX_BYTES = 128 * 1024;
export const TAKOSUMI_INSTALL_UX_MAX_MODULES = 32;
export const TAKOSUMI_INSTALL_UX_MAX_INPUTS = 128;
export const TAKOSUMI_INSTALL_UX_MAX_PROJECTIONS = 16;
export const TAKOSUMI_INSTALL_UX_MAX_FEATURES = 32;

export interface RepositoryInstallUxText {
  readonly ja: string;
  readonly en: string;
}

export type RepositoryInstallUxInputSource =
  | { readonly kind: "user" }
  | { readonly kind: "capsule_name" }
  | { readonly kind: "workspace_scoped_capsule_name" }
  | { readonly kind: "module_default" };

export interface RepositoryInstallUxInput {
  readonly name: string;
  readonly source: RepositoryInstallUxInputSource;
  readonly type?: "string" | "number" | "boolean" | "json";
  readonly format?: string;
  readonly required?: boolean;
  readonly label: RepositoryInstallUxText;
  readonly helper?: RepositoryInstallUxText;
  readonly placeholder?: string;
  readonly advanced?: boolean;
  readonly secret?: boolean;
}

export type RepositoryInstallUxProjection =
  | {
      readonly kind: "service_name";
      readonly variable: string;
    }
  | {
      readonly kind: "public_endpoint";
      readonly variables: {
        readonly subdomain?: string;
        readonly url?: string;
        readonly routePattern?: string;
      };
    }
  | {
      readonly kind: "initial_secret";
      readonly variable: string;
      readonly secretKind?: "password" | "password_or_hash" | "token";
      readonly optional?: boolean;
    }
  | {
      readonly kind: "oidc_client";
      readonly variables: {
        readonly issuerUrl?: string;
        readonly accountsUrl?: string;
        readonly clientId?: string;
        readonly redirectUri?: string;
      };
      readonly callbackPath: string;
      readonly scopes?: readonly string[];
    }
  | {
      readonly kind: "artifact";
      readonly variables: {
        readonly url?: string;
        readonly sha256?: string;
      };
    };

export interface RepositoryInstallUxFeature {
  readonly id: string;
  readonly optional: boolean;
  readonly label: RepositoryInstallUxText;
  readonly inputs: readonly string[];
}

export interface RepositoryInstallUxModule {
  readonly inputs: readonly RepositoryInstallUxInput[];
  readonly installExperience?: {
    readonly projections: readonly RepositoryInstallUxProjection[];
  };
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
  const keys = exactKeys(value, [
    "inputs",
    "installExperience",
    "features",
  ]);
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

  const installExperience = parseInstallExperience(
    value.installExperience,
    prefix,
  );
  if (typeof installExperience === "string") return installExperience;
  const features = parseFeatures(value.features, prefix, inputNames);
  if (typeof features === "string") return features;

  return {
    inputs,
    ...(installExperience ? { installExperience } : {}),
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

function parseInstallExperience(
  value: unknown,
  prefix: string,
):
  | RepositoryInstallUxModule["installExperience"]
  | string
  | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    return `${prefix}.installExperience must be an object`;
  }
  const keys = exactKeys(value, ["projections"]);
  if (keys) return `${prefix}.installExperience.${keys}`;
  if (!Array.isArray(value.projections)) {
    return `${prefix}.installExperience.projections must be an array`;
  }
  if (value.projections.length > TAKOSUMI_INSTALL_UX_MAX_PROJECTIONS) {
    return `${prefix}.installExperience.projections must contain no more than 16 entries`;
  }
  const projections: RepositoryInstallUxProjection[] = [];
  const kinds = new Set<RepositoryInstallUxProjection["kind"]>();
  for (let index = 0; index < value.projections.length; index += 1) {
    const projectionPrefix =
      `${prefix}.installExperience.projections[${index}]`;
    const parsed = parseProjection(
      value.projections[index],
      projectionPrefix,
    );
    if (typeof parsed === "string") return parsed;
    if (kinds.has(parsed.kind)) {
      return `${projectionPrefix}.kind must be unique`;
    }
    kinds.add(parsed.kind);
    projections.push(parsed);
  }
  return { projections };
}

function parseProjection(
  value: unknown,
  prefix: string,
): RepositoryInstallUxProjection | string {
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  switch (value.kind) {
    case "service_name": {
      const keys = exactKeys(value, ["kind", "variable"]);
      if (keys) return `${prefix}.${keys}`;
      const variable = variableName(value.variable);
      return variable
        ? { kind: "service_name", variable }
        : `${prefix}.variable must be a valid OpenTofu variable name`;
    }
    case "public_endpoint": {
      const keys = exactKeys(value, ["kind", "variables"]);
      if (keys) return `${prefix}.${keys}`;
      const variables = parseVariables(
        value.variables,
        `${prefix}.variables`,
        ["subdomain", "url", "routePattern"] as const,
      );
      return typeof variables === "string"
        ? variables
        : { kind: "public_endpoint", variables };
    }
    case "initial_secret": {
      const keys = exactKeys(value, [
        "kind",
        "variable",
        "secretKind",
        "optional",
      ]);
      if (keys) return `${prefix}.${keys}`;
      const variable = variableName(value.variable);
      if (!variable || variable === "env") {
        return `${prefix}.variable must be a secret-specific OpenTofu variable`;
      }
      const secretKind =
        value.secretKind === undefined
          ? undefined
          : oneOf(value.secretKind, [
              "password",
              "password_or_hash",
              "token",
            ] as const);
      if (value.secretKind !== undefined && !secretKind) {
        return `${prefix}.secretKind is unsupported`;
      }
      const optional = optionalBoolean(value.optional);
      if (value.optional !== undefined && optional === undefined) {
        return `${prefix}.optional must be a boolean`;
      }
      return {
        kind: "initial_secret",
        variable,
        ...(secretKind ? { secretKind } : {}),
        ...(optional !== undefined ? { optional } : {}),
      };
    }
    case "oidc_client": {
      const keys = exactKeys(value, [
        "kind",
        "variables",
        "callbackPath",
        "scopes",
      ]);
      if (keys) return `${prefix}.${keys}`;
      const variables = parseVariables(
        value.variables,
        `${prefix}.variables`,
        ["issuerUrl", "accountsUrl", "clientId", "redirectUri"] as const,
      );
      if (typeof variables === "string") return variables;
      const callbackPath = rootRelativePath(value.callbackPath);
      if (!callbackPath) {
        return `${prefix}.callbackPath must be a bounded root-relative path without an origin, query, or fragment`;
      }
      const scopes = parseScopes(value.scopes, prefix);
      if (typeof scopes === "string") return scopes;
      return {
        kind: "oidc_client",
        variables,
        callbackPath,
        ...(scopes ? { scopes } : {}),
      };
    }
    case "artifact": {
      const keys = exactKeys(value, ["kind", "variables"]);
      if (keys) return `${prefix}.${keys}`;
      const variables = parseVariables(
        value.variables,
        `${prefix}.variables`,
        ["url", "sha256"] as const,
      );
      return typeof variables === "string"
        ? variables
        : { kind: "artifact", variables };
    }
    default:
      return `${prefix}.kind is unsupported`;
  }
}

function parseVariables<const K extends string>(
  value: unknown,
  prefix: string,
  allowed: readonly K[],
): Readonly<Partial<Record<K, string>>> | string {
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, allowed);
  if (keys) return `${prefix}.${keys}`;
  const variables: Partial<Record<K, string>> = {};
  for (const key of allowed) {
    if (value[key] === undefined) continue;
    const variable = variableName(value[key]);
    if (!variable) {
      return `${prefix}.${key} must be a valid OpenTofu variable name`;
    }
    variables[key] = variable;
  }
  if (Object.keys(variables).length === 0) {
    return `${prefix} must contain at least one variable`;
  }
  return variables;
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
