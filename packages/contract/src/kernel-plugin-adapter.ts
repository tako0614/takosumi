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
 * (Phase K iteration 2 consolidation) so provider packages and external
 * adapter packages import the same implementation instead of shipping
 * byte-identical 140-line copies. `KernelPlugin` is the current reference
 * adapter API; `ProviderPlugin` is the legacy shape/provider surface this
 * bridge quarantines for older packages.
 */

import type { JsonObject } from "./types.ts";
import type { PlatformContext, ProviderPlugin } from "./provider-plugin.ts";
import type { PreparedSourceLocator } from "./runtime-agent-lifecycle.ts";
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
 * adapter erases to the generic JsonObject form so each provider package can
 * pass its provider-local typed ProviderPlugin without manual casts at the
 * call site.
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
      return Promise.resolve(providerOutputsToNamespaceMaterial(ctx.outputs));
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
): NamespaceMaterial {
  const material: Record<string, JsonObject[string] | { secretRef: string }> =
    {};
  for (const [key, value] of Object.entries(outputs)) {
    material[key] = secretRefMaterial(key, value) ?? value;
  }
  return material;
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
  const url = material.url;
  if (typeof url === "string" && url.length > 0) return url;
  const target = material.target;
  if (typeof target === "string" && target.length > 0) return target;
  throw new Error(
    `listen target ${sourceRef} must publish a string url or target field`,
  );
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
