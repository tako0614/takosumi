import type { JsonValue } from "./types.ts";
import type { SourceBuildConfig } from "./install-configs.ts";
import { containsSecretLikeString, isSecretKey } from "./redaction.ts";

/**
 * Optional, repository-owned metadata proposed by the exact Git commit captured
 * in a SourceSnapshot.
 *
 * The manifest is an extensible envelope, but every API version is a closed
 * object. Version 1 carries only install presentation. Version 2 adds generic
 * Capsule-owned Interface proposals. Version 2.1 retains that exact module
 * vocabulary and adds the legacy `defaultModule` hint. Version 2.2 adds
 * provider-neutral requests to consume a host Interface.
 * Version 2.3 adds an optional credential-free sourceBuild proposal per
 * module. Earlier versions remain closed and reject that field.
 * Every declaration is still only a proposal until Takosumi validates and
 * compiles it into its DB-owned InstallConfig before a reviewed Plan can use it.
 */

export const TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION =
  "takosumi.com/v1" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2 =
  "takosumi.com/v2" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_1 =
  "takosumi.com/v2.1" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2 =
  "takosumi.com/v2.2" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3 =
  "takosumi.com/v2.3" as const;
export const TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_4 =
  "takosumi.com/v2.4" as const;
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
export const TAKOSUMI_REPOSITORY_INTERFACE_MAX_ENTRIES = 32;
export const TAKOSUMI_REPOSITORY_INTERFACE_MAX_INPUTS = 64;
export const TAKOSUMI_REPOSITORY_INTERFACE_MAX_BINDING_REQUESTS = 16;
export const TAKOSUMI_REPOSITORY_INTERFACE_MAX_PERMISSIONS = 16;

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

/** OIDC slots delivered to ordinary OpenTofu module variables. */
export type RepositoryOidcVariableSlot =
  "issuerUrl" | "accountsUrl" | "clientId" | "redirectUri";
/** OIDC slots delivered to the runtime binding environment. */
export type RepositoryOidcBindingSlot =
  "issuerUrl" | "clientId" | "ownerSubject" | "redirectUri";
/** Compatibility union for callers that only need the complete slot set. */
export type RepositoryOidcSlot =
  | RepositoryOidcVariableSlot
  | RepositoryOidcBindingSlot;
export type RepositoryEndpointSlot = "url" | "subdomain" | "routePattern";
export type RepositorySecretSlot = "value";

export interface RepositoryConsumedInterfaceRequirement {
  readonly kind: "interface.consume";
  /** Stable identity within the selected module. */
  readonly key: string;
  /** Provider-neutral runtime contract selector; display names are irrelevant. */
  readonly interface: {
    readonly type: string;
    readonly version: string;
  };
  readonly permissions: readonly string[];
  /** Credential values are never delivered through repository metadata. */
  readonly delivery: { readonly type: string };
}

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
      readonly deliver:
        | RepositoryRuntimeDelivery<RepositoryOidcVariableSlot>
        | RepositoryRuntimeDelivery<RepositoryOidcBindingSlot>;
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
    }
  | RepositoryConsumedInterfaceRequirement;

/** Public output types that a Capsule Interface may consume. */
export type RepositoryInterfaceOutputType =
  "string" | "url" | "hostname" | "number" | "boolean" | "json";

/** The only two input forms a repository may propose for a Capsule Interface. */
export type RepositoryInterfaceInput =
  | {
      readonly source: "literal";
      /** Non-secret JSON document material owned by the repository. */
      readonly value: JsonValue;
    }
  | {
      readonly source: "output";
      /** Exact root-module Output name; no Output-name convention is inferred. */
      readonly outputName: string;
      /** The public projection type requested for that exact Output. */
      readonly outputType: RepositoryInterfaceOutputType;
    };

export interface RepositoryInterfaceAccess {
  readonly visibility: "private" | "workspace" | "public";
  readonly policyRef?: string;
  readonly resourceUriInput?: string;
}

export interface RepositoryInterfaceBindingRequest {
  readonly key: string;
  /** The only subject a repository-owned declaration may request. */
  readonly subject: { readonly source: "installing_principal" };
  readonly permissions: readonly string[];
  /** Delivery remains an operator-policy decision; it is never a credential. */
  readonly delivery: { readonly type: string };
}

export interface RepositoryInterfaceDeclaration {
  /** Stable identity used for deterministic InstallConfig merging later. */
  readonly key: string;
  readonly name: string;
  readonly spec: {
    readonly type: string;
    readonly version: string;
    readonly document: JsonValue;
    readonly inputs?: Readonly<Record<string, RepositoryInterfaceInput>>;
    readonly access: RepositoryInterfaceAccess;
  };
  /** Requests are proposals, not grants; the host resolves the installer later. */
  readonly bindingRequests?: readonly RepositoryInterfaceBindingRequest[];
}

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
  /** Present only in the closed v2+ vocabularies. */
  readonly interfaces?: readonly RepositoryInterfaceDeclaration[];
}

