/**
 * One resolution of the runtime-binding derivation key, for every lane.
 *
 * WHY this exists. Two lanes materialize the same Capsule's
 * `runtimeBindingMaterialization` profile, and they read the same environment
 * variable with two different fallbacks:
 *
 * - The private RPC materializer coerced an absent key to `""` and then threw a
 *   `TypeError` from its bounded-secret check — at *use* time, because the
 *   materializer was constructed per RPC call. That surfaced during a live
 *   apply.
 * - The composition root mapped an absent key to `undefined`, which silently
 *   dropped the derived value source and switched the run-scoped lane from host
 *   derivation to the sealed lane.
 *
 * Same Capsule, same profile, different secret bytes, and nothing observed the
 * disagreement. A key that is present but too short reproduced it exactly: one
 * lane failed mid-apply, the other quietly sealed.
 *
 * So resolution happens once, here, and returns a value both lanes read the
 * same way:
 *
 * - `configured` — host derivation. Both lanes derive.
 * - `absent` — an explicitly declared degraded mode. Both lanes seal, and
 *   `/readyz` names it, so "we are on the sealed lane" is something an operator
 *   can see rather than something they infer from a stack trace.
 * - `invalid` — a refusal. A composition never starts on a key it cannot use;
 *   it does not get to find out mid-apply.
 */

export const RUNTIME_BINDING_DERIVATION_KEY_ENV =
  "TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY" as const;

/** The bounds the derivation HMAC requires of its key. */
const MINIMUM_KEY_BYTES = 32;
const MAXIMUM_KEY_BYTES = 4_096;

export type RuntimeBindingDerivationKey =
  | { readonly status: "configured"; readonly key: string }
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly why: string };

export function resolveRuntimeBindingDerivationKey(
  value: unknown,
): RuntimeBindingDerivationKey {
  if (value === undefined || value === null || value === "") {
    return { status: "absent" };
  }
  if (typeof value !== "string") {
    return { status: "invalid", why: "must be a string" };
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < MINIMUM_KEY_BYTES) {
    return {
      status: "invalid",
      why: `must be at least ${MINIMUM_KEY_BYTES} bytes, found ${bytes}`,
    };
  }
  if (bytes > MAXIMUM_KEY_BYTES) {
    return {
      status: "invalid",
      why: `must be at most ${MAXIMUM_KEY_BYTES} bytes, found ${bytes}`,
    };
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return { status: "invalid", why: "must not contain control characters" };
  }
  return { status: "configured", key: value };
}

/** The lane both materializers are on, as one word `/readyz` can print. */
export function runtimeBindingDerivationMode(
  resolved: RuntimeBindingDerivationKey,
): "host-derivation" | "sealed" {
  return resolved.status === "configured" ? "host-derivation" : "sealed";
}

export class RuntimeBindingDerivationKeyError extends Error {
  constructor(why: string) {
    super(`${RUNTIME_BINDING_DERIVATION_KEY_ENV} ${why}`);
    this.name = "RuntimeBindingDerivationKeyError";
  }
}

/**
 * Resolve at composition or refuse to compose. Never at use time: a lane that
 * discovers a bad key while an apply is in flight has already changed the
 * world.
 */
export function requireRuntimeBindingDerivationKey(
  value: unknown,
): RuntimeBindingDerivationKey {
  const resolved = resolveRuntimeBindingDerivationKey(value);
  if (resolved.status === "invalid") {
    throw new RuntimeBindingDerivationKeyError(resolved.why);
  }
  return resolved;
}
