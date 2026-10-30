/**
 * Workspace-free replacement reads on shared resource roots (TASK-0118
 * Phase 9.1). Each handler claims only its new query shape and returns
 * `undefined` for everything else, so the existing resource handler keeps
 * serving its legacy (Workspace-addressed) form unchanged:
 *
 * - `GET /api/v1/install-plans?open=1` — the caller's own open install
 *   attempts, in every internal namespace.
 * - `GET /api/v1/sources?capsuleId=` — the app's Source.
 * - `GET /api/v1/capsule-configs?capsuleId=` — the app's current InstallConfig.
 * - `GET /api/v1/provider-connections` — the caller's own Provider
 *   Connections plus release-owned bindable ones; `?capsuleId=&projection=
 *   release-owned` is the app-level release-owned projection.
 *
 * App-addressed forms use the ordinary per-app decision (`view`); account
 * forms require an account credential (a session or a PAT without a
 * Workspace or app restriction). None reads Workspace membership.
 */
import type { Capsule } from "takosumi-contract/install-configs";
import type { ProviderConnection } from "takosumi-contract/connections";
import type { Source } from "takosumi-contract/sources";
import { errorJson, json, stringValue } from "../http-helpers.ts";
import {
  requireAppAccess,
  requireResourceAccess,
  sourceCapsuleIds,
} from "./app-authorization.ts";
import { listOpenInstallAttempts } from "./install-plans.ts";
import { publicInstallConfig } from "./install-configs.ts";
import {
  controllerErrorCode,
  controlPlaneUnavailable,
  publicProviderConnection,
  type ControlDispatchContext,
} from "./shared.ts";

/** Owned-connection pages the account provider-connection list may read. */
const ACCOUNT_CONNECTION_PAGE_LIMIT = 10;

function accountCredentialRefusal(ctx: ControlDispatchContext, action: string): Response | undefined {
  return ctx.session.workspaceId !== undefined || ctx.session.appIds !== undefined
    ? errorJson("app_access_denied", `An account credential is required to ${action}.`, 403, ctx.request)
    : undefined;
}

function capsuleIdQuery(ctx: ControlDispatchContext):
  | { readonly present: false }
  | { readonly present: true; readonly capsuleId: string }
  | { readonly present: true; readonly response: Response } {
  const raw = ctx.url.searchParams.get("capsuleId");
  if (raw === null) return { present: false };
  const capsuleId = stringValue(raw);
  if (!capsuleId || capsuleId.length > 256 || ctx.url.searchParams.has("workspaceId")) {
    return {
      present: true,
      response: errorJson(
        "invalid_request",
        "capsuleId must be a non-empty app id and cannot be combined with workspaceId",
        400,
        ctx.request,
      ),
    };
  }
  return { present: true, capsuleId };
}

async function viewApp(
  ctx: ControlDispatchContext,
  capsuleId: string,
): Promise<{ readonly ok: true; readonly capsule: Capsule } | { readonly ok: false; readonly response: Response }> {
  const capsule = await ctx.operations.capsules.getCapsule(capsuleId);
  const decision = await requireAppAccess({
    operations: ctx.operations,
    store: ctx.store,
    session: ctx.session,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    capsule,
    action: "view",
    ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
    ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
  });
  return decision.ok ? { ok: true, capsule } : decision;
}

/** `GET /api/v1/install-plans?open=1`. */
export async function handleAccountInstallPlanList(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments.length !== 1 || segments[0] !== "install-plans" || method !== "GET") return undefined;
  const refused = accountCredentialRefusal(ctx, "list install attempts");
  if (refused) return refused;
  return await listOpenInstallAttempts(ctx, undefined);
}

/** `GET /api/v1/sources?capsuleId=`: the Source the app is built from. */
export async function handleAppSourceList(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments.length !== 1 || segments[0] !== "sources" || method !== "GET") return undefined;
  const query = capsuleIdQuery(ctx);
  if (!query.present) return undefined;
  if ("response" in query) return query.response;
  const viewed = await viewApp(ctx, query.capsuleId);
  if (!viewed.ok) return viewed.response;
  const { capsule } = viewed;
  let source: Source | undefined;
  if (capsule.sourceId) {
    try {
      source = (await ctx.operations.getSource(capsule.sourceId)).source;
    } catch (error) {
      if (controllerErrorCode(error) !== "not_found") throw error;
    }
  }
  const sources: Source[] = [];
  if (source && source.id === capsule.sourceId &&
    (source.ownerCapsuleId === undefined || source.ownerCapsuleId === capsule.id)) {
    if (source.ownerCapsuleId === undefined) {
      // A pre-claim Source shared by several apps describes all of them: the
      // caller must be able to view every app built from it.
      const decision = await requireResourceAccess({
        operations: ctx.operations,
        store: ctx.store,
        session: ctx.session,
        workspaceId: source.workspaceId ?? capsule.workspaceId,
        capsuleIds: [...new Set([capsule.id, ...(await sourceCapsuleIds(ctx.operations, source))])],
        action: "view",
        ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
        ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
      });
      if (decision.ok) sources.push(source);
    } else {
      sources.push(source);
    }
  }
  return json({ sources }, 200, { "cache-control": "no-store" });
}

