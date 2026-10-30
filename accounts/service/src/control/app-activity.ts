/**
 * Workspace-free Activity reads (TASK-0118 Phase 9.1).
 *
 * `GET /api/v1/activity` lists Activity of the apps the caller owns or is a
 * member of; `GET /api/v1/capsules/:id/activity` lists one app's Activity
 * after the ordinary per-app `view` decision. Neither reads Workspace
 * membership. Events are stored per internal partition (the frozen namespace
 * each app records into), so a page is read from the partitions of the apps
 * in scope and then filtered event by event:
 *
 * - each event is attributed to apps by the same rule as the legacy Workspace
 *   Activity list (`attributeActivityEvents`);
 * - an event whose app cannot be determined, or that belongs to no app
 *   (Workspace-level and connection events), is omitted;
 * - an event is shown only when EVERY app it belongs to is in scope, so an
 *   Interface link event never reveals the other side's app to someone who
 *   cannot view it.
 *
 * The next page starts after the last row this request examined, on the
 * store's `(createdAt, id)` keyset. That row may be one the caller cannot
 * see, so the cursor leaves the server only sealed (see `activity-cursor.ts`),
 * bound to the read and the caller: the client can echo it back but cannot
 * read, forge or choose a keyset, so unsealed cursors are refused. A host
 * without a secret-store passphrase cannot seal and fails closed when a page
 * needs a cursor or one is passed. One request scans at most four store pages and spends one
 * shared budget of Run/Source/Interface reads, stopping before an event it
 * could not afford to attribute; a page can therefore hold fewer than `limit`
 * events (even none) and still carry `nextCursor`. Partitions beyond
 * {@link ACTIVITY_PARTITION_LIMIT} and apps beyond one account read are left
 * out and reported as `incomplete`.
 */
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Capsule } from "takosumi-contract/install-configs";
import {
  clampPageLimit,
  encodeCursor,
  type PageCursor,
} from "takosumi-contract/pagination";
import { errorJson, json, methodNotAllowed } from "../http-helpers.ts";
import { SEALED_ACTIVITY_CURSOR_PREFIX, type ActivityCursorContext } from "./activity-cursor.ts";
import {
  activityAttributionLookupBound,
  attributeActivityEvents,
  createActivityAttributionLookups,
} from "./app-authorization.ts";
import { resolveAccountAppScope } from "./app-scope.ts";
import { ACTIVITY_PARTITION_LIMIT } from "../../../../core/domains/activity/mod.ts";
import {
  controlPlaneUnavailable,
  parseControlPageParams,
  type ControlDispatchContext,
} from "./shared.ts";

/** Default events per page when `limit` is absent. */
const APP_ACTIVITY_DEFAULT_LIMIT = 50;
/** Store pages one request may scan before it returns a sparse page. */
const APP_ACTIVITY_SCAN_PAGES = 4;

export interface AppActivityPage {
  readonly events: readonly ActivityEvent[];
  /**
   * The keyset of the last row examined when more rows remain. Server-side
   * only: it can name a hidden event, so HTTP responses carry it sealed.
   */
  readonly next?: PageCursor;
  /** Some of the caller's apps were left out (see the module comment). */
  readonly incomplete?: true;
}

/** One Activity page request: a size and the keyset to continue after. */
export interface AppActivityPageRequest {
  readonly limit?: number;
  readonly after?: PageCursor;
}

interface ScanInput {
  readonly ctx: ControlDispatchContext;
  readonly partitions: readonly string[];
  readonly request: AppActivityPageRequest;
  /** Called once per scanned store page with the attributed app ids. */
  readonly keep: (
    events: readonly ActivityEvent[],
    attributed: readonly (readonly string[] | undefined)[],
  ) => Promise<readonly boolean[]>;
}

