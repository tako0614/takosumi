/**
 * Per-app authorization for app-scoped control routes (TASK-0118 Phase 6b).
 *
 * Once a Capsule has an ownership row, the app's owner/member role is the only
 * management authority: Workspace membership neither grants nor is required.
 * While the rollout is incomplete (no ownership port, a pre-v77 D1 / pre-v123
 * Postgres schema, or a Capsule the backfill has not reached), the request uses
 * the legacy Workspace decision unchanged, and the fallback is reported.
 */
import { appActionAllowed, type AppAccess, type AppAction } from "takosumi-contract/app-access";
import type { Capsule } from "takosumi-contract/install-configs";
import type { Run } from "takosumi-contract/runs";
import type { Source } from "takosumi-contract/sources";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { PublicPlanRun } from "@takosumi/internal/deploy-control-api";
import type { CapsuleOwnership } from "../../../../core/domains/app-ownership/store.ts";
import { isMissingOwnershipSchemaError } from "../../../../core/domains/app-ownership/store.ts";
import { bearerAppAllows, bearerWorkspaceAllows } from "../account-session.ts";
import type { ControlPlaneOperations } from "../control-operations.ts";
import { errorJson } from "../http-helpers.ts";
import type {
  AppAuthorizationFallbackReason,
  RequestPhaseObserver,
} from "../request-phase-diagnostics.ts";
import type { AccountsStore } from "../store.ts";
import {
  canAccessWorkspace,
  controllerErrorCode,
  controlPlaneUnavailable,
  requireWorkspaceAccess,
  workspaceAccessForbidden,
  type ControlSession,
} from "./shared.ts";

export type AppAuthorizationResult =
  | { readonly ok: true; readonly authority: "app"; readonly access: AppAccess }
  | {
      readonly ok: true;
      readonly authority: "workspace";
      readonly fallbackReason?: AppAuthorizationFallbackReason;
    }
  | { readonly ok: false; readonly response: Response };

interface AuthorizationContext {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly session: ControlSession;
  readonly assertActive?: () => void;
  readonly diagnostics?: RequestPhaseObserver;
}

export interface AppAccessRequest extends AuthorizationContext {
  readonly capsuleId: string;
  /** Workspace recorded on the addressed resource (Capsule, Run, StateVersion...). */
  readonly workspaceId: string;
  /** The already loaded Capsule, when the route has it. */
  readonly capsule?: Pick<Capsule, "id" | "workspaceId" | "status">;
  readonly action: AppAction;
}

type OwnershipFence =
  | { readonly kind: "owned"; readonly ownership: CapsuleOwnership }
  | { readonly kind: "fallback"; readonly reason: AppAuthorizationFallbackReason };

/** Reuses the store's own schema probe; one ownership read per decision. */
async function readOwnershipFence(
  operations: ControlPlaneOperations,
  capsuleId: string,
): Promise<OwnershipFence> {
  const store = operations.appOwnership;
  if (!store) return { kind: "fallback", reason: "ownership_store_unavailable" };
  let fence: { readonly schemaAvailable: boolean; readonly ownership?: CapsuleOwnership };
  try {
    fence = store.readOwnershipFence
      ? await store.readOwnershipFence(capsuleId)
      : { schemaAvailable: true, ownership: await store.getOwnership(capsuleId) };
  } catch (error) {
    if (!isMissingOwnershipSchemaError(error)) throw error;
    fence = { schemaAvailable: false };
  }
  if (!fence.schemaAvailable) return { kind: "fallback", reason: "ownership_schema_unavailable" };
  if (!fence.ownership || fence.ownership.capsuleId !== capsuleId) {
    return { kind: "fallback", reason: "capsule_not_backfilled" };
  }
  return { kind: "owned", ownership: fence.ownership };
}

const FALLBACK_LOG_INTERVAL_MS = 5 * 60_000;
const fallbackLogState = new Map<AppAuthorizationFallbackReason, { lastAt: number; suppressed: number }>();

/** Value-free and throttled per isolate so a v75 target does not flood logs. */
async function reportFallback(
  diagnostics: RequestPhaseObserver | undefined,
  reason: AppAuthorizationFallbackReason,
): Promise<void> {
  try {
    await diagnostics?.observeAppAuthorizationFallback?.({ reason });
  } catch {
    // Diagnostics have no authority and must not affect the response.
  }
  try {
    const now = Date.now();
    const state = fallbackLogState.get(reason);
    if (state && now - state.lastAt < FALLBACK_LOG_INTERVAL_MS) {
      state.suppressed++;
      return;
    }
    console.info(JSON.stringify({
      event: "app_authorization_workspace_fallback",
      reason,
      suppressedSinceLastLog: state?.suppressed ?? 0,
    }));
    fallbackLogState.set(reason, { lastAt: now, suppressed: 0 });
  } catch {
    // Logging is best-effort only.
  }
}

