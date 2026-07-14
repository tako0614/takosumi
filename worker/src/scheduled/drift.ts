/**
 * Scheduled drift sweep (Core Specification §28 `scheduled/drift.ts`; §19
 * `drift_check`; Phase 8 advanced).
 *
 * Every cron tick (when enabled), create one `workspace_drift_check` RunGroup per
 * Workspace that currently has active Capsules. Each group creates one
 * read-only `drift_check` per active Capsule in that Workspace. A drift check
 * runs `tofu plan` against the live state; on a non-empty change summary the
 * controller emits a `capsule.drift_detected` Activity event with
 * public-safe aggregate metadata. A drift check NEVER parks waiting_approval and
 * can NEVER be applied.
 *
 * This mirrors how `pollAutoSyncSources` wires the scheduled source poll: the
 * sweep takes a NARROW operations interface (active Capsule listing plus
 * Workspace-scoped RunGroup creation) so it stays unit-testable with a stub, and it
 * is best-effort + bounded — one bad Workspace never aborts the sweep, and the
 * default cap keeps a single tick from enqueuing an unbounded number of runs.
 */

/** Default cap on Capsules drift-checked per tick. */
export const DRIFT_SWEEP_DEFAULT_LIMIT = 20;

/**
 * The subset of the deploy-control operations facade the drift sweep needs. The
 * platform worker passes its in-process `operations` facade (which structurally
 * satisfies this); tests pass a stub.
 */
export interface DriftSweepOperations {
  /** Lists active Capsules across all Workspaces, capped at `limit`. */
  listActiveCapsules(
    limit: number,
  ): Promise<readonly { readonly id: string; readonly workspaceId: string }[]>;
  /** Creates a Workspace-scoped RunGroup containing read-only §19 drift_check Runs. */
  createWorkspaceDriftCheck(
    workspaceId: string,
    options?: { readonly limit?: number },
  ): Promise<unknown>;
}

export interface DriftSweepOptions {
  /** Max Capsules to drift-check this tick (default {@link DRIFT_SWEEP_DEFAULT_LIMIT}). */
  readonly limit?: number;
}

export interface DriftSweepResult {
  /** Capsules scanned this tick. */
  readonly scanned: number;
  /** Capsules a drift check was successfully created for. */
  readonly checked: number;
}

/**
 * Runs one scheduled drift sweep. Scans up to `limit` active Capsules,
 * groups them by Workspace, and creates one `workspace_drift_check` RunGroup per Workspace.
 * Best-effort: a failed Workspace group is swallowed so the sweep continues. Returns
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
  const capsules = await operations.listActiveCapsules(limit);
  const byWorkspace = new Map<string, number>();
  for (const capsule of capsules) {
    byWorkspace.set(
      capsule.workspaceId,
      (byWorkspace.get(capsule.workspaceId) ?? 0) + 1,
    );
  }
  let checked = 0;
  for (const [workspaceId, workspaceLimit] of byWorkspace) {
    try {
      await operations.createWorkspaceDriftCheck(workspaceId, {
        limit: workspaceLimit,
      });
      checked += workspaceLimit;
    } catch {
      // Best-effort: one bad Workspace must not abort the whole sweep.
    }
  }
  return { scanned: capsules.length, checked };
}
