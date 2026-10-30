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
import type { ListSourcesResponse, Source } from "takosumi-contract/sources";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { ListBackupsResponse } from "takosumi-contract/backups";
import type { UsageEvent } from "takosumi-contract/billing";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type { PublicPlanRun } from "@takosumi/internal/deploy-control-api";
import type { CapsuleOwnership } from "../../../../core/domains/app-ownership/store.ts";
import { isMissingOwnershipSchemaError } from "../../../../core/domains/app-ownership/store.ts";
import type { AppListViewer } from "../../../../core/domains/app-ownership/list-visibility.ts";
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
  installedAppTokenDelegates,
  isDesignatedDelegateApp,
  isInstalledAppToken,
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
  // One exception: an operator-designated delegate token (Takos) may
  // uninstall ANOTHER app for its user when the user may (the app's owner;
  // the Workspace owner while the app has no ownership row). It never
  // uninstalls its own app, and never transfers ownership or manages members.
  let delegatedUninstall = false;
  if (input.session.credential === "oauth-access-token" && OWNER_ONLY_ACTIONS.has(input.action)) {
    delegatedUninstall = input.action === "uninstall" && isInstalledAppToken(input.session) &&
      !input.session.appIds.includes(input.capsuleId) &&
      await installedAppTokenDelegates(input.operations, input.session);
    input.assertActive?.();
    if (!delegatedUninstall) {
      return {
        ok: false,
        response: errorJson(
          "app_access_denied",
          "Uninstall, ownership transfer and member management require an account session or personal access token.",
          403,
        ),
      };
    }
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
    if (allowed && delegatedUninstall && !(await isWorkspaceOwner(input.operations, input.session, input.workspaceId))) {
      return { ok: false, response: appOwnerOnly() };
    }
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
  // An installed app's own token reaches only its own app unless the
  // operator designated the app as a delegate. A delegate token acting on
  // ANOTHER owned app acts for its user (TASK-0118 P9.1-b): the user's live
  // role on that app is the decision, and the Workspace the token may still be
  // bound to (derived from Workspace membership at issuance) neither limits nor
  // grants it. The OAuth exclusions in requireAppAccess still apply.
  const delegatedForUser = isInstalledAppToken(session) && !session.appIds.includes(input.capsuleId) &&
    await installedAppTokenDelegates(operations, session);
  input.assertActive?.();
  if (isInstalledAppToken(session) && !session.appIds.includes(input.capsuleId) && !delegatedForUser) {
    return { ok: false, response: appAccessDenied() };
  }
  // Bearer restrictions come first and are never replaced by a role.
  if (!delegatedForUser && !bearerWorkspaceAllows(session, input.workspaceId)) return { ok: false, response: appAccessDenied() };
  if (session.appIds !== undefined && session.credential !== "oauth-access-token" &&
    !bearerAppAllows(session, input.capsuleId)) {
    return { ok: false, response: appAccessDenied() };
  }
  let capsule = input.capsule;
  if (session.workspaceId !== undefined && !delegatedForUser) {
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
  // A delegate token acting for its user on another app has no Workspace
  // limit here: it is bounded by the user's app role above, exactly as the
  // user's own session is.
  if ((session.credential === "oauth-access-token" && !delegatedForUser) || session.requireCurrentMembership) {
    const workspaceAllowed = await canAccessWorkspace({
      operations,
      store: input.store,
      session,
      workspaceId: input.workspaceId,
      capsuleId: input.capsuleId,
      appAction: input.action,
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
 * Interface unless it is an operator-designated delegate token whose user has
 * that action on the provider. A false result makes the link `pending_approval`.
 */
export async function mayApproveInterfaceProvider(
  input: AuthorizationContext & {
    readonly consumerCapsuleId: string;
    readonly provider: { readonly capsuleId: string; readonly workspaceId: string };
  },
): Promise<boolean> {
  if (input.provider.capsuleId === input.consumerCapsuleId) return true;
  // An app's own token never approves another app's Interface, except an
  // operator-designated delegate token (Takos installing for its user): it
  // approves only when its USER may change links on the provider app (the
  // decision below applies the user's role and the token's own limits).
  if (input.session.credential === "oauth-access-token" &&
    !(isInstalledAppToken(input.session) && await installedAppTokenDelegates(input.operations, input.session))) {
    return false;
  }
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
 * Whether this credential may approve or decline Interface links waiting for
 * `providerCapsuleId`. Approval hands the provider app's permissions to the
 * consumer app's people, so it is a person's decision: an installed app's own
 * OAuth token never decides, on any app (its own included). The one exception
 * is an operator-designated delegate token (Takos), and only for ANOTHER app:
 * the caller still needs `change_interface_link` on the provider app under its
 * user's role there (`requireAppAccess` applies the token's own limits).
 */
export async function mayDecideInterfaceLinkRequests(input: {
  readonly operations: ControlPlaneOperations;
  readonly session: AppAccessRequest["session"];
  readonly providerCapsuleId: string;
  readonly assertActive?: () => void;
}): Promise<boolean> {
  if (input.session.credential !== "oauth-access-token") return true;
  if (!isInstalledAppToken(input.session) || input.session.appIds.includes(input.providerCapsuleId)) return false;
  const delegates = await installedAppTokenDelegates(input.operations, input.session);
  input.assertActive?.();
  return delegates;
}

/**
 * Resources that belong to apps decide per app: every app in `capsuleIds` must
 * allow `action` under its own rule (the per-app decision when it has an
 * ownership row, the legacy Workspace decision when it has none). A resource
 * with no app at all (an unowned preflight Source, a Workspace-level Run)
 * keeps the Workspace decision.
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
    // A resource shared by several apps (an ownerless Source used by more than
    // one app) changes every one of them, so EVERY app must allow the action
    // under its own rule: the per-app decision for an app with an ownership
    // row, the legacy Workspace decision for an app without one. An owned app
    // never stands in for an unowned one, nor the reverse.
    const { capsule: _capsule, ...rest } = input;
    let decided: AppAuthorizationResult | undefined;
    for (const capsuleId of ids) {
      const result = await requireAppAccess({ ...rest, capsuleId });
      if (!result.ok) return result;
      if (!decided || (decided.ok && decided.authority === "workspace" && result.authority === "app")) decided = result;
    }
    return decided!;
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

/** The caller as a Workspace list viewer; `appIds` limits the owned apps it sees. */
function appListViewer(session: ControlSession): AppListViewer {
  return { accountId: session.subject, ...(session.appIds !== undefined ? { appIds: session.appIds } : {}) };
}

/**
 * Keyset-paged Workspace compatibility lists (capsules, current StateVersions,
 * Runs, Sources, backups, usage, dashboard overview). With an ownership store
 * wired, each page is filtered for the caller in the store query
 * (core/domains/app-ownership/list-visibility.ts): pages hold only rows the
 * caller may view, paging continues past any number of hidden rows, and the
 * cursor is the store's own cursor for a visible row. Without an ownership
 * store no app can be owned and the plain reads apply. A host that wires an
 * ownership store without the filtered reads is refused, never served an
 * unfiltered list.
 */
export interface WorkspaceListReads {
  capsulesPage(workspaceId: string, params: PageParams & { readonly includeDestroyed?: boolean }): Promise<Page<Capsule>>;
  /** Absent only on a host without Run paging and without an ownership store. */
  readonly runsPage?: (
    workspaceId: string,
    options: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<{ readonly runs: readonly Run[]; readonly nextCursor?: string }>;
  sources(workspaceId: string, params: PageParams): Promise<ListSourcesResponse>;
  backups(workspaceId: string, params: PageParams): Promise<ListBackupsResponse>;
  usage(
    workspaceId: string,
    params: PageParams,
  ): Promise<{ readonly usageEvents: readonly UsageEvent[]; readonly nextCursor?: string }>;
}

export function workspaceListReads(
  operations: ControlPlaneOperations,
  session: ControlSession,
): WorkspaceListReads | Response {
  if (!operations.appOwnership) {
    const listRunsPage = operations.listRunsPage?.bind(operations);
    return {
      capsulesPage: (workspaceId, params) => operations.capsules.listCapsulesPage(workspaceId, params),
      ...(listRunsPage ? { runsPage: (workspaceId, options) => listRunsPage(workspaceId, options) } : {}),
      sources: (workspaceId, params) => operations.listSources(workspaceId, params),
      backups: (workspaceId, params) => operations.backups.listBackups(workspaceId, params),
      usage: (workspaceId, params) => operations.listWorkspaceUsage(workspaceId, params),
    };
  }
  const lists = operations.viewerLists;
  if (!lists) return controlPlaneUnavailable();
  const viewer = appListViewer(session);
  return {
    capsulesPage: (workspaceId, params) => lists.listCapsulesPage(workspaceId, params, viewer),
    runsPage: (workspaceId, options) => lists.listRunsPage(workspaceId, options, viewer),
    sources: (workspaceId, params) => lists.listSources(workspaceId, params, viewer),
    backups: (workspaceId, params) => lists.listBackups(workspaceId, params, viewer),
    usage: (workspaceId, params) => lists.listWorkspaceUsage(workspaceId, params, viewer),
  };
}

/**
 * Filtering for the Workspace reads that are not keyset-paged (Activity,
 * materialization failures, installed apps): an item that belongs to an app
 * the caller may not see in a list (the rule in list-visibility.ts, so the
 * retained owner and members of an uninstalled app still see its history) is
 * omitted. Items of apps without an ownership row keep the Workspace decision
 * the route already applied. One batch read per request; no per-item
 * authorization lookups.
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
  if (store.listHiddenCapsuleIds) {
    const hidden = await store.listHiddenCapsuleIds(appListViewer(input.session), ids);
    return hidden.size ? { allows: (capsuleIds) => capsuleIds.every((id) => !hidden.has(id)) } : ALLOW_ALL;
  }
  // Stores without the batch read: accessible-app pages (uninstalled apps excluded).
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
const ACTIVITY_CAPSULE_LIST_KEYS = ["memberCapsuleIds"] as const;
const ACTIVITY_SOURCE_KEYS = ["sourceId", "fromSourceId", "toSourceId"] as const;
const ACTIVITY_RUN_KEYS = ["runId", "planRunId", "applyRunId"] as const;
/** Activity that never belongs to an app. */
const WORKSPACE_ACTIVITY_TARGETS: ReadonlySet<string> = new Set(["workspace", "connection"]);
/** Distinct Run/Source/Interface reads one Activity request may spend. */
const ACTIVITY_LOOKUP_LIMIT = 50;

async function ownedCapsuleIds(operations: ControlPlaneOperations, capsuleIds: readonly string[]): Promise<ReadonlySet<string>> {
  const store = operations.appOwnership;
  if (!store || !capsuleIds.length) return new Set();
  if (store.listOwnedCapsuleIds) return await store.listOwnedCapsuleIds(capsuleIds);
  const owned = new Set<string>();
  for (const id of capsuleIds) if ((await readOwnershipFence(operations, id)).kind === "owned") owned.add(id);
  return owned;
}

/**
 * Activity of apps the caller cannot view is omitted.
 *
 * Reads: the Workspace's Capsules and one batch ownership read first; when no
 * app in the Workspace has an ownership row (every app on a v75 target), the
 * events are returned unchanged with no further reads. Otherwise an event is
 * attributed to apps by its Capsule target, Capsule ids in metadata
 * (`memberCapsuleIds` of a run group: every member must be visible), an
 * Interface's Capsule owner (`ownerId`) or a binding's Capsule subject
 * (`subjectId`), its Source (the apps built from it, or its owner app), the
 * Interface it concerns (the provider app), and, when nothing else names an
 * app, its Run (`runId`, a Run target, `metadata.runId`/`planRunId`/
 * `applyRunId`). A backup that names no app is Workspace-wide and belongs to
 * every live app. Run/Source/Interface reads are deduplicated, run in
 * parallel and capped at ACTIVITY_LOOKUP_LIMIT per request.
 *
 * Fail closed: while the Workspace has owned apps, an event whose app cannot
 * be determined (a read past the cap, a missing Run or Interface, a Capsule id
 * this Workspace does not have, or no attribution at all) is omitted, even
 * when another reference resolves; except Workspace-level events (`workspace`,
 * `connection`) and events that resolve to no app (a Run or Source used by no
 * app, a retired Source), which keep the Workspace decision.
 */
export async function visibleActivityEvents<T extends ActivityEvent>(input: {
  readonly operations: ControlPlaneOperations;
  readonly session: ControlSession;
  readonly workspaceId: string;
  readonly events: readonly T[];
}): Promise<readonly T[]> {
  const { operations } = input;
  if (!input.events.length || !operations.appOwnership) return input.events;
  const capsules = (await operations.capsules.listCapsules(input.workspaceId))
    .filter((capsule) => capsule.workspaceId === input.workspaceId);
  const known = new Set(capsules.map((capsule) => capsule.id));
  if (!(await ownedCapsuleIds(operations, [...known])).size) return input.events;
  const attributed = await attributeActivityEvents({ operations, capsules, events: input.events });
  const visibility = await workspaceAppVisibility({
    operations, session: input.session, capsuleIds: attributed.flatMap((ids) => ids ?? []),
  });
  return input.events.filter((_, index) => {
    const ids = attributed[index];
    return ids !== undefined && visibility.allows(ids);
  });
}

/**
 * The apps each Activity event of one internal partition belongs to, by the
 * rule documented on {@link visibleActivityEvents}: `undefined` when the app
 * cannot be determined (fail closed), `[]` for an event that belongs to no
 * app, otherwise the Capsule ids. `capsules` are every Capsule recorded in
 * the events' partition (destroyed ones included). Attribution grants
 * nothing: callers still filter by what the caller may view.
 */
export async function attributeActivityEvents<T extends ActivityEvent>(input: {
  readonly operations: ControlPlaneOperations;
  readonly capsules: readonly Capsule[];
  readonly events: readonly T[];
}): Promise<readonly (readonly string[] | undefined)[]> {
  const { operations, capsules } = input;
  if (!input.events.length) return [];
  const known = new Set(capsules.map((capsule) => capsule.id));
  const live = capsules.filter((capsule) => capsule.status !== "destroyed");
  const sourceApps = sourceAppsOf(live);
  let budget = ACTIVITY_LOOKUP_LIMIT;
  /** undefined: the app could not be determined. */
  type Resolved = readonly string[] | undefined;
  const cached = (cache: Map<string, Promise<Resolved>>, id: string, read: () => Promise<Resolved>): Promise<Resolved> => {
    const pending = cache.get(id);
    if (pending) return pending;
    if (budget <= 0) return Promise.resolve(undefined);
    budget--;
    const started = read();
    cache.set(id, started);
    return started;
  };
  const sources = new Map<string, Promise<Resolved>>();
  const runs = new Map<string, Promise<Resolved>>();
  const interfaces = new Map<string, Promise<Resolved>>();
  const sourceAppIds = (sourceId: string): Promise<Resolved> => {
    const apps = sourceApps.get(sourceId);
    if (apps) return Promise.resolve(apps);
    // No live app is built from it: only its owner app (if any) can claim it.
    return cached(sources, sourceId, async () => {
      try {
        const owner = sourceOwner((await operations.getSource(sourceId)).source);
        return owner ? [owner] : [];
      } catch (error) {
        if (controllerErrorCode(error) === "not_found") return [];
        throw error;
      }
    });
  };
  const runAppIds = (runId: string): Promise<Resolved> => cached(runs, runId, async () => {
    let run: Run;
    try {
      run = await operations.getRun(runId);
    } catch (error) {
      if (controllerErrorCode(error) === "not_found") return undefined;
      throw error;
    }
    if (run.capsuleId) return [run.capsuleId];
    if (run.subject?.kind === "capsule") return [run.subject.id];
    const sourceId = run.sourceId ?? (run.subject?.kind === "source" ? run.subject.id : undefined);
    return sourceId ? await sourceAppIds(sourceId) : [];
  });
  const interfaceAppIds = (interfaceId: string): Promise<Resolved> => cached(interfaces, interfaceId, async () => {
    const service = operations.interfaces;
    if (!service?.get) return undefined;
    try {
      const iface = await service.get(interfaceId);
      return iface.metadata.ownerRef.kind === "Capsule" ? [iface.metadata.ownerRef.id] : [];
    } catch (error) {
      if (controllerErrorCode(error) === "not_found" || (error as { code?: unknown } | undefined)?.code === "not_found") return undefined;
      throw error;
    }
  });
  const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
  const attribute = async (event: T): Promise<Resolved> => {
    const metadata = (event.metadata ?? {}) as Record<string, unknown>;
    const ids = new Set<string>();
    let undetermined = false;
    let resolvedNoApp = false;
    const add = (id: string | undefined) => {
      if (!id) return;
      // A Capsule this Workspace does not have cannot be attributed here.
      if (known.has(id)) ids.add(id);
      else undetermined = true;
    };
    const include = (resolved: Resolved) => {
      if (resolved === undefined) undetermined = true;
      else if (!resolved.length) resolvedNoApp = true;
      else resolved.forEach(add);
    };
    if (event.targetType === "capsule") add(event.targetId);
    for (const key of ACTIVITY_CAPSULE_KEYS) add(text(metadata[key]));
    for (const key of ACTIVITY_CAPSULE_LIST_KEYS) {
      const list = metadata[key];
      if (Array.isArray(list)) for (const value of list) add(text(value));
    }
    if (metadata.ownerKind === "Capsule") add(text(metadata.ownerId));
    if (metadata.subjectKind === "Capsule") add(text(metadata.subjectId));
    const sourceIds = [
      ...(event.targetType === "source" ? [event.targetId] : []),
      ...ACTIVITY_SOURCE_KEYS.map((key) => text(metadata[key])),
    ].filter((id): id is string => id !== undefined);
    const interfaceIds = [
      ...(event.targetType === "interface" && metadata.ownerKind === undefined ? [event.targetId] : []),
      ...(text(metadata.interfaceId) ? [text(metadata.interfaceId)!] : []),
    ];
    for (const resolved of await Promise.all([...sourceIds.map(sourceAppIds), ...interfaceIds.map(interfaceAppIds)])) include(resolved);
    if (!ids.size) {
      const runIds = new Set([
        ...(event.runId ? [event.runId] : []),
        ...(event.targetType === "run" ? [event.targetId] : []),
        ...ACTIVITY_RUN_KEYS.map((key) => text(metadata[key])).filter((id): id is string => id !== undefined),
      ]);
      for (const resolved of await Promise.all([...runIds].map(runAppIds))) include(resolved);
    }
    // A backup that names no app is Workspace-wide: it carries every live app.
    if (event.targetType === "backup" && !ids.size) return live.map((capsule) => capsule.id);
    if (undetermined) return undefined;
    if (ids.size) return [...ids];
    return WORKSPACE_ACTIVITY_TARGETS.has(event.targetType) || resolvedNoApp ? [] : undefined;
  };
  return await Promise.all(input.events.map(attribute));
}

function sourceOwner(source: { readonly ownerCapsuleId?: string }): string | undefined {
  return typeof source.ownerCapsuleId === "string" && source.ownerCapsuleId ? source.ownerCapsuleId : undefined;
}

function sourceAppsOf(capsules: readonly Pick<Capsule, "id" | "sourceId" | "status">[]): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const capsule of capsules) {
    if (capsule.status === "destroyed" || !capsule.sourceId) continue;
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

/** The legacy stand-in for "the app's owner" while an app has no ownership row. */
async function isWorkspaceOwner(
  operations: ControlPlaneOperations,
  session: ControlSession,
  workspaceId: string,
): Promise<boolean> {
  const workspace = await operations.workspaces.getWorkspace(workspaceId);
  return workspace.id === workspaceId && workspace.ownerUserId !== undefined &&
    workspace.ownerUserId === session.subject;
}

/**
 * Changing what a designated delegate app deploys (its ref, path, adopted
 * config, or a rollback to an earlier snapshot) is owner-only: the app's own
 * token carries Workspace delegation. Runs after the ordinary decision; while
 * the app has no ownership row, only the Workspace owner may.
 */
export async function requireOwnerForDelegateCodeChange(
  input: AuthorizationContext & { readonly workspaceId: string; readonly capsuleIds: readonly string[] },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly response: Response }> {
  if (!input.session.installedAppDelegationSources?.length) return { ok: true };
  for (const capsuleId of input.capsuleIds) {
    if (!(await isDesignatedDelegateApp(input.operations, input.session, capsuleId))) continue;
    const decision = await requireAppAccess({ ...input, capsuleId, action: "change_settings" });
    if (!decision.ok) return decision;
    if (decision.authority === "app" && decision.access.role !== "owner") return { ok: false, response: appOwnerOnly() };
    // Without an ownership row the Workspace owner stands in for the app owner.
    if (decision.authority === "workspace" && !(await isWorkspaceOwner(input.operations, input.session, input.workspaceId))) {
      return { ok: false, response: appOwnerOnly() };
    }
    input.assertActive?.();
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