export type RepositoryInstallUxModuleV1 = Omit<
  RepositoryInstallUxModule,
  "interfaces"
> & { readonly interfaces?: never };

export interface RepositoryManifestInstallV1 {
  readonly modules: Readonly<Record<string, RepositoryInstallUxModuleV1>>;
}

export interface RepositoryManifestInstallV2 {
  readonly modules: Readonly<Record<string, RepositoryInstallUxModule>>;
}

export interface RepositoryManifestInstallV2_1 {
  readonly modules: Readonly<Record<string, RepositoryInstallUxModule>>;
  /**
   * Compatibility-only presentation hint from the published v2.1 wire.
   * Module execution authority remains the SourceSnapshot scan plus the
   * installer's explicit selection.
   */
  readonly defaultModule?: string;
}

export interface RepositoryManifestInstallV2_2 {
  readonly modules: Readonly<Record<string, RepositoryInstallUxModule>>;
  /** @see RepositoryManifestInstallV2_1.defaultModule */
  readonly defaultModule?: string;
}

export interface RepositoryInstallUxModuleV2_3 extends RepositoryInstallUxModule {
  /** Credential-free argv build proposal, reviewed before Plan. */
  readonly sourceBuild?: SourceBuildConfig;
}

/** v2.4 retains v2.3 and adds the closed runtime OIDC binding slots. */
export interface RepositoryInstallUxModuleV2_4 extends RepositoryInstallUxModuleV2_3 {}

export interface RepositoryManifestInstallV2_3 {
  readonly modules: Readonly<Record<string, RepositoryInstallUxModuleV2_3>>;
  /** @see RepositoryManifestInstallV2_1.defaultModule */
  readonly defaultModule?: string;
}

export interface RepositoryManifestInstallV2_4 {
  readonly modules: Readonly<Record<string, RepositoryInstallUxModuleV2_4>>;
}

/** Compatibility alias for callers that only need the install envelope. */
export type RepositoryManifestInstall =
  | RepositoryManifestInstallV1
  | RepositoryManifestInstallV2
  | RepositoryManifestInstallV2_1
  | RepositoryManifestInstallV2_2
  | RepositoryManifestInstallV2_3
  | RepositoryManifestInstallV2_4;

export interface RepositoryManifestDocumentV1 {
  readonly apiVersion: typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION;
  readonly kind: typeof TAKOSUMI_REPOSITORY_MANIFEST_KIND;
  readonly install: RepositoryManifestInstallV1;
}

export interface RepositoryManifestDocumentV2 {
  readonly apiVersion: typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2;
  readonly kind: typeof TAKOSUMI_REPOSITORY_MANIFEST_KIND;
  readonly install: RepositoryManifestInstallV2;
}

export interface RepositoryManifestDocumentV2_1 {
  readonly apiVersion: typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_1;
  readonly kind: typeof TAKOSUMI_REPOSITORY_MANIFEST_KIND;
  readonly install: RepositoryManifestInstallV2_1;
}

export interface RepositoryManifestDocumentV2_2 {
  readonly apiVersion: typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2;
  readonly kind: typeof TAKOSUMI_REPOSITORY_MANIFEST_KIND;
  readonly install: RepositoryManifestInstallV2_2;
}

export interface RepositoryManifestDocumentV2_3 {
  readonly apiVersion: typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3;
  readonly kind: typeof TAKOSUMI_REPOSITORY_MANIFEST_KIND;
  readonly install: RepositoryManifestInstallV2_3;
}

export interface RepositoryManifestDocumentV2_4 {
  readonly apiVersion: typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_4;
  readonly kind: typeof TAKOSUMI_REPOSITORY_MANIFEST_KIND;
  readonly install: RepositoryManifestInstallV2_4;
}

export type RepositoryManifestDocument =
  | RepositoryManifestDocumentV1
  | RepositoryManifestDocumentV2
  | RepositoryManifestDocumentV2_1
  | RepositoryManifestDocumentV2_2
  | RepositoryManifestDocumentV2_3
  | RepositoryManifestDocumentV2_4;

export type RepositoryManifestInterfaceApiVersion =
  | typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2
  | typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_1
  | typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2
  | typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3
  | typeof TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_4;

