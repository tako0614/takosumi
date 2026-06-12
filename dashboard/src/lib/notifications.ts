/**
 * Shared notification-feed primitives.
 *
 * The friendly notifications feed (NotificationsView) and the TopBar bell badge
 * read the same data: the Space-scoped Activity trail of every Space the
 * visitor belongs to, merged newest-first. This module owns the loader, the
 * "needs attention" classification, and the last-seen marker so the badge and
 * the page can never disagree.
 *
 * Honesty contract (inherited from the original feed): only values the backend
 * already recorded as public-safe Activity metadata are surfaced — no invented
 * prices, formulas, or messages.
 */
import { createSignal } from "solid-js";
import {
  type ActivityEvent,
  listActivity,
  listSpaces,
  type Space,
} from "./control-api.ts";

/** Max events fetched per Space and rendered in the merged feed. */
export const NOTIF_PER_SPACE_LIMIT = 50;
export const NOTIF_FEED_LIMIT = 60;

const SEEN_KEY = "tg_notif_seen_at";

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

/**
 * Cached feed for the TopBar bell badge. The shell remounts on every route
 * change (each view owns its own <AppShell>), so the badge must not re-fan-out
 * one activity request per Space per navigation — within the TTL it reuses the
 * last result. The notifications PAGE always loads fresh via
 * `loadNotificationFeed` and then refreshes this cache through `markSeen`.
 */
const BADGE_TTL_MS = 60_000;
let badgeCache: { at: number; feed: readonly FeedEntry[] } | null = null;

export async function loadFeedForBadge(): Promise<readonly FeedEntry[]> {
  if (badgeCache && Date.now() - badgeCache.at < BADGE_TTL_MS) {
    return badgeCache.feed;
  }
  const spaces = await listSpaces();
  const feed = await loadNotificationFeed(spaces);
  badgeCache = { at: Date.now(), feed };
  return feed;
}

/**
 * Bumped whenever the seen marker changes so an already-mounted bell badge
 * clears reactively when the visitor opens the notifications page.
 */
const [seenVersion, setSeenVersion] = createSignal(0);
export { seenVersion };

/** When the visitor last opened the notifications page (epoch ms, 0 = never). */
export function lastSeenAt(): number {
  if (typeof localStorage === "undefined") return 0;
  const raw = localStorage.getItem(SEEN_KEY);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

/** Mark the feed as seen now (called when the notifications page mounts). */
export function markSeen(feed?: readonly FeedEntry[]): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  }
  if (feed) badgeCache = { at: Date.now(), feed };
  setSeenVersion((v) => v + 1);
}

/** Unseen needs-attention count for the bell badge. */
export function unseenFailureCount(feed: readonly FeedEntry[]): number {
  const seen = lastSeenAt();
  return feed.filter(
    (entry) =>
      isFailureAction(entry.event.action) &&
      Date.parse(entry.event.createdAt) > seen,
  ).length;
}
