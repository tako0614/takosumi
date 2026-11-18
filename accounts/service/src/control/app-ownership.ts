/** Per-app account control routes. Durable mutations belong to AppOwnershipOperations. */
import { installDisplayName } from "./install-names.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AppAccess, AppAccessResolver } from "../../../../contract/app-access.ts";
import type { InstallConfig } from "takosumi-contract/install-configs";
import { errorJson, json, methodNotAllowed, readJsonObject } from "../http-helpers.ts";
import { appOwnershipMutationsFrozenResponse } from "../app-ownership-mutations-freeze.ts";
import { bearerAppAllows } from "../account-session.ts";
import type { ControlDispatchContext } from "./shared.ts";
import { controlPlaneUnavailable } from "./shared.ts";
import { readCapsuleAppSummaries, readCapsuleAppView } from "./capsule-app.ts";
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
    readonly consent: "connections_and_code";
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
  listTransfers(input: {
    readonly capsuleId?: string;
    readonly toAccountId?: string;
    readonly state: "pending";
  }): Promise<readonly AppOwnershipTransferRecord[]>;
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

/** An app OAuth grant cannot change account membership or ownership. */
function accountManagementCredential(ctx: ControlDispatchContext): Response | undefined {
  return (ctx.session.credential === "session" &&
      ctx.session.uninstallRequester?.grant === undefined) ||
      (ctx.session.credential === "personal-access-token" &&
        ctx.session.uninstallRequester?.grant?.kind === "personal-access-token")
    ? undefined
    : denied(ctx.request);
}

