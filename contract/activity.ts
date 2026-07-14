/**
 * Activity audit ledger contract.
 *
 * Activity is the Workspace-scoped audit trail surfaced in the dashboard's Activity
 * view. One {@link ActivityEvent} records a single state-changing action
 * inside a Workspace — a Capsule created, a plan / apply / destroy run reaching
 * a milestone, a Dependency added, stale propagation, a RunGroup created — keyed
 * by the Workspace so the dashboard can list a Workspace's recent activity.
 *
 * This is the PUBLIC, Workspace-level audit trail. It is distinct from the public
 * run-level `RunAuditEvent` projection (the per-run policy / lease / dispatch
 * trace carried inside a Run response); the two never share a type.
 *
 * Security invariant: an ActivityEvent records WHAT happened, not secrets.
 * `metadata` carries identifiers, names, digests, and counts only — never
 * credential material and never resolved output VALUES: secret outputs and
 * credential values are never stored as public ledger values.
 */

import { INTERNAL_V1_PREFIX } from "./api-surface.ts";

export const WORKSPACE_ACTIVITY_PATH = (workspaceId: string): string =>
  `${INTERNAL_V1_PREFIX}/workspaces/${encodeURIComponent(
    workspaceId,
  )}/activity`;

/** Default page size for an Activity listing when no limit is given. */
export const ACTIVITY_DEFAULT_LIMIT = 100;
/** Maximum page size accepted on the Activity listing route. */
export const ACTIVITY_MAX_LIMIT = 500;

/**
 * One Workspace-scoped audit-trail entry (`audit_events` row).
 *
 *   - `id`         — service-assigned event id.
 *   - `workspaceId`    — the owning Workspace (the listing key).
 *   - `actorId`    — the principal that triggered the action, when known.
 *   - `action`     — a dotted action verb (`capsule.created`,
 *                    `run.plan_created`, `run.approved`, `run.applied`,
 *                    `run.destroyed`, `capsule.stale`,
 *                    `dependency.created`, `dependency.deleted`,
 *                    `connection.default_set`, `run_group.created`, …).
 *   - `targetType` — the kind of entity the action targeted
 *                    (`capsule` / `run` / `dependency` / `connection` /
 *                    `run_group` / `workspace` / `resource`).
 *   - `targetId`   — the targeted entity id.
 *   - `runId`      — the Run this event belongs to, for run lifecycle events.
 *   - `metadata`   — non-secret structured context (names / ids / digests /
 *                    counts only).
 *   - `createdAt`  — ISO-8601 timestamp.
 */
export interface ActivityEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId?: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly runId?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

/** The body of an Activity listing (`GET /internal/v1/workspaces/:workspaceId/activity`). */
export interface ListActivityResponse {
  readonly events: readonly ActivityEvent[];
}