/** v2.1 through v2.4 retain the full v2 provided-Interface wire. */
export function isRepositoryManifestInterfaceCapableApiVersion(
  apiVersion: RepositoryManifestDocument["apiVersion"] | string,
): apiVersion is RepositoryManifestInterfaceApiVersion {
  return (
    apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2 ||
    apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_1 ||
    apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2 ||
    apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3 ||
    apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_4
  );
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
  const apiVersion = oneOf(value.apiVersion, [
    TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION,
    TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2,
    TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_1,
    TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2,
    TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3,
    TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_4,
  ] as const);
  if (!apiVersion) {
    return invalid(
      `apiVersion must be ${TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION}, ${TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2}, ${TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_1}, ${TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2}, ${TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3}, or ${TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_4}`,
    );
  }
  if (value.kind !== TAKOSUMI_REPOSITORY_MANIFEST_KIND) {
    return invalid(`kind must be ${TAKOSUMI_REPOSITORY_MANIFEST_KIND}`);
  }
  if (!isPlainRecord(value.install)) {
    return invalid("install must be an object");
  }
  const acceptsLegacyDefaultModule =
    apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_1 ||
    apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2 ||
    apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3;
  const installKeys = exactKeys(value.install, [
    "modules",
    ...(acceptsLegacyDefaultModule ? ["defaultModule"] : []),
  ]);
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
    const parsed = parseModule(
      rawModule,
      modulePath,
      isRepositoryManifestInterfaceCapableApiVersion(apiVersion),
      apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2 ||
        apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3 ||
        apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_4,
      apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3 ||
        apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_4,
      apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_4,
    );
    if (typeof parsed === "string") return invalid(parsed);
    modules[modulePath] = parsed;
  }
  const defaultModule = acceptsLegacyDefaultModule
    ? value.install.defaultModule
    : undefined;
  if (defaultModule !== undefined) {
    if (
      typeof defaultModule !== "string" ||
      !isCanonicalModulePath(defaultModule)
    ) {
      return invalid(
        "install.defaultModule must be a canonical safe relative module path",
      );
    }
    if (!Object.prototype.hasOwnProperty.call(modules, defaultModule)) {
      return invalid(
        "install.defaultModule must name an exact install.modules key",
      );
    }
  }
  return {
    ok: true,
    document: {
      apiVersion,
      kind: TAKOSUMI_REPOSITORY_MANIFEST_KIND,
      install: {
        modules,
        ...(defaultModule !== undefined ? { defaultModule } : {}),
      },
    } as RepositoryManifestDocument,
  };
}

function parseModule(
  value: unknown,
  modulePath: string,
  allowInterfaces: boolean,
  allowConsumedInterfaces: boolean,
  allowSourceBuild: boolean,
  allowRuntimeOidcBindings: boolean,
): RepositoryInstallUxModule | string {
  const prefix = `install.modules.${JSON.stringify(modulePath)}`;
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, [
    "inputs",
    "requires",
    "features",
    ...(allowInterfaces ? ["interfaces"] : []),
    ...(allowSourceBuild ? ["sourceBuild"] : []),
  ]);
  if (keys) return `${prefix}.${keys}`;
  if (!Array.isArray(value.inputs)) return `${prefix}.inputs must be an array`;
  if (value.inputs.length > TAKOSUMI_INSTALL_UX_MAX_INPUTS) {
    return `${prefix}.inputs must contain no more than 128 entries`;
  }
  const inputs: RepositoryInstallUxInput[] = [];
  const inputNames = new Set<string>();
  for (let index = 0; index < value.inputs.length; index += 1) {
    const parsed = parseInput(
      value.inputs[index],
      `${prefix}.inputs[${index}]`,
    );
    if (typeof parsed === "string") return parsed;
    if (inputNames.has(parsed.name)) {
      return `${prefix}.inputs[${index}].name must be unique`;
    }
    inputNames.add(parsed.name);
    inputs.push(parsed);
  }

  const requires = parseRequirements(
    value.requires,
    prefix,
    allowConsumedInterfaces,
    allowRuntimeOidcBindings,
  );
  if (typeof requires === "string") return requires;
  const features = parseFeatures(value.features, prefix, inputNames);
  if (typeof features === "string") return features;

  const interfaces = allowInterfaces
    ? parseInterfaces(value.interfaces, prefix)
    : undefined;
  if (typeof interfaces === "string") return interfaces;

  const sourceBuild = allowSourceBuild
    ? parseRepositorySourceBuild(value.sourceBuild, `${prefix}.sourceBuild`)
    : undefined;
  if (typeof sourceBuild === "string") return sourceBuild;

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
    ...(interfaces ? { interfaces } : {}),
    ...(sourceBuild ? { sourceBuild } : {}),
  };
}

