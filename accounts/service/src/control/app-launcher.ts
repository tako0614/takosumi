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
 * 20, at most 50) and returns every launcher candidate of those apps; the
 * opaque `nextCursor` resumes after the last app.
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
/** Launcher candidates read per app; an app rarely declares more than a few. */
const LAUNCHER_SURFACES_PER_APP = 50;
const LAUNCHER_READ_CONCURRENCY = 8;
/** Distinguishes launcher cursors from other keyset cursors. */
const LAUNCHER_CURSOR_MARK = "ui-surfaces";
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
  if (page.params.cursor !== undefined) {
    const cursor = decodeCursor(page.params.cursor);
    if (!cursor || cursor.createdAt !== LAUNCHER_CURSOR_MARK) {
      return errorJson("invalid_request", "cursor is malformed", 400);
    }
    after = cursor.id;
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
    .filter((capsule) => after === undefined || capsule.id > after);
  // Decide only the apps this page returns (a restricted credential re-runs
  // the per-app decision for each), within a bounded number of decisions.
  const window: Capsule[] = [];
  let examined = 0;
  const maxDecisions = limit * LAUNCHER_DECISIONS_PER_PAGE_FACTOR;
  while (examined < candidates.length && window.length < limit && examined < maxDecisions) {
    const capsule = candidates[examined++]!;
    if (await accountAppAllowed(ctx, capsule)) window.push(capsule);
  }
  const perApp: Interface[][] = window.map(() => []);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= window.length) return;
      const capsule = window[index]!;
      ctx.assertActive?.();
      const candidates = await interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage(
        { workspaceId: capsule.workspaceId, phase: "Resolved" },
        ctx.session.subject,
        UI_SURFACE_OPEN_PERMISSION,
        { limit: LAUNCHER_SURFACES_PER_APP },
        capsule.id,
      );
      perApp[index] = candidates.items.filter((iface) => isLauncherSurface(iface, capsule));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LAUNCHER_READ_CONCURRENCY, window.length) }, worker),
  );
  const lastExamined = examined > 0 ? candidates[examined - 1] : undefined;
  return json(
    {
      interfaces: perApp.flat(),
      ...(examined < candidates.length && lastExamined
        ? { nextCursor: encodeCursor({ createdAt: LAUNCHER_CURSOR_MARK, id: lastExamined.id }) }
        : {}),
      // The caller manages more apps than one account read enumerates; the
      // launcher covers the first ones in the resolver's order.
      ...(resolved.scope.complete ? {} : { incomplete: true }),
    },
    200,
    { "cache-control": "no-store" },
  );
}
