import type { Context, Hono as HonoApp } from "hono";
import { apiError, registerApiErrorHandler } from "./errors.ts";
import type { ApiEndpoint } from "./route_families.ts";

export const TAKOSUMI_SERVICE_READINESS_PATHS = {
  ready: "/readyz",
  live: "/livez",
} as const;

/**
 * Endpoint inventory for the `readiness` family, co-located with the mount
 * calls below. Consumed by `route_families.ts` to derive `/capabilities` and
 * `/openapi.json`.
 * Keep in lockstep with {@link registerReadinessRoutes}.
 */
export const READINESS_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    method: "GET",
    path: TAKOSUMI_SERVICE_READINESS_PATHS.ready,
    summary: "Readiness probe for the current Takosumi role.",
    auth: "none",
    operationId: "getReadyz",
    tag: "readiness",
    openapi: { okSchema: "HealthProbeResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_SERVICE_READINESS_PATHS.live,
    summary: "Liveness probe for the current Takosumi role.",
    auth: "none",
    operationId: "getLivez",
    tag: "readiness",
    openapi: { okSchema: "HealthProbeResponse" },
  },
] as const;

export interface HealthProbeResult {
  readonly ok: boolean;
  readonly state?: "ready" | "not-ready" | "booting";
  readonly status?: number;
  readonly [key: string]: unknown;
}

export type HealthProbe = () => HealthProbeResult | Promise<HealthProbeResult>;

export interface ReadinessRouteProbes {
  readonly ready: HealthProbe;
  readonly live: HealthProbe;
}

export interface RegisterReadinessRoutesOptions {
  readonly probes: ReadinessRouteProbes;
}

export function registerReadinessRoutes(
  app: HonoApp,
  options: RegisterReadinessRoutesOptions,
): void {
  registerApiErrorHandler(app);
  app.get(TAKOSUMI_SERVICE_READINESS_PATHS.ready, async (c) => {
    return await healthResponse(c, options.probes.ready);
  });

  app.get(TAKOSUMI_SERVICE_READINESS_PATHS.live, async (c) => {
    return await healthResponse(c, options.probes.live);
  });

}

async function healthResponse(
  c: Context,
  probe: HealthProbe,
): Promise<Response> {
  try {
    const result = await probe();
    const status = statusCodeForProbe(result);
    c.status(status);
    if (status !== 200) {
      return c.json(
        apiError(
          "readiness_probe_failed",
          typeof result.reason === "string"
            ? result.reason
            : "readiness probe failed",
          result,
        ),
      );
    }
    return c.json(result);
  } catch (error) {
    c.status(503);
    return c.json(apiError("readiness_probe_failed", errorMessage(error)));
  }
}

function statusCodeForProbe(result: HealthProbeResult): 200 | 503 {
  if (result.status === 200 || result.status === 503) return result.status;
  if (result.state === "booting" || result.state === "not-ready") return 503;
  return result.ok ? 200 : 503;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "probe failed";
}
