/**
 * Scheduled drift sweep (Core Specification §28 `scheduled/drift.ts`; §19
 * `drift_check`; Phase 8 advanced).
 *
 * Every cron tick (when enabled), create one `space_drift_check` RunGroup per
 * Space that currently has active Installations. Each group creates one
 * read-only `drift_check` per active Installation in that Space. A drift check
 * runs `tofu plan` against the live state; on a non-empty change summary the
 * controller emits an `installation.drift_detected` Activity event with
 * public-safe aggregate metadata. A drift check NEVER parks waiting_approval and
 * can NEVER be applied.
 *
 * This mirrors how `pollAutoSyncSources` wires the scheduled source poll: the
 * sweep takes a NARROW operations interface (active Installation listing plus
 * Space-scoped RunGroup creation) so it stays unit-testable with a stub, and it
 * is best-effort + bounded — one bad Space never aborts the sweep, and the
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
  ): Promise<readonly { readonly id: string; readonly spaceId: string }[]>;
  /** Creates a Space-scoped RunGroup containing read-only §19 drift_check Runs. */
  createSpaceDriftCheck(
    spaceId: string,
    options?: { readonly limit?: number },
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
 * Runs one scheduled drift sweep. Scans up to `limit` ACTIVE Installations,
 * groups them by Space, and creates one `space_drift_check` RunGroup per Space.
 * Best-effort: a failed Space group is swallowed so the sweep continues. Returns
 * the scanned/checked counts so the caller (and tests) can assert the bound.
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
  const bySpace = new Map<string, number>();
  for (const installation of installations) {
    bySpace.set(
      installation.spaceId,
      (bySpace.get(installation.spaceId) ?? 0) + 1,
    );
  }
  let checked = 0;
  for (const [spaceId, spaceLimit] of bySpace) {
    try {
      await operations.createSpaceDriftCheck(spaceId, { limit: spaceLimit });
      checked += spaceLimit;
    } catch {
      // Best-effort: one bad Space must not abort the whole sweep.
    }
  }
  return { scanned: installations.length, checked };
}
