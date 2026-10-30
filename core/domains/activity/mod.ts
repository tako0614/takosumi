/**
 * Activity domain service (Core Specification §27 audit_events / §34 Activity).
 *
 * The Workspace-scoped audit trail surfaced in the dashboard Activity view (§31).
 * Domain services and the deploy-control controller emit one {@link
 * ActivityEvent} per state-changing action through {@link ActivityService.record};
 * the route layer reads a Workspace's recent activity through {@link
 * ActivityService.list}.
 *
 * Recording is FIRE-AND-FORGET: `record` mints the event id + timestamp, persists
 * it, and NEVER throws into the caller's path (a failed audit write must not fail
 * the action it describes). On a store error it warns and returns `undefined`.
 *
 * Security invariant: callers should pass identifiers / names / digests / counts
 * in `metadata` only — never secret material and never resolved output VALUES
 * (spec §9 / §16). The service still redacts secret-shaped metadata as a central
 * backstop so a bad emission site cannot persist obvious token/password fields.
 */

import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import { clampPageLimit, encodeCursor } from "takosumi-contract/pagination";
import {
  ACTIVITY_WORKSPACE_BATCH_LIMIT,
  boundedActivityWorkspaceIds,
  clampActivityLimit,
} from "../deploy-control/store.ts";
import type {
  ActivityLedgerPageInput,
  OpenTofuControlStore,
} from "../deploy-control/store.ts";
import { log } from "../../shared/log.ts";
import { redactRecord } from "../../shared/redaction.ts";

/** The {@link ActivityEvent} fields a caller supplies; id + createdAt are minted. */
export type RecordActivityInput = Omit<ActivityEvent, "id" | "createdAt">;

/**
 * Context handed only to the host's recorded hook (the notification path).
 * It is never stored with the event, so it never reaches Activity responses.
 */
export interface RecordActivityContext {
  /** The owner of the recorded target when the event alone cannot name it. */
  readonly ownerAccountId?: string;
  /** The account that acted, when the stored `actorId` is not an account. */
  readonly actorAccountId?: string;
}

export interface ActivityServiceDependencies {
  readonly store: OpenTofuControlStore;
  /**
   * Called after an event is stored. It must not throw or block; the host
   * uses it to start the immediate delivery of a notified event (TASK-0119).
   */
  readonly onRecorded?: (event: ActivityEvent, context?: RecordActivityContext) => void;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
}

/**
 * Thin emission seam handed to domain services / the controller so emission
 * points stay one-liners and decoupled from the concrete service. The default
 * is a no-op recorder (audit disabled), so a service constructed without an
 * Activity binding simply records nothing.
 */
export interface ActivityRecorder {
  record(
    event: RecordActivityInput,
    context?: RecordActivityContext,
  ): Promise<ActivityEvent | undefined>;
}

/** Read seam for one entity's filtered, newest-first Activity history. */
export interface ActivityTargetReader {
  listTargetPage(
    workspaceId: string,
    targetType: string,
    targetId: string,
    params: PageParams,
  ): Promise<Page<ActivityEvent>>;
}

/** Restart-safe Activity write used by durable Run outboxes. */
export interface IdempotentActivityRecorder {
  recordIdempotent(
    id: string,
    createdAt: string,
    event: RecordActivityInput,
  ): Promise<ActivityEvent | undefined>;
}

/** Shared read/write ledger seam consumed by Resource Shape. */
export type ActivityLedger = ActivityRecorder &
  ActivityTargetReader &
  IdempotentActivityRecorder;

/** A recorder that drops every event. Used when no Activity ledger is wired. */
export const NOOP_ACTIVITY_RECORDER: ActivityRecorder = {
  record: () => Promise.resolve(undefined),
};

export class ActivityService implements ActivityLedger {
  readonly #store: OpenTofuControlStore;
  readonly #onRecorded:
    | ((event: ActivityEvent, context?: RecordActivityContext) => void)
    | undefined;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  #lastTimestampMs = 0;

  constructor(deps: ActivityServiceDependencies) {
    this.#store = deps.store;
    this.#onRecorded = deps.onRecorded;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * Records one Activity event. Fire-and-forget safe: it mints the id +
   * createdAt, persists, and swallows any store error (warn-only) so the
   * caller's action is never failed by an audit write.
   */
  async record(
    event: RecordActivityInput,
    context?: RecordActivityContext,
  ): Promise<ActivityEvent | undefined> {
    const createdAt = this.#nextCreatedAt();
    const full: ActivityEvent = {
      ...event,
      metadata: redactRecord(event.metadata),
      id: this.#newId("act"),
      createdAt,
    };
    Object.defineProperty(full, "toJSON", { value: undefined });
    let stored: ActivityEvent;
    try {
      stored = await this.#store.putActivityEvent(full);
    } catch (error) {
      log.warn("service.activity.record_failed", {
        action: event.action,
        workspaceId: event.workspaceId,
        error,
      });
      return undefined;
    }
    this.#notifyRecorded(stored, context);
    return stored;
  }

  #notifyRecorded(event: ActivityEvent, context?: RecordActivityContext): void {
    try {
      this.#onRecorded?.(event, context);
    } catch (error) {
      log.warn("service.activity.observer_failed", { action: event.action, error });
    }
  }