/**
 * Parse the v2.3 credential-free source preparation proposal. The shape is
 * intentionally the same as InstallConfig SourceBuildConfig, but the
 * manifest parser keeps the object closed so repository metadata cannot add an
 * env map, credential reference, or another execution knob.
 */
export function parseRepositorySourceBuild(
  value: unknown,
  prefix = "sourceBuild",
): SourceBuildConfig | string | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, ["commands", "outputs"]);
  if (keys) return `${prefix}.${keys}`;
  if (
    !Array.isArray(value.commands) ||
    value.commands.length < 1 ||
    value.commands.length > 8
  ) {
    return `${prefix}.commands must contain 1-8 commands`;
  }
  if (
    !Array.isArray(value.outputs) ||
    value.outputs.length < 1 ||
    value.outputs.length > 16
  ) {
    return `${prefix}.outputs must contain 1-16 paths`;
  }

  const commands: SourceBuildConfig["commands"][number][] = [];
  for (let index = 0; index < value.commands.length; index += 1) {
    const commandPrefix = `${prefix}.commands[${index}]`;
    const rawCommand = value.commands[index];
    if (!isPlainRecord(rawCommand)) {
      return `${commandPrefix} must be an object`;
    }
    const commandKeys = exactKeys(rawCommand, ["argv", "workingDirectory"]);
    if (commandKeys) return `${commandPrefix}.${commandKeys}`;
    if (
      !Array.isArray(rawCommand.argv) ||
      rawCommand.argv.length < 1 ||
      rawCommand.argv.length > 32
    ) {
      return `${commandPrefix}.argv must contain 1-32 arguments`;
    }
    const argv: string[] = [];
    for (
      let argumentIndex = 0;
      argumentIndex < rawCommand.argv.length;
      argumentIndex += 1
    ) {
      const argument = rawCommand.argv[argumentIndex];
      if (
        typeof argument !== "string" ||
        codePointLength(argument) < 1 ||
        codePointLength(argument) > 4096 ||
        argument.includes("\0")
      ) {
        return `${commandPrefix}.argv[${argumentIndex}] must be a bounded non-empty argument without NUL`;
      }
      if (containsSecretLikeString(argument)) {
        return `${commandPrefix}.argv[${argumentIndex}] contains forbidden secret-like material`;
      }
      argv.push(argument);
    }
    const workingDirectory = sourceBuildRelativePath(
      rawCommand.workingDirectory,
    );
    if (
      rawCommand.workingDirectory !== undefined &&
      workingDirectory === undefined
    ) {
      return `${commandPrefix}.workingDirectory must be a safe relative path`;
    }
    commands.push({
      argv,
      ...(workingDirectory ? { workingDirectory } : {}),
    });
  }

  const outputs: string[] = [];
  for (let index = 0; index < value.outputs.length; index += 1) {
    const output = sourceBuildRelativePath(value.outputs[index]);
    if (!output || output === ".") {
      return `${prefix}.outputs[${index}] must be a safe relative produced path`;
    }
    outputs.push(output);
  }
  return { commands, outputs };
}

function sourceBuildRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || codePointLength(value) > 1_024) {
    return undefined;
  }
  const raw = value;
  if (
    !raw ||
    raw !== raw.trim() ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/u.test(raw) ||
    raw.includes("\\") ||
    /[\u0000-\u001f\u007f\u2028\u2029]/u.test(raw)
  ) {
    return undefined;
  }
  if (raw === ".") return raw;
  const segments = raw.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return undefined;
  }
  return raw;
}

/** Exact path predicate shared with the Runner's final source-root jail. */
export function isRepositorySourceBuildRelativePath(
  value: unknown,
): value is string {
  return sourceBuildRelativePath(value) !== undefined;
}

/** Source-build outputs are paths, never the checkout root itself. */
export function isRepositorySourceBuildOutputPath(
  value: unknown,
): value is string {
  return value !== "." && sourceBuildRelativePath(value) !== undefined;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function parseInterfaces(
  value: unknown,
  prefix: string,
): readonly RepositoryInterfaceDeclaration[] | string | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > TAKOSUMI_REPOSITORY_INTERFACE_MAX_ENTRIES
  ) {
    return `${prefix}.interfaces must be an array of no more than ${TAKOSUMI_REPOSITORY_INTERFACE_MAX_ENTRIES} entries`;
  }
  const declarations: RepositoryInterfaceDeclaration[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  const outputTypes = new Map<string, RepositoryInterfaceOutputType>();
  for (let index = 0; index < value.length; index += 1) {
    const entryPrefix = `${prefix}.interfaces[${index}]`;
    const parsed = parseInterfaceDeclaration(value[index], entryPrefix);
    if (typeof parsed === "string") return parsed;
    if (keys.has(parsed.key)) {
      return `${entryPrefix}.key must be unique`;
    }
    if (names.has(parsed.name)) {
      return `${entryPrefix}.name must be unique`;
    }
    keys.add(parsed.key);
    names.add(parsed.name);
    for (const input of Object.values(parsed.spec.inputs ?? {})) {
      if (input.source !== "output") continue;
      const prior = outputTypes.get(input.outputName);
      if (prior !== undefined && prior !== input.outputType) {
        return `${entryPrefix}.spec.inputs output ${JSON.stringify(input.outputName)} has conflicting outputType declarations`;
      }
      outputTypes.set(input.outputName, input.outputType);
    }
    declarations.push(parsed);
  }
  return declarations;
}