async function scanAppActivity(input: ScanInput): Promise<AppActivityPage | undefined> {
  const { ctx } = input;
  const activity = ctx.operations.activity;
  if (typeof activity.listAcrossWorkspacesPage !== "function") return undefined;
  if (input.partitions.length === 0) return { events: [] };
  const limit = clampPageLimit(input.request.limit ?? APP_ACTIVITY_DEFAULT_LIMIT);
  const partitionCapsules = new Map<string, Promise<readonly Capsule[]>>();
  const capsulesOf = (workspaceId: string): Promise<readonly Capsule[]> => {
    let pending = partitionCapsules.get(workspaceId);
    if (!pending) {
      pending = ctx.operations.capsules.listCapsules(workspaceId).then((capsules) =>
        capsules.filter((capsule) => capsule.workspaceId === workspaceId)
      );
      partitionCapsules.set(workspaceId, pending);
    }
    return pending;
  };
  // One lookup budget and cache for the whole request (every page and
  // partition): a request spends at most one budget of Run, Source and
  // Interface reads.
  const lookups = createActivityAttributionLookups();
  // The last row examined (shown or not): the store keyset to continue after.
  let last: PageCursor | undefined = input.request.after;
  let examinedAny = false;
  const events: ActivityEvent[] = [];
  for (let scanned = 0; scanned < APP_ACTIVITY_SCAN_PAGES; scanned++) {
    ctx.assertActive?.();
    const page = await activity.listAcrossWorkspacesPage.call(activity, input.partitions, {
      limit,
      ...(last !== undefined ? { cursor: encodeCursor(last) } : {}),
    });
    const rows = page.items;
    // Admit rows only while their worst-case lookups fit the remaining
    // budget, so no event is left undetermined (and passed by the cursor)
    // for lack of budget; the next request resumes at the first row left.
    let admitted = 0;
    let reserved = 0;
    while (admitted < rows.length) {
      const cost = activityAttributionLookupBound(rows[admitted]!);
      if (reserved + cost > lookups.budget && (admitted > 0 || examinedAny)) break;
      reserved += cost;
      admitted++;
    }
    const consumed = rows.slice(0, admitted);
    const byPartition = new Map<string, number[]>();
    consumed.forEach((event, index) => {
      byPartition.set(event.workspaceId, [...(byPartition.get(event.workspaceId) ?? []), index]);
    });
    const attributed: (readonly string[] | undefined)[] = consumed.map(() => undefined);
    await Promise.all([...byPartition].map(async ([workspaceId, indexes]) => {
      if (!input.partitions.includes(workspaceId)) return;
      const result = await attributeActivityEvents({
        operations: ctx.operations,
        capsules: await capsulesOf(workspaceId),
        events: indexes.map((index) => consumed[index]!),
        lookups,
      });
      indexes.forEach((index, at) => {
        attributed[index] = result[at];
      });
    }));
    const kept = await input.keep(consumed, attributed);
    for (let index = 0; index < consumed.length; index++) {
      const event = consumed[index]!;
      examinedAny = true;
      last = { createdAt: event.createdAt, id: event.id };
      if (!kept[index]) continue;
      events.push(event);
      if (events.length === limit) {
        const more = index < consumed.length - 1 || admitted < rows.length || page.nextCursor !== undefined;
        return more ? { events, next: last } : { events };
      }
    }
    // Out of lookup budget: continue at the first row left next time.
    if (admitted < rows.length) return last !== undefined ? { events, next: last } : { events };
    if (page.nextCursor === undefined) return { events };
  }
  return last !== undefined ? { events, next: last } : { events };
}

function activityCursorUnavailable(): Response {
  return errorJson(
    "feature_unavailable",
    "Activity paging is unavailable: this server has no secret-store passphrase " +
      "(TAKOSUMI_SECRET_STORE_PASSPHRASE or TAKOSUMI_SECRET_STORE_KEY, 32+ bytes) to seal cursors.",
    503,
  );
}

function malformedCursor(): Response {
  return errorJson("invalid_request", "cursor is malformed", 400);
}

/**
 * `?limit=` and `?cursor=` of an Activity read. Only a sealed token this
 * server issued for the same read and caller is a cursor; anything else is
 * `400` and the client starts again from the newest page.
 */
async function readActivityPageRequest(ctx: ControlDispatchContext, context: ActivityCursorContext):
  Promise<
    | { readonly ok: true; readonly request: AppActivityPageRequest }
    | { readonly ok: false; readonly response: Response }
  > {
  const withoutCursor = new URL(ctx.url);
  withoutCursor.searchParams.delete("cursor");
  const parsed = parseControlPageParams(withoutCursor);
  if (!parsed.ok) return parsed;
  const limit = parsed.params.limit;
  const raw = ctx.url.searchParams.get("cursor");
  if (raw === null || raw === "") {
    return { ok: true, request: limit !== undefined ? { limit } : {} };
  }
  // An unsealed keyset would let the caller choose a position and learn,
  // from what follows it, where hidden rows lie.
  if (!raw.startsWith(SEALED_ACTIVITY_CURSOR_PREFIX)) return { ok: false, response: malformedCursor() };
  if (!ctx.activityCursorSealer) return { ok: false, response: activityCursorUnavailable() };
  const after = await ctx.activityCursorSealer.open(raw, context);
  if (!after) return { ok: false, response: malformedCursor() };
  return { ok: true, request: { ...(limit !== undefined ? { limit } : {}), after } };
}

