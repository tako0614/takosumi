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
 * Capsule-bound resources decide per app; resources without a Capsule (for
 * example an unowned preflight Source or a Workspace-level Run) keep the
 * Workspace decision.
 */
export async function requireResourceAccess(
  input: AuthorizationContext & {
    readonly workspaceId: string;
    readonly capsuleId: string | undefined;
    readonly capsule?: Pick<Capsule, "id" | "workspaceId" | "status">;
    readonly action: AppAction;
  },
): Promise<AppAuthorizationResult> {
  if (input.capsuleId) {
    return await requireAppAccess({ ...input, capsuleId: input.capsuleId });
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
