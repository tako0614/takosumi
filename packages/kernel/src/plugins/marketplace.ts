import { createHash } from "node:crypto";
import type { Digest, JsonObject, JsonValue } from "takosumi-contract";
import { stableStringify } from "../adapters/source/digest.ts";
import {
  type ExecutableCatalogHookPackage,
  executableCatalogHookPackageFromModule,
} from "./executable_hooks.ts";
import {
  installTrustedKernelPlugins,
  TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
  type TrustedKernelPluginInstallPolicy,
  type TrustedKernelPluginManifestEnvelope,
  type TrustedKernelPluginPublisherKey,
} from "./trusted_install.ts";
import type { TakosPaaSKernelPlugin } from "./types.ts";

export const TAKOSUMI_PLUGIN_MARKETPLACE_SCHEMA_VERSION =
  "takosumi.plugin-marketplace.v1" as const;
export const TAKOSUMI_PLUGIN_MARKETPLACE_JSONLD_CONTEXT =
  "https://takosumi.com/contexts/plugin-marketplace-v1.jsonld" as const;

export type KernelPluginMarketplaceJsonLdContext =
  | string
  | JsonObject
  | readonly (string | JsonObject)[];

export type KernelPluginMarketplacePackageKind =
  | "kernel-plugin"
  | "executable-hook-package";

export interface KernelPluginMarketplaceIndex {
  readonly "@context"?: KernelPluginMarketplaceJsonLdContext;
  readonly schemaVersion: typeof TAKOSUMI_PLUGIN_MARKETPLACE_SCHEMA_VERSION;
  readonly marketplaceId: string;
  readonly generatedAt: string;
  readonly packages: readonly KernelPluginMarketplacePackage[];
  readonly metadata?: JsonObject;
}

export interface KernelPluginMarketplacePackage {
  readonly packageRef: string;
  readonly kind: KernelPluginMarketplacePackageKind;
  readonly version: string;
  readonly manifestEnvelope: TrustedKernelPluginManifestEnvelope;
  readonly module: KernelPluginMarketplaceModule;
  readonly metadata?: JsonObject;
}

export interface KernelPluginMarketplaceModule {
  readonly specifier: string;
  readonly digest: Digest;
  readonly mediaType?: string;
}

export interface FetchKernelPluginMarketplaceIndexOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
}

export interface InstallKernelPluginMarketplacePackagesInput {
  readonly indexes: readonly KernelPluginMarketplaceIndex[];
  readonly packageRefs: readonly string[];
  readonly trustedKeys: readonly TrustedKernelPluginPublisherKey[];
  readonly policy: TrustedKernelPluginInstallPolicy;
  readonly environment: string;
  readonly fetch?: typeof fetch;
}

export interface InstalledKernelPluginMarketplacePackage {
  readonly packageRef: string;
  readonly kind: KernelPluginMarketplacePackageKind;
  readonly version: string;
  readonly moduleDigest: Digest;
  readonly plugins: readonly TakosPaaSKernelPlugin[];
  readonly hookPackages: readonly ExecutableCatalogHookPackage[];
}

export interface InstallKernelPluginMarketplacePackagesResult {
  readonly packages: readonly InstalledKernelPluginMarketplacePackage[];
  readonly plugins: readonly TakosPaaSKernelPlugin[];
  readonly hookPackages: readonly ExecutableCatalogHookPackage[];
}

export async function fetchKernelPluginMarketplaceIndex(
  options: FetchKernelPluginMarketplaceIndexOptions,
): Promise<KernelPluginMarketplaceIndex> {
  const response = await (options.fetch ?? fetch)(options.url);
  if (!response.ok) {
    throw new Error(
      `plugin marketplace fetch failed: ${options.url} ` +
        `HTTP ${response.status}`,
    );
  }
  const body = await response.json();
  return assertKernelPluginMarketplaceIndex(body, options.url);
}

