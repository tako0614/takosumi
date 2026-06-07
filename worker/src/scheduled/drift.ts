/**
 * Scheduled drift sweep (Core Specification §28 `scheduled/drift.ts`; §19
 * `drift_check`; Phase 8 advanced).
 *
 * Every cron tick (when enabled), iterate the ACTIVE Installations across all
 * Spaces and create one read-only `drift_check` per Installation. A drift check
 * runs `tofu plan` against the live state; on a non-empty change summary the
 * controller emits an `installation.drift_detected` Activity event (counts only).
 * A drift check NEVER parks waiting_approval and can NEVER be applied.
 *
 * This mirrors how `pollAutoSyncSources` wires the scheduled source poll: the
 * sweep takes a NARROW operations interface (only `listActiveInstallations` +
 * `createInstallationDriftCheck`) so it stays unit-testable with a stub, and it
 * is best-effort + bounded — one bad Installation never aborts the sweep, and the
 * default cap keeps a single tick from enqueuing an unbounded number of runs.
 */

/** Default cap on Installations drift-checked per tick. */
export const DRIFT_SWEEP_DEFAULT_LIMIT = 20;

/**
 * The subset of the deploy-control operations facade the drift sweep needs. The
 * platform worker passes its in-process `operations` facade (which structurally
 * satisfies this); tests pass a stub.
 */
export interface DriftSweepOperations {
  /** Lists ACTIVE Installations across all Spaces, capped at `limit`. */
  listActiveInstallations(
    limit: number,
  ): Promise<readonly { readonly id: string }[]>;
  /** Creates a read-only §19 drift_check for one Installation. */
  createInstallationDriftCheck(
    installationId: string,
  ): Promise<unknown>;
}

export interface DriftSweepOptions {
  /** Max Installations to drift-check this tick (default {@link DRIFT_SWEEP_DEFAULT_LIMIT}). */
  readonly limit?: number;
}

export interface DriftSweepResult {
  /** Installations scanned this tick. */
  readonly scanned: number;
  /** Installations a drift check was successfully created for. */
  readonly checked: number;
}

/**
 * Runs one scheduled drift sweep. Scans up to `limit` ACTIVE Installations and
 * creates a drift check for each. Best-effort: a failed drift check for one
 * Installation is swallowed so the sweep continues. Returns the scanned/checked
 * counts so the caller (and tests) can assert the bound.
 */
export async function driftSweep(
  operations: DriftSweepOperations,
  options: DriftSweepOptions = {},
): Promise<DriftSweepResult> {
  const limit = options.limit ?? DRIFT_SWEEP_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    return { scanned: 0, checked: 0 };
  }
  const installations = await operations.listActiveInstallations(limit);
  let checked = 0;
  for (const installation of installations) {
    try {
      await operations.createInstallationDriftCheck(installation.id);
      checked++;
    } catch {
      // Best-effort: one bad Installation must not abort the whole sweep.
    }
  }
  return { scanned: installations.length, checked };
}
