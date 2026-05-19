/**
 * Adapter helper that wraps an existing `ProviderPlugin` instance as a
 * `KernelPlugin` (Wave 9 Phase D plain-array plugin shape).
 *
 * The wrapper is intentionally thin: it forwards `component.spec` (passed
 * through the AppSpec installer pipeline as opaque JSON) to the underlying
 * provider's `apply()` / `destroy()`, and surfaces the resource handle as
 * `providerResourceId` for the kernel to record on the Deployment.
 *
 * Single-source-of-truth: this adapter lives in `@takos/takosumi-contract`
 * (Phase K iteration 2 consolidation) so the 6 per-cloud provider packages
 * (`@takos/takosumi-{cloudflare,aws,gcp,kubernetes,deno-deploy,selfhost}-
 * providers`) import the same implementation instead of shipping byte-
 * identical 140-line copies. The contract package remains the canonical
 * `ProviderPlugin` / `KernelPlugin` definition site, so the adapter that
 * bridges them is semantically at home here.
 */

import type { JsonObject } from "./types.ts";
import type { PlatformContext, ProviderPlugin } from "./provider-plugin.ts";
import type { KernelPlugin } from "./plugin.ts";

/**
 * Build a `KernelPlugin` that delegates `apply()` / `destroy()` to an
 * underlying `ProviderPlugin`. The kind URI must match the canonical
 * Takosumi kind catalog entry the underlying provider materializes.
 *
 * `ProviderPlugin` is generic over `Spec` / `Outputs` types; we erase to
 * the generic JsonObject form so each bundled wrapper can pass its
 * shape-specific ProviderPlugin without manual casts at the call site.
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
      const result = await provider.apply(
        (ctx.component.spec ?? {}) as JsonObject,
        synthesizePlatformContext(ctx.installationId),
      );
      return {
        providerResourceId: result.handle,
        outputs: stringifyOutputs(result.outputs),
      };
    },
    async destroy(ctx) {
      await provider.destroy(
        ctx.providerResourceId,
        synthesizePlatformContext(ctx.installationId),
      );
    },
  };
}

/**
 * Build a minimal `PlatformContext` for shape-provider delegation. The
 * bundled set of providers (selfhost / cloud) uses `_ctx` exclusively, so
 * we pass typed stubs for the SDK ports — none of them are exercised by
 * the wrappers in this directory.
 */
function synthesizePlatformContext(installationId: string): PlatformContext {
  return {
    tenantId: installationId,
    spaceId: installationId,
    secrets: NOOP_SECRET_STORE,
    observability: NOOP_OBSERVABILITY,
    kms: NOOP_KMS,
    objectStorage: NOOP_OBJECT_STORAGE,
    refResolver: NOOP_REF_RESOLVER,
    resolvedOutputs: new Map(),
  };
}

/**
 * `apply()` outputs are `JsonObject` on the contract side; the kernel
 * surfaces `Record<string, string>` to downstream components via use-edge
 * env injection. Numbers / booleans get stringified — secrets / refs stay
 * as their string form.
 */
function stringifyOutputs(
  outputs: JsonObject | undefined,
): Readonly<Record<string, string>> {
  if (!outputs) return Object.freeze({});
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(outputs)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return Object.freeze(out);
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
 * The kernel's shape-model apply path builds a per-resource ref
 * resolver before dispatch; these stubs are intentionally fail-loud /
 * fail-quiet fallbacks for code paths that never exercise them.
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