export async function installKernelPluginMarketplacePackages(
  input: InstallKernelPluginMarketplacePackagesInput,
): Promise<InstallKernelPluginMarketplacePackagesResult> {
  const packageRecords = resolveMarketplacePackages({
    indexes: input.indexes,
    packageRefs: input.packageRefs,
  });
  const installedPackages: InstalledKernelPluginMarketplacePackage[] = [];
  const plugins: TakosPaaSKernelPlugin[] = [];
  const hookPackages: ExecutableCatalogHookPackage[] = [];

  for (const packageRecord of packageRecords) {
    assertMarketplaceModuleAllowed(packageRecord, input.policy);
    assertMarketplaceManifestBindsModule(packageRecord, input.policy);
    const module = await importVerifiedMarketplaceModule({
      module: packageRecord.module,
      fetch: input.fetch,
    });
    const hookPackage = executableCatalogHookPackageFromModule(
      module,
      packageRecord.module.specifier,
    );
    const modulePlugins = kernelPluginsFromModuleOrEmpty(
      module,
      packageRecord.module.specifier,
      hookPackage,
    );
    const signedModulePlugins = modulePlugins.map((plugin) =>
      bindMarketplacePluginManifest(plugin, packageRecord)
    );
    const trustPlugins = hookPackage
      ? [...signedModulePlugins, hookTrustPlugin(packageRecord)]
      : signedModulePlugins;
    const installed = await installTrustedKernelPlugins({
      envelopes: [packageRecord.manifestEnvelope],
      availablePlugins: trustPlugins,
      trustedKeys: input.trustedKeys,
      policy: input.policy,
      environment: input.environment,
    });
    const installedModulePlugins = installed.filter((plugin) =>
      signedModulePlugins.some((candidate) =>
        candidate.manifest.id === plugin.manifest.id
      )
    );
    plugins.push(...installedModulePlugins);
    if (hookPackage) hookPackages.push(hookPackage);
    installedPackages.push({
      packageRef: packageRecord.packageRef,
      kind: packageRecord.kind,
      version: packageRecord.version,
      moduleDigest: packageRecord.module.digest,
      plugins: Object.freeze([...installedModulePlugins]),
      hookPackages: Object.freeze(hookPackage ? [hookPackage] : []),
    });
  }

  return {
    packages: Object.freeze(installedPackages),
    plugins: Object.freeze(plugins),
    hookPackages: Object.freeze(hookPackages),
  };
}

