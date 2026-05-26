/**
 * Adapter helper that wraps an existing `ProviderPlugin` instance as a
 * `KernelPlugin`.
 *
 * The wrapper is intentionally thin: it forwards `component.spec` (passed
 * through the AppSpec installer pipeline as opaque JSON) to the underlying
 * provider's `apply()` / `destroy()`, and surfaces the resource handle as
 * `resourceHandle` for the kernel's internal apply evidence.
 *
 * Single-source-of-truth: this adapter lives in `@takos/takosumi-contract`
 * (Phase K iteration 2 consolidation) so kind packages import the same
 * implementation instead of shipping
 * byte-identical 140-line copies. `KernelPlugin` is the current reference
 * adapter API; `ProviderPlugin` is the legacy shape/provider surface this
 * bridge quarantines for older packages.
 */

import type { JsonObject } from "./types.ts";
import type { PlatformContext, ProviderPlugin } from "./provider-plugin.ts";
import type { PreparedSourceLocator } from "./runtime-agent-lifecycle.ts";
import {
  isOfficialOutputTypeName,
  validateOfficialOutputMaterial,
} from "./type-catalog.ts";
import type {
  KernelPlugin,
  KernelPluginApplyContext,
  NamespaceMaterial,
  ResolvedListenBinding,
} from "./plugin.ts";

/**
 * Build a `KernelPlugin` that delegates `apply()` / `destroy()` to an
 * underlying `ProviderPlugin`. The kind URI must match the descriptor URI
 * the underlying provider materializes.
 *
 * `ProviderPlugin` is generic over `Spec` / `Outputs` types; this compatibility
 * adapter erases to the generic JsonObject form so each kind package can pass
 * its typed ProviderPlugin without manual casts at the call site.
 */
export function kernelPluginFromProviderPlugin(
  opts: {
    // deno-lint-ignore no-explicit-any
    readonly provider: ProviderPlugin<any, any, any>;
    readonly kindUri: string;
    readonly capabilities?: readonly string[];
  },
): KernelPlugin {
  const provider = opts.provider as unknown as ProviderPlugin;
  const capabilities = opts.capabilities ??
    (provider.capabilities as readonly string[]);
  return {
    name: provider.id,
    version: provider.version,
    provides: [opts.kindUri],
    capabilities,
    async apply(ctx) {
      const spec = mergeResolvedBindingsIntoSpec(
        (ctx.component.spec ?? {}) as JsonObject,
        ctx.resolvedBindings,
      );
      const result = await provider.apply(
        spec,
        synthesizePlatformContext(ctx),
      );
      return {
        resourceHandle: result.handle,
        outputs: result.outputs ?? {},
      };
    },
    publishMaterial(ctx) {
      return Promise.resolve(
        providerOutputsToNamespaceMaterial(ctx.outputs, ctx.options.as),
      );
    },
    async destroy(ctx) {
      await provider.destroy(
        ctx.resourceHandle,
        synthesizePlatformContext({ installationId: ctx.installationId }),
      );
    },
  };
}

function providerOutputsToNamespaceMaterial(
  outputs: JsonObject,
  contract?: string,
): NamespaceMaterial {
  const generic = rawProviderOutputsToNamespaceMaterial(outputs);
  if (contract === undefined || !isOfficialOutputTypeName(contract)) {
    return generic;
  }
  const material = projectOfficialMaterial(contract, generic);
  const issues = validateOfficialOutputMaterial(contract, material);
  if (issues.length > 0) {
    throw new Error(
      `provider outputs cannot be projected to ${contract} material: ${
        issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
      }`,
    );
  }
  return material;
}

function rawProviderOutputsToNamespaceMaterial(
  outputs: JsonObject,
): NamespaceMaterial {
  const material: Record<string, JsonObject[string] | { secretRef: string }> =
    {};
  for (const [key, value] of Object.entries(outputs)) {
    material[key] = secretRefMaterial(key, value) ?? value;
  }
  return material;
}

