/**
 * Shared notification-feed primitives.
 *
 * The friendly notifications page reads the Activity trail for a bounded set
 * of recently updated active Workspaces, always pinning the current Workspace,
 * and merges them newest-first. The TopBar bell has a separate,
 * Workspace-scoped snapshot. Both surfaces use the same failure predicate and
 * count helper.
 *
 * Honesty contract (inherited from the original feed): only values the backend
 * already recorded as public-safe Activity metadata are surfaced — no invented
 * prices, formulas, or messages.
 */
import { createSignal } from "solid-js";
import {
  type ActivityEvent,
  listActivity,
  type Workspace,
} from "./control-api.ts";
import { fetchDashboardWorkspaceBootstrap } from "./dashboard-bootstrap.ts";

/** Max events fetched per Workspace and rendered in the merged feed. */
export const NOTIF_PER_WORKSPACE_LIMIT = 50;
export const NOTIF_FEED_LIMIT = 60;
/** Recent Workspaces included in the cross-Workspace feed (plus current). */
export const NOTIF_WORKSPACE_LIMIT = 12;
/** Browser requests allowed in flight for either Activity or Capsule labels. */
export const NOTIF_FANOUT_CONCURRENCY = 4;

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

function notificationWorkspaces(
  workspaces: readonly Workspace[],
  selectedWorkspaceId?: string,
): readonly Workspace[] {
  const sorted = [...workspaces].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
  const recent = sorted.slice(0, NOTIF_WORKSPACE_LIMIT);
  const selected = selectedWorkspaceId
    ? sorted.find((workspace) => workspace.id === selectedWorkspaceId)
    : undefined;
  return selected && !recent.some((workspace) => workspace.id === selected.id)
    ? [selected, ...recent]
    : recent;
}

async function settledNotificationFanout<T, R>(
  items: readonly T[],
  load: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  if (items.length === 0) return [];
  const results: Array<R | undefined> = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await load(item);
      } catch {
        // One inaccessible Workspace must not blank the reachable feed.
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(NOTIF_FANOUT_CONCURRENCY, items.length) },
      () => worker(),
    ),
  );
  return results.filter((result): result is R => result !== undefined);
}

/** Load bounded recent Workspace activity and merge it newest-first. */
export async function loadNotificationFeed(
  workspaces: readonly Workspace[],
  options: { readonly selectedWorkspaceId?: string } = {},
): Promise<readonly FeedEntry[]> {
  const candidates = notificationWorkspaces(
    workspaces,
    options.selectedWorkspaceId,
  );
  const perWorkspace = await settledNotificationFanout(
    candidates,
    async (workspace): Promise<readonly FeedEntry[]> => {
      const events = await listActivity(
        workspace.id,
        NOTIF_PER_WORKSPACE_LIMIT,
      );
      return events.map((event) => ({
        event,
        workspaceHandle: workspace.handle,
      }));
    },
  );
  return perWorkspace
    .flatMap((entries) => entries)
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
let sharedFeedScope = "";
let requestedSharedFeedScope = "";
const sharedFeedInflight = new Map<string, Promise<readonly FeedEntry[]>>();

interface WorkspaceFeedSnapshot {
  readonly workspaceId: string;
  readonly entries: readonly FeedEntry[];
  readonly fetchedAt: number;
}

const [workspaceFeedSnapshot, setWorkspaceFeedSnapshot] = createSignal<
  WorkspaceFeedSnapshot | undefined
>(undefined);
const workspaceFeedInflight = new Map<string, Promise<readonly FeedEntry[]>>();
let requestedWorkspaceId = "";

/** Reactive last-loaded cross-Workspace feed (`undefined` before first load). */
export const notificationFeed = sharedFeed;

/** Last loaded badge feed for `workspaceId`, or `undefined` while that
 * Workspace has not been loaded. The snapshot is deliberately separate from
 * the cross-Workspace notifications page feed. */
export function workspaceNotificationFeed(
  workspaceId: string,
): readonly FeedEntry[] | undefined {
  const snapshot = workspaceFeedSnapshot();
  return snapshot?.workspaceId === workspaceId ? snapshot.entries : undefined;
}

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
  options: {
    readonly force?: boolean;
    readonly selectedWorkspaceId?: string;
  } = {},
): Promise<readonly FeedEntry[]> {
  const scope = options.selectedWorkspaceId?.trim() ?? "";
  const current = sharedFeed();
  if (
    !options.force &&
    current !== undefined &&
    sharedFeedScope === scope &&
    Date.now() - sharedFeedFetchedAt < NOTIF_FEED_TTL_MS
  ) {
    return current;
  }
  requestedSharedFeedScope = scope;
  const currentInflight = sharedFeedInflight.get(scope);
  if (currentInflight) return currentInflight;
  const request = (async () => {
    const bootstrap = await fetchDashboardWorkspaceBootstrap({
      includeNotifications: true,
      selectedWorkspaceId: scope || undefined,
    });
    if (!Array.isArray(bootstrap?.notifications)) {
      throw new Error("Dashboard notification projection is unavailable");
    }
    const entries = bootstrap.notifications.slice(0, NOTIF_FEED_LIMIT);
    if (requestedSharedFeedScope === scope) {
      sharedFeedFetchedAt = Date.now();
      sharedFeedScope = scope;
      setSharedFeed(entries);
    }
    return entries;
  })().finally(() => {
    if (sharedFeedInflight.get(scope) === request) {
      sharedFeedInflight.delete(scope);
    }
  });
  sharedFeedInflight.set(scope, request);
  return request;
}

/**
 * Refresh the TopBar badge from exactly one Workspace Activity endpoint.
 *
 * Navigation used to call {@link refreshNotificationFeed}, which first listed
 * every Workspace and then opened one Activity request for every result. A
 * user with N Workspaces therefore paid N+1 API requests on ordinary shell
 * navigation. This path is intentionally scoped and bounded to one request.
 */
export async function refreshWorkspaceNotificationFeed(
  workspaceId: string,
  options: { readonly force?: boolean } = {},
): Promise<readonly FeedEntry[]> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) return [];
  requestedWorkspaceId = normalizedWorkspaceId;

  const current = workspaceFeedSnapshot();
  if (
    !options.force &&
    current?.workspaceId === normalizedWorkspaceId &&
    Date.now() - current.fetchedAt < NOTIF_FEED_TTL_MS
  ) {
    return current.entries;
  }

  const currentInflight = workspaceFeedInflight.get(normalizedWorkspaceId);
  if (currentInflight) return currentInflight;

  const request = listActivity(normalizedWorkspaceId, NOTIF_PER_WORKSPACE_LIMIT)
    .then((events): readonly FeedEntry[] =>
      events.slice(0, NOTIF_FEED_LIMIT).map((event) => ({
        event,
        // The badge never renders the handle. Keeping this non-secret field
        // deterministic avoids a Workspace-list read solely for decoration.
        workspaceHandle: normalizedWorkspaceId,
      })),
    )
    .then((entries) => {
      if (requestedWorkspaceId === normalizedWorkspaceId) {
        setWorkspaceFeedSnapshot({
          workspaceId: normalizedWorkspaceId,
          entries,
          fetchedAt: Date.now(),
        });
      }
      return entries;
    })
    .finally(() => {
      if (workspaceFeedInflight.get(normalizedWorkspaceId) === request) {
        workspaceFeedInflight.delete(normalizedWorkspaceId);
      }
    });
  workspaceFeedInflight.set(normalizedWorkspaceId, request);
  return request;
}
