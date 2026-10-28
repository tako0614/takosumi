/** Per-app account control routes. Durable mutations belong to AppOwnershipOperations. */
import type { CapsuleAppState, CapsuleAppAction } from "takosumi-contract/capsules";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AppAccess, AppAccessResolver } from "../../../../contract/app-access.ts";
import { errorJson, json, methodNotAllowed, readJsonObject } from "../http-helpers.ts";
import { bearerAppAllows } from "../account-session.ts";
import type { ControlDispatchContext } from "./shared.ts";
import { controlPlaneUnavailable } from "./shared.ts";
import { readCapsuleAppView } from "./capsule-app.ts";
import { AppAuthorizationError } from "../../../../core/domains/app-authorization/errors.ts";

export interface AppMemberRecord {
  readonly accountId: string;
  readonly status: "active" | "invited";
}

export interface AppOwnershipTransferRecord {
  readonly transferId: string;
  readonly capsuleId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly state: "pending" | "accepted" | "cancelled";
}

/**
 * All writes must recheck the current actor, owner and ownership epoch inside
 * one durable serialized transaction. Remove must cancel the removed member's
 * queued and waiting-approval Runs atomically. Accept must drain admission,
 * swap owner, increment ownership epoch, clear provider bindings and switch the
 * payer before admitting new work. No route-level read grants write authority.
 */
export interface AppOwnershipOperations extends AppAccessResolver {
  listMembers(capsuleId: string): Promise<{
    readonly ownerAccountId: string;
    readonly ownershipEpoch: number;
    readonly members: readonly AppMemberRecord[];
  }>;
  addMember(input: {
    readonly capsuleId: string;
    readonly actorAccountId: string;
    readonly accountId: string;
    readonly expectedOwnershipEpoch: number;
  }): Promise<AppMemberRecord>;
  removeMember(input: {
    readonly capsuleId: string;
    readonly actorAccountId: string;
    readonly accountId: string;
    readonly expectedOwnershipEpoch: number;
  }): Promise<void>;
  createTransfer(input: {
    readonly capsuleId: string;
    readonly actorAccountId: string;
    readonly toAccountId: string;
    readonly expectedOwnershipEpoch: number;
  }): Promise<{ readonly transferId: string; readonly state: "pending" }>;
  getTransfer(transferId: string): Promise<AppOwnershipTransferRecord | undefined>;
  acceptTransfer(input: {
    readonly transferId: string;
    readonly actorAccountId: string;
  }): Promise<{ readonly transferId: string; readonly state: "pending" | "accepted" }>;
  cancelTransfer(input: {
    readonly transferId: string;
    readonly actorAccountId: string;
  }): Promise<void>;
}

export { AppAuthorizationError as AppOwnershipError };

function mutationError(error: unknown, request: Request): Response {
  if (!(error instanceof AppAuthorizationError)) throw error;
  const status = error.code === "not_found" ? 404
    : error.code === "feature_unavailable" ? 503
    : error.code === "ownership_transfer_pending" || error.code === "conflict" ? 409
    : 403;
  return errorJson(error.code, error.message, status, request);
}

function denied(request: Request, ownerOnly = false): Response {
  return errorJson(
    ownerOnly ? "app_owner_only" : "app_access_denied",
    ownerOnly ? "Only the current app owner can perform this action." : "App access is required.",
    403,
    request,
  );
}

/** Legacy Workspace-only bearers have no per-app attenuation. */
function accountSessionOnly(ctx: ControlDispatchContext): Response | undefined {
  return ctx.session.workspaceId && ctx.session.appIds === undefined
    ? denied(ctx.request)
    : undefined;
}

function appPort(ctx: ControlDispatchContext): AppAccessResolver | undefined {
  const operations = ctx.operations as typeof ctx.operations & {
    readonly appAccess?: AppAccessResolver;
    readonly appAuthorization?: AppOwnershipOperations;
  };
  return operations.appAccess ?? operations.appAuthorization;
}

function ownershipPort(ctx: ControlDispatchContext): AppOwnershipOperations | undefined {
  return (ctx.operations as typeof ctx.operations & {
    readonly appAuthorization?: AppOwnershipOperations;
  }).appAuthorization;
}

