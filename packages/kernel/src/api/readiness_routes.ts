import type { Context, Hono as HonoApp } from "hono";
import type { GroupSummaryStatusProjection } from "../services/status/mod.ts";
import { findNonCatalogConditionReasons } from "./condition_reasons.ts";
import { apiError, registerApiErrorHandler } from "./errors.ts";

export const TAKOS_PAAS_READINESS_PATHS = {
  ready: "/readyz",
  live: "/livez",
  statusSummary: "/status/summary",
} as const;

export interface HealthProbeResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly [key: string]: unknown;
}

export type HealthProbe = () => HealthProbeResult | Promise<HealthProbeResult>;

export type StatusSummaryProbe = () =>
  | GroupSummaryStatusProjection
  | Promise<GroupSummaryStatusProjection>;

export interface ReadinessRouteProbes {
  readonly ready: HealthProbe;
  readonly live: HealthProbe;
  readonly statusSummary: StatusSummaryProbe;
}

export interface RegisterReadinessRoutesOptions {
  readonly probes: ReadinessRouteProbes;
}

export function registerReadinessRoutes(
  app: HonoApp,
  options: RegisterReadinessRoutesOptions,
): void {
  registerApiErrorHandler(app);
  app.get(TAKOS_PAAS_READINESS_PATHS.ready, async (c) => {
    return await healthResponse(c, options.probes.ready);
  });

  app.get(TAKOS_PAAS_READINESS_PATHS.live, async (c) => {
    return await healthResponse(c, options.probes.live);
  });

  app.get(TAKOS_PAAS_READINESS_PATHS.statusSummary, async (c) => {
    try {
      const summary = await options.probes.statusSummary();
      assertCatalogConditionReasons(summary, "status summary");
      return c.json(summary);
    } catch (error) {
      c.status(503);
      return c.json(
        apiError("readiness_probe_failed", errorMessage(error)),
      );
    }
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

function assertCatalogConditionReasons(value: unknown, surface: string): void {
  const errors = findNonCatalogConditionReasons(value);
  if (errors.length === 0) return;
  throw new TypeError(
    `${surface} emitted non-catalog condition reason at ${errors[0].path}: ${
      errors[0].reason
    }`,
  );
}

function statusCodeForProbe(result: HealthProbeResult): 200 | 503 {
  if (result.status === 200 || result.status === 503) return result.status;
  return result.ok ? 200 : 503;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "probe failed";
}
