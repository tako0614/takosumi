/**
 * Activity audit ledger contract (Core Specification §27 `audit_events` / §34
 * "Activity").
 *
 * Activity is the Space-scoped audit trail surfaced in the dashboard's Activity
 * view (§31). One {@link ActivityEvent} records a single state-changing action
 * inside a Space — an Installation created, a plan / apply / destroy run reaching
 * a milestone, a Dependency added, stale propagation, a RunGroup created — keyed
 * by the Space so the dashboard can list a Space's recent activity.
 *
 * This is the PUBLIC, Space-level audit trail. It is distinct from the internal
 * run-level {@link DeployControlAuditEvent} (the per-run policy / lease / dispatch
 * trace carried inside a PlanRun / ApplyRun record); the two never share a type.
 *
 * Security invariant: an ActivityEvent records WHAT happened, not secrets.
 * `metadata` carries identifiers, names, digests, and counts only — never
 * credential material and never resolved output VALUES (spec §9 / §16: secret
 * outputs and credential values are never stored as public ledger values).
 */

export const SPACE_ACTIVITY_PATH = (spaceId: string): string =>
  `/v1/spaces/${encodeURIComponent(spaceId)}/activity`;

/** Default page size for an Activity listing when no limit is given (§27). */
export const ACTIVITY_DEFAULT_LIMIT = 100;
/** Maximum page size accepted on the Activity listing route. */
export const ACTIVITY_MAX_LIMIT = 500;

/**
 * One Space-scoped audit-trail entry (§27 `audit_events` row).
 *
 *   - `id`         — service-assigned event id.
 *   - `spaceId`    — the owning Space (the listing key).
 *   - `actorId`    — the principal that triggered the action, when known.
 *   - `action`     — a dotted action verb (`installation.created`,
 *                    `run.plan_created`, `run.approved`, `run.applied`,
 *                    `run.destroyed`, `installation.stale`,
 *                    `dependency.created`, `dependency.deleted`,
 *                    `connection.default_set`, `run_group.created`, …).
 *   - `targetType` — the kind of entity the action targeted
 *                    (`installation` / `run` / `dependency` / `connection` /
 *                    `run_group` / `space`).
 *   - `targetId`   — the targeted entity id.
 *   - `runId`      — the Run this event belongs to, for run lifecycle events.
 *   - `metadata`   — non-secret structured context (names / ids / digests /
 *                    counts only).
 *   - `createdAt`  — ISO-8601 timestamp.
 */
export interface ActivityEvent {
  readonly id: string;
  readonly spaceId: string;
  readonly actorId?: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly runId?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

/** The body of an Activity listing (`GET /v1/spaces/:spaceId/activity`). */
export interface ListActivityResponse {
  readonly events: readonly ActivityEvent[];
}