function parseInterfaceDeclaration(
  value: unknown,
  prefix: string,
): RepositoryInterfaceDeclaration | string {
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, ["key", "name", "spec", "bindingRequests"]);
  if (keys) return `${prefix}.${keys}`;
  const key = token(value.key, 128);
  if (!key) return `${prefix}.key must be a bounded token`;
  const name = interfaceName(value.name);
  if (!name) {
    return `${prefix}.name must start with a letter and contain only letters, digits, dot, underscore, or hyphen`;
  }
  if (!isPlainRecord(value.spec)) return `${prefix}.spec must be an object`;
  const specKeys = exactKeys(value.spec, [
    "type",
    "version",
    "document",
    "inputs",
    "access",
  ]);
  if (specKeys) return `${prefix}.spec.${specKeys}`;
  const type = token(value.spec.type, 256);
  if (!type) return `${prefix}.spec.type must be a bounded token`;
  const version = token(value.spec.version, 256);
  if (!version) return `${prefix}.spec.version must be a bounded token`;
  if (!isJsonValue(value.spec.document)) {
    return `${prefix}.spec.document must be valid JSON`;
  }
  const forbiddenDocumentField = findForbiddenRepositoryManifestMaterial(
    value.spec.document,
  );
  if (forbiddenDocumentField) {
    return `${prefix}.spec.document contains forbidden secret or authority material ${JSON.stringify(forbiddenDocumentField)}`;
  }
  const inputs = parseInterfaceInputs(value.spec.inputs, `${prefix}.spec`);
  if (typeof inputs === "string") return inputs;
  const access = parseInterfaceAccess(
    value.spec.access,
    `${prefix}.spec.access`,
  );
  if (typeof access === "string") return access;
  if (
    access.resourceUriInput !== undefined &&
    (inputs === undefined ||
      !Object.prototype.hasOwnProperty.call(inputs, access.resourceUriInput))
  ) {
    return `${prefix}.spec.access.resourceUriInput must name a declared interface input`;
  }
  const bindingRequests = parseInterfaceBindingRequests(
    value.bindingRequests,
    prefix,
  );
  if (typeof bindingRequests === "string") return bindingRequests;
  return {
    key,
    name,
    spec: {
      type,
      version,
      document: value.spec.document,
      ...(inputs ? { inputs } : {}),
      access,
    },
    ...(bindingRequests ? { bindingRequests } : {}),
  };
}

function parseInterfaceInputs(
  value: unknown,
  prefix: string,
): Readonly<Record<string, RepositoryInterfaceInput>> | string | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return `${prefix}.inputs must be an object`;
  const entries = Object.entries(value);
  if (entries.length > TAKOSUMI_REPOSITORY_INTERFACE_MAX_INPUTS) {
    return `${prefix}.inputs must contain no more than ${TAKOSUMI_REPOSITORY_INTERFACE_MAX_INPUTS} entries`;
  }
  const inputs: Record<string, RepositoryInterfaceInput> = Object.create(null);
  for (const [name, raw] of entries) {
    if (!interfaceName(name)) {
      return `${prefix}.inputs.${JSON.stringify(name)} must be a valid Interface input name`;
    }
    const inputPrefix = `${prefix}.inputs.${JSON.stringify(name)}`;
    if (!isPlainRecord(raw)) return `${inputPrefix} must be an object`;
    if (raw.source === "literal") {
      const keys = exactKeys(raw, ["source", "value"]);
      if (keys) return `${inputPrefix}.${keys}`;
      if (!isJsonValue(raw.value)) {
        return `${inputPrefix}.value must be valid JSON`;
      }
      const forbiddenLiteralField = findForbiddenRepositoryManifestMaterial(
        raw.value,
      );
      if (forbiddenLiteralField) {
        return `${inputPrefix}.value contains forbidden secret or authority material ${JSON.stringify(forbiddenLiteralField)}`;
      }
      inputs[name] = { source: "literal", value: raw.value };
      continue;
    }
    if (raw.source === "output") {
      const keys = exactKeys(raw, ["source", "outputName", "outputType"]);
      if (keys) return `${inputPrefix}.${keys}`;
      const outputName = variableName(raw.outputName);
      if (!outputName) {
        return `${inputPrefix}.outputName must be a valid OpenTofu output name`;
      }
      const outputType = oneOf(raw.outputType, [
        "string",
        "url",
        "hostname",
        "number",
        "boolean",
        "json",
      ] as const);
      if (!outputType) {
        return `${inputPrefix}.outputType is unsupported`;
      }
      inputs[name] = { source: "output", outputName, outputType };
      continue;
    }
    return `${inputPrefix}.source is unsupported`;
  }
  return inputs;
}

