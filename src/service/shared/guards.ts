/**
 * Single source of truth for the "is this a JSON object (record)?" guard used
 * across the service's validation, projection, and adapter boundaries.
 *
 * Previously ~13 files each hand-rolled their own `isRecord` copy, and the
 * bodies silently diverged on whether they excluded arrays: some used the
 * `!Array.isArray(value)` form and some used the bare
 * `typeof value === "object" && value !== null` form. The latter is weaker — a
 * JSON array (`typeof [] === "object"`) passes as a "record" — so the same
 * untrusted payload was accepted at one validation call-site and rejected at
 * another. The `!Array.isArray(value)` form is the canonical, stronger variant
 * and is the only one used here.
 */

/**
 * Narrow `value` to a non-null, non-array object. A JSON array is NOT a record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return `value` as a record when it is one, otherwise `undefined`. Useful for
 * optional-chaining style field access without a separate `isRecord` branch.
 */
export function asRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
