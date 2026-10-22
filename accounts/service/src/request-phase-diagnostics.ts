import { PUBLIC_SESSION_CONTROL_ENDPOINTS } from "./control-route-inventory.ts";

export interface RequestPhaseDiagnosticsConfiguration {
  readonly environment?: string;
  readonly enabled?: string;
}

export type RequestDiagnosticPhase =
  | "issuer_schema"
  | "shared_workspace_auth"
  | "shared_workspace_dispatch"
  | "shared_workspace_control_resolve"
  | "shared_workspace_billing_admission"
  | "shared_workspace_billing_grant"
  | "shared_workspace_billing_get"
  | "shared_workspace_billing_prepare"
  | "shared_workspace_billing_enrollment"
  | "shared_workspace_billing_claim"
  | "accounts_init"
  | "allowlist"
  | "control_auth"
  | "control_init"
  | "control_dispatch";

export interface RequestPhaseObserver {
  measure<T>(
    phase: RequestDiagnosticPhase,
    operation: () => T | Promise<T>,
  ): Promise<T>;
}

const PHASES = new Set<RequestDiagnosticPhase>([
  "issuer_schema",
  "shared_workspace_auth",
  "shared_workspace_dispatch",
  "shared_workspace_control_resolve",
  "shared_workspace_billing_admission",
  "shared_workspace_billing_grant",
  "shared_workspace_billing_get",
  "shared_workspace_billing_prepare",
  "shared_workspace_billing_enrollment",
  "shared_workspace_billing_claim",
  "accounts_init",
  "allowlist",
  "control_auth",
  "control_init",
  "control_dispatch",
]);
const PENDING_THRESHOLD_MS = 2000;
const MAX_PENDING_NOTIFICATIONS = 64;

const silent: RequestPhaseObserver = {
  async measure(_phase, operation) {
    return await operation();
  },
};

/** Observe settlement only. The observer never owns the operation or its value. */
export async function measureRequestPhaseOperation<T>(
  observer: RequestPhaseObserver | undefined,
  phase: RequestDiagnosticPhase,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!observer || observer === silent) return await operation();
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A diagnostic consumer may throw, ignore the signal, or never settle.
  void completion.catch(() => {});
  try {
    void Promise.resolve(observer.measure(phase, () => completion)).catch(() => {});
  } catch {
    // Diagnostics cannot prevent or replace the real operation.
  }
  try {
    const value = await operation();
    resolveCompletion();
    return value;
  } catch (error) {
    rejectCompletion(new Error("Request phase operation rejected"));
    throw error;
  }
}

function routeShape(request: Request): string | undefined {
  const pathname = new URL(request.url).pathname;
  if (request.method === "POST" && pathname === "/api/v1/account/shared-workspaces/bootstrap") return pathname;
  if (request.method === "GET" && /^\/api\/v1\/account\/shared-workspaces\/[^/]+\/billing-organization$/u.test(pathname)) {
    return "/api/v1/account/shared-workspaces/{workspaceId}/billing-organization";
  }
  for (const endpoint of PUBLIC_SESSION_CONTROL_ENDPOINTS) {
    if (endpoint.method !== request.method) continue;
    const parts = endpoint.path.split("/");
    const actual = pathname.split("/");
    if (parts.length !== actual.length) continue;
    if (
      parts.every((part, i) =>
        /^\{[A-Za-z]+\}$/u.test(part)
          ? actual[i].length > 0
          : part === actual[i],
      )
    ) {
      return endpoint.path;
    }
  }
  if (
    request.method === "GET" &&
    ["/.well-known/takosumi", "/.well-known/openid-configuration"].includes(
      pathname,
    )
  ) {
    return pathname;
  }
  return undefined;
}

/**
 * An opt-in staging observer. It never cancels/replaces I/O, races the result,
 * changes authority, reads a body or retains the Request. Pending notifications
 * are bounded per factory; each timer releases its slot on firing or settlement.
 */
export function createRequestPhaseDiagnostics(
  configuration: RequestPhaseDiagnosticsConfiguration,
) {
  const enabled =
    configuration.environment === "staging" && configuration.enabled === "true";
  let activePendingNotifications = 0;
  return {
    get activePendingNotifications() {
      return activePendingNotifications;
    },
    forRequest(request: Request): RequestPhaseObserver {
      if (!enabled) return silent;
      const route = routeShape(request);
      if (route === undefined) return silent;
      const ray = request.headers.get("cf-ray");
      const probe = request.headers.get("x-takosumi-request-probe-id");
      const metadata = {
        route,
        method: request.method,
        ...(ray && /^[a-f0-9]{16}-[A-Z]{3}$/u.test(ray) ? { cfRay: ray } : {}),
        ...(probe && /^[a-f0-9]{16}$/u.test(probe) ? { probeId: probe } : {}),
      };
      return {
        async measure<T>(
          phase: RequestDiagnosticPhase,
          operation: () => T | Promise<T>,
        ): Promise<T> {
          if (!PHASES.has(phase)) return await operation();
          const startedAt = performance.now();
          const emit = (
            outcome: "started" | "pending" | "fulfilled" | "rejected",
          ) => {
            const elapsedMs = Math.max(
              0,
              Math.round((performance.now() - startedAt) * 10) / 10,
            );
            try {
              console.info(
                JSON.stringify({
                  event: "request_phase",
                  ...metadata,
                  phase,
                  outcome,
                  elapsedMs,
                }),
              );
            } catch {
              // Diagnostic output must never affect request execution.
            }
          };
          emit("started");
          let timer: ReturnType<typeof setTimeout> | undefined;
          let reserved = false;
          const release = () => {
            if (!reserved) return;
            reserved = false;
            activePendingNotifications -= 1;
          };
          if (activePendingNotifications < MAX_PENDING_NOTIFICATIONS) {
            reserved = true;
            activePendingNotifications += 1;
            timer = setTimeout(() => {
              release();
              emit("pending");
            }, PENDING_THRESHOLD_MS);
          }
          try {
            const result = await operation();
            emit("fulfilled");
            return result;
          } catch (error) {
            emit("rejected");
            throw error;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
            release();
          }
        },
      };
    },
  };
}
