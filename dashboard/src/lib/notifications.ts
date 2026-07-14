/**
 * Shared notification-feed primitives.
 *
 * The friendly notifications page reads the Activity trail for every Workspace
 * the visitor belongs to, merged newest-first. The same merged feed backs the
 * TopBar bell badge: one module-level snapshot (refreshed on navigation with a
 * short TTL) so the badge count and the page's 要対応 banner are always the
 * SAME filter over the SAME data, and the badge survives views that fetch
 * nothing else.
 *
 * Honesty contract (inherited from the original feed): only values the backend
 * already recorded as public-safe Activity metadata are surfaced — no invented
 * prices, formulas, or messages.
 */
import { createSignal } from "solid-js";
import {
  type ActivityEvent,
  listActivity,
  listWorkspaces,
  type Workspace,
} from "./control-api.ts";

/** Max events fetched per Workspace and rendered in the merged feed. */
export const NOTIF_PER_WORKSPACE_LIMIT = 50;
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
    action === "capsule.drift_detected" ||
    action === "resource.drift_detected" ||
    action === "connection.revoked" ||
    // Auto-update failures carry failure-toned copy in describeEvent; keep the
    // icon/styling in step so they don't render with the neutral Bell.
    action === "capsule.auto_update_failed" ||
    action === "capsule.auto_update_apply_failed"
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
      const events = await listActivity(
        workspace.id,
        NOTIF_PER_WORKSPACE_LIMIT,
      );
      return events.map((event) => ({
        event,
        workspaceHandle: workspace.handle,
      }));
    }),
  );
  return perWorkspace
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort(
      (a, b) => Date.parse(b.event.createdAt) - Date.parse(a.event.createdAt),
    )
    .slice(0, NOTIF_FEED_LIMIT);
}

// --- shared feed snapshot (TopBar badge + /notifications banner) -------------

/** Navigation-driven refresh throttle — no polling loop, just "don't refetch
 * the whole cross-Workspace trail on every route change". */
const NOTIF_FEED_TTL_MS = 30_000;

const [sharedFeed, setSharedFeed] = createSignal<
  readonly FeedEntry[] | undefined
>(undefined);
let sharedFeedFetchedAt = 0;
let sharedFeedInflight: Promise<readonly FeedEntry[]> | undefined;

/** Reactive last-loaded cross-Workspace feed (`undefined` before first load). */
export const notificationFeed = sharedFeed;

/** Total failures currently in the feed for a Workspace — the count both the
 * TopBar bell badge and the /notifications page's 要対応 banner show, from one
 * shared derivation. The count is scoped to the CURRENT Workspace when
 * `workspaceId` is given — the feed itself stays cross-Workspace (the page
 * labels other Workspaces' entries). An empty/absent `workspaceId` counts every
 * Workspace. */
export function attentionCount(
  entries: readonly FeedEntry[] | undefined,
  workspaceId?: string,
): number {
  return (entries ?? []).filter(
    (entry) =>
      isFailureAction(entry.event.action) &&
      (!workspaceId || entry.event.workspaceId === workspaceId),
  ).length;
}

/**
 * Loads (or re-loads) the shared feed snapshot. TTL-throttled unless `force`;
 * concurrent callers share one in-flight request. Rejects only when the
 * Workspace list itself is unreachable (per-Workspace activity failures are
 * already absorbed by {@link loadNotificationFeed}).
 */
export async function refreshNotificationFeed(
  options: { readonly force?: boolean } = {},
): Promise<readonly FeedEntry[]> {
  const current = sharedFeed();
  if (
    !options.force &&
    current !== undefined &&
    Date.now() - sharedFeedFetchedAt < NOTIF_FEED_TTL_MS
  ) {
    return current;
  }
  if (sharedFeedInflight) return sharedFeedInflight;
  const request = (async () => {
    const workspaces = await listWorkspaces();
    const entries = await loadNotificationFeed(workspaces);
    sharedFeedFetchedAt = Date.now();
    setSharedFeed(entries);
    return entries;
  })().finally(() => {
    if (sharedFeedInflight === request) sharedFeedInflight = undefined;
  });
  sharedFeedInflight = request;
  return request;
}