export async function importVerifiedMarketplaceModule(input: {
  readonly module: KernelPluginMarketplaceModule;
  readonly fetch?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const source = await fetchModuleSource(input.module, input.fetch ?? fetch);
  const digest = sha256Digest(source);
  if (digest !== input.module.digest) {
    throw new Error(
      `plugin marketplace module digest mismatch for ` +
        `${input.module.specifier}: expected ${input.module.digest}, got ${digest}`,
    );
  }
  const mediaType = input.module.mediaType ?? "application/javascript";
  const dataUrl = `data:${mediaType};base64,${bytesToBase64(source)}`;
  return await import(dataUrl) as Record<string, unknown>;
}

function resolveMarketplacePackages(input: {
  readonly indexes: readonly KernelPluginMarketplaceIndex[];
  readonly packageRefs: readonly string[];
}): readonly KernelPluginMarketplacePackage[] {
  const packagesByRef = new Map<string, KernelPluginMarketplacePackage>();
  for (const index of input.indexes) {
    for (const packageRecord of index.packages) {
      packagesByRef.set(packageRecord.packageRef, packageRecord);
    }
  }
  return input.packageRefs.map((packageRef) => {
    const packageRecord = packagesByRef.get(packageRef);
    if (!packageRecord) {
      throw new Error(
        `plugin marketplace package not found: ${packageRef}`,
      );
    }
    return packageRecord;
  });
}

function kernelPluginsFromModuleOrEmpty(
  module: Record<string, unknown>,
  specifier: string,
  hookPackage: ExecutableCatalogHookPackage | undefined,
): readonly TakosPaaSKernelPlugin[] {
  const candidates = [
    module.default,
    module.plugin,
    module.plugins,
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
  const plugins = candidates.flatMap((value) =>
    Array.isArray(value) ? value : [value]
  ).filter((value) => value !== hookPackage) as TakosPaaSKernelPlugin[];
  if (plugins.length === 0) {
    if (hookPackage) return Object.freeze([]);
    throw new Error(`kernel plugin module exported no plugins: ${specifier}`);
  }
  return Object.freeze(plugins);
}

function assertKernelPluginMarketplaceIndex(
  value: unknown,
  source: string,
): KernelPluginMarketplaceIndex {
  if (!isRecord(value)) {
    throw new Error(`plugin marketplace index must be an object: ${source}`);
  }
  assertMarketplaceJsonLdContext(value["@context"], source);
  if (value.schemaVersion !== TAKOSUMI_PLUGIN_MARKETPLACE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported plugin marketplace schemaVersion: ${
        String(value.schemaVersion)
      }`,
    );
  }
  if (typeof value.marketplaceId !== "string" || !value.marketplaceId.trim()) {
    throw new Error(`plugin marketplace id is required: ${source}`);
  }
  if (typeof value.generatedAt !== "string" || !value.generatedAt.trim()) {
    throw new Error(`plugin marketplace generatedAt is required: ${source}`);
  }
  if (!Array.isArray(value.packages)) {
    throw new Error(`plugin marketplace packages must be an array: ${source}`);
  }
  return {
    ...(value["@context"] !== undefined
      ? {
        "@context": value[
          "@context"
        ] as KernelPluginMarketplaceJsonLdContext,
      }
      : {}),
    schemaVersion: TAKOSUMI_PLUGIN_MARKETPLACE_SCHEMA_VERSION,
    marketplaceId: value.marketplaceId,
    generatedAt: value.generatedAt,
    packages: Object.freeze(
      value.packages.map((item, index) =>
        assertMarketplacePackage(item, `${source}#packages[${index}]`)
      ),
    ),
    ...(isRecord(value.metadata)
      ? { metadata: value.metadata as JsonObject }
      : {}),
  };
}

function assertMarketplaceJsonLdContext(
  context: unknown,
  source: string,
): void {
  if (context === undefined) return;
  if (typeof context === "string" && context.trim()) return;
  if (isRecord(context) && isJsonValue(context)) return;
  if (Array.isArray(context) && context.length > 0) {
    const invalidIndex = context.findIndex((entry) =>
      !(
        (typeof entry === "string" && entry.trim()) ||
        (isRecord(entry) && isJsonValue(entry))
      )
    );
    if (invalidIndex < 0) return;
    throw new Error(
      `plugin marketplace @context entry is invalid: ` +
        `${source}#@context[${invalidIndex}]`,
    );
  }
  throw new Error(
    `plugin marketplace @context must be a non-empty string, ` +
      `JSON-LD context object, or non-empty array: ${source}`,
  );
}

function assertMarketplacePackage(
  value: unknown,
  source: string,
): KernelPluginMarketplacePackage {
  if (!isRecord(value)) {
    throw new Error(`plugin marketplace package must be an object: ${source}`);
  }
  if (typeof value.packageRef !== "string" || !value.packageRef.trim()) {
    throw new Error(`plugin marketplace packageRef is required: ${source}`);
  }
  if (
    value.kind !== "kernel-plugin" && value.kind !== "executable-hook-package"
  ) {
    throw new Error(
      `unsupported plugin marketplace package kind: ${String(value.kind)}`,
    );
  }
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error(
      `plugin marketplace package version is required: ${source}`,
    );
  }
  if (!isRecord(value.module)) {
    throw new Error(`plugin marketplace package module is required: ${source}`);
  }
  const module = assertMarketplaceModule(value.module, source);
  const envelope = assertMarketplaceManifestEnvelope(
    value.manifestEnvelope,
    source,
  );
  if (envelope.manifest.id !== value.packageRef) {
    throw new Error(
      `plugin marketplace packageRef must match signed manifest id: ${source}`,
    );
  }
  return {
    packageRef: value.packageRef,
    kind: value.kind,
    version: value.version,
    manifestEnvelope: envelope,
    module,
    ...(isRecord(value.metadata)
      ? { metadata: value.metadata as JsonObject }
      : {}),
  };
}

