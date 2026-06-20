/**
 * Small value-shape guards shared across the runtime-agent modules.
 *
 * Kept local to the runtime-agent boundary (rather than reaching into the
 * service layer) so the operator-internal runtime agent stays decoupled from
 * `core/`, while still avoiding a per-module re-declaration of the same
 * `isRecord` one-liner.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