function projectOfficialMaterial(
  contract: string,
  material: NamespaceMaterial,
): NamespaceMaterial {
  switch (contract) {
    case "http-endpoint":
      return projectHttpEndpointMaterial(material);
    case "service-binding":
      return projectServiceBindingMaterial(material);
    case "object-store":
      return projectObjectStoreMaterial(material);
    default:
      return material;
  }
}

function projectHttpEndpointMaterial(
  material: NamespaceMaterial,
): NamespaceMaterial {
  if (Array.isArray(material.targets) || Array.isArray(material.endpoints)) {
    return material;
  }
  const url = readString(material.url);
  const host = readString(material.host) ?? readString(material.internalHost);
  const port = readNumber(material.port) ?? readNumber(material.internalPort);
  const listener = readString(material.listener);
  const scheme = readString(material.scheme);
  const routes = readRouteSummaries(material.routes);
  if (listener || scheme || routes) {
    if (!url) return material;
    const endpoint: Record<string, JsonObject[string]> = {
      url,
      visibility: "public",
      primary: true,
    };
    if (scheme) endpoint.scheme = scheme;
    if (host) endpoint.host = host;
    if (listener) endpoint.listener = listener;
    if (routes) endpoint.routes = routes;
    return { endpoints: [endpoint] };
  }
  if (!url && !(host && port !== undefined)) return material;
  const target: Record<string, JsonObject[string]> = {
    name: "default",
    visibility: "private",
  };
  if (url) target.url = url;
  if (host) target.host = host;
  if (port !== undefined) target.port = port;
  const protocol = readString(material.protocol);
  if (protocol) target.protocol = protocol;
  const basePath = readString(material.basePath);
  if (basePath) target.basePath = basePath;
  return { targets: [target] };
}

function projectServiceBindingMaterial(
  material: NamespaceMaterial,
): NamespaceMaterial {
  if (
    readString(material.protocol) &&
    readString(material.host) &&
    readNumber(material.port) !== undefined &&
    material.passwordSecretRef === undefined &&
    material.connectionString === undefined
  ) {
    return material;
  }
  const host = readString(material.host);
  const port = readNumber(material.port);
  if (!host || port === undefined) return material;
  const out: Record<string, JsonObject[string] | { secretRef: string }> = {
    protocol: readString(material.protocol) ?? inferServiceProtocol(material),
    host,
    port,
  };
  const service = readString(material.service);
  if (service) out.service = service;
  const database = readString(material.database);
  if (database) out.database = database;
  const username = readString(material.username);
  if (username) out.username = username;
  const connectionUrl = readString(material.connectionUrl) ??
    readString(material.connectionString);
  if (connectionUrl) out.connectionUrl = connectionUrl;
  const caCertRef = readString(material.caCertRef);
  if (caCertRef) out.caCertRef = caCertRef;
  const passwordRef = readSecretReference(material.passwordRef) ??
    readSecretReference(material.passwordSecretRef);
  if (passwordRef) out.passwordRef = passwordRef;
  const tokenRef = readSecretReference(material.tokenRef);
  if (tokenRef) out.tokenRef = tokenRef;
  if (isRecord(material.tokenRefs)) out.tokenRefs = material.tokenRefs;
  return out;
}

function projectObjectStoreMaterial(
  material: NamespaceMaterial,
): NamespaceMaterial {
  const bucket = readString(material.bucket);
  const endpoint = readString(material.endpoint);
  if (!bucket || !endpoint) return material;
  const out: Record<string, JsonObject[string] | { secretRef: string }> = {
    bucket,
    endpoint,
  };
  const region = readString(material.region);
  if (region) out.region = region;
  if (typeof material.pathStyle === "boolean") {
    out.pathStyle = material.pathStyle;
  }
  const publicBaseUrl = readString(material.publicBaseUrl);
  if (publicBaseUrl) out.publicBaseUrl = publicBaseUrl;
  if (Array.isArray(material.policyRefs)) out.policyRefs = material.policyRefs;
  const accessKeyIdRef = readSecretReference(material.accessKeyIdRef) ??
    readSecretReference(material.accessKeyRef);
  if (accessKeyIdRef) out.accessKeyIdRef = accessKeyIdRef;
  const secretAccessKeyRef = readSecretReference(material.secretAccessKeyRef) ??
    readSecretReference(material.secretKeyRef);
  if (secretAccessKeyRef) out.secretAccessKeyRef = secretAccessKeyRef;
  const sessionTokenRef = readSecretReference(material.sessionTokenRef);
  if (sessionTokenRef) out.sessionTokenRef = sessionTokenRef;
  return out;
}