function assertMarketplaceManifestEnvelope(
  value: unknown,
  source: string,
): TrustedKernelPluginManifestEnvelope {
  if (!isRecord(value)) {
    throw new Error(
      `plugin marketplace package manifestEnvelope must be an object: ${source}`,
    );
  }
  // Downstream `installTrustedKernelPlugins` performs the full signature
  // verification and full manifest-shape validation; the marketplace layer
  // owns the structural envelope check needed for the digest+ref matching
  // that runs before signature verification.
  return {
    manifest: assertManifestEnvelopeManifest(value.manifest, source),
    signature: assertManifestEnvelopeSignature(value.signature, source),
  };
}

function assertManifestEnvelopeManifest(
  value: unknown,
  source: string,
): TrustedKernelPluginManifestEnvelope["manifest"] {
  if (!isRecord(value)) {
    throw new Error(
      `plugin marketplace package manifestEnvelope.manifest must be an object: ${source}`,
    );
  }
  const requiredString = (key: string): string => {
    const v = value[key];
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(
        `plugin marketplace package manifestEnvelope.manifest.${key} is required: ${source}`,
      );
    }
    return v;
  };
  if (!Array.isArray(value.capabilities)) {
    throw new Error(
      `plugin marketplace package manifestEnvelope.manifest.capabilities must be an array: ${source}`,
    );
  }
  const capabilities = value
    .capabilities as TrustedKernelPluginManifestEnvelope[
      "manifest"
    ]["capabilities"];
  return {
    id: requiredString("id"),
    name: requiredString("name"),
    version: requiredString("version"),
    kernelApiVersion: requiredString("kernelApiVersion"),
    capabilities,
    ...(isRecord(value.metadata)
      ? { metadata: value.metadata as JsonObject }
      : {}),
  };
}

function assertManifestEnvelopeSignature(
  value: unknown,
  source: string,
): TrustedKernelPluginManifestEnvelope["signature"] {
  if (!isRecord(value)) {
    throw new Error(
      `plugin marketplace package manifestEnvelope.signature must be an object: ${source}`,
    );
  }
  if (value.alg !== TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM) {
    throw new Error(
      `plugin marketplace package manifestEnvelope.signature.alg must be ${TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM}: ${source}`,
    );
  }
  if (typeof value.keyId !== "string" || !value.keyId.trim()) {
    throw new Error(
      `plugin marketplace package manifestEnvelope.signature.keyId is required: ${source}`,
    );
  }
  if (typeof value.value !== "string" || !value.value.trim()) {
    throw new Error(
      `plugin marketplace package manifestEnvelope.signature.value is required: ${source}`,
    );
  }
  return {
    alg: TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
    keyId: value.keyId,
    value: value.value,
  };
}

function assertMarketplaceModule(
  value: Record<string, unknown>,
  source: string,
): KernelPluginMarketplaceModule {
  if (typeof value.specifier !== "string" || !value.specifier.trim()) {
    throw new Error(
      `plugin marketplace module specifier is required: ${source}`,
    );
  }
  if (!isSha256Digest(value.digest)) {
    throw new Error(`plugin marketplace module digest is invalid: ${source}`);
  }
  return {
    specifier: value.specifier,
    digest: value.digest,
    ...(typeof value.mediaType === "string" && value.mediaType.trim()
      ? { mediaType: value.mediaType }
      : {}),
  };
}

