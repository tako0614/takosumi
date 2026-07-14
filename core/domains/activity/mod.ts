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
import { clampActivityLimit } from "../deploy-control/store.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import { log } from "../../shared/log.ts";
import { redactRecord } from "../../shared/redaction.ts";

/** The {@link ActivityEvent} fields a caller supplies; id + createdAt are minted. */
export type RecordActivityInput = Omit<ActivityEvent, "id" | "createdAt">;

export interface ActivityServiceDependencies {
  readonly store: OpenTofuControlStore;
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
  record(event: RecordActivityInput): Promise<ActivityEvent | undefined>;
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
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  #lastTimestampMs = 0;

  constructor(deps: ActivityServiceDependencies) {
    this.#store = deps.store;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * Records one Activity event. Fire-and-forget safe: it mints the id +
   * createdAt, persists, and swallows any store error (warn-only) so the
   * caller's action is never failed by an audit write.
   */
  async record(event: RecordActivityInput): Promise<ActivityEvent | undefined> {
    const createdAt = this.#nextCreatedAt();
    const full: ActivityEvent = {
      ...event,
      metadata: redactRecord(event.metadata),
      id: this.#newId("act"),
      createdAt,
    };
    try {
      return await this.#store.putActivityEvent(full);
    } catch (error) {
      log.warn("service.activity.record_failed", {
        action: event.action,
        workspaceId: event.workspaceId,
        error,
      });
      return undefined;
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

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
