/**
 * Shared notification-feed primitives.
 *
 * The friendly notifications page reads the Activity trail for every Workspace
 * the visitor belongs to, merged newest-first. The TopBar bell badge stays
 * scoped to the current Workspace's service state and lives in TopBar.
 *
 * Honesty contract (inherited from the original feed): only values the backend
 * already recorded as public-safe Activity metadata are surfaced — no invented
 * prices, formulas, or messages.
 */
import { type ActivityEvent, listActivity, type Workspace } from "./control-api.ts";

/** Max events fetched per Workspace and rendered in the merged feed. */
export const NOTIF_PER_SPACE_LIMIT = 50;
export const NOTIF_FEED_LIMIT = 60;

/** An ActivityEvent plus the Workspace it came from (for cross-Workspace labelling). */
export interface FeedEntry {
  readonly event: ActivityEvent;
  readonly workspaceHandle: string;
}

/** Actions we treat as failures / needs-attention (danger styling + badge). */
export function isFailureAction(action: string): boolean {
  return (
    action === "run.failed" ||
    action === "installation.drift_detected" ||
    action === "connection.revoked" ||
    // Auto-update failures carry failure-toned copy in describeEvent; keep the
    // icon/styling in step so they don't render with the neutral Bell.
    action === "installation.auto_update_failed" ||
    action === "installation.auto_update_apply_failed"
  );
}

/** Load every Workspace's recent activity and merge it into one newest-first feed. */
export async function loadNotificationFeed(
  workspaces: readonly Workspace[],
): Promise<readonly FeedEntry[]> {
  // allSettled, not all: one workspace whose activity fetch rejects must not
  // blank the entire merged feed — the reachable workspaces still show.
  const perWorkspace = await Promise.allSettled(
    workspaces.map(async (workspace): Promise<readonly FeedEntry[]> => {
      const events = await listActivity(workspace.id, NOTIF_PER_SPACE_LIMIT);
      return events.map((event) => ({ event, workspaceHandle: workspace.handle }));
    }),
  );
  return perWorkspace
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort(
      (a, b) => Date.parse(b.event.createdAt) - Date.parse(a.event.createdAt),
    )
    .slice(0, NOTIF_FEED_LIMIT);
}