async function accessTo(
  ctx: ControlDispatchContext,
  capsuleId: string,
): Promise<AppAccess | undefined> {
  if (!bearerAppAllows(ctx.session, capsuleId)) return undefined;
  const access = await appPort(ctx)?.resolveAppAccess(ctx.session.subject, capsuleId);
  if (!access) return undefined;
  return await capsuleWithinBearerScope(ctx, capsuleId) ? access : undefined;
}

async function capsuleWithinBearerScope(ctx: ControlDispatchContext, capsuleId: string): Promise<boolean> {
  if (!bearerAppAllows(ctx.session, capsuleId)) return false;
  if (!ctx.session.workspaceId) return true;
  const capsule = await ctx.operations.capsules.getCapsule(capsuleId);
  return capsule.workspaceId === ctx.session.workspaceId;
}

function accountId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
      !/[\x00-\x1f\x7f]/u.test(value)
    ? value
    : undefined;
}

function memberEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 320) return undefined;
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : undefined;
}

async function profile(
  ctx: ControlDispatchContext,
  subject: string,
  includeEmail: boolean,
): Promise<{ accountId: string; displayName: string; email?: string }> {
  const account = await ctx.store.findAccount(subject as TakosumiSubject);
  const displayName = account?.displayName?.trim() || subject;
  const email = includeEmail && account?.emailVerified === true
    ? account.email?.trim()
    : undefined;
  return {
    accountId: subject,
    displayName,
    ...(email ? { email } : {}),
  };
}

async function listApps(ctx: ControlDispatchContext): Promise<Response> {
  const port = appPort(ctx);
  if (!port || typeof ctx.operations.listCapsuleRunsPage !== "function") return controlPlaneUnavailable();
  const rawLimit = ctx.url.searchParams.get("limit");
  if (rawLimit !== null && !/^[1-9]\d*$/u.test(rawLimit)) {
    return errorJson("invalid_request", "limit must be a positive integer", 400, ctx.request);
  }
  const limit = rawLimit === null ? 50 : Math.min(Number(rawLimit), 100);
  const cursor = ctx.url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor))) {
    return errorJson("invalid_request", "cursor is malformed", 400, ctx.request);
  }
  const page = await port.listAccessibleApps(ctx.session.subject, {
    limit,
    ...(cursor ? { cursor } : {}),
  });
  if (page.apps.length > limit) return controlPlaneUnavailable();
  const apps = await Promise.all(page.apps.map(async (entry) => {
    if (!bearerAppAllows(ctx.session, entry.capsuleId)) return undefined;
    // A stale page may outlive revocation. Recheck before reading any app facts.
    const live = await port.resolveAppAccess(ctx.session.subject, entry.capsuleId);
    if (!live || live.ownerAccountId !== entry.ownerAccountId || live.ownershipEpoch !== entry.ownershipEpoch) return undefined;
    const capsule = await ctx.operations.capsules.getCapsule(entry.capsuleId);
    if (ctx.session.workspaceId && capsule.workspaceId !== ctx.session.workspaceId) return undefined;
    if (capsule.status === "destroyed") return undefined;
    const [view, owner] = await Promise.all([
      readCapsuleAppView(ctx, capsule, Date.now()),
      ctx.store.findAccount(live.ownerAccountId as TakosumiSubject),
    ]);
    return {
      capsuleId: capsule.id,
      name: capsule.name,
      ...(view.displayName ? { displayName: view.displayName } : {}),
      ...(view.iconUrl ? { iconUrl: view.iconUrl } : {}),
      role: live.role,
      ownerDisplayName: owner?.displayName?.trim() || live.ownerAccountId,
      state: view.state as CapsuleAppState,
      primaryAction: view.primaryAction as CapsuleAppAction,
    };
  }));
  return json({
    apps: apps.filter((entry) => entry !== undefined),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }, 200, { "cache-control": "no-store" });
}

