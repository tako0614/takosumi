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
 * Wrongly charging an account is worse than leaving an event unattributed.
 * The meter's `createdAt` is a claim on the meter's clock for an aggregated
 * measurement, while acceptance times are server clock instants. So an event
 * stands for usage somewhere in a span around its claimed time (see
 * {@link meterEventSpan}), and it is attributed only when that whole span lies
 * inside one owner's interval. Missing rows, epoch gaps, discontinuous owners,
 * absent or non-canonical acceptance times, non-increasing acceptance times,
 * an unplaceable event time, or a transfer drain that may be fixing the end of
 * the current interval all resolve to no payer. The current owner is never
 * substituted.
 */

/** Accepted transfers one lookup walks back from the current owner. */
export const APP_OWNERSHIP_HISTORY_MAX_TRANSFERS = 64;

/**
 * Guard G around a meter's claimed event time, in milliseconds.
 *
 * G must cover the meter's aggregation window plus meter/server clock skew.
 * `UsageEvent` carries no usage window, and `createdAt` may name either end of
 * an aggregated bucket. Independent meters therefore must aggregate over at
 * most one hour (the coarsest unit in use, such as `storage.gb_hour`). Their
 * clocks must also stay within one hour of the server's. Two hours covers
 * both. A coarser producer needs a window-aware usage input before its events
 * can be attributed across a transfer.
 */
export const APP_PAYER_BOUNDARY_GUARD_MS = 2 * 60 * 60 * 1000;

/**
 * Oldest claimed event time trusted when the choice is between owners
 * (`ownership_epoch > 0`), relative to the server's recording time. Seven days
 * absorbs delayed batch reports and retry backlogs. Older claims cannot select
 * which account pays.
 */
export const APP_PAYER_MAX_LATENESS_MS = 7 * 24 * 60 * 60 * 1000;

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
   * Present while a pending transfer is draining the app
   * (`management_state = 'draining'` with that transfer's drain epoch): the
   * pending row's `created_at`. Its acceptance can be stamped before the owner
   * swap commits, so the current open interval ends at an unknown instant no
   * earlier than this.
   */
  readonly drainingTransferCreatedAt?: string;
  /**
   * Accepted transfers walked back from the current owner, newest first: each
   * row ending `owner -> previous owner`, stopping one row after the first
   * acceptance at or before the requested time. A store returns every row it
   * reached (including duplicates at one epoch) so that ambiguity is visible.
   */
  readonly transfers: readonly AppOwnershipTransferRecord[];
}

/** Server-side facts that bound where a meter event's usage can lie. */
export interface MeterEventPlacement {
  /** The meter's claimed event time (`createdAt`, canonical ISO instant). */
  readonly at: string;
  /** Server clock milliseconds when the event is recorded. */
  readonly recordedAt: number;
  /** The app's creation time; no usage precedes it. */
  readonly appCreatedAt: string;
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
  readonly draining_transfer_created_at: unknown;
}

/**
 * One SQLite/PostgreSQL statement, hence one consistent snapshot: the owner
 * tuple, then accepted transfers reached by `to_account_id = previous owner`
 * through the existing `(to_account_id, state)` recipient index (the ledger
 * has no capsule index and this read adds no DDL). The walk stops one row
 * after the first acceptance at or before `at` (lexical ISO comparison is
 * only the stop bound; the resolver re-checks every instant) or at the depth
 * bound. Parameters: 1 capsule id, 2 walk-stop instant, 3 depth bound.
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
  head.draining_transfer_created_at
  from chain cross join (
    select (
      select pending.created_at from ${capsules} c join ${transfers} pending on pending.capsule_id = c.id
       where c.id = ${p}1 and c.management_state = 'draining' and pending.state = 'pending'
         and pending.drain_management_epoch = c.management_epoch
       limit 1
    ) as draining_transfer_created_at
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
  const draining = head.draining_transfer_created_at;
  return {
    ownerAccountId: head.to_account_id,
    ownershipEpoch: Number(head.ownership_epoch),
    // A draining row with an unreadable time stays present (and fails closed).
    ...(draining === null || draining === undefined ? {} : { drainingTransferCreatedAt: text(draining) }),
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
 * Server-clock span that must contain the usage an event reports:
 * `[max(at - G, app creation), min(at + G, recordedAt)]`. The upper clamp holds
 * because usage happens before the server receives its report. Undefined when
 * the claim is unplaceable: not a canonical instant, earlier than the app's
 * creation, or later than the recording time plus G.
 */
export function meterEventSpan(event: MeterEventPlacement): { readonly start: number; readonly end: number } | undefined {
  const eventAt = canonicalInstant(event.at);
  const createdAt = Date.parse(event.appCreatedAt);
  if (eventAt === undefined || !Number.isFinite(createdAt) || !Number.isFinite(event.recordedAt) ||
    eventAt < createdAt || eventAt > event.recordedAt + APP_PAYER_BOUNDARY_GUARD_MS) return undefined;
  const start = Math.max(eventAt - APP_PAYER_BOUNDARY_GUARD_MS, createdAt);
  const end = Math.min(eventAt + APP_PAYER_BOUNDARY_GUARD_MS, event.recordedAt);
  return start <= end ? { start, end } : undefined;
}

/**
 * The single owner whose interval contains the event's whole usage span, or
 * undefined when the history cannot establish exactly one. Intervals are
 * half-open, `[acceptance, next acceptance)`.
 */
export function appPayerAtEventTime(history: AppOwnershipHistory, event: MeterEventPlacement): string | undefined {
  const span = meterEventSpan(event);
  const epoch = history.ownershipEpoch;
  if (!span || !accountId(history.ownerAccountId) || !Number.isSafeInteger(epoch) || epoch < 0) return undefined;
  // Selecting between owners trusts the meter's claim only within bounded lateness.
  if (epoch > 0 && canonicalInstant(event.at)! < event.recordedAt - APP_PAYER_MAX_LATENESS_MS) return undefined;
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
  // An acceptance inside the span splits the usage between owners.
  if (acceptances.some((acceptedAt) => acceptedAt > span.start && acceptedAt <= span.end)) return undefined;
  // The newest acceptance at or before the span starts its interval.
  const index = acceptances.findIndex((acceptedAt) => acceptedAt <= span.start);
  let payer: string;
  if (index === -1) {
    // Every reached acceptance is after the span: only a walk that reached
    // epoch 0 proves the original owner.
    if (acceptances.length !== epoch) return undefined;
    payer = holder;
  } else {
    const found = history.transfers[index]!;
    // The interval's own start boundary must sit on a reached chain row too.
    if (found.ownershipEpoch > 0 && index + 1 >= history.transfers.length) return undefined;
    payer = found.toAccountId;
  }
  // A transfer drain can already have stamped the end of the open interval,
  // never earlier than its pending row's creation.
  const openInterval = index === 0 || (index === -1 && epoch === 0);
  if (openInterval && history.drainingTransferCreatedAt !== undefined) {
    const drainCreatedAt = canonicalInstant(history.drainingTransferCreatedAt);
    if (drainCreatedAt === undefined || span.end >= drainCreatedAt) return undefined;
  }
  return payer;
}
