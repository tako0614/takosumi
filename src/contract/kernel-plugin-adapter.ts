/**
 * Adapter helper that wraps an existing `ProviderPlugin` instance as a
 * `KernelPlugin`.
 *
 * The wrapper is intentionally thin: it forwards `component.spec` (passed
 * through the reference installer pipeline as opaque JSON) to the underlying
 * provider's `apply()` / `destroy()`, and surfaces the resource handle as
 * `resourceHandle` for the kernel's internal apply evidence.
 *
 * This bridge is retained for deploy-core compatibility code. `KernelPlugin`
 * is the current reference adapter API; `ProviderPlugin` is the older
 * shape/provider surface this file keeps isolated from native kind implementations.
 */

import type { JsonObject } from "./types.ts";
import type { PlatformContext, ProviderPlugin } from "./provider-plugin.ts";
import type { PreparedSourceLocator } from "./runtime-agent-lifecycle.ts";
import { outputsToOutputMaterial } from "./plugin.ts";
import type {
  EnvValue,
  KernelPlugin,
  KernelPluginApplyContext,
  ResolvedInputBinding,
} from "./plugin.ts";

/**
 * Build a `KernelPlugin` that delegates `apply()` / `destroy()` to an
 * underlying `ProviderPlugin`. The kind URI must match the descriptor URI
 * the underlying provider materializes.
 *
 * `ProviderPlugin` is generic over `Spec` / `Outputs` types; this compatibility
 * adapter erases to the generic JsonObject form before entering the current
 * `KernelPlugin` pipeline.
 */
export function kernelPluginFromProviderPlugin(
  opts: {
    // deno-lint-ignore no-explicit-any
    readonly provider: ProviderPlugin<any, any, any>;
    readonly kindUri: string;
    readonly name?: string;
    readonly version?: string;
    readonly capabilities?: readonly string[];
  },
): KernelPlugin {
  const provider = opts.provider as unknown as ProviderPlugin;
  const capabilities = opts.capabilities ??
    (provider.capabilities as readonly string[]);
  const materializeOutput = (
    ctx: Parameters<
      NonNullable<KernelPlugin["materializeOutput"]>
    >[0],
  ) =>
    Promise.resolve(
      outputsToOutputMaterial(ctx.outputs),
    );
  return {
    name: opts.name ?? provider.id,
    version: opts.version ?? provider.version,
    provides: [opts.kindUri],
    capabilities,
    async apply(ctx) {
      const spec = mergeResolvedEnvIntoSpec(
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
    materializeOutput,
    publishMaterial: materializeOutput,
    async destroy(ctx) {
      await provider.destroy(
        ctx.resourceHandle,
        synthesizePlatformContext({ installationId: ctx.installationId }),
      );
    },
  };
}

function mergeResolvedEnvIntoSpec(
  spec: JsonObject,
  bindings: readonly ResolvedInputBinding[],
): JsonObject {
  if (bindings.length === 0) return spec;
  const out: Record<string, unknown> = { ...spec };
  const env = collectEnvBindings(bindings);
  if (Object.keys(env).length > 0) {
    const existing = readStringRecord(out.env, "$.env");
    out.env = mergeWithoutConflict(existing, env, "$.env");
  }
  return out as JsonObject;
}

function collectEnvBindings(
  bindings: readonly ResolvedInputBinding[],
): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {};
  for (const binding of bindings) {
    for (const [key, value] of Object.entries(binding.envInjections)) {
      if (out[key] !== undefined && !sameEnvValue(out[key], value)) {
        throw new Error(
          `binding-derived env ${key} is defined more than once`,
        );
      }
      out[key] = value;
    }
  }
  return out;
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
  injected: Record<string, EnvValue>,
  path: string,
): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = { ...explicit };
  for (const [key, value] of Object.entries(injected)) {
    const existing = out[key];
    if (existing !== undefined && !sameEnvValue(existing, value)) {
      throw new Error(
        `binding-derived ${path}.${key} conflicts with explicit spec`,
      );
    }
    out[key] = value;
  }
  return out;
}

function sameEnvValue(a: EnvValue, b: EnvValue): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.secretRef === b.secretRef;
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
 * The kernel's legacy `resources[]` apply path builds a per-resource ref resolver
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