function inferServiceProtocol(material: NamespaceMaterial): string {
  const connection = readString(material.connectionString) ??
    readString(material.connectionUrl);
  if (connection?.startsWith("postgres://")) return "postgresql";
  if (connection?.startsWith("postgresql://")) return "postgresql";
  if (
    material.database !== undefined || material.passwordSecretRef !== undefined
  ) {
    return "postgresql";
  }
  return "tcp";
}

function readRouteSummaries(
  value: NamespaceMaterial[string],
): JsonObject[string] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    if (!isRecord(entry)) return {};
    const pathPrefix = readString(entry.pathPrefix);
    const to = readString(entry.to);
    return {
      ...(pathPrefix ? { pathPrefix } : {}),
      ...(to ? { to } : {}),
    };
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readSecretReference(
  value: unknown,
): { readonly secretRef: string } | undefined {
  if (isRecord(value) && readString(value.secretRef)) {
    return { secretRef: value.secretRef as string };
  }
  if (typeof value === "string" && value.startsWith("secret://")) {
    return { secretRef: value };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, JsonObject[string]> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function secretRefMaterial(
  key: string,
  value: JsonObject[string],
): { secretRef: string } | undefined {
  if (
    typeof value === "string" &&
    key.endsWith("Ref") &&
    value.startsWith("secret://")
  ) {
    return { secretRef: value };
  }
  return undefined;
}

function mergeResolvedBindingsIntoSpec(
  spec: JsonObject,
  bindings: readonly ResolvedListenBinding[],
): JsonObject {
  if (bindings.length === 0) return spec;
  const out: Record<string, unknown> = { ...spec };
  const env = collectEnvBindings(bindings);
  if (Object.keys(env).length > 0) {
    const existing = readStringRecord(out.env, "$.env");
    out.env = mergeWithoutConflict(existing, env, "$.env");
  }
  const target = collectTarget(bindings);
  if (target !== undefined) {
    const existingTarget = out.target;
    if (existingTarget !== undefined && existingTarget !== target) {
      throw new Error(
        "listen-derived target conflicts with explicit $.target in component spec",
      );
    }
    out.target = target;
  }
  return out as JsonObject;
}

function collectEnvBindings(
  bindings: readonly ResolvedListenBinding[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const binding of bindings) {
    for (const [key, value] of Object.entries(binding.envInjections)) {
      const stringValue = envValueToString(value);
      if (out[key] !== undefined && out[key] !== stringValue) {
        throw new Error(`listen-derived env ${key} is defined more than once`);
      }
      out[key] = stringValue;
    }
  }
  return out;
}

function collectTarget(
  bindings: readonly ResolvedListenBinding[],
): string | undefined {
  let out: string | undefined;
  for (const binding of bindings) {
    if (!binding.target) continue;
    const target = targetMaterialToString(
      binding.target,
      binding.sourceRef,
    );
    if (out !== undefined && out !== target) {
      throw new Error("listen-derived target is defined more than once");
    }
    out = target;
  }
  return out;
}

function targetMaterialToString(
  material: NamespaceMaterial,
  sourceRef: string,
): string {
  const direct = readString(material.url) ?? readString(material.target);
  if (direct) return direct;
  const httpTarget = firstRecord(material.targets) ??
    firstRecord(material.endpoints);
  if (httpTarget) {
    const url = readString(httpTarget.url);
    if (url) return url;
    const host = readString(httpTarget.host);
    const port = readNumber(httpTarget.port);
    if (host && port !== undefined) {
      const protocol = readString(httpTarget.protocol) ??
        readString(httpTarget.scheme) ?? "http";
      const basePath = readString(httpTarget.basePath) ?? "";
      return `${protocol}://${host}:${port}${basePath}`;
    }
  }
  throw new Error(
    `listen target ${sourceRef} must publish an http-endpoint target or endpoint`,
  );
}

function firstRecord(
  value: unknown,
): Record<string, JsonObject[string]> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find(isRecord);
}

function envValueToString(
  value: string | { readonly secretRef: string },
): string {
  return typeof value === "string" ? value : value.secretRef;
}

function readStringRecord(
  value: unknown,
  path: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a string-valued object`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`${path}.${key} must be a string`);
    }
    out[key] = entry;
  }
  return out;
}

function mergeWithoutConflict(
  explicit: Record<string, string>,
  injected: Record<string, string>,
  path: string,
): Record<string, string> {
  const out: Record<string, string> = { ...explicit };
  for (const [key, value] of Object.entries(injected)) {
    const existing = out[key];
    if (existing !== undefined && existing !== value) {
      throw new Error(
        `listen-derived ${path}.${key} conflicts with explicit spec`,
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Build a minimal `PlatformContext` for legacy shape/provider delegation. The
 * compatibility provider set (external / cloud) uses `_ctx` exclusively, so we
 * pass typed stubs for the SDK ports — none of them are exercised by the
 * wrappers in this directory.
 */
function synthesizePlatformContext(input: {
  readonly installationId: string;
  readonly source?: KernelPluginApplyContext["source"];
  readonly sourceDirectory?: string;
}): PlatformContext {
  return {
    tenantId: input.installationId,
    spaceId: input.installationId,
    secrets: NOOP_SECRET_STORE,
    observability: NOOP_OBSERVABILITY,
    kms: NOOP_KMS,
    objectStorage: NOOP_OBJECT_STORAGE,
    refResolver: NOOP_REF_RESOLVER,
    resolvedOutputs: new Map(),
    preparedSource: preparedSourceLocator(input),
  };
}

function preparedSourceLocator(input: {
  readonly source?: KernelPluginApplyContext["source"];
  readonly sourceDirectory?: string;
}): PreparedSourceLocator | undefined {
  if (input.source?.kind === "prepared" && input.source.url) {
    return {
      url: input.source.url,
      ...(input.source.digest ? { digest: input.source.digest } : {}),
    };
  }
  if (input.sourceDirectory) {
    return { workingDirectory: input.sourceDirectory };
  }
  return undefined;
}

function unavailable(port: string): Promise<never> {
  return Promise.reject(
    new Error(`${port} unavailable in bundled wrapper context`),
  );
}

/**
 * Noop port stubs shared across the kernel and bundled provider
 * wrappers. Centralized here (single source of truth) so per-package
 * adapters and the kernel `apply_service.ts` fallback do not maintain
 * byte-identical copies.
 *
 * The kernel's legacy shape-model apply path builds a per-resource ref resolver
 * before dispatch; these stubs are intentionally fail-loud / fail-quiet
 * fallbacks for code paths that never exercise them.
 */
export const NOOP_SECRET_STORE = {
  get: () => unavailable("secret store"),
  put: () => unavailable("secret store"),
  delete: () => unavailable("secret store"),
  list: () => Promise.resolve([]),
} as unknown as PlatformContext["secrets"];

export const NOOP_OBSERVABILITY = {
  emit() {},
  span() {
    return { end() {} };
  },
} as unknown as PlatformContext["observability"];

export const NOOP_KMS = {
  encrypt: () => unavailable("kms"),
  decrypt: () => unavailable("kms"),
} as unknown as PlatformContext["kms"];

export const NOOP_OBJECT_STORAGE = {
  put: () => unavailable("object storage"),
  get: () => unavailable("object storage"),
  delete: () => unavailable("object storage"),
  head: () => unavailable("object storage"),
} as unknown as PlatformContext["objectStorage"];

/**
 * Noop ref resolver. Returns `null` rather than throwing so a
 * defensive caller that consults the resolver before falling through
 * to its own resolution path keeps working; throwing variants should
 * be inlined at call sites that genuinely require ref resolution.
 */
export const NOOP_REF_RESOLVER = {
  resolve(_expression: string) {
    return null;
  },
} as unknown as PlatformContext["refResolver"];