function appPort(ctx: ControlDispatchContext): AppAccessResolver | undefined {
  const operations = ctx.operations as typeof ctx.operations & {
    readonly appAccess?: AppAccessResolver;
  };
  return operations.appAccess;
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

async function appCursorBinding(ctx: ControlDispatchContext, q: string): Promise<string> {
  const scope = JSON.stringify([q, ctx.session.subject, ctx.session.credential,
    ctx.session.workspaceId ?? null, ctx.session.appIds ? [...new Set(ctx.session.appIds)].sort() : null]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function readAppCursor(token: string, binding: string): string | undefined {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(token)) return undefined;
    const value = JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/")));
    return value?.v === 1 && value.binding === binding && typeof value.after === "string" &&
      /^[A-Za-z0-9_-]{1,2048}$/u.test(value.after) ? value.after : undefined;
  } catch { return undefined; }
}

function writeAppCursor(after: string, binding: string): string {
  return btoa(JSON.stringify({ v: 1, binding, after })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function listApps(ctx: ControlDispatchContext): Promise<Response> {
  const port = appPort(ctx);
  if (!port || typeof ctx.operations.listCapsuleRunsPage !== "function") return controlPlaneUnavailable();
  const rawLimit = ctx.url.searchParams.get("limit");
  if (rawLimit !== null && !/^[1-9]\d*$/u.test(rawLimit)) {
    return errorJson("invalid_request", "limit must be a positive integer", 400, ctx.request);
  }
  const limit = rawLimit === null ? 50 : Math.min(Number(rawLimit), 100);
  const rawQuery = ctx.url.searchParams.get("q");
  if (rawQuery !== null && (rawQuery.length > 200 || /[\x00-\x1f\x7f]/u.test(rawQuery))) {
    return errorJson("invalid_request", "q must be at most 200 characters without control characters", 400, ctx.request);
  }
  const q = rawQuery?.trim().toLowerCase() ?? "";
  const binding = await appCursorBinding(ctx, q);
  const rawCursor = ctx.url.searchParams.get("cursor");
  const cursor = rawCursor === null ? undefined : readAppCursor(rawCursor, binding);
  if (rawCursor !== null && cursor === undefined) {
    return errorJson("invalid_request", "cursor does not match this search or access scope", 400, ctx.request);
  }
  const page = await port.listAccessibleApps(ctx.session.subject, {
    limit,
    ...(cursor ? { cursor } : {}),
  });
  if (page.apps.length > limit || (page.nextCursor !== undefined &&
    (!/^[A-Za-z0-9_-]{1,2048}$/u.test(page.nextCursor) || page.nextCursor === cursor))) return controlPlaneUnavailable();
  const authorized = await Promise.all(page.apps.map(async (entry) => {
    if (!bearerAppAllows(ctx.session, entry.capsuleId)) return undefined;
    // A stale page may outlive revocation. Recheck before reading any app facts.
    const live = await port.resolveAppAccess(ctx.session.subject, entry.capsuleId);
    if (!live || live.ownerAccountId !== entry.ownerAccountId || live.ownershipEpoch !== entry.ownershipEpoch) return undefined;
    return live;
  }));
  const liveAccesses = authorized.filter((entry) => entry !== undefined);
  const capsules = liveAccesses.length > 0
    ? await ctx.operations.capsules.getCapsulesByIds(liveAccesses.map((entry) => entry.capsuleId))
    : [];
  const visible = capsules.filter((capsule) => capsule.status !== "destroyed" &&
    (!ctx.session.workspaceId || capsule.workspaceId === ctx.session.workspaceId));
  const visibleIds = new Set(visible.map((capsule) => capsule.id));
  const visibleAccesses = liveAccesses.filter((access) => visibleIds.has(access.capsuleId));
  const metadata = await Promise.all([
    Promise.all([...new Set(visibleAccesses.map((access) => access.ownerAccountId))]
      .map(async (id) => [id, await ctx.store.findAccount(id as TakosumiSubject)] as const)),
    (async (): Promise<ReadonlyMap<string, InstallConfig> | undefined> => {
      if (!q || visible.length === 0) return undefined;
      const configs = ctx.operations.capsules;
      if (!configs.getInstallConfigsByIds) throw new Error("search config batch unavailable");
      return new Map((await configs.getInstallConfigsByIds([...new Set(visible.map((capsule) => capsule.installConfigId))]))
        .map((config) => [config.id, config]));
    })(),
    // Browsing retains the existing parallel profile/summary reads.
    q ? undefined : readCapsuleAppSummaries(ctx, visible, Date.now()),
  ]).catch(() => undefined);
  if (!metadata) return controlPlaneUnavailable();
  const [profiles, searchConfigs, browseSummaries] = metadata;
  const owners = new Map(profiles);
  let selected = visible;
  if (q && visible.length > 0) {
    // Search only authorized candidates from this one page. Display labels
    // come from one config batch, reused by the matching summary projection.
    if (visible.some((capsule) => !searchConfigs!.has(capsule.installConfigId))) return controlPlaneUnavailable();
    const accesses = new Map(visibleAccesses.map((access) => [access.capsuleId, access]));
    selected = visible.filter((capsule) => {
      const display = installDisplayName(capsule.name, searchConfigs!.get(capsule.installConfigId));
      const access = accesses.get(capsule.id)!;
      const owner = access.role === "member"
        ? owners.get(access.ownerAccountId)?.displayName?.trim() || access.ownerAccountId : "";
      return [capsule.name, display?.ja, display?.en, owner].some((value) => value?.toLowerCase().includes(q));
    });
  }
  const summaries = browseSummaries ?? await readCapsuleAppSummaries(ctx, selected, Date.now(), searchConfigs);
  const byId = new Map(summaries.map((view) => [view.capsuleId, view]));
  const apps = liveAccesses.flatMap((access) => {
    const view = byId.get(access.capsuleId);
    return view ? [{ ...view, role: access.role,
      ownerDisplayName: owners.get(access.ownerAccountId)?.displayName?.trim() || access.ownerAccountId }] : [];
  });
  return json({
    apps: apps.filter((entry) => entry !== undefined),
    ...(rawQuery !== null ? { appliedQuery: q } : {}),
    ...(page.nextCursor ? { nextCursor: writeAppCursor(page.nextCursor, binding) } : {}),
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
    return json({ accepted: true }, 202, { "cache-control": "no-store" });
  }
  if (account.subject === access.ownerAccountId) {
    return errorJson("invalid_request", "The app owner cannot be added as a member.", 400, ctx.request);
  }
  try {
    await port.addMember({
      capsuleId,
      actorAccountId: ctx.session.subject,
      accountId: account.subject,
      expectedOwnershipEpoch: access.ownershipEpoch,
      consent: "connections_and_code",
    });
    return json({ accepted: true }, 202, { "cache-control": "no-store" });
  } catch (error) {
    return mutationError(error, ctx.request);
  }
}

function pendingState(ctx: ControlDispatchContext): Response | undefined {
  const state = ctx.url.searchParams.get("state");
  return state === null || state === "pending" ? undefined
    : errorJson("invalid_request", "state must be pending.", 400, ctx.request);
}

async function listCapsuleTransfers(ctx: ControlDispatchContext, capsuleId: string): Promise<Response> {
  const port = ownershipPort(ctx);
  if (!port || !appPort(ctx)) return controlPlaneUnavailable();
  const invalid = pendingState(ctx);
  if (invalid) return invalid;
  if (!await capsuleWithinBearerScope(ctx, capsuleId)) return denied(ctx.request);
  const access = await accessTo(ctx, capsuleId);
  const transfers = await port.listTransfers({ capsuleId, state: "pending" });
  const visible = transfers.filter((transfer) => transfer.capsuleId === capsuleId &&
    transfer.state === "pending" && (transfer.toAccountId === ctx.session.subject ||
      (access?.role === "owner" && transfer.fromAccountId === access.ownerAccountId)));
  if (access?.role !== "owner" && visible.length === 0) return denied(ctx.request);
  return json({ ownershipTransfers: await pendingTransferViews(ctx, visible) }, 200, { "cache-control": "no-store" });
}

/** Recipient preview contains names only; no Capsule source, output or credentials. */
async function pendingTransferViews(
  ctx: ControlDispatchContext,
  transfers: readonly AppOwnershipTransferRecord[],
) {
  const capsules = await ctx.operations.capsules.getCapsulesByIds([...new Set(transfers.map((row) => row.capsuleId))]);
  const byId = new Map(capsules.map((capsule) => [capsule.id, capsule]));
  return await Promise.all(transfers.map(async (transfer) => {
    const capsule = byId.get(transfer.capsuleId);
    const [sender, appView] = await Promise.all([
      ctx.store.findAccount(transfer.fromAccountId as TakosumiSubject),
      capsule ? readCapsuleAppView(ctx, capsule, Date.now()) : undefined,
    ]);
    return {
      ...transfer,
      appDisplayName: appView?.displayName || capsule?.name || transfer.capsuleId,
      senderDisplayName: sender?.displayName?.trim() || transfer.fromAccountId,
    };
  }));
}

async function listIncomingTransfers(ctx: ControlDispatchContext): Promise<Response> {
  const port = ownershipPort(ctx);
  if (!port) return controlPlaneUnavailable();
  const invalid = pendingState(ctx);
  if (invalid) return invalid;
  const transfers = await port.listTransfers({ toAccountId: ctx.session.subject, state: "pending" });
  const visible = await Promise.all(transfers.map(async (transfer) =>
    transfer.toAccountId === ctx.session.subject && transfer.state === "pending" &&
      await capsuleWithinBearerScope(ctx, transfer.capsuleId) ? transfer : undefined));
  return json({ ownershipTransfers: await pendingTransferViews(ctx, visible.filter((transfer) => transfer !== undefined)) }, 200, {
    "cache-control": "no-store",
  });
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

/**
 * Member add/remove/leave and transfer create/accept/cancel: the writers the
 * operator kill switch stops. Reads stay available.
 */
function isAppOwnershipMutation(segments: readonly string[], method: string): boolean {
  const verb = method.toUpperCase();
  if (segments[0] === "capsules" && segments[2] === "members") {
    return (segments.length === 3 && verb === "POST") || (segments.length === 4 && verb === "DELETE");
  }
  if (segments[0] === "capsules" && segments[2] === "ownership-transfers") return segments.length === 3 && verb === "POST";
  if (segments[0] !== "ownership-transfers") return false;
  return (segments.length === 3 && segments[2] === "accept" && verb === "POST") || (segments.length === 2 && verb === "DELETE");
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
  const isCapsuleTransfers = segments[0] === "capsules" && segments[2] === "ownership-transfers" && segments.length === 3;
  const isIncomingTransfers = segments[0] === "ownership-transfers" && segments.length === 1;
  const isTransfer = segments[0] === "ownership-transfers" && segments.length >= 2 && segments.length <= 3;
  if (!isApps && !isMembers && !isCapsuleTransfers && !isIncomingTransfers && !isTransfer) return undefined;
  const scoped = accountSessionOnly(ctx);
  if (scoped) return scoped;
  if (isApps) return method === "GET" ? listApps(ctx) : methodNotAllowed("GET");
  const credential = accountManagementCredential(ctx);
  if (credential) return credential;
  if (ctx.appOwnershipMutationsFrozen && isAppOwnershipMutation(segments, method)) {
    return appOwnershipMutationsFrozenResponse(ctx.request);
  }
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
  if (isCapsuleTransfers) {
    const capsuleId = accountId(segments[1]);
    if (!capsuleId) return errorJson("invalid_request", "Invalid capsule ID.", 400, ctx.request);
    if (method === "POST") return createTransfer(ctx, capsuleId);
    if (method === "GET") return listCapsuleTransfers(ctx, capsuleId);
    return methodNotAllowed("GET, POST");
  }
  if (isIncomingTransfers) return method === "GET" ? listIncomingTransfers(ctx) : methodNotAllowed("GET");
  const transferId = accountId(segments[1]);
  if (!transferId) return errorJson("invalid_request", "Invalid transfer ID.", 400, ctx.request);
  if (segments.length === 3 && segments[2] === "accept") {
    return method === "POST" ? changeTransfer(ctx, transferId, true) : methodNotAllowed("POST");
  }
  if (segments.length === 2) return method === "DELETE" ? changeTransfer(ctx, transferId, false) : methodNotAllowed("DELETE");
  return undefined;
}
