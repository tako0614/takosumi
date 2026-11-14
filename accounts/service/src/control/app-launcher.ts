/**
 * Account-level launcher (TASK-0118 Phase 9.1): `GET /api/v1/ui-surfaces`
 * lists the UI surface Interfaces of the apps the caller owns or is a member
 * of, without a Workspace. It replaces `GET /api/v1/workspaces/:id/ui-surfaces`.
 *
 * Authority is the same two-part rule as the Workspace launcher, with the app
 * decision in place of Workspace membership:
 *
 * - the app must be in the caller's account scope (owner or member, narrowed
 *   by a PAT's `appIds`; an installed app's own token covers its own app, or,
 *   for an operator-designated delegate app such as Takos, its user's apps
 *   under the ordinary per-app decision);
 * - the Interface needs the caller's exact current Principal Binding with the
 *   launcher permission (the InterfaceService projection), as before.
 *
 * Pages walk the apps in id order: one page covers up to `limit` apps (default
 * 20, at most 50); the opaque `nextCursor` resumes unfinished candidate
 * keysets as well as the outer app position. Each response is in app id order.
 * Candidate reads are bounded, with `incomplete` marking a partial window.
 */
import type { Capsule } from "takosumi-contract/install-configs";
import type { Interface } from "takosumi-contract";
import {
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_INTERFACE_VERSION,
  UI_SURFACE_OPEN_PERMISSION,
} from "takosumi-contract";
import { decodeCursor, encodeCursor } from "takosumi-contract/pagination";
import { errorJson, json, methodNotAllowed, stringValue } from "../http-helpers.ts";
import { accountAppAllowed, resolveAccountAppScope } from "./app-scope.ts";
import {
  controlPlaneUnavailable,
  parseControlPageParams,
  type ControlDispatchContext,
} from "./shared.ts";

const LAUNCHER_DEFAULT_APPS = 20;
const LAUNCHER_MAX_APPS = 50;
/** Launcher candidates in one store page. */
const LAUNCHER_SURFACES_PER_PAGE = 50;
/** Match the app view's bounded candidate-page window. */
const LAUNCHER_SURFACE_PAGE_LIMIT = 5;
const LAUNCHER_READ_CONCURRENCY = 8;
/** Distinguishes launcher cursors from other keyset cursors. */
const LAUNCHER_CURSOR_MARK = "ui-surfaces";
const LAUNCHER_SURFACE_CURSOR_MARK = "ui-surfaces:surface";
/**
 * Candidate apps one page may decide for a restricted credential (a
 * delegate app's token decides each of its user's apps); the page ends
 * early, with a cursor, when this many were examined.
 */
const LAUNCHER_DECISIONS_PER_PAGE_FACTOR = 4;

function launchable(capsule: Capsule): boolean {
  return capsule.status === "active" || capsule.status === "stale";
}

function isLauncherSurface(iface: Interface, capsule: Capsule): boolean {
  return iface.metadata.ownerRef.kind === "Capsule" &&
    iface.metadata.ownerRef.id === capsule.id &&
    iface.metadata.workspaceId === capsule.workspaceId &&
    iface.spec.type === UI_SURFACE_INTERFACE_TYPE &&
    iface.spec.version === UI_SURFACE_INTERFACE_VERSION &&
    iface.status.phase === "Resolved";
}

