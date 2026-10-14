import type {
  BillingExtensionFactory,
  BillingExtensionFactoryResult,
  BillingEnforcementDecision,
  BillingRpcService,
  ShowbackRating,
} from "takosumi-contract/billing";
import type { JsonValue } from "takosumi-contract";
import type { CloudflareWorkerEnv } from "./bindings.ts";

type BillingBindings = Pick<
  CloudflareWorkerEnv,
  | "TAKOSUMI_BILLING"
  | "TAKOSUMI_BILLING_REQUIRED"
  | "TAKOSUMI_BILLING_EXTENSION_FACTORY"
>;

const METHODS = [
  "ratePlan", "rateUsage", "reservePlanBilling", "assertReservationSatisfied",
  "captureRunBilling", "releaseReservation", "evaluatePlanQuota",
] as const;

/** Operator-owned per-call bound; neither request data nor env overrides it. */
export const BILLING_RPC_DEADLINE_MS = 15_000;

/** Resolve one explicit host port; absence retains the OSS self-host defaults. */
export function workerBillingComposition(env: BillingBindings): {
  readonly billingExtensionFactory?: BillingExtensionFactory;
  readonly billingEnforcementRequired?: true;
} {
  const required = env.TAKOSUMI_BILLING_REQUIRED;
  if (required !== undefined && required !== "1") {
    throw new TypeError("TAKOSUMI_BILLING_REQUIRED must be 1 or omitted");
  }
  const service = env.TAKOSUMI_BILLING;
  const factory = env.TAKOSUMI_BILLING_EXTENSION_FACTORY;
  if (service !== undefined && factory !== undefined) {
    throw new TypeError("TAKOSUMI_BILLING and its in-process factory are mutually exclusive");
  }
  let billingExtensionFactory: BillingExtensionFactory | undefined;
  if (service !== undefined) {
    if (
      service === null || typeof service !== "object" ||
      METHODS.some((method) => typeof service[method] !== "function")
    ) {
      throw new TypeError("TAKOSUMI_BILLING must implement all seven billing methods");
    }
    const ports = billingRpcPorts(service);
    billingExtensionFactory = { create: () => ports };
  } else if (factory !== undefined) {
    if (factory === null || typeof factory !== "object" || typeof factory.create !== "function") {
      throw new TypeError("TAKOSUMI_BILLING_EXTENSION_FACTORY must implement create()");
    }
    billingExtensionFactory = factory;
  } else if (required === "1") {
    throw new TypeError("Required billing service is not configured");
  }
  return {
    ...(billingExtensionFactory ? { billingExtensionFactory } : {}),
    ...(required === "1" ? { billingEnforcementRequired: true } : {}),
  };
}

function billingRpcPorts(service: BillingRpcService): BillingExtensionFactoryResult {
  // Keep the RPC stub as `this`; destructuring remote methods loses its receiver.
  // Calls have no retry or no-op fallback. The Run engine owns durable retries.
  return {
    showbackRater: {
      ratePlan: async (ctx) => rating(await invoke("ratePlan", () => service.ratePlan(ctx)), "ratePlan"),
      rateUsage: async (ctx) => rating(await invoke("rateUsage", () => service.rateUsage(ctx)), "rateUsage"),
    },
    billingEnforcement: {
      reservePlanBilling: async (ctx) => decision(
        await invoke("reservePlanBilling", () => service.reservePlanBilling(ctx)), "reservePlanBilling",
      ),
      assertReservationSatisfied: async (ctx) => voidResult(
        await invoke("assertReservationSatisfied", () => service.assertReservationSatisfied(ctx)), "assertReservationSatisfied",
      ),
      captureRunBilling: async (ctx) => voidResult(
        await invoke("captureRunBilling", () => service.captureRunBilling(ctx)), "captureRunBilling",
      ),
      releaseReservation: async (ctx) => voidResult(
        await invoke("releaseReservation", () => service.releaseReservation(ctx)), "releaseReservation",
      ),
    },
    quotaPolicy: {
      evaluatePlanQuota: async (ctx) => decision(
        await invoke("evaluatePlanQuota", () => service.evaluatePlanQuota(ctx)), "evaluatePlanQuota",
      ),
    },
  };
}

async function invoke<T>(method: string, operation: () => Promise<T>): Promise<T> {
  const deadlineExpired = Symbol("billing_rpc_deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(deadlineExpired), BILLING_RPC_DEADLINE_MS);
    });
    // A deadline is an unknown acknowledgement, not cancellation or proof that
    // a mutation did not commit. Durable reconciliation reuses the same Run /
    // Apply references; this adapter never retries or substitutes a no-op.
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    // Remote exception messages/causes can contain commercial or secret data.
    // Expose only the failed port, never its input or the host's diagnostics.
    throw new Error(`TAKOSUMI_BILLING ${method} ${error === deadlineExpired ? "timed out" : "failed"}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function invalid(method: string): never {
  throw new TypeError(`TAKOSUMI_BILLING returned invalid ${method} DTO`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function rating(value: unknown, method: string): ShowbackRating {
  if (!plainRecord(value) || Object.keys(value).some((key) => !["ratingStatus", "usdMicros", "audit"].includes(key))) {
    return invalid(method);
  }
  const { ratingStatus, usdMicros } = value;
  if (
    (ratingStatus !== "rated" && ratingStatus !== "unrated") ||
    typeof usdMicros !== "number" || !Number.isSafeInteger(usdMicros) || usdMicros < 0 ||
    (ratingStatus === "unrated" && usdMicros !== 0)
  ) return invalid(method);
  const audit = auditRecord(value.audit, method);
  return { ratingStatus, usdMicros, ...(audit ? { audit } : {}) };
}

function decision(value: unknown, method: string): BillingEnforcementDecision {
  if (
    !plainRecord(value) || Object.keys(value).some((key) => !["reasons", "audit"].includes(key)) ||
    !Array.isArray(value.reasons) || Array.from(value.reasons).some((reason) => typeof reason !== "string" || reason.trim().length === 0)
  ) return invalid(method);
  const audit = auditRecord(value.audit, method);
  return { reasons: [...value.reasons], ...(audit ? { audit } : {}) };
}

function voidResult(value: unknown, method: string): void {
  if (value !== undefined) invalid(method);
}

function auditRecord(value: unknown, method: string): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value)) return invalid(method);
  const remaining = { nodes: 10_000 };
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: jsonValue(item, method, 0, remaining), enumerable: true,
    });
  }
  return out;
}

function jsonValue(value: unknown, method: string, depth: number, remaining: { nodes: number }): JsonValue {
  if (depth > 32 || --remaining.nodes < 0) return invalid(method);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, (item) => jsonValue(item, method, depth + 1, remaining));
  if (!plainRecord(value)) return invalid(method);
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: jsonValue(item, method, depth + 1, remaining), enumerable: true,
    });
  }
  return out;
}
