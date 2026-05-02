// Phase 18.3 / M6 — Multi-generation GroupHead history.
//
// `group_heads.previous_deployment_id` is a single slot: when GroupHead
// advances D2 -> D3, D2 becomes the previous and D1 is forgotten.
// `rollbackGroup` therefore only ever resolves to the immediately previous
// head. M6 retains N generations of history so:
//
//   1. `rollbackGroup({ targetDeploymentId })` can validate the target
//      against the retained history (defensive: reject targets that were
//      never the head, or whose history entry has been pruned).
//   2. `rollbackGroup({ steps: N })` resolves the target as
//      "the head N rollovers ago", skipping the current head.
//
// The history is append-only. Each successful `advanceGroupHead` /
// `commitAppliedDeployment` writes one row capturing the new head's
// deployment id, the rollover timestamp, and a per-(space, group) monotonic
// `sequence`. The `sequence` matches `GroupHead.generation` so callers can
// correlate history rows with the point-in-time GroupHead snapshot.
//
// The DB schema for the durable adapter lives in
// `db/migrations/20260430000017_group_head_history.sql`. The in-memory
// implementation in this module is the reference adapter used by tests and
// by the in-memory bootstrap path.

import type { IsoTimestamp } from "takosumi-contract";

/**
 * One persisted advance-event for a (space, group) pair. Append-only: the
 * tuple `(space_id, group_id, sequence)` is unique, so each rollover writes
 * exactly one row. The same `deployment_id` may legitimately appear more
 * than once (deploy D1 -> deploy D2 -> rollback to D1 -> deploy D3 ->
 * rollback to D1 again would write three rows for D1) — the most recent row
 * wins for `--target=<deployment_id>` resolution.
 */
export interface GroupHeadHistoryEntry {
  readonly spaceId: string;
  readonly groupId: string;
  readonly deploymentId: string;
  /** The id that was the head immediately before this entry, or null if
   *  this entry was the first head for the (space, group) pair. */
  readonly previousDeploymentId: string | null;
  /** Monotonic per-(space, group) advance counter. Equals the GroupHead
   *  `generation` at the time of the rollover. */
  readonly sequence: number;
  readonly advancedAt: IsoTimestamp;
}

/** Append-only mutation envelope. The history store records exactly one
 *  row per call. */
export interface GroupHeadHistoryAppendInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly deploymentId: string;
  readonly previousDeploymentId: string | null;
  readonly sequence: number;
  readonly advancedAt: IsoTimestamp;
}

export interface GroupHeadHistoryQuery {
  readonly spaceId: string;
  readonly groupId: string;
  /** When set, only entries with `sequence <= upToSequence` are considered.
   *  Used by the rollback resolver to ignore history rows newer than the
   *  observed GroupHead snapshot (defensive against racing writers). */
  readonly upToSequence?: number;
}

/**
 * Persistence port for the GroupHead advance history.
 *
 * The store is intentionally small: append + query. Implementations MUST
 * write each `append` durably before returning so the resolver can rely on
 * the history during a subsequent rollback. The DB-backed adapter wraps
 * `append` in the same transaction as the GroupHead mutation so the two
 * can never disagree.
 */
export interface GroupHeadHistoryStore {
  /** Persist one advance-event row. */
  append(input: GroupHeadHistoryAppendInput): Promise<GroupHeadHistoryEntry>;
  /** Return the full history for a (space, group), newest-first. */
  list(
    query: GroupHeadHistoryQuery,
  ): Promise<readonly GroupHeadHistoryEntry[]>;
  /**
   * Resolve a `rollback --target=<deployment_id>` request. Returns the most
   * recent history entry where `deployment_id` matches the target. Returns
   * `undefined` when the target was never the head (caller MUST then refuse
   * the rollback so we never advance to a Deployment that has not been
   * applied through this group).
   */
  findMostRecentByDeployment(
    query: GroupHeadHistoryQuery & { deploymentId: string },
  ): Promise<GroupHeadHistoryEntry | undefined>;
  /**
   * Resolve a `rollback --steps=N` request. Returns the head from N
   * rollovers ago, skipping the current head (steps=1 means "the head
   * immediately before the current one", matching the pre-M6 single-slot
   * behaviour). Returns `undefined` when the history does not retain that
   * many generations.
   */
  findStepsBack(
    query: GroupHeadHistoryQuery & { steps: number },
  ): Promise<GroupHeadHistoryEntry | undefined>;
}

/**
 * Reference in-memory implementation. Used by tests and by the
 * `InMemoryDeploymentStore` so the history surface works out of the box
 * without a DB.
 */
export class InMemoryGroupHeadHistoryStore implements GroupHeadHistoryStore {
  // Keyed by `${space_id}::${group_id}`. Each value is the append-only list
  // of advances for that pair, kept in `sequence` ascending order.
  readonly #entries = new Map<string, GroupHeadHistoryEntry[]>();

  // deno-lint-ignore require-await
  async append(
    input: GroupHeadHistoryAppendInput,
  ): Promise<GroupHeadHistoryEntry> {
    const key = historyKey(input.spaceId, input.groupId);
    const list = this.#entries.get(key) ?? [];
    // Defensive: every history row must have a strictly increasing
    // `sequence`. The store does not assign sequences itself (the caller
    // already holds the GroupHead lock and knows the target generation),
    // but we reject duplicates / regressions to surface caller bugs early.
    const last = list[list.length - 1];
    if (last && input.sequence <= last.sequence) {
      throw new Error(
        `group_head_history append for (${input.spaceId}, ${input.groupId}) ` +
          `regressed sequence: incoming=${input.sequence} prior=${last.sequence}`,
      );
    }
    const entry: GroupHeadHistoryEntry = Object.freeze({
      spaceId: input.spaceId,
      groupId: input.groupId,
      deploymentId: input.deploymentId,
      previousDeploymentId: input.previousDeploymentId,
      sequence: input.sequence,
      advancedAt: input.advancedAt,
    });
    list.push(entry);
    this.#entries.set(key, list);
    return entry;
  }