function assertMarketplaceModuleAllowed(
  packageRecord: KernelPluginMarketplacePackage,
  policy: TrustedKernelPluginInstallPolicy,
): void {
  const specifier = packageRecord.module.specifier;
  const prefixes = policy.allowedModuleSpecifierPrefixes;
  if (prefixes && !prefixes.some((prefix) => specifier.startsWith(prefix))) {
    throw new Error(
      `plugin marketplace module is outside install policy: ${specifier}`,
    );
  }
  const protocol = protocolOf(specifier);
  if (protocol === "https:" || protocol === "data:") return;
  if (prefixes && prefixes.some((prefix) => specifier.startsWith(prefix))) {
    return;
  }
  throw new Error(
    `plugin marketplace module must use https: or an explicitly allowed ` +
      `specifier prefix: ${specifier}`,
  );
}

function assertMarketplaceManifestBindsModule(
  packageRecord: KernelPluginMarketplacePackage,
  policy: TrustedKernelPluginInstallPolicy,
): void {
  const provenance = implementationProvenance(
    packageRecord.manifestEnvelope.manifest.metadata,
  );
  if (!provenance) {
    if (policy.requireImplementationProvenance) {
      throw new Error(
        `plugin marketplace package ${packageRecord.packageRef} ` +
          `requires signed implementation provenance`,
      );
    }
    return;
  }
  if (
    typeof provenance.moduleSpecifier === "string" &&
    provenance.moduleSpecifier !== packageRecord.module.specifier
  ) {
    throw new Error(
      `plugin marketplace package ${packageRecord.packageRef} signed ` +
        `moduleSpecifier does not match marketplace module`,
    );
  }
  if (
    typeof provenance.moduleDigest === "string" &&
    provenance.moduleDigest !== packageRecord.module.digest
  ) {
    throw new Error(
      `plugin marketplace package ${packageRecord.packageRef} signed ` +
        `moduleDigest does not match marketplace module`,
    );
  }
  if (
    policy.requireRemoteModuleDigest && provenance.moduleDigest !==
      packageRecord.module.digest
  ) {
    throw new Error(
      `plugin marketplace package ${packageRecord.packageRef} must bind ` +
        `moduleDigest in signed provenance`,
    );
  }
}

async function fetchModuleSource(
  module: KernelPluginMarketplaceModule,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(module.specifier);
  if (!response.ok) {
    throw new Error(
      `plugin marketplace module fetch failed: ${module.specifier} ` +
        `HTTP ${response.status}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function hookTrustPlugin(
  packageRecord: KernelPluginMarketplacePackage,
): TakosPaaSKernelPlugin {
  return {
    manifest: packageRecord.manifestEnvelope.manifest,
    implementationProvenance: implementationProvenance(
      packageRecord.manifestEnvelope.manifest.metadata,
    ),
    createAdapters() {
      return {};
    },
  } as TakosPaaSKernelPlugin;
}

function bindMarketplacePluginManifest(
  plugin: TakosPaaSKernelPlugin,
  packageRecord: KernelPluginMarketplacePackage,
): TakosPaaSKernelPlugin {
  const signed = packageRecord.manifestEnvelope.manifest;
  if (plugin.manifest.id !== signed.id) {
    throw new Error(
      `plugin marketplace module ${packageRecord.module.specifier} exported ` +
        `plugin ${plugin.manifest.id}, expected ${signed.id}`,
    );
  }
  return {
    ...plugin,
    manifest: signed,
    implementationProvenance: implementationProvenance(signed.metadata),
  } as TakosPaaSKernelPlugin;
}

function implementationProvenance(
  metadata: JsonObject | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  if (isRecord(metadata.implementationProvenance)) {
    return metadata.implementationProvenance;
  }
  if (!isRecord(metadata.trustedInstall)) return undefined;
  return isRecord(metadata.trustedInstall.implementationProvenance)
    ? metadata.trustedInstall.implementationProvenance
    : undefined;
}

function protocolOf(specifier: string): string | undefined {
  try {
    return new URL(specifier).protocol;
  } catch {
    return undefined;
  }
}

function sha256Digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isSha256Digest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

export function marketplacePackageDigest(
  packageRecord: KernelPluginMarketplacePackage,
): Digest {
  return `sha256:${
    createHash("sha256").update(stableStringify(packageRecord)).digest("hex")
  }`;
}