/** `GET /api/v1/capsule-configs?capsuleId=`: the app's current InstallConfig. */
export async function handleAppInstallConfigList(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments.length !== 1 || segments[0] !== "capsule-configs" || method !== "GET") return undefined;
  const query = capsuleIdQuery(ctx);
  if (!query.present) return undefined;
  if ("response" in query) return query.response;
  const viewed = await viewApp(ctx, query.capsuleId);
  if (!viewed.ok) return viewed.response;
  const { capsule } = viewed;
  const installConfigs = [];
  if (capsule.installConfigId) {
    try {
      installConfigs.push(publicInstallConfig(await ctx.operations.capsules.getInstallConfig(capsule.installConfigId)));
    } catch (error) {
      if (controllerErrorCode(error) !== "not_found") throw error;
    }
  }
  return json({ installConfigs }, 200, { "cache-control": "no-store" });
}

async function releaseOwnedBindable(
  ctx: ControlDispatchContext,
  partition?: string,
): Promise<readonly ProviderConnection[]> {
  const connections = ctx.operations.connections;
  if (typeof connections.listReleaseOwnedBindableProviderConnections === "function") {
    return await connections.listReleaseOwnedBindableProviderConnections.call(connections);
  }
  // Older hosts answer only for a partition; the projection is release config.
  return partition ? await connections.listReleaseOwnedProviderConnections(partition) : [];
}

function isSourceGitConnection(connection: ProviderConnection): boolean {
  return connection.kind === "source_git_https_token" || connection.kind === "source_git_ssh_key";
}

async function ownProviderConnections(
  ctx: ControlDispatchContext,
): Promise<readonly ProviderConnection[] | undefined> {
  const owner = ctx.session.subject;
  const rows: ProviderConnection[] = [];
  const reader = ctx.operations.accountResources;
  if (reader) {
    let cursor: string | undefined;
    for (let page = 0; page < ACCOUNT_CONNECTION_PAGE_LIMIT; page++) {
      let result;
      try {
        result = await reader.listConnections(owner, { limit: 100, ...(cursor ? { cursor } : {}) });
      } catch (error) {
        if (error instanceof Error &&
          /(?:no such column.*owner_account_id|column .*owner_account_id.*does not exist)/iu.test(error.message)) {
          return undefined;
        }
        throw error;
      }
      rows.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  } else {
    const owned = await ctx.operations.connections.listOwnedConnections?.(owner);
    if (owned === undefined) return undefined;
    rows.push(...owned);
  }
  return rows.filter((connection) =>
    connection.scope !== "operator" && connection.ownerAccountId === owner && !isSourceGitConnection(connection)
  );
}

/**
 * `GET /api/v1/provider-connections` without `workspaceId`: the account list
 * (own connections plus release-owned bindable ones), or with
 * `capsuleId=&projection=release-owned` the app-level release-owned list.
 */
export async function handleAccountProviderConnections(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments.length !== 1 || segments[0] !== "provider-connections" || method !== "GET") return undefined;
  if (ctx.url.searchParams.has("workspaceId")) return undefined;
  const projection = ctx.url.searchParams.get("projection");
  if (projection !== null && projection !== "release-owned") {
    return errorJson("invalid_request", "projection must be release-owned when provided", 400, ctx.request);
  }
  const query = capsuleIdQuery(ctx);
  if (query.present) {
    if ("response" in query) return query.response;
    if (projection !== "release-owned") {
      return errorJson(
        "invalid_request",
        "An app list requires projection=release-owned; use GET /api/v1/connections?capsuleId=&projection=labels for the app's connection choices.",
        400,
        ctx.request,
      );
    }
    const viewed = await viewApp(ctx, query.capsuleId);
    if (!viewed.ok) return viewed.response;
    const providerConnections = await releaseOwnedBindable(ctx, viewed.capsule.workspaceId);
    return json({ providerConnections: providerConnections.map(publicProviderConnection) }, 200, {
      "cache-control": "no-store",
    });
  }
  const refused = accountCredentialRefusal(ctx, "list provider connections");
  if (refused) return refused;
  const releaseOwned = await releaseOwnedBindable(ctx);
  if (projection === "release-owned") {
    return json({ providerConnections: releaseOwned.map(publicProviderConnection) }, 200, {
      "cache-control": "no-store",
    });
  }
  const own = await ownProviderConnections(ctx);
  if (own === undefined) return controlPlaneUnavailable();
  const merged = new Map<string, ProviderConnection>();
  for (const connection of own) merged.set(connection.id, connection);
  for (const connection of releaseOwned) merged.set(connection.id, connection);
  return json({
    providerConnections: [...merged.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(publicProviderConnection),
  }, 200, { "cache-control": "no-store" });
}
