/**
 * Deep-immutability helpers shared across the service's stores, adapters, and
 * services. Previously ~13 files each hand-rolled their own `deepFreeze` /
 * `freezeClone` (and a few `immutable`) copy, and the copies diverged:
 *
 *  - only `adapters/source/digest.ts` guarded typed-array / `ArrayBuffer` view
 *    fields (`ArrayBuffer.isView`), so
 *    every other copy would recurse into a `Uint8Array`'s numeric indices and
 *    freeze byte payloads element by element, and
 *  - `adapters/auth/local.ts` only `Object.freeze`d the top-level object
 *    (a shallow freeze), leaving nested actor context fields mutable.
 *
 * These helpers are the single source of truth. The `ArrayBuffer.isView` guard
 * is universally safe: a frozen reference returned from a store should not have
 * its backing bytes treated as a plain record, and skipping views avoids the
 * wasteful per-index recursion while leaving the (already non-extensible) view
 * intact.
 */

/**
 * Recursively `Object.freeze` a value in place and return it. Typed-array /
 * `ArrayBuffer` views are returned as-is rather than recursed into.
 */
export function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    if (ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freeze(nested);
    }
  }
  return value;
}

/**
 * Deep-freeze a structural clone of `value` so a stored reference cannot be
 * mutated by callers (and a caller-supplied value cannot mutate stored state).
 */
export function freezeClone<T>(value: T): T {
  return freeze(structuredClone(value));
}

/** Alias of {@link freezeClone}: a frozen deep copy of `value`. */
export const immutable = freezeClone;
