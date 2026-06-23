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
import { type ActivityEvent, listActivity, type Space } from "./control-api.ts";

/** Max events fetched per Space and rendered in the merged feed. */
export const NOTIF_PER_SPACE_LIMIT = 50;
export const NOTIF_FEED_LIMIT = 60;

/** An ActivityEvent plus the Space it came from (for cross-Space labelling). */
export interface FeedEntry {
  readonly event: ActivityEvent;
  readonly spaceHandle: string;
}

/** Actions we treat as failures / needs-attention (danger styling + badge). */
export function isFailureAction(action: string): boolean {
  return (
    action === "run.failed" ||
    action === "installation.drift_detected" ||
    action === "connection.revoked"
  );
}

/** Load every Space's recent activity and merge it into one newest-first feed. */
export async function loadNotificationFeed(
  spaces: readonly Space[],
): Promise<readonly FeedEntry[]> {
  const perSpace = await Promise.all(
    spaces.map(async (space): Promise<readonly FeedEntry[]> => {
      const events = await listActivity(space.id, NOTIF_PER_SPACE_LIMIT);
      return events.map((event) => ({ event, spaceHandle: space.handle }));
    }),
  );
  return perSpace
    .flat()
    .sort(
      (a, b) => Date.parse(b.event.createdAt) - Date.parse(a.event.createdAt),
    )
    .slice(0, NOTIF_FEED_LIMIT);
}
