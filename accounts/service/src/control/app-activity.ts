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
 * The cursor is a position in the stream (a timestamp and a count of rows
 * consumed at it), never an event id. One request scans at most four store
 * pages and spends one shared budget of Run/Source/Interface reads, stopping
 * before an event it could not afford to attribute; a page can therefore
 * hold fewer than `limit` events (even none) and still carry `nextCursor`.
 * Partitions beyond {@link ACTIVITY_PARTITION_LIMIT} and apps beyond one
 * account read are left out and reported as `incomplete`.
 */
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Capsule } from "takosumi-contract/install-configs";
import {
  clampPageLimit,
  decodeCursor,
  encodeCursor,
  type PageParams,
} from "takosumi-contract/pagination";
import { json, methodNotAllowed } from "../http-helpers.ts";
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
  readonly nextCursor?: string;
  /** Some of the caller's apps were left out (see the module comment). */
  readonly incomplete?: true;
}

interface ScanInput {
  readonly ctx: ControlDispatchContext;
  readonly partitions: readonly string[];
  readonly params: PageParams;
  /** Called once per scanned store page with the attributed app ids. */
  readonly keep: (
    events: readonly ActivityEvent[],
    attributed: readonly (readonly string[] | undefined)[],
  ) => Promise<readonly boolean[]>;
}

/** Marks a positional cursor: `#k:<rows already consumed at createdAt>`. */
const POSITION_MARK = "#k:";

/**
 * The client cursor is a position in the newest-first Activity stream: the
 * timestamp of the last row this request consumed and how many rows at that
 * exact timestamp were consumed. It never carries an event id, so a row the
 * caller could not see is never named by the cursor.
 */
function encodeActivityPosition(createdAt: string, consumedAtCreatedAt: number): string {
  return encodeCursor({ createdAt, id: `${POSITION_MARK}${consumedAtCreatedAt}` });
}

interface ActivityStart {
  readonly storeCursor?: string;
  readonly position?: string;
  readonly consumed: number;
}

function decodeActivityPosition(raw: string | undefined): ActivityStart {
  const decoded = decodeCursor(raw);
  if (!raw || !decoded) return { consumed: 0 };
  if (!decoded.id.startsWith(POSITION_MARK)) {
    // A keyset cursor of an event (from an earlier release) stays valid.
    return { storeCursor: raw, consumed: 0 };
  }
  const consumed = Number(decoded.id.slice(POSITION_MARK.length));
  const at = Date.parse(decoded.createdAt);
  if (!Number.isSafeInteger(consumed) || consumed < 0 || !Number.isFinite(at)) return { consumed: 0 };
  // Every row at or before the position's millisecond; the rows already
  // consumed at that timestamp are skipped by count (ids order them).
  return {
    storeCursor: encodeCursor({ createdAt: new Date(at + 1).toISOString(), id: "" }),
    position: decoded.createdAt,
    consumed,
  };
}

async function scanAppActivity(input: ScanInput): Promise<AppActivityPage | undefined> {
  const { ctx } = input;
  const activity = ctx.operations.activity;
  if (typeof activity.listAcrossWorkspacesPage !== "function") return undefined;
  if (input.partitions.length === 0) return { events: [] };
  const limit = clampPageLimit(input.params.limit ?? APP_ACTIVITY_DEFAULT_LIMIT);
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
  const start = decodeActivityPosition(input.params.cursor);
  let position = start.position;
  let consumedAtPosition = start.consumed;
  let pendingSkip = start.consumed;
  let cursor = start.storeCursor;
  let processedAny = false;
  const events: ActivityEvent[] = [];
  for (let scanned = 0; scanned < APP_ACTIVITY_SCAN_PAGES; scanned++) {
    ctx.assertActive?.();
    const page = await activity.listAcrossWorkspacesPage.call(activity, input.partitions, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    let rows = page.items;
    // Rows the incoming position already consumed (newest first at its
    // timestamp, so they lead the first page).
    while (pendingSkip > 0 && rows.length > 0 && rows[0]!.createdAt === position) {
      rows = rows.slice(1);
      pendingSkip--;
    }
    if (rows.length > 0) pendingSkip = 0;
    // Admit rows only while their worst-case lookups fit the remaining
    // budget, so no event is left undetermined (and skipped by the cursor)
    // for lack of budget; the next request resumes at the first row left.
    let admitted = 0;
    let reserved = 0;
    while (admitted < rows.length) {
      const cost = activityAttributionLookupBound(rows[admitted]!);
      if (reserved + cost > lookups.budget && (admitted > 0 || processedAny)) break;
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
      processedAny = true;
      if (event.createdAt === position) consumedAtPosition++;
      else {
        position = event.createdAt;
        consumedAtPosition = 1;
      }
      if (!kept[index]) continue;
      events.push(event);
      if (events.length === limit) {
        const more = index < consumed.length - 1 || admitted < rows.length || page.nextCursor !== undefined;
        return more ? { events, nextCursor: encodeActivityPosition(position, consumedAtPosition) } : { events };
      }
    }
    if (admitted < rows.length && position !== undefined) {
      return { events, nextCursor: encodeActivityPosition(position, consumedAtPosition) };
    }
    if (page.nextCursor === undefined) return { events };
    cursor = page.nextCursor;
  }
  return position === undefined
    ? { events }
    : { events, nextCursor: encodeActivityPosition(position, consumedAtPosition) };
}

function readPageParams(ctx: ControlDispatchContext):
  | { readonly ok: true; readonly params: PageParams }
  | { readonly ok: false; readonly response: Response } {
  return parseControlPageParams(ctx.url);
}

/** `GET /api/v1/activity`: Activity of every app in the caller's scope. */
export async function listAccountActivity(
  ctx: ControlDispatchContext,
  params: PageParams,
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
    params,
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
  const params = readPageParams(ctx);
  if (!params.ok) return params.response;
  const result = await listAccountActivity(ctx, params.params);
  if (!result.ok) return result.response;
  return json({
    events: result.page.events,
    ...(result.page.nextCursor !== undefined ? { nextCursor: result.page.nextCursor } : {}),
    ...(result.page.incomplete ? { incomplete: true } : {}),
  }, 200, { "cache-control": "no-store" });
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
  const params = readPageParams(ctx);
  if (!params.ok) return params.response;
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
    params: params.params,
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
  return json({
    events: page.events,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
  }, 200, { "cache-control": "no-store" });
}
