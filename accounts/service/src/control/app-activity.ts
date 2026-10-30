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
 * Pages use the store's opaque `(createdAt, id)` keyset cursor. One request
 * scans a bounded number of store pages; a page can therefore hold fewer than
 * `limit` events (even none) and still carry `nextCursor`.
 */
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Capsule } from "takosumi-contract/install-configs";
import {
  clampPageLimit,
  encodeCursor,
  type PageParams,
} from "takosumi-contract/pagination";
import { json, methodNotAllowed } from "../http-helpers.ts";
import { attributeActivityEvents } from "./app-authorization.ts";
import { resolveAccountAppScope } from "./app-scope.ts";
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
  const events: ActivityEvent[] = [];
  let cursor = input.params.cursor;
  for (let scanned = 0; scanned < APP_ACTIVITY_SCAN_PAGES; scanned++) {
    ctx.assertActive?.();
    const page = await activity.listAcrossWorkspacesPage.call(activity, input.partitions, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const byPartition = new Map<string, number[]>();
    page.items.forEach((event, index) => {
      byPartition.set(event.workspaceId, [...(byPartition.get(event.workspaceId) ?? []), index]);
    });
    const attributed: (readonly string[] | undefined)[] = page.items.map(() => undefined);
    await Promise.all([...byPartition].map(async ([workspaceId, indexes]) => {
      if (!input.partitions.includes(workspaceId)) return;
      const result = await attributeActivityEvents({
        operations: ctx.operations,
        capsules: await capsulesOf(workspaceId),
        events: indexes.map((index) => page.items[index]!),
      });
      indexes.forEach((index, position) => {
        attributed[index] = result[position];
      });
    }));
    const kept = await input.keep(page.items, attributed);
    for (let index = 0; index < page.items.length; index++) {
      if (!kept[index]) continue;
      events.push(page.items[index]!);
      if (events.length === limit) {
        // Resume right after the last returned event; the rest of this store
        // page is scanned again by the next request.
        const last = page.items[index]!;
        const more = index < page.items.length - 1 || page.nextCursor !== undefined;
        return more
          ? { events, nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) }
          : { events };
      }
    }
    if (page.nextCursor === undefined) return { events };
    cursor = page.nextCursor;
  }
  return { events, nextCursor: cursor };
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
  const partitions = [...new Set([...scope.capsules.values()].map((capsule) => capsule.workspaceId))];
  const page = await scanAppActivity({
    ctx,
    partitions,
    params,
    keep: async (_events, attributed) =>
      attributed.map((ids) =>
        ids !== undefined && ids.length > 0 && ids.every((id) => scope.appIds.has(id))
      ),
  });
  return page ? { ok: true, page } : { ok: false, response: controlPlaneUnavailable() };
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
