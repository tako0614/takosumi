import type { ReadinessRouteProbes } from "../api/readiness_routes.ts";
import type { AppContext, AppRuntimeConfig } from "../app_context.ts";
import type { TakosumiProcessRole } from "../process/mod.ts";
import { errorMessage } from "../shared/errors.ts";

export interface RoleReadinessProbeOptions {
  readonly role: TakosumiProcessRole;
  readonly context: AppContext;
  readonly runtimeConfig: AppRuntimeConfig;
  readonly runtimeEnv: Record<string, string | undefined>;
}

export function createRoleReadinessProbes(
  options: RoleReadinessProbeOptions,
): ReadinessRouteProbes {
  return {
    ready: async () => {
      const checks: Record<string, unknown> = {};
      const failures: string[] = [];
      const booting: string[] = [];
      await recordCheck(checks, failures, "role", () => {
        if (
          options.runtimeConfig.processRole &&
          options.runtimeConfig.processRole !== options.role
        ) {
          throw new Error(
            `runtime config role ${options.runtimeConfig.processRole} does not match process role ${options.role}`,
          );
        }
        return options.runtimeConfig.processRole ?? options.role;
      });
      await recordCheck(checks, failures, "observability", () =>
        options.context.adapters.observability ? "configured" : "missing"
      );
      if (requiresInternalApiSecret(options.role)) {
        await recordCheck(checks, failures, "internalApiSecret", () => {
          if (!options.runtimeEnv.TAKOSUMI_INTERNAL_API_SECRET) {
            throw new Error("TAKOSUMI_INTERNAL_API_SECRET is required");
          }
          return "configured";
        });
      }
      const state = failures.length === 0
        ? "ready"
        : booting.length > 0 && booting.length === failures.length
        ? "booting"
        : "not-ready";
      return {
        ok: failures.length === 0,
        state,
        service: "takosumi",
        role: options.role,
        checkedAt: new Date().toISOString(),
        checks,
        ...(failures.length > 0 ? { reason: failures.join("; ") } : {}),
      };
    },
    live: () => ({
      ok: true,
      service: "takosumi",
      role: options.role,
      checkedAt: new Date().toISOString(),
    }),
  };
}

async function recordCheck(
  checks: Record<string, unknown>,
  failures: string[],
  name: string,
  fn: () => unknown | Promise<unknown>,
  booting: string[] = [],
): Promise<void> {
  try {
    const value = await fn();
    checks[name] = value;
    const checkFailure = checkFailureMessage(value);
    if (checkFailure) {
      failures.push(`${name}: ${checkFailure.message}`);
      if (checkFailure.booting) booting.push(name);
    }
  } catch (error) {
    const message = errorMessage(error);
    checks[name] = { ok: false, error: message };
    failures.push(`${name}: ${message}`);
  }
}

function requiresInternalApiSecret(role: TakosumiProcessRole): boolean {
  return role === "takosumi-api";
}

function checkFailureMessage(
  value: unknown,
): { readonly message: string; readonly booting: boolean } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== false) return undefined;
  const message = typeof record.error === "string"
    ? record.error
    : typeof record.reason === "string"
    ? record.reason
    : "check failed";
  return { message, booting: record.state === "booting" };
}