const OWNER_ONLY_ACTIONS: ReadonlySet<AppAction> = new Set(["uninstall", "transfer_ownership", "manage_members"]);

function appAccessDenied(): Response {
  return errorJson("app_access_denied", "App access is required.", 403);
}

function appOwnerOnly(): Response {
  return errorJson("app_owner_only", "Only the current app owner can perform this action.", 403);
}

function appOwnershipChanged(): Response {
  return errorJson("conflict", "App ownership changed; retry the request.", 409);
}

/**
 * The single decision for a request addressed to (or resolving to) one app.
 * Order: rollout fence, bearer restrictions, live AppAccess role and action,
 * then the credential intersections that must never widen.
 */
export async function requireAppAccess(input: AppAccessRequest): Promise<AppAuthorizationResult> {
  input.assertActive?.();
  // An installed app's OAuth token acts for the app, never as its owner:
  // uninstall (including destroy plans and destroy Runs), ownership transfer
  // and member management are refused on every path, fallback included.
  if (input.session.credential === "oauth-access-token" && OWNER_ONLY_ACTIONS.has(input.action)) {
    return {
      ok: false,
      response: errorJson(
        "app_access_denied",
        "Uninstall, ownership transfer and member management require an account session or personal access token.",
        403,
      ),
    };
  }
  const fence = await readOwnershipFence(input.operations, input.capsuleId);
  input.assertActive?.();
  if (fence.kind === "fallback") {
    await reportFallback(input.diagnostics, fence.reason);
    const allowed = await canAccessWorkspace({
      operations: input.operations,
      store: input.store,
      session: input.session,
      workspaceId: input.workspaceId,
      capsuleId: input.capsuleId,
      appAction: input.action,
      ...(input.assertActive ? { assertActive: input.assertActive } : {}),
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    });
    input.assertActive?.();
    return allowed
      ? { ok: true, authority: "workspace", fallbackReason: fence.reason }
      : { ok: false, response: workspaceAccessForbidden() };
  }
  return await decideOwnedApp(input, fence.ownership);
}

async function decideOwnedApp(
  input: AppAccessRequest,
  ownership: CapsuleOwnership,
): Promise<AppAuthorizationResult> {
  const { operations, session } = input;
  // Bearer restrictions come first and are never replaced by a role.
  if (!bearerWorkspaceAllows(session, input.workspaceId)) return { ok: false, response: appAccessDenied() };
  if (session.appIds !== undefined && session.credential !== "oauth-access-token" &&
    !bearerAppAllows(session, input.capsuleId)) {
    return { ok: false, response: appAccessDenied() };
  }
  let capsule = input.capsule;
  if (session.workspaceId !== undefined) {
    capsule ??= await operations.capsules.getCapsule(input.capsuleId);
    input.assertActive?.();
    if (capsule.id !== input.capsuleId || capsule.workspaceId !== session.workspaceId) {
      return { ok: false, response: appAccessDenied() };
    }
  }
  const resolver = operations.appAccess;
  if (!resolver) return { ok: false, response: controlPlaneUnavailable() };
  let access = await resolver.resolveAppAccess(session.subject, input.capsuleId);
  input.assertActive?.();
  if (!access) {
    // The resolver stops at uninstall completion. The retained owner row and
    // roster still identify who may read the destroyed app's history.
    capsule ??= await operations.capsules.getCapsule(input.capsuleId);
    input.assertActive?.();
    if (capsule.id === input.capsuleId && capsule.status === "destroyed") {
      access = await retainedDestroyedAppAccess(operations, session.subject, ownership);
      input.assertActive?.();
    }
  }
  if (!access || access.capsuleId !== input.capsuleId ||
    (access.role !== "owner" && access.role !== "member")) {
    return { ok: false, response: appAccessDenied() };
  }
  if (access.ownerAccountId !== ownership.ownerAccountId || access.ownershipEpoch !== ownership.ownershipEpoch) {
    return { ok: false, response: appOwnershipChanged() };
  }
  if (!appActionAllowed(access.role, input.action)) return { ok: false, response: appOwnerOnly() };
  // An installed app's own OAuth token and the trusted shared-account
  // composition (current membership required) keep their Workspace limit:
  // their effective authority is the intersection, never wider than before.
  if (session.credential === "oauth-access-token" || session.requireCurrentMembership) {
    const workspaceAllowed = await canAccessWorkspace({
      operations,
      store: input.store,
      session,
      workspaceId: input.workspaceId,
      ...(input.assertActive ? { assertActive: input.assertActive } : {}),
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    });
    input.assertActive?.();
    if (!workspaceAllowed) return { ok: false, response: appAccessDenied() };
  }
  return { ok: true, authority: "app", access };
}