  // deno-lint-ignore require-await
  async list(
    query: GroupHeadHistoryQuery,
  ): Promise<readonly GroupHeadHistoryEntry[]> {
    const key = historyKey(query.spaceId, query.groupId);
    const list = this.#entries.get(key) ?? [];
    const filtered = query.upToSequence === undefined
      ? list
      : list.filter((entry) => entry.sequence <= query.upToSequence!);
    // Newest-first (sequence desc) so callers do not need to re-sort.
    return [...filtered].sort((a, b) => b.sequence - a.sequence);
  }

  async findMostRecentByDeployment(
    query: GroupHeadHistoryQuery & { deploymentId: string },
  ): Promise<GroupHeadHistoryEntry | undefined> {
    const recent = await this.list(query);
    return recent.find((entry) => entry.deploymentId === query.deploymentId);
  }

  async findStepsBack(
    query: GroupHeadHistoryQuery & { steps: number },
  ): Promise<GroupHeadHistoryEntry | undefined> {
    if (!Number.isInteger(query.steps) || query.steps < 1) {
      throw new Error(
        `group_head_history findStepsBack requires steps >= 1, got ${query.steps}`,
      );
    }
    const recent = await this.list(query);
    // Index 0 is the current head; index N is N rollovers back.
    return recent[query.steps];
  }
}

function historyKey(spaceId: string, groupId: string): string {
  return `${spaceId}::${groupId}`;
}

/**
 * Resolve a rollback target from either an explicit `targetDeploymentId` or
 * a `steps` count. Returns the resolved Deployment id or throws with a
 * descriptive error. Used by `DeploymentService.rollbackGroup`.
 *
 * Resolution rules:
 *   1. `targetDeploymentId` set: the deployment must appear in the
 *      retained history. The most recent occurrence wins so a
 *      deploy-rollback-redeploy-rollback chain resolves to the latest
 *      retained generation.
 *   2. `steps` set: skip the current head (`steps=1` ⇒ the immediately
 *      previous head; `steps=3` ⇒ three generations back). Falls through
 *      to "no retained generation" when the history was pruned.
 *   3. Both set: validates that resolving by `steps` yields the same id as
 *      `targetDeploymentId`. This lets a CLI accept both `--target=` and
 *      `--steps=` in the same invocation as a defensive cross-check.
 *   4. Neither set: error — the caller did not actually request a rollback.
 */
export interface RollbackResolutionInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly currentSequence: number;
  readonly targetDeploymentId?: string;
  readonly steps?: number;
}

export interface RollbackResolution {
  readonly entry: GroupHeadHistoryEntry;
  readonly resolvedBy: "target" | "steps" | "target-and-steps";
}

export async function resolveRollbackTarget(
  store: GroupHeadHistoryStore,
  input: RollbackResolutionInput,
): Promise<RollbackResolution> {
  const hasTarget = typeof input.targetDeploymentId === "string" &&
    input.targetDeploymentId.length > 0;
  const hasSteps = typeof input.steps === "number";
  if (!hasTarget && !hasSteps) {
    throw new Error(
      "rollbackGroup: at least one of targetDeploymentId or steps must be provided",
    );
  }
  // Cap every history query at the observed `currentSequence` so racing
  // writers cannot smuggle a newer head into the rollback resolution.
  const baseQuery = {
    spaceId: input.spaceId,
    groupId: input.groupId,
    upToSequence: input.currentSequence,
  };

  let stepsEntry: GroupHeadHistoryEntry | undefined;
  if (hasSteps) {
    if (!Number.isInteger(input.steps) || (input.steps as number) < 1) {
      throw new Error(
        `rollbackGroup: steps must be a positive integer, got ${input.steps}`,
      );
    }
    stepsEntry = await store.findStepsBack({
      ...baseQuery,
      steps: input.steps as number,
    });
    if (!stepsEntry) {
      throw new Error(
        `rollbackGroup: history does not retain ${input.steps} prior generation(s) ` +
          `for (${input.spaceId}, ${input.groupId})`,
      );
    }
  }

  let targetEntry: GroupHeadHistoryEntry | undefined;
  if (hasTarget) {
    targetEntry = await store.findMostRecentByDeployment({
      ...baseQuery,
      deploymentId: input.targetDeploymentId as string,
    });
    if (!targetEntry) {
      throw new Error(
        `rollbackGroup: deployment ${input.targetDeploymentId} was never the ` +
          `head of (${input.spaceId}, ${input.groupId}) — refusing to rollback`,
      );
    }
    // Refuse when the named target IS the current head: rolling forward to
    // the existing head is a no-op that masks caller bugs.
    if (targetEntry.sequence === input.currentSequence) {
      throw new Error(
        `rollbackGroup: deployment ${input.targetDeploymentId} is the current ` +
          `head of (${input.spaceId}, ${input.groupId}) — nothing to rollback`,
      );
    }
  }

  if (hasTarget && hasSteps) {
    if (targetEntry!.deploymentId !== stepsEntry!.deploymentId) {
      throw new Error(
        `rollbackGroup: target=${input.targetDeploymentId} and steps=${input.steps} ` +
          `disagree (steps resolves to ${stepsEntry!.deploymentId})`,
      );
    }
    return { entry: targetEntry!, resolvedBy: "target-and-steps" };
  }
  if (hasTarget) {
    return { entry: targetEntry!, resolvedBy: "target" };
  }
  return { entry: stepsEntry!, resolvedBy: "steps" };
}