function parseInterfaceAccess(
  value: unknown,
  prefix: string,
): RepositoryInterfaceAccess | string {
  if (!isPlainRecord(value)) return `${prefix} must be an object`;
  const keys = exactKeys(value, [
    "visibility",
    "policyRef",
    "resourceUriInput",
  ]);
  if (keys) return `${prefix}.${keys}`;
  const visibility = oneOf(value.visibility, [
    "private",
    "workspace",
    "public",
  ] as const);
  if (!visibility) return `${prefix}.visibility is unsupported`;
  if (visibility !== "workspace") {
    return `${prefix}.visibility must be workspace for repository-owned Interfaces`;
  }
  if (value.policyRef !== undefined) {
    return `${prefix}.policyRef is host-owned and cannot be supplied by a repository`;
  }
  const resourceUriInput =
    value.resourceUriInput === undefined
      ? undefined
      : interfaceName(value.resourceUriInput);
  if (value.resourceUriInput !== undefined && !resourceUriInput) {
    return `${prefix}.resourceUriInput must be a valid Interface input name`;
  }
  return {
    visibility,
    ...(resourceUriInput ? { resourceUriInput } : {}),
  };
}

function parseInterfaceBindingRequests(
  value: unknown,
  prefix: string,
): readonly RepositoryInterfaceBindingRequest[] | string | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > TAKOSUMI_REPOSITORY_INTERFACE_MAX_BINDING_REQUESTS
  ) {
    return `${prefix}.bindingRequests must be an array of no more than ${TAKOSUMI_REPOSITORY_INTERFACE_MAX_BINDING_REQUESTS} entries`;
  }
  if (value.length > 1) {
    return `${prefix}.bindingRequests must contain at most one installing_principal request`;
  }
  const requests: RepositoryInterfaceBindingRequest[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entryPrefix = `${prefix}.bindingRequests[${index}]`;
    const raw = value[index];
    if (!isPlainRecord(raw)) return `${entryPrefix} must be an object`;
    const allowedKeys = exactKeys(raw, [
      "key",
      "subject",
      "permissions",
      "delivery",
    ]);
    if (allowedKeys) return `${entryPrefix}.${allowedKeys}`;
    const key = token(raw.key, 128);
    if (!key) return `${entryPrefix}.key must be a bounded token`;
    if (keys.has(key)) return `${entryPrefix}.key must be unique`;
    keys.add(key);
    if (!isPlainRecord(raw.subject)) {
      return `${entryPrefix}.subject must be an object`;
    }
    const subjectKeys = exactKeys(raw.subject, ["source"]);
    if (subjectKeys) return `${entryPrefix}.subject.${subjectKeys}`;
    if (raw.subject.source !== "installing_principal") {
      return `${entryPrefix}.subject.source must be installing_principal`;
    }
    if (
      !Array.isArray(raw.permissions) ||
      raw.permissions.length < 1 ||
      raw.permissions.length > TAKOSUMI_REPOSITORY_INTERFACE_MAX_PERMISSIONS
    ) {
      return `${entryPrefix}.permissions must contain between 1 and ${TAKOSUMI_REPOSITORY_INTERFACE_MAX_PERMISSIONS} entries`;
    }
    const permissions: string[] = [];
    const permissionSet = new Set<string>();
    for (
      let permissionIndex = 0;
      permissionIndex < raw.permissions.length;
      permissionIndex += 1
    ) {
      const permission = interfacePermissionToken(
        raw.permissions[permissionIndex],
      );
      if (!permission) {
        return `${entryPrefix}.permissions[${permissionIndex}] must be a bounded permission token`;
      }
      if (permissionSet.has(permission)) {
        return `${entryPrefix}.permissions[${permissionIndex}] must be unique`;
      }
      permissionSet.add(permission);
      permissions.push(permission);
    }
    if (!isPlainRecord(raw.delivery)) {
      return `${entryPrefix}.delivery must be an object`;
    }
    const deliveryKeys = exactKeys(raw.delivery, ["type"]);
    if (deliveryKeys) return `${entryPrefix}.delivery.${deliveryKeys}`;
    const deliveryType = token(raw.delivery.type, 128);
    if (!deliveryType) {
      return `${entryPrefix}.delivery.type must be a bounded token`;
    }
    requests.push({
      key,
      subject: { source: "installing_principal" },
      permissions,
      delivery: { type: deliveryType },
    });
  }
  return requests;
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
  const forbiddenPlaceholder = placeholder
    ? findForbiddenRepositoryManifestMaterial(placeholder)
    : undefined;
  if (forbiddenPlaceholder) {
    return `${prefix}.placeholder contains forbidden secret or authority material ${JSON.stringify(forbiddenPlaceholder)}`;
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
  allowConsumedInterfaces: boolean,
  allowRuntimeOidcBindings: boolean,
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
    const parsed = parseRequirement(
      value[index],
      entryPrefix,
      allowConsumedInterfaces,
      allowRuntimeOidcBindings,
    );
    if (typeof parsed === "string") return parsed;
    // Only a generated secret is plural: an app may need several, but one
    // identity and one endpoint are the whole of what a module can hold.
    if (parsed.kind === "secret.generated") {
      generatedSecrets += 1;
      if (generatedSecrets > TAKOSUMI_MAX_GENERATED_SECRETS_PER_MODULE) {
        return `${prefix}.requires declares more than 8 generated secrets`;
      }
    } else if (parsed.kind === "interface.consume") {
      if (singletons.has(`interface.consume:${parsed.key}`)) {
        return `${entryPrefix}.key must be unique`;
      }
      singletons.add(`interface.consume:${parsed.key}`);
    } else if (singletons.has(parsed.kind)) {
      return `${entryPrefix}.kind must be unique`;
    } else {
      singletons.add(parsed.kind);
    }
    if (!("deliver" in parsed)) {
      requirements.push(parsed);
      continue;
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
  allowConsumedInterfaces: boolean,
  allowRuntimeOidcBindings: boolean,
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
      const deliver = parseOidcDelivery(
        value.deliver,
        `${prefix}.deliver`,
        allowRuntimeOidcBindings,
      );
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
    case "interface.consume": {
      if (!allowConsumedInterfaces) return `${prefix}.kind is unsupported`;
      const keys = exactKeys(value, [
        "kind",
        "key",
        "interface",
        "permissions",
        "delivery",
      ]);
      if (keys) return `${prefix}.${keys}`;
      const key = token(value.key, 128);
      if (!key) return `${prefix}.key must be a bounded token`;
      if (!isPlainRecord(value.interface)) {
        return `${prefix}.interface must be an object`;
      }
      const interfaceKeys = exactKeys(value.interface, ["type", "version"]);
      if (interfaceKeys) return `${prefix}.interface.${interfaceKeys}`;
      const interfaceType = token(value.interface.type, 128);
      const interfaceVersion = token(value.interface.version, 128);
      if (!interfaceType) {
        return `${prefix}.interface.type must be a bounded token`;
      }
      if (!interfaceVersion) {
        return `${prefix}.interface.version must be a bounded token`;
      }
      const permissions = parseInterfacePermissionList(
        value.permissions,
        `${prefix}.permissions`,
      );
      if (typeof permissions === "string") return permissions;
      if (!isPlainRecord(value.delivery)) {
        return `${prefix}.delivery must be an object`;
      }
      const deliveryKeys = exactKeys(value.delivery, ["type"]);
      if (deliveryKeys) return `${prefix}.delivery.${deliveryKeys}`;
      const deliveryType = token(value.delivery.type, 128);
      if (!deliveryType) {
        return `${prefix}.delivery.type must be a bounded token`;
      }
      return {
        kind: "interface.consume",
        key,
        interface: { type: interfaceType, version: interfaceVersion },
        permissions,
        delivery: { type: deliveryType },
      };
    }
    default:
      return `${prefix}.kind is unsupported`;
  }
}