async function retainedDestroyedAppAccess(
  operations: ControlPlaneOperations,
  subject: string,
  ownership: CapsuleOwnership,
): Promise<AppAccess | undefined> {
  const base = {
    capsuleId: ownership.capsuleId,
    ownerAccountId: ownership.ownerAccountId,
    ownershipEpoch: ownership.ownershipEpoch,
  };
  if (subject === ownership.ownerAccountId) return { ...base, role: "owner" };
  const members = await operations.appOwnership?.listMembers(ownership.capsuleId) ?? [];
  return members.some((member) => member.accountId === subject && member.status === "active")
    ? { ...base, role: "member" }
    : undefined;
}

/**
 * Whether a new Interface link from `consumerCapsuleId` to `provider` may be
 * created already approved. Approval is the PROVIDER side's consent, so the
 * caller must hold `change_interface_link` on the provider app under the same
 * decision as every other app-scoped request: the per-app role once the
 * provider has an ownership row, the Workspace decision only while it has
 * none. An installed app's own OAuth token never approves another app's
 * Interface. A false result makes the link `pending_approval`.
 */
export async function mayApproveInterfaceProvider(
  input: AuthorizationContext & {
    readonly consumerCapsuleId: string;
    readonly provider: { readonly capsuleId: string; readonly workspaceId: string };
  },
): Promise<boolean> {
  if (input.provider.capsuleId === input.consumerCapsuleId) return true;
  if (input.session.credential === "oauth-access-token") return false;
  const provider = await input.operations.capsules.getCapsule(input.provider.capsuleId);
  input.assertActive?.();
  if (provider.id !== input.provider.capsuleId || provider.workspaceId !== input.provider.workspaceId) return false;
  const decision = await requireAppAccess({
    operations: input.operations,
    store: input.store,
    session: { ...input.session, requiredAccess: "write" },
    workspaceId: provider.workspaceId,
    capsuleId: provider.id,
    capsule: provider,
    action: "change_interface_link",
    ...(input.assertActive ? { assertActive: input.assertActive } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  return decision.ok;
}

/**
 * Resources that belong to apps decide per app: when any of `capsuleIds` has
 * an ownership row, every such app must allow `action`; when none has one, the
 * legacy decision for each (or the Workspace decision when the resource has no
 * app at all, such as an unowned preflight Source or a Workspace-level Run).
 */
export async function requireResourceAccess(
  input: AuthorizationContext & {
    readonly workspaceId: string;
    readonly capsuleId?: string | undefined;
    readonly capsuleIds?: readonly string[];
    readonly capsule?: Pick<Capsule, "id" | "workspaceId" | "status">;
    readonly action: AppAction;
  },
): Promise<AppAuthorizationResult> {
  const ids = [...new Set([...(input.capsuleIds ?? []), ...(input.capsuleId ? [input.capsuleId] : [])])];
  if (ids.length === 1) {
    return await requireAppAccess({ ...input, capsuleId: ids[0]! });
  }
  if (ids.length > 1) {
    const owned: string[] = [];
    for (const capsuleId of ids) {
      if ((await readOwnershipFence(input.operations, capsuleId)).kind === "owned") owned.push(capsuleId);
      input.assertActive?.();
    }
    let last: AppAuthorizationResult | undefined;
    for (const capsuleId of owned.length ? owned : ids) {
      const { capsule: _capsule, ...rest } = input;
      last = await requireAppAccess({ ...rest, capsuleId });
      if (!last.ok) return last;
    }
    return last!;
  }
  const result = await requireWorkspaceAccess({
    operations: input.operations,
    store: input.store,
    session: input.session,
    workspaceId: input.workspaceId,
    ...(input.assertActive ? { assertActive: input.assertActive } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  return result.ok ? { ok: true, authority: "workspace" } : result;
}

/**
 * The apps a Source belongs to: its exclusive owner, or, for an ownerless
 * (pre-claim) Source, every live Capsule built from it (`capsules.source_id`).
 */
export async function sourceCapsuleIds(
  operations: ControlPlaneOperations,
  source: { readonly id: string; readonly workspaceId?: string; readonly ownerCapsuleId?: string },
): Promise<readonly string[]> {
  if (typeof source.ownerCapsuleId === "string" && source.ownerCapsuleId) return [source.ownerCapsuleId];
  // Without an ownership port no app can be owned: keep the legacy decision.
  if (!source.workspaceId || !operations.appOwnership) return [];
  return [...new Set((await operations.capsules.listCapsules(source.workspaceId))
    .filter((capsule) => capsule.sourceId === source.id && capsule.workspaceId === source.workspaceId &&
      capsule.status !== "destroyed")
    .map((capsule) => capsule.id))];
}

/**
 * The apps a Run belongs to, including Source-scoped Runs of an app's Source.
 * A retired Source means the Run has no app; the Workspace decision applies.
 */
export async function runCapsuleIds(
  operations: ControlPlaneOperations,
  run: Pick<Run, "capsuleId" | "sourceId" | "subject">,
): Promise<readonly string[]> {
  if (run.capsuleId) return [run.capsuleId];
  if (run.subject?.kind === "capsule") return [run.subject.id];
  const sourceId = run.sourceId ?? (run.subject?.kind === "source" ? run.subject.id : undefined);
  if (!sourceId) return [];
  let source: Source;
  try {
    source = (await operations.getSource(sourceId)).source;
  } catch (error) {
    if (controllerErrorCode(error) === "not_found") return [];
    throw error;
  }
  return await sourceCapsuleIds(operations, source);
}

/**
 * List filtering for Workspace compatibility reads: an item that belongs to
 * an app with an ownership row is visible only if the caller may view that
 * app. Items of apps without an ownership row keep the Workspace decision the
 * route already applied. One batch ownership read and the resolver's
 * accessible-app pages per request; no per-item authorization lookups.
 */
export interface AppVisibility {
  allows(capsuleIds: readonly string[]): boolean;
}

const ALLOW_ALL: AppVisibility = { allows: () => true };
const ACCESSIBLE_APP_PAGE_LIMIT = 20;

export async function workspaceAppVisibility(input: {
  readonly operations: ControlPlaneOperations;
  readonly session: ControlSession;
  readonly capsuleIds: Iterable<string>;
}): Promise<AppVisibility> {
  const ids = [...new Set([...input.capsuleIds].filter((id) => typeof id === "string" && id.length > 0))];
  const store = input.operations.appOwnership;
  if (!ids.length || !store) return ALLOW_ALL;
  const owned = store.listOwnedCapsuleIds
    ? await store.listOwnedCapsuleIds(ids)
    : new Set((await Promise.all(ids.map(async (id) =>
      (await readOwnershipFence(input.operations, id)).kind === "owned" ? id : undefined)))
      .filter((id): id is string => id !== undefined));
  if (!owned.size) return ALLOW_ALL;
  const accessible = new Set<string>();
  const resolver = input.operations.appAccess;
  if (resolver) {
    let cursor: string | undefined;
    for (let page = 0; page < ACCESSIBLE_APP_PAGE_LIMIT; page++) {
      const result = await resolver.listAccessibleApps(input.session.subject, { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const app of result.apps) {
        if (owned.has(app.capsuleId) && (app.role === "owner" || app.role === "member")) accessible.add(app.capsuleId);
      }
      if (!result.nextCursor || [...owned].every((id) => accessible.has(id))) break;
      cursor = result.nextCursor;
    }
  }
  const appIds = input.session.appIds;
  return {
    allows: (capsuleIds) => capsuleIds.every((id) =>
      !owned.has(id) || (accessible.has(id) && (appIds === undefined || appIds.includes(id)))),
  };
}

const ACTIVITY_CAPSULE_KEYS = ["capsuleId", "consumerCapsuleId", "providerCapsuleId", "ownerCapsuleId"] as const;
const ACTIVITY_SOURCE_KEYS = ["sourceId", "fromSourceId", "toSourceId"] as const;

/**
 * Activity of apps the caller cannot view is omitted. Events are attributed by
 * their Capsule target, Capsule ids in metadata, Source targets (via the
 * Capsules built from them), and, only for Run events that carry no Capsule
 * id, the Run itself.
 */
export async function visibleActivityEvents<T extends ActivityEvent>(input: {
  readonly operations: ControlPlaneOperations;
  readonly session: ControlSession;
  readonly workspaceId: string;
  readonly events: readonly T[];
}): Promise<readonly T[]> {
  if (!input.events.length || !input.operations.appOwnership) return input.events;
  const sourceApps = await workspaceSourceApps(input.operations, input.workspaceId);
  const attributed = new Map<T, readonly string[]>();
  for (const event of input.events) {
    const ids = new Set<string>();
    const metadata = (event.metadata ?? {}) as Record<string, unknown>;
    if (event.targetType === "capsule") ids.add(event.targetId);
    for (const key of ACTIVITY_CAPSULE_KEYS) if (typeof metadata[key] === "string" && metadata[key]) ids.add(metadata[key] as string);
    const sourceIds = [
      ...(event.targetType === "source" ? [event.targetId] : []),
      ...ACTIVITY_SOURCE_KEYS.map((key) => metadata[key]).filter((value): value is string => typeof value === "string" && value.length > 0),
    ];
    for (const sourceId of sourceIds) for (const id of sourceApps.get(sourceId) ?? []) ids.add(id);
    const runId = event.runId ?? (event.targetType === "run" ? event.targetId : undefined);
    if (!ids.size && runId) {
      try {
        for (const id of await runCapsuleIds(input.operations, await input.operations.getRun(runId))) ids.add(id);
      } catch (error) {
        if (controllerErrorCode(error) !== "not_found") throw error;
      }
    }
    attributed.set(event, [...ids]);
  }
  const visibility = await workspaceAppVisibility({
    operations: input.operations, session: input.session, capsuleIds: [...attributed.values()].flat(),
  });
  return input.events.filter((event) => visibility.allows(attributed.get(event) ?? []));
}

/** sourceId → live Capsules built from it, for mapping list items without a capsuleId. */
export async function workspaceSourceApps(
  operations: ControlPlaneOperations,
  workspaceId: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const map = new Map<string, string[]>();
  for (const capsule of await operations.capsules.listCapsules(workspaceId)) {
    if (capsule.workspaceId !== workspaceId || capsule.status === "destroyed" || !capsule.sourceId) continue;
    map.set(capsule.sourceId, [...(map.get(capsule.sourceId) ?? []), capsule.id]);
  }
  return map;
}

/**
 * Workspace-level bulk actions (Workspace update, drift check, Workspace
 * backup, restore without an explicit app) still require the Workspace
 * decision, which the caller has already applied. They must not reach an app
 * with an ownership row unless the caller may perform `action` on that app.
 */
export async function requireWorkspaceAppsAccess(
  input: AuthorizationContext & { readonly workspaceId: string; readonly action: AppAction },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly response: Response }> {
  if (!input.operations.appOwnership) {
    // Without an ownership port no app can be owned yet; skip the listing.
    await reportFallback(input.diagnostics, "ownership_store_unavailable");
    return { ok: true };
  }
  const capsules = await input.operations.capsules.listCapsules(input.workspaceId);
  input.assertActive?.();
  for (const capsule of capsules) {
    if (capsule.workspaceId !== input.workspaceId || capsule.status === "destroyed") continue;
    const fence = await readOwnershipFence(input.operations, capsule.id);
    input.assertActive?.();
    if (fence.kind === "fallback") {
      if (fence.reason !== "capsule_not_backfilled") {
        // No ownership schema or port: no app in this Workspace is owned yet.
        await reportFallback(input.diagnostics, fence.reason);
        return { ok: true };
      }
      continue;
    }
    const result = await decideOwnedApp({
      ...input,
      capsuleId: capsule.id,
      capsule,
      workspaceId: input.workspaceId,
      action: input.action,
    }, fence.ownership);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/** Destroy work is uninstall (owner only); restore is a rollback. */
export function runAppAction(
  run: Pick<Run, "type" | "origin">,
  intent: "view" | "operate",
): AppAction {
  if (intent === "view") return "view";
  if (run.type === "destroy_plan" || run.type === "destroy_apply" ||
    run.origin?.kind === "scheduled_uninstall") return "uninstall";
  if (run.type === "restore" || run.origin?.kind === "rollback") return "rollback";
  if (run.origin?.kind === "configuration") return "change_settings";
  return "update";
}

export function planRunAppAction(planRun: Pick<PublicPlanRun, "operation" | "origin">): AppAction {
  if (planRun.operation === "destroy" || planRun.origin?.kind === "scheduled_uninstall") return "uninstall";
  if (planRun.origin?.kind === "rollback") return "rollback";
  if (planRun.origin?.kind === "configuration") return "change_settings";
  return "update";
}