export async function handleAccountUiSurfaces(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments.length !== 1 || segments[0] !== "ui-surfaces") return undefined;
  if (method !== "GET") return methodNotAllowed("GET");
  const interfaces = ctx.operations.interfaces;
  if (!interfaces) return controlPlaneUnavailable();
  const rawCapsuleId = ctx.url.searchParams.get("capsuleId");
  if (rawCapsuleId !== null && !stringValue(rawCapsuleId)) {
    return errorJson("invalid_request", "capsuleId must be a non-empty string", 400);
  }
  const capsuleId = stringValue(rawCapsuleId ?? undefined);
  const page = parseControlPageParams(ctx.url);
  if (!page.ok) return page.response;
  let after: string | undefined;
  const pending = new Map<string, string>();
  if (page.params.cursor !== undefined) {
    const cursor = decodeCursor(page.params.cursor);
    if (cursor?.createdAt === LAUNCHER_CURSOR_MARK) {
      after = cursor.id;
    } else if (cursor?.createdAt === LAUNCHER_SURFACE_CURSOR_MARK) {
      try {
        const value = JSON.parse(cursor.id) as { after?: unknown; pending?: unknown; capsuleId?: unknown } | null;
        if (!value || typeof value.after !== "string" || !value.after ||
          value.capsuleId !== (capsuleId ?? null) || !Array.isArray(value.pending) ||
          value.pending.length === 0 || value.pending.length > LAUNCHER_MAX_APPS) throw new Error();
        after = value.after;
        let previous: string | undefined;
        for (const entry of value.pending) {
          if (!Array.isArray(entry) || entry.length !== 2 ||
            typeof entry[0] !== "string" || !entry[0] || entry[0] > after ||
            (previous !== undefined && entry[0] <= previous) || typeof entry[1] !== "string") throw new Error();
          const position = decodeCursor(entry[1]);
          if (!position?.createdAt || !position.id) throw new Error();
          pending.set(entry[0], entry[1]);
          previous = entry[0];
        }
      } catch {
        return errorJson("invalid_request", "cursor is malformed", 400);
      }
    } else {
      return errorJson("invalid_request", "cursor is malformed", 400);
    }
  }
  const limit = Math.min(page.params.limit ?? LAUNCHER_DEFAULT_APPS, LAUNCHER_MAX_APPS);
  const resolved = await resolveAccountAppScope(ctx, {
    expandDelegate: true,
    deferRestrictedDecision: true,
  });
  if (!resolved.ok) return resolved.response;
  const candidates = [...resolved.scope.capsules.values()]
    .filter((capsule) => launchable(capsule) && (capsuleId === undefined || capsule.id === capsuleId))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .filter((capsule) => pending.has(capsule.id) || after === undefined || capsule.id > after);
  // Cursor positions never supply app scope. Drop apps that disappeared or
  // ceased being launchable/visible through this request's current credential.
  const currentIds = new Set(candidates.map((capsule) => capsule.id));
  for (const id of pending.keys()) if (!currentIds.has(id)) pending.delete(id);
  const continuations = new Map(pending);
  // Decide only the apps this page returns (a restricted credential re-runs
  // the per-app decision for each), within a bounded number of decisions.
  const window: Capsule[] = [];
  let examined = 0;
  const maxDecisions = limit * LAUNCHER_DECISIONS_PER_PAGE_FACTOR;
  while (examined < candidates.length && window.length < limit && examined < maxDecisions) {
    const capsule = candidates[examined++]!;
    if (!pending.has(capsule.id)) after = capsule.id;
    continuations.delete(capsule.id);
    if (await accountAppAllowed(ctx, capsule)) window.push(capsule);
  }
  const perApp: Interface[][] = window.map(() => []);
  // Reserve one read for every covered app. Continuations use only the spare
  // reads within the existing maximum of 50 candidate reads per request.
  let remainingExtraPages = LAUNCHER_MAX_APPS - window.length;
  let surfacesIncomplete = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= window.length) return;
      const capsule = window[index]!;
      const surfaces = new Map<string, Interface>();
      let cursor = pending.get(capsule.id);
      const seenCursors = new Set<string>(cursor ? [cursor] : []);
      for (let page = 0; page < LAUNCHER_SURFACE_PAGE_LIMIT; page++) {
        if (page > 0) {
          if (remainingExtraPages === 0) {
            surfacesIncomplete = true;
            if (cursor) continuations.set(capsule.id, cursor);
            break;
          }
          remainingExtraPages--;
        }
        ctx.assertActive?.();
        const candidates = await interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage(
          { workspaceId: capsule.workspaceId, phase: "Resolved" },
          ctx.session.subject,
          UI_SURFACE_OPEN_PERMISSION,
          { limit: LAUNCHER_SURFACES_PER_PAGE, ...(cursor ? { cursor } : {}) },
          capsule.id,
        );
        for (const iface of candidates.items) {
          if (isLauncherSurface(iface, capsule)) surfaces.set(iface.metadata.id, iface);
        }
        if (candidates.nextCursor === undefined) break;
        if (!candidates.nextCursor || seenCursors.has(candidates.nextCursor)) {
          surfacesIncomplete = true;
          break;
        }
        seenCursors.add(candidates.nextCursor);
        cursor = candidates.nextCursor;
        if (page + 1 === LAUNCHER_SURFACE_PAGE_LIMIT) {
          surfacesIncomplete = true;
          continuations.set(capsule.id, cursor);
        }
      }
      perApp[index] = [...surfaces.values()];
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LAUNCHER_READ_CONCURRENCY, window.length) }, worker),
  );
  // Carry only bounded keyset positions, never rows or authorization. Apps
  // already completed before `after` must not be delivered again on resumption.
  const nextCursor = continuations.size > 0
    ? encodeCursor({
      createdAt: LAUNCHER_SURFACE_CURSOR_MARK,
      id: JSON.stringify({
        after,
        pending: [...continuations].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
        capsuleId: capsuleId ?? null,
      }),
    })
    : examined < candidates.length && after
    ? encodeCursor({ createdAt: LAUNCHER_CURSOR_MARK, id: after })
    : undefined;
  return json(
    {
      interfaces: perApp.flat(),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      // Either the account read or a covered app's candidate read was bounded.
      ...(resolved.scope.complete && !surfacesIncomplete ? {} : { incomplete: true }),
    },
    200,
    { "cache-control": "no-store" },
  );
}