/**
 * A delivery names exactly one target surface. Accepting both at once would
 * let one requirement be satisfied twice through different authorities.
 */
function parseOidcDelivery(
  value: unknown,
  prefix: string,
  allowRuntimeOidcBindings: boolean,
):
  | RepositoryRuntimeDelivery<RepositoryOidcVariableSlot>
  | RepositoryRuntimeDelivery<RepositoryOidcBindingSlot>
  | string {
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
      ["issuerUrl", "accountsUrl", "clientId", "redirectUri"] as const,
      variableName,
      "a valid OpenTofu variable name",
    );
    return typeof variables === "string" ? variables : { variables };
  }
  const bindings = parseTargets(
    value.bindings,
    `${prefix}.bindings`,
    allowRuntimeOidcBindings
      ? (["issuerUrl", "clientId", "ownerSubject", "redirectUri"] as const)
      : (["issuerUrl", "accountsUrl", "clientId", "redirectUri"] as const),
    bindingName,
    "a valid runtime binding name",
  );
  return typeof bindings === "string" ? bindings : { bindings };
}

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
  deliver: Exclude<
    RepositoryRuntimeRequirement,
    RepositoryConsumedInterfaceRequirement
  >["deliver"],
): Readonly<Record<string, string>> {
  return (
    "variables" in deliver ? deliver.variables : deliver.bindings
  ) as Readonly<Record<string, string>>;
}