/** The response body of an Activity page, with the cursor sealed. */
async function activityPageBody(
  ctx: ControlDispatchContext,
  context: ActivityCursorContext,
  page: AppActivityPage,
  withIncomplete: boolean,
): Promise<{ readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly response: Response }> {
  let nextCursor: string | undefined;
  if (page.next !== undefined) {
    if (!ctx.activityCursorSealer) return { ok: false, response: activityCursorUnavailable() };
    nextCursor = await ctx.activityCursorSealer.seal(page.next, context);
  }
  return {
    ok: true,
    body: {
      events: page.events,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(withIncomplete && page.incomplete ? { incomplete: true } : {}),
    },
  };
}

/** `GET /api/v1/activity`: Activity of every app in the caller's scope. */
export async function listAccountActivity(
  ctx: ControlDispatchContext,
  request: AppActivityPageRequest,
): Promise<{ readonly ok: true; readonly page: AppActivityPage } | { readonly ok: false; readonly response: Response }> {
  const resolved = await resolveAccountAppScope(ctx);
  if (!resolved.ok) return resolved;
  const { scope } = resolved;
  const allPartitions = [...new Set([...scope.capsules.values()].map((capsule) => capsule.workspaceId))].sort();
  // One request reads a bounded number of partitions; beyond it the read
  // stays well-formed and says it is incomplete instead of failing.
  const partitions = allPartitions.slice(0, ACTIVITY_PARTITION_LIMIT);
  const page = await scanAppActivity({
    ctx,
    partitions,
    request,
    keep: async (_events, attributed) =>
      attributed.map((ids) =>
        ids !== undefined && ids.length > 0 && ids.every((id) => scope.appIds.has(id))
      ),
  });
  if (!page) return { ok: false, response: controlPlaneUnavailable() };
  const incomplete = !scope.complete || allPartitions.length > partitions.length;
  return { ok: true, page: incomplete ? { ...page, incomplete: true } : page };
}

export async function handleAccountActivity(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments.length !== 1 || segments[0] !== "activity") return undefined;
  if (method !== "GET") return methodNotAllowed("GET");
  const context = { route: "activity", subject: ctx.session.subject };
  const request = await readActivityPageRequest(ctx, context);
  if (!request.ok) return request.response;
  const result = await listAccountActivity(ctx, request.request);
  if (!result.ok) return result.response;
  const body = await activityPageBody(ctx, context, result.page, true);
  if (!body.ok) return body.response;
  return json(body.body, 200, { "cache-control": "no-store" });
}

/**
 * `GET /api/v1/capsules/:id/activity`. The caller already passed the per-app
 * `view` decision for `capsule`. Events that also belong to another app are
 * shown only when the caller may view that app too.
 */
export async function handleCapsuleActivity(
  ctx: ControlDispatchContext,
  capsule: Capsule,
  method: string,
): Promise<Response> {
  if (method !== "GET") return methodNotAllowed("GET");
  const context = { route: `capsules/${capsule.id}/activity`, subject: ctx.session.subject };
  const request = await readActivityPageRequest(ctx, context);
  if (!request.ok) return request.response;
  let others: Promise<ReadonlySet<string>> | undefined;
  const otherViewableApps = (): Promise<ReadonlySet<string>> => {
    others ??= resolveAccountAppScope(ctx).then((resolved) =>
      resolved.ok ? resolved.scope.appIds : new Set<string>()
    );
    return others;
  };
  const page = await scanAppActivity({
    ctx,
    partitions: [capsule.workspaceId],
    request: request.request,
    keep: async (_events, attributed) => {
      const needsOthers = attributed.some((ids) =>
        ids?.includes(capsule.id) === true && ids.some((id) => id !== capsule.id)
      );
      const viewable = needsOthers ? await otherViewableApps() : new Set<string>();
      return attributed.map((ids) =>
        ids !== undefined && ids.includes(capsule.id) &&
        ids.every((id) => id === capsule.id || viewable.has(id))
      );
    },
  });
  if (!page) return controlPlaneUnavailable();
  const body = await activityPageBody(ctx, context, page, false);
  if (!body.ok) return body.response;
  return json(body.body, 200, { "cache-control": "no-store" });
}