async function listMembers(ctx: ControlDispatchContext, capsuleId: string): Promise<Response> {
  const port = ownershipPort(ctx);
  if (!port || !appPort(ctx)) return controlPlaneUnavailable();
  const access = await accessTo(ctx, capsuleId);
  if (!access) return denied(ctx.request);
  const roster = await port.listMembers(capsuleId);
  if (roster.ownerAccountId !== access.ownerAccountId || roster.ownershipEpoch !== access.ownershipEpoch) {
    return errorJson("conflict", "App ownership changed; retry the request.", 409, ctx.request);
  }
  const includeEmail = access.role === "owner";
  const [owner, members] = await Promise.all([
    profile(ctx, roster.ownerAccountId, includeEmail),
    Promise.all(roster.members.map(async (member) => ({
      ...await profile(ctx, member.accountId, includeEmail),
      status: member.status,
    }))),
  ]);
  // Guard owner-only email after profile reads, too.
  const live = await accessTo(ctx, capsuleId);
  if (!live || live.ownerAccountId !== roster.ownerAccountId || live.ownershipEpoch !== roster.ownershipEpoch || live.role !== access.role) {
    return errorJson("conflict", "App access changed; retry the request.", 409, ctx.request);
  }
  return json({ owner, members }, 200, { "cache-control": "no-store" });
}

async function addMember(ctx: ControlDispatchContext, capsuleId: string): Promise<Response> {
  const port = ownershipPort(ctx);
  if (!port || !appPort(ctx)) return controlPlaneUnavailable();
  const access = await accessTo(ctx, capsuleId);
  if (!access) return denied(ctx.request);
  if (access.role !== "owner") return denied(ctx.request, true);
  const body = await readJsonObject(ctx.request);
  const email = memberEmail(body?.email);
  if (!body || !email || body.consent !== "connections_and_code") {
    return errorJson("invalid_request", "email and consent: connections_and_code are required.", 400, ctx.request);
  }
  const account = await ctx.store.findAccountByVerifiedEmail(email);
  if (!account || account.emailVerified !== true || account.email?.trim().toLowerCase() !== email.toLowerCase()) {
    return errorJson("not_found", "No verified Takosumi account was found for that email.", 404, ctx.request);
  }
  if (account.subject === access.ownerAccountId) {
    return errorJson("invalid_request", "The app owner cannot be added as a member.", 400, ctx.request);
  }
  try {
    const member = await port.addMember({
      capsuleId,
      actorAccountId: ctx.session.subject,
      accountId: account.subject,
      expectedOwnershipEpoch: access.ownershipEpoch,
    });
    return json({ member: { ...await profile(ctx, member.accountId, true), status: member.status } }, 201, {
      "cache-control": "no-store",
    });
  } catch (error) {
    return mutationError(error, ctx.request);
  }
}

async function removeMember(ctx: ControlDispatchContext, capsuleId: string, targetId: string): Promise<Response> {
  const port = ownershipPort(ctx);
  if (!port || !appPort(ctx)) return controlPlaneUnavailable();
  const access = await accessTo(ctx, capsuleId);
  if (!access) return denied(ctx.request);
  if (access.role !== "owner" && ctx.session.subject !== targetId) return denied(ctx.request, true);
  if (targetId === access.ownerAccountId) return denied(ctx.request, true);
  try {
    await port.removeMember({
      capsuleId,
      actorAccountId: ctx.session.subject,
      accountId: targetId,
      expectedOwnershipEpoch: access.ownershipEpoch,
    });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mutationError(error, ctx.request);
  }
}

async function createTransfer(ctx: ControlDispatchContext, capsuleId: string): Promise<Response> {
  const port = ownershipPort(ctx);
  if (!port || !appPort(ctx)) return controlPlaneUnavailable();
  const access = await accessTo(ctx, capsuleId);
  if (!access) return denied(ctx.request);
  if (access.role !== "owner") return denied(ctx.request, true);
  const body = await readJsonObject(ctx.request);
  const toAccountId = accountId(body?.toAccountId);
  if (!toAccountId || toAccountId === access.ownerAccountId) {
    return errorJson("invalid_request", "A different toAccountId is required.", 400, ctx.request);
  }
  if (!await ctx.store.findAccount(toAccountId as TakosumiSubject)) {
    return errorJson("not_found", "Recipient account was not found.", 404, ctx.request);
  }
  try {
    const transfer = await port.createTransfer({
      capsuleId,
      actorAccountId: ctx.session.subject,
      toAccountId,
      expectedOwnershipEpoch: access.ownershipEpoch,
    });
    return json(transfer, 201, { "cache-control": "no-store" });
  } catch (error) {
    return mutationError(error, ctx.request);
  }
}