/** True when a requirement is satisfied by writing module input variables. */
export function deliversToVariables(
  deliver: Exclude<
    RepositoryRuntimeRequirement,
    RepositoryConsumedInterfaceRequirement
  >["deliver"],
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

function parseInterfacePermissionList(
  value: unknown,
  prefix: string,
): readonly string[] | string {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > TAKOSUMI_REPOSITORY_INTERFACE_MAX_PERMISSIONS
  ) {
    return `${prefix} must contain between 1 and ${TAKOSUMI_REPOSITORY_INTERFACE_MAX_PERMISSIONS} entries`;
  }
  const permissions: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const permission = interfacePermissionToken(value[index]);
    if (!permission) {
      return `${prefix}[${index}] must be a bounded permission token`;
    }
    if (seen.has(permission)) return `${prefix}[${index}] must be unique`;
    seen.add(permission);
    permissions.push(permission);
  }
  return permissions;
}

function parseFeatures(
  value: unknown,
  prefix: string,
  inputNames: ReadonlySet<string>,
): readonly RepositoryInstallUxFeature[] | string | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > TAKOSUMI_INSTALL_UX_MAX_FEATURES
  ) {
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
  const forbidden = findForbiddenRepositoryManifestMaterial(value);
  if (forbidden) {
    return `${prefix} contains forbidden secret or authority material ${JSON.stringify(forbidden)}`;
  }
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
  const parsed = canonicalText(value, max);
  return parsed && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(parsed)
    ? parsed
    : undefined;
}

function optionalToken(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : token(value, max);
}

function variableName(value: unknown): string | undefined {
  const parsed = canonicalText(value, 128);
  return parsed && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(parsed)
    ? parsed
    : undefined;
}

/**
 * Runtime binding names land in the application's own environment, so the
 * grammar is the conventional binding/env shape rather than a Tofu variable.
 */
function bindingName(value: unknown): string | undefined {
  const parsed = canonicalText(value, 128);
  return parsed && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(parsed)
    ? parsed
    : undefined;
}

function interfaceName(value: unknown): string | undefined {
  const parsed = canonicalText(value, 128);
  return parsed && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(parsed)
    ? parsed
    : undefined;
}

function interfacePermissionToken(value: unknown): string | undefined {
  const parsed = canonicalText(value, 256);
  return parsed && /^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(parsed)
    ? parsed
    : undefined;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}

/**
 * Repository-owned public values are metadata, not secret storage. Reuse the
 * canonical redaction vocabulary for both key and value detection, then add
 * the authority-id names that are unsafe even when they are not secrets.
 * Return only a bounded field/marker so diagnostics never echo the value.
 */
export function findForbiddenRepositoryManifestMaterial(
  value: unknown,
  depth = 0,
): string | undefined {
  if (depth > 32) return "<nested-value>";
  if (typeof value === "string") {
    return containsSecretLikeString(value) ? "<secret-like-string>" : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForbiddenRepositoryManifestMaterial(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isPlainRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key) || isRepositoryAuthorityKey(key)) {
      return key.slice(0, 128);
    }
    const found = findForbiddenRepositoryManifestMaterial(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function isRepositoryAuthorityKey(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[_\-\s]/gu, "");
  return /^(?:provider|credential|account|host|target|capsule|resource|workspace|principal|connection|project|installation|runner)(?:id|ref)?$/u.test(
    normalized,
  );
}

function stableId(value: unknown): string | undefined {
  const parsed = canonicalText(value, 96);
  return parsed && /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u.test(parsed)
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

/**
 * Identifier fields are wire keys, not user prose. Do not trim them before
 * validation: the published schema rejects leading/trailing whitespace and
 * the parser must make the same accept/reject decision.
 */
function canonicalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length > max) return undefined;
  if (value.length === 0 || value.trim() !== value) return undefined;
  if (/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  return value;
}

function isCanonicalModulePath(value: string): boolean {
  if (
    !value ||
    value.trim() !== value ||
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
