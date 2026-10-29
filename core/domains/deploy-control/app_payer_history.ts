/**
 * Independent-meter payer history across app ownership transfers.
 *
 * The accepted rows of the ownership transfer ledger are the payer history.
 * An accepted row ends ownership epoch `ownershipEpoch`, held by
 * `fromAccountId`, and starts epoch `ownershipEpoch + 1`, held by
 * `toAccountId`, at its acceptance time. Acceptance time is the row's
 * `updated_at`, written once by the pending -> accepted CAS together with the
 * owner swap; accepted rows are terminal and never written again.
 *
 * The payer of an event at time T is the owner whose epoch interval contains
 * T. Missing rows, epoch gaps, discontinuous owners, absent or non-canonical
 * acceptance times, non-increasing acceptance times, an unplaceable event time
 * or a transfer drain that may be fixing the boundary of the current interval
 * all resolve to no payer. The current owner is never substituted.
 */

/** Accepted transfers one lookup walks back from the current owner. */
export const APP_OWNERSHIP_HISTORY_MAX_TRANSFERS = 64;

export interface AppOwnershipTransferRecord {
  /** The epoch this transfer ended; the recipient holds `ownershipEpoch + 1`. */
  readonly ownershipEpoch: number;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  /** Acceptance time (`updated_at` of the accepted ledger row). */
  readonly acceptedAt: string;
}

/**
 * One snapshot of the physical ownership tuple and the accepted transfers
 * reachable from it. Stores read it in a single consistent read.
 */
export interface AppOwnershipHistory {
  readonly ownerAccountId: string;
  readonly ownershipEpoch: number;
  /**
   * A pending transfer is draining the app (`management_state = 'draining'`
   * with the transfer's drain epoch). Its acceptance time can be fixed before
   * the owner swap commits, so the current open interval has no known end.
   */
  readonly transferDraining: boolean;
  /**
   * Accepted transfers walked back from the current owner, newest first: each
   * row ending `owner -> previous owner`, stopping one row after the first
   * acceptance at or before the requested time. A store returns every row it
   * reached (including duplicates at one epoch) so that ambiguity is visible.
   */
  readonly transfers: readonly AppOwnershipTransferRecord[];
}