async function changeTransfer(ctx: ControlDispatchContext, transferId: string, accept: boolean): Promise<Response> {
  const port = ownershipPort(ctx);
  if (!port || !appPort(ctx)) return controlPlaneUnavailable();
  const transfer = await port.getTransfer(transferId);
  if (!transfer) return errorJson("not_found", "Transfer was not found.", 404, ctx.request);
  if (!await capsuleWithinBearerScope(ctx, transfer.capsuleId)) return denied(ctx.request);
  if (accept) {
    if (transfer.toAccountId !== ctx.session.subject) return denied(ctx.request);
    try {
      const outcome = await port.acceptTransfer({ transferId, actorAccountId: ctx.session.subject });
      if (outcome.state === "pending") {
        return errorJson("ownership_transfer_pending", "App management is draining; retry after active Runs settle.", 409, ctx.request);
      }
      return json(outcome, 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      return mutationError(error, ctx.request);
    }
  }
  const access = await accessTo(ctx, transfer.capsuleId);
  if (!access || access.role !== "owner" || access.ownerAccountId !== transfer.fromAccountId) return denied(ctx.request, true);
  try {
    await port.cancelTransfer({ transferId, actorAccountId: ctx.session.subject });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mutationError(error, ctx.request);
  }
}

/** Called before the existing Workspace-gated capsules handler for these paths. */
export async function handleAppOwnership(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const isApps = segments[0] === "apps" && segments.length === 1;
  const isMembers = segments[0] === "capsules" && segments[2] === "members" &&
    (segments.length === 3 || segments.length === 4);
  const isCreateTransfer = segments[0] === "capsules" && segments[2] === "ownership-transfers" && segments.length === 3;
  const isTransfer = segments[0] === "ownership-transfers" && segments.length >= 2 && segments.length <= 3;
  if (!isApps && !isMembers && !isCreateTransfer && !isTransfer) return undefined;
  const scoped = accountSessionOnly(ctx);
  if (scoped) return scoped;
  if (isApps) return method === "GET" ? listApps(ctx) : methodNotAllowed("GET");
  if (isMembers) {
    const capsuleId = accountId(segments[1]);
    if (!capsuleId) return errorJson("invalid_request", "Invalid capsule ID.", 400, ctx.request);
    if (segments.length === 3) {
      if (method === "GET") return listMembers(ctx, capsuleId);
      if (method === "POST") return addMember(ctx, capsuleId);
      return methodNotAllowed("GET, POST");
    }
    const targetId = accountId(segments[3]);
    if (!targetId) return errorJson("invalid_request", "Invalid account ID.", 400, ctx.request);
    return method === "DELETE" ? removeMember(ctx, capsuleId, targetId) : methodNotAllowed("DELETE");
  }
  if (isCreateTransfer) {
    const capsuleId = accountId(segments[1]);
    if (!capsuleId) return errorJson("invalid_request", "Invalid capsule ID.", 400, ctx.request);
    return method === "POST" ? createTransfer(ctx, capsuleId) : methodNotAllowed("POST");
  }
  const transferId = accountId(segments[1]);
  if (!transferId) return errorJson("invalid_request", "Invalid transfer ID.", 400, ctx.request);
  if (segments.length === 3 && segments[2] === "accept") {
    return method === "POST" ? changeTransfer(ctx, transferId, true) : methodNotAllowed("POST");
  }
  if (segments.length === 2) return method === "DELETE" ? changeTransfer(ctx, transferId, false) : methodNotAllowed("DELETE");
  return undefined;
}