  /**
   * Persists a caller-minted deterministic event. Store backends upsert by id,
   * so replay after a lost Run acknowledgement cannot duplicate Activity.
   */
  async recordIdempotent(
    id: string,
    createdAt: string,
    event: RecordActivityInput,
  ): Promise<ActivityEvent | undefined> {
    if (id.trim() === "" || !Number.isFinite(Date.parse(createdAt))) {
      throw new TypeError(
        "idempotent Activity id and ISO createdAt are required",
      );
    }
    const full: ActivityEvent = {
      ...event,
      metadata: redactRecord(event.metadata),
      id,
      createdAt,
    };
    Object.defineProperty(full, "toJSON", { value: undefined });
    try {
      return await this.#store.putActivityEvent(full);
    } catch (error) {
      log.warn("service.activity.record_idempotent_failed", {
        id,
        action: event.action,
        workspaceId: event.workspaceId,
        error,
      });
      return undefined;
    }
  }

  #nextCreatedAt(): string {
    const observed = this.#now().getTime();
    const next =
      observed <= this.#lastTimestampMs ? this.#lastTimestampMs + 1 : observed;
    this.#lastTimestampMs = next;
    return new Date(next).toISOString();
  }

  /**
   * Lists a Workspace's recent activity, newest first. `limit` is clamped to
   * `1..ACTIVITY_MAX_LIMIT` (default `ACTIVITY_DEFAULT_LIMIT`).
   */
  async list(
    workspaceId: string,
    limit?: number,
  ): Promise<readonly ActivityEvent[]> {
    return await this.#store.listActivityEvents(workspaceId, {
      limit: clampActivityLimit(limit),
    });
  }

  /** One bounded newest-first read across already-authorized Workspaces. */
  async listAcrossWorkspaces(
    workspaceIds: readonly string[],
    limit?: number,
  ): Promise<readonly ActivityEvent[]> {
    const ids = boundedActivityWorkspaceIds(workspaceIds);
    if (ids.length === 0) return [];
    return await this.#store.listActivityEventsForWorkspaces(ids, {
      limit: clampActivityLimit(limit),
    });
  }

  /** One stored event by id, for the notification dispatcher's parked events. */
  async get(id: string): Promise<ActivityEvent | undefined> {
    return await this.#store.getActivityEvent(id);
  }

  /**
   * Oldest-first page of the whole ledger, every Workspace included, for the
   * notification dispatcher's `(createdAt, id)` cursor. Not an API surface.
   */
  async listAfter(
    input: ActivityLedgerPageInput,
  ): Promise<readonly ActivityEvent[]> {
    return await this.#store.listActivityEventsAfter(input);
  }

  /**
   * One newest-first keyset page across any number of internal Activity
   * partitions, read in batches of {@link ACTIVITY_WORKSPACE_BATCH_LIMIT}
   * (the D1 bound-variable budget) and merged on the shared
   * `(createdAt, id)` keyset, so the cursor stays the store's opaque cursor.
   * At most {@link ACTIVITY_PARTITION_LIMIT} partitions are read; the caller
   * passes only partitions of apps it may view and still filters each event.
   */
  async listAcrossWorkspacesPage(
    workspaceIds: readonly string[],
    params: PageParams,
  ): Promise<Page<ActivityEvent>> {
    const ids = [...new Set(workspaceIds.map((id) => id.trim()))];
    if (ids.some((id) => id.length === 0)) {
      throw new RangeError("Activity partitions must be non-empty ids");
    }
    if (ids.length > ACTIVITY_PARTITION_LIMIT) {
      throw new RangeError(
        `Activity page reads at most ${ACTIVITY_PARTITION_LIMIT} partitions`,
      );
    }
    if (ids.length === 0) return { items: [] };
    const limit = clampPageLimit(params.limit);
    const batches: string[][] = [];
    for (let index = 0; index < ids.length; index += ACTIVITY_WORKSPACE_BATCH_LIMIT) {
      batches.push(ids.slice(index, index + ACTIVITY_WORKSPACE_BATCH_LIMIT));
    }
    const pages = await Promise.all(
      batches.map((batch) =>
        this.#store.listActivityEventsForWorkspacesPage(batch, {
          ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
          limit,
        })
      ),
    );
    const merged = pages
      .flatMap((page) => page.items)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
    const more = merged.length > limit || pages.some((page) => page.nextCursor !== undefined);
    const items = merged.slice(0, limit);
    const last = items[items.length - 1];
    return more && last !== undefined
      ? { items, nextCursor: encodeCursor(last) }
      : { items };
  }

  /** Lists one target's audit history using the shared opaque keyset cursor. */
  async listTargetPage(
    workspaceId: string,
    targetType: string,
    targetId: string,
    params: PageParams,
  ): Promise<Page<ActivityEvent>> {
    return await this.#store.listActivityEventsForTargetPage(
      workspaceId,
      targetType,
      targetId,
      params,
    );
  }
}

/** Partitions one {@link ActivityService.listAcrossWorkspacesPage} call may read. */
export const ACTIVITY_PARTITION_LIMIT = 96;

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
