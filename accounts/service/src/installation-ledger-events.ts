/**
 * Append-only installation ledger event helpers.
 *
 * This module is the focused seam for the hash-chained ledger-event append
 * path used by every installation lifecycle route family. The retry/atomicity
 * semantics of `appendLedgerEvent` were hardened for D1 hash-chain safety and
 * live in `installation-helpers.ts`; this module re-exports them unchanged so
 * the route modules depend on a small ledger-events surface rather than the
 * broad `installation-helpers` module. Do NOT reimplement the retry loop here
 * — it must stay a single source of truth.
 */
export { appendLedgerEvent } from "./installation-helpers.ts";
