import type {
  JsonObject,
  PlatformContext,
  PlatformTraceContext,
  RefResolver,
} from "takosumi-contract";
import type { AppContext } from "../app_context.ts";
import type {
  RequestCorrelation,
  RequestTraceContext,
} from "./request_correlation.ts";

/**
 * Build a `PlatformContext` from the kernel's `AppContext`. The kernel's
 * adapters (`secrets` / `observability` / `kms` / `objectStorage`) implement
 * the contract's `PlatformContext` ports directly, so we just thread them
 * through. `refResolver` is overwritten per-resource by `applyV2` itself; the
 * fallback returned here is never invoked during a normal apply.
 */
export function platformContextFromAppContext(
  appContext: AppContext,
  tenantId: string,
  trace?: PlatformTraceContext,
): PlatformContext {
  const adapters = appContext.adapters;
  return attachPlatformTrace({
    tenantId,
    spaceId: tenantId,
    secrets: adapters.secrets as PlatformContext["secrets"],
    observability: adapters.observability as PlatformContext["observability"],
    kms: adapters.kms as PlatformContext["kms"],
    objectStorage: adapters.objectStorage as PlatformContext["objectStorage"],
    refResolver: PUBLIC_DEPLOY_REF_RESOLVER,
    resolvedOutputs: new Map<string, JsonObject>(),
  }, trace);
}

export function attachPlatformTrace(
  context: PlatformContext,
  trace: PlatformTraceContext | undefined,
): PlatformContext {
  return trace ? { ...context, trace } : context;
}

export function deployTraceFromRequest(
  trace: RequestTraceContext | undefined,
  correlation: RequestCorrelation | undefined,
): PlatformTraceContext | undefined {
  if (!trace) return undefined;
  return {
    traceId: trace.traceId,
    parentSpanId: trace.spanId,
    ...(correlation?.requestId ? { requestId: correlation.requestId } : {}),
    ...(correlation?.correlationId
      ? { correlationId: correlation.correlationId }
      : {}),
  };
}

export const PUBLIC_DEPLOY_REF_RESOLVER: RefResolver = {
  resolve(_expression: string) {
    // applyV2 builds its own per-resource ref resolver; this fallback is
    // never invoked during a shape-model apply.
    return null;
  },
};