/** In-memory row of the physical ownership transfer ledger. */
export interface CapsuleOwnershipTransferRow {
  readonly id: string;
  readonly capsuleId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly ownershipEpoch: number;
  readonly drainManagementEpoch?: number;
  readonly state: "pending" | "accepted" | "cancelled";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Raw row of {@link appOwnershipHistorySql}; depth 0 is the owner tuple. */
export interface AppOwnershipHistoryRow extends Record<string, unknown> {
  readonly depth: unknown;
  readonly ownership_epoch: unknown;
  readonly from_account_id: unknown;
  readonly to_account_id: unknown;
  readonly accepted_at: unknown;
  readonly transfer_draining: unknown;
}

/**
 * One SQLite/PostgreSQL statement, hence one consistent snapshot: the owner
 * tuple, then accepted transfers reached by `to_account_id = previous owner`
 * through the existing `(to_account_id, state)` recipient index (the ledger
 * has no capsule index and this read adds no DDL). The walk stops one row
 * after the first acceptance at or before `at` (lexical ISO comparison is
 * only the stop bound; the resolver re-checks every instant) or at the depth
 * bound. Parameters: 1 capsule id, 2 event time, 3 depth bound.
 */
export function appOwnershipHistorySql(input: {
  readonly capsules: string;
  readonly transfers: string;
  readonly placeholder: "?" | "$";
}): string {
  const { capsules, transfers, placeholder: p } = input;
  return `with recursive chain(depth, ownership_epoch, from_account_id, to_account_id, accepted_at, settled) as (
  select 0, c.ownership_epoch, c.owner_account_id, c.owner_account_id, cast(null as text), 0
    from ${capsules} c where c.id = ${p}1
  union all
  select chain.depth + 1, t.ownership_epoch, t.from_account_id, t.to_account_id, t.updated_at,
    chain.settled + (case when t.updated_at <= ${p}2 then 1 else 0 end)
    from chain join ${transfers} t
      on t.to_account_id = chain.from_account_id and t.state = 'accepted'
     and t.capsule_id = ${p}1 and t.ownership_epoch = chain.ownership_epoch - 1
   where chain.settled < 2 and chain.depth < ${p}3
)
select chain.depth, chain.ownership_epoch, chain.from_account_id, chain.to_account_id, chain.accepted_at,
  head.transfer_draining
  from chain cross join (
    select exists(
      select 1 from ${capsules} c join ${transfers} pending on pending.capsule_id = c.id
       where c.id = ${p}1 and c.management_state = 'draining' and pending.state = 'pending'
         and pending.drain_management_epoch = c.management_epoch
    ) as transfer_draining
  ) head
 order by chain.depth`;
}

/** Map {@link appOwnershipHistorySql} rows; values are validated by the resolver. */
export function appOwnershipHistoryFromRows(rows: readonly AppOwnershipHistoryRow[]): AppOwnershipHistory | undefined {
  const [head, ...rest] = rows;
  if (!head || Number(head.depth) !== 0 || typeof head.to_account_id !== "string" || !head.to_account_id) {
    return undefined;
  }
  const text = (value: unknown) => typeof value === "string" ? value : "";
  return {
    ownerAccountId: head.to_account_id,
    ownershipEpoch: Number(head.ownership_epoch),
    transferDraining: head.transfer_draining === true || head.transfer_draining === 1,
    transfers: rest.map((row) => ({
      ownershipEpoch: Number(row.ownership_epoch),
      fromAccountId: text(row.from_account_id),
      toAccountId: text(row.to_account_id),
      acceptedAt: text(row.accepted_at),
    })),
  };
}

/** Pre-v77 or pre-ledger schemas provide no history (`undefined`), never an error. */
export function appOwnershipHistorySchemaMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|no such column|does not exist|undefined column|undefined table/iu.test(message);
}

const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Milliseconds of a canonical `Date#toISOString()` instant, else undefined. */
function canonicalInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : undefined;
}

function accountId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The owner whose epoch interval contains `at`, or undefined when the history
 * cannot establish exactly one. Intervals are half-open: an event at an
 * acceptance instant belongs to the recipient.
 */
export function appPayerAtEventTime(history: AppOwnershipHistory, at: string): string | undefined {
  const eventAt = canonicalInstant(at);
  const epoch = history.ownershipEpoch;
  if (eventAt === undefined || !accountId(history.ownerAccountId) || !Number.isSafeInteger(epoch) || epoch < 0) {
    return undefined;
  }
  // Every reached row must continue one chain back from the current owner:
  // epochs E-1, E-2, ... exactly once, owner continuity, and strictly
  // decreasing acceptance times.
  const acceptances: number[] = [];
  let holder = history.ownerAccountId;
  for (const [index, transfer] of history.transfers.entries()) {
    const acceptedAt = canonicalInstant(transfer.acceptedAt);
    if (transfer.ownershipEpoch !== epoch - 1 - index || transfer.toAccountId !== holder ||
      !accountId(transfer.fromAccountId) || transfer.fromAccountId === holder || acceptedAt === undefined ||
      (index > 0 && acceptedAt >= acceptances[index - 1]!)) return undefined;
    acceptances.push(acceptedAt);
    holder = transfer.fromAccountId;
  }
  // The newest acceptance at or before the event starts its interval.
  const index = acceptances.findIndex((acceptedAt) => acceptedAt <= eventAt);
  if (index === -1) {
    // Every reached acceptance is after the event: only a walk that reached
    // epoch 0 proves the original owner.
    if (acceptances.length !== epoch) return undefined;
    if (epoch === 0 && history.transferDraining) return undefined;
    return holder;
  }
  // A transfer drain may already have stamped the end of the open interval.
  if (index === 0 && history.transferDraining) return undefined;
  const found = history.transfers[index]!;
  // The interval's own start boundary must sit on a reached chain row too.
  if (found.ownershipEpoch > 0 && index + 1 >= history.transfers.length) return undefined;
  return found.toAccountId;
}
