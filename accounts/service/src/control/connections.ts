/**
 * Session-authed Provider Connection (`/api/v1/connections`) control routes: list /
 * create / item test+revoke / provider-owned OAuth start+callback.
 * `completeConnectionOAuth` is exported because `handleControlRoute` invokes the
 * cross-site OAuth callback before the session gate. Extracted from
 * `control-routes.ts` (P3 god-file split).
 */
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  ConnectionScopeHints,
  CreateApplyRunRequest,
  CreateConnectionFile,
  CreateConnectionRequest,
  DeployControlErrorCode,
  ListConnectionsResponse,
  ListRunnerProfilesResponse,
  OpenTofuModuleSource,
  PlanRunResponse,
  PublicPlanRun,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  Source,
  CreateSourceRequest,
  CreateSourceResponse,
  ListSourceSnapshotsResponse,
  ListSourcesResponse,
  PatchSourceRequest,
  SourceResponse,
  SourceSnapshot,
} from "takosumi-contract/sources";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListCredentialRecipesResponse } from "takosumi-contract/credential-recipes";
import type { Workspace, WorkspaceType } from "takosumi-contract/workspaces";
import type {
  InstallConfig,
  Capsule,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicCapsule,
} from "takosumi-contract/install-configs";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  ProviderBinding,
  ProviderBindings,
  ProviderBindingSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import { isWorkspaceBindableOperatorConnection } from "takosumi-contract/connections";
import { bearerAppAllows } from "../account-session.ts";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type {
  BackupRecord,
  CreateBackupResponse,
  CreateRestoreRequest,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  ListRunsResponse,
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  PublicRun,
} from "takosumi-contract/runs";
import type { JsonValue } from "takosumi-contract";
import type { AccountsStore } from "../store.ts";
import type {
  ControlPlaneOperations,
  RunGroupWithRunsLike,
  ControlWorkspaceRole,
  ControlMembershipStatus,
  PublicWorkspaceMember,
  MembershipActor,
} from "../control-operations.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
  readOptionalJsonObject,
  stringValue,
} from "../http-helpers.ts";
import {
  type ControlDispatchContext,
  type ControlSession,
  canAccessWorkspace,
  controlPlaneUnavailable,
  controllerErrorCode,
  controllerErrorResponse,
  isRecord,
  jsonStatus,
  parseControlPageParams,
  publicApplyActionResponse,
  publicCompatibilityReportResponse,
  publicCapsule,
  publicProviderConnection,
  publicPlanActionResponse,
  publicRun,
  requireWorkspaceAccess,
  resolveProviderBindings,
} from "./shared.ts";
import {
  booleanValue,
  connectionCredentialFiles,
  connectionScopeHints,
  isJsonValue,
  isPlainJsonObject,
  jsonRecordValue,
  modulePathValue,
  outputAllowlistValue,
  parseProviderBinding,
  parseProviderBindings,
  parseLimit,
  workspaceTypeValue,
  stringRecord,
  stringRecordValue,
} from "./parse.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/default_install_config.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { base64UrlEncodeBytes } from "../encoding.ts";
import {
  assertWorkspaceManagementAuthorityInput,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";

export async function handleConnections(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/connections?workspaceId=  (GET list / POST create)
  if (segments.length === 1 && segments[0] === "connections") {
    if (method === "GET") {
      return await listControlConnections(operations, store, ctx.session, url);
    }
    if (method === "POST") {
      return await createControlConnection(
        request,
        operations,
        store,
        ctx.session,
      );
    }
    return methodNotAllowed("GET, POST");
  }

  // /api/v1/connections/:id/test ; /api/v1/connections/:id/revoke
  // (the item surface consolidated from the former /v1/connections edge). The
  // oauth/:helperId subroutes are `segments.length === 4` (handled below), so
  // a 3-segment connections path is always one of these two item ops.
  if (
    segments.length === 3 &&
    segments[0] === "connections" &&
    (segments[2] === "test" || segments[2] === "revoke")
  ) {
    if (method !== "POST") return methodNotAllowed("POST");
    const connectionId = decodeURIComponent(segments[1] ?? "");
    return await connectionItemOp(
      operations,
      store,
      ctx.session,
      connectionId,
      segments[2],
    );
  }

  // /api/v1/connections/oauth/:helperId/start — credential OAuth helper
  // (present only when the operator wired the upstream client). The cookie-
  // authenticated `start` embeds the authenticated subject into the signed
  // OAuth state. The matching `callback` is handled BEFORE the session gate in
  // `handleControlRoute` (cross-site redirect, no strict cookie), so it never
  // reaches this dispatcher.
  if (
    segments[0] === "connections" &&
    segments[1] === "oauth" &&
    segments.length === 4
  ) {
    if (segments[3] === "start") {
      if (method !== "POST") return methodNotAllowed("POST");
      return await startConnectionOAuth(
        request,
        operations,
        store,
        ctx.session,
        url,
        decodeURIComponent(segments[2] ?? ""),
      );
    }
  }
  return undefined;
}

async function listControlConnections(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  url: URL,
): Promise<Response> {
  const capsuleId = stringValue(url.searchParams.get("capsuleId") ?? undefined);
  if (url.searchParams.get("projection") === "labels") {
    if (!capsuleId || url.searchParams.has("workspaceId")) return errorJson("invalid_request", "capsuleId is required", 400);
    return await listAppConnectionLabels(operations, session, capsuleId, url);
  }
  const workspaceId = stringValue(
    url.searchParams.get("workspaceId") ?? undefined,
  );
  if (!workspaceId) {
    if (session.workspaceId !== undefined || session.appIds !== undefined) return errorJson("app_access_denied", "An account credential is required.", 403);
    const page = parseControlPageParams(url);
    if (!page.ok) return page.response;
    const connections = new Map<string, ProviderConnection>();
    let personalNextCursor: string | undefined;
    if (operations.accountResources) {
      let result;
      try {
        result = await operations.accountResources.listConnections(session.subject, page.params);
      } catch (error) {
        if (error instanceof Error && /(?:no such column.*owner_account_id|column .*owner_account_id.*does not exist)/iu.test(error.message)) return controlPlaneUnavailable();
        throw error;
      }
      for (const connection of result.items) connections.set(connection.id, connection);
      personalNextCursor = result.nextCursor;
    } else {
      for (const workspace of await operations.workspaces.listWorkspacesByOwner(session.subject)) {
        if (workspace.ownerUserId !== session.subject || workspace.archivedAt) continue;
        for (const connection of await operations.connections.listProviderConnections(workspace.id)) {
          if ((connection.scope === "workspace" || connection.scope === "personal") &&
            connection.workspaceId === workspace.id &&
            (connection.ownerAccountId === undefined || connection.ownerAccountId === session.subject)) connections.set(connection.id, connection);
        }
      }
    }
    const operatorConnections = [
      ...(await operations.listOperatorConnections()).connections,
      ...await operations.connections.listReleaseOwnedProviderConnections(),
    ];
    for (const connection of operatorConnections) {
      if (isWorkspaceBindableOperatorConnection(connection)) connections.set(connection.id, connection);
    }
    const result = pageSorted([...connections.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)), page.params);
    const nextCursor = result.nextCursor ?? personalNextCursor;
    return json({ connections: result.items.map(publicProviderConnection), ...(nextCursor ? { nextCursor } : {}) });
  }
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId,
    session,
  });
  if (!auth.ok) return auth.response;
  if (session.appIds !== undefined || (await operations.workspaces.getWorkspace(workspaceId)).ownerUserId !== session.subject) {
    return errorJson("app_owner_only", "Only the connection owner can list personal connections.", 403);
  }
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const response = await operations.listConnections(workspaceId, page.params);
  return json({
    ...response,
    connections: response.connections.map(publicProviderConnection),
  });
}

async function listAppConnectionLabels(
  operations: ControlPlaneOperations,
  session: ControlSession,
  capsuleId: string,
  url: URL,
): Promise<Response> {
  const params = parseControlPageParams(url);
  if (!params.ok) return params.response;
  if (!bearerAppAllows(session, capsuleId)) return errorJson("app_access_denied", "App access is required.", 403);
  const access = await operations.appAccess?.resolveAppAccess(session.subject, capsuleId);
  if (!access || access.capsuleId !== capsuleId) return errorJson("app_access_denied", "App access is required.", 403);
  if (session.workspaceId) {
    const capsule = await operations.capsules.getCapsule(capsuleId);
    if (capsule.workspaceId !== session.workspaceId) return errorJson("app_access_denied", "App access is required.", 403);
  }
  const owner = access.ownerAccountId;
  const connections = new Map<string, ProviderConnection>();
  if (operations.accountResources) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      if (seen.size >= 100) return controlPlaneUnavailable();
      const page = await operations.accountResources.listConnections(owner, { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const connection of page.items) {
        if ((connection.scope === "personal" || connection.scope === "workspace") && connection.ownerAccountId === owner && connection.status === "verified") connections.set(connection.id, connection);
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) return controlPlaneUnavailable();
      if (cursor) seen.add(cursor);
    } while (cursor);
  } else {
    for (const workspace of await operations.workspaces.listWorkspacesByOwner(owner)) {
      if (workspace.ownerUserId !== owner || workspace.archivedAt) continue;
      for (const connection of await operations.connections.listProviderConnections(workspace.id)) {
        if ((connection.scope === "personal" || connection.scope === "workspace") && connection.ownerAccountId === owner && connection.status === "verified") connections.set(connection.id, connection);
      }
    }
  }
  const operatorConnections = [
    ...(await operations.listOperatorConnections()).connections,
    ...await operations.connections.listReleaseOwnedProviderConnections(),
  ];
  for (const connection of operatorConnections) {
    if (isWorkspaceBindableOperatorConnection(connection)) connections.set(connection.id, connection);
  }
  const current = await operations.appAccess?.resolveAppAccess(session.subject, capsuleId);
  if (!current || current.ownerAccountId !== owner || current.ownershipEpoch !== access.ownershipEpoch || current.role !== access.role ||
    !(await (session.reauthorizeBearer?.() ?? Promise.resolve(true)))) {
    return errorJson("app_access_denied", "App access is required.", 403);
  }
  const page = pageSorted([...connections.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), params.params);
  return json({ connections: page.items.map((connection) => ({
    id: connection.id,
    provider: connection.provider,
    ...(connection.displayName ? { displayName: connection.displayName } : {}),
  })), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }, 200, { "cache-control": "no-store" });
}

/**
 * Registers a Workspace-owned provider/source helper Connection from the dashboard
 * session. This is the credential-helper write path
 * the §31 connections screen calls same-origin: the guided-token paste and the
 * raw-token "詳細設定" fallback both POST here.
 *
 * Invariants enforced here (independent of any client coercion):
 *   - the session subject must own the target Workspace (Workspace permission gate);
 *   - the created Connection is ALWAYS `scope: "workspace"`; operator/global
 *     internal resolver records stay on the bearer-gated §30 surface, so we force
 *     `scope` server-side;
 *   - the secret `values` are write-only: they are forwarded to the controller
 *     and NEVER read, logged, or echoed; generic-env `files` are also forwarded
 *     write-only and never echoed; the response is the public
 *     {@link Connection} projection, which has no `values` field.
 */
async function createControlConnection(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const personal = body.workspaceId === undefined;
  if (session.appIds !== undefined || (personal && session.workspaceId !== undefined)) {
    return errorJson("app_access_denied", "An account credential is required.", 403);
  }
  const workspaceId = stringValue(body.workspaceId);
  if (!personal && !workspaceId) {
    return errorJson("invalid_request", "workspaceId is required", 400);
  }
  // Capture the exact Workspace-management tuple before authorization and the
  // remaining asynchronous preparation. Keep capture refusal private until the
  // existing Workspace access gate has produced its normal response.
  const captured = await (async () => {
    if (personal) return { ok: true as const, authority: undefined };
    try {
      return {
        ok: true as const,
        authority: await operations.workspaces.captureManagementAuthority(
          workspaceId!,
        ),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  const managementAuthority = (): WorkspaceManagementAuthority | undefined => {
    if (!captured.ok) throw captured.error;
    return captured.authority;
  };
  if (!personal) {
    const auth = await requireWorkspaceAccess({ operations, store, workspaceId: workspaceId!, session });
    if (!auth.ok) return auth.response;
    if ((await operations.workspaces.getWorkspace(workspaceId!)).ownerUserId !== session.subject) {
      return errorJson("app_owner_only", "Only the connection owner can create personal connections.", 403);
    }
  }
  const requestedKind = stringValue(body.kind);
  const sourceGitKind =
    requestedKind === "source_git_https_token" ||
    requestedKind === "source_git_ssh_key"
      ? requestedKind
      : undefined;
  const requestedRecipe = isRecord(body.credentialRecipe)
    ? {
        id: stringValue(body.credentialRecipe.id),
        authMode: stringValue(body.credentialRecipe.authMode),
        secretPartition: stringValue(body.credentialRecipe.secretPartition),
      }
    : undefined;
  if (
    requestedRecipe &&
    (!requestedRecipe.id ||
      !requestedRecipe.authMode ||
      !requestedRecipe.secretPartition)
  ) {
    return errorJson(
      "invalid_request",
      "credentialRecipe.id, credentialRecipe.authMode, and credentialRecipe.secretPartition are required",
      400,
    );
  }
  const provider = sourceGitKind ? sourceGitKind : stringValue(body.provider);
  if (!provider) {
    return errorJson("invalid_request", "provider is required", 400);
  }
  if (!sourceGitKind && !requestedRecipe) {
    return errorJson(
      "invalid_request",
      "credentialRecipe is required for Provider Connections",
      400,
    );
  }
  const values = stringRecord(body.values);
  const filesResult = connectionCredentialFiles(body.files);
  if (!filesResult.ok) {
    return errorJson("invalid_request", filesResult.message, 400);
  }
  const files = filesResult.files;
  const valueCount = values ? Object.keys(values).length : 0;
  if (valueCount === 0 && files.length === 0) {
    return errorJson("invalid_request", "values or files is required", 400);
  }
  if (sourceGitKind && !stringValue(values?.GIT_HTTPS_TOKEN)) {
    if (
      sourceGitKind === "source_git_https_token" ||
      !stringValue(values?.GIT_SSH_PRIVATE_KEY)
    ) {
      return errorJson(
        "invalid_request",
        sourceGitKind === "source_git_https_token"
          ? "values.GIT_HTTPS_TOKEN is required"
          : "values.GIT_SSH_PRIVATE_KEY is required",
        400,
      );
    }
  }
  const scopeHints = connectionScopeHints(body.scopeHints);
  const createRequest: CreateConnectionRequest = {
    ...(workspaceId ? { workspaceId } : {}),
    provider,
    ...(sourceGitKind ? { kind: sourceGitKind } : {}),
    ...(!sourceGitKind
      ? {
          credentialRecipe: {
            id: requestedRecipe!.id!,
            authMode: requestedRecipe!.authMode!,
            secretPartition: requestedRecipe!.secretPartition!,
          },
        }
      : {}),
    // Force Workspace scope: the dashboard session surface never mints an operator
    // default. Any caller-supplied `scope` is ignored.
    scope: personal ? "personal" : "workspace",
    ownerAccountId: session.subject,
    ...(stringValue(body.displayName)
      ? { displayName: stringValue(body.displayName) }
      : {}),
    ...(scopeHints ? { scopeHints } : {}),
    values: values ?? {},
    ...(files.length > 0 ? { files } : {}),
  };
  const response = await operations.createConnection(
    createRequest,
    managementAuthority(),
    session.subject,
  );
  // `response.connection` is the public projection (no secret values).
  return jsonStatus(
    {
      ...response,
      connection: publicProviderConnection(response.connection),
    },
    201,
  );
}

/**
 * Connection item op (test / revoke) from the dashboard session
 * (`POST /api/v1/connections/:id/{test,revoke}`). This is the consolidated
 * surface that replaced the former account-plane `/v1/connections/:id` edge.
 *
 * The request only names the connection id, so Workspace ownership is enforced by
 * first reading the Connection (a non-secret projection — the public Connection
 * type carries no values) to learn its `workspaceId`, then checking the session
 * subject owns that Workspace. To prevent cross-tenant probing of connection ids, a
 * missing connection, an absent `workspaceId`, and a Workspace-ownership failure all
 * answer a non-disclosing `connection_not_found` (404).
 */
async function connectionItemOp(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  connectionId: string,
  op: "test" | "revoke",
): Promise<Response> {
  if (!connectionId) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  // Resolve the Connection's owning Workspace for the ownership gate. A missing
  // connection (typed `not_found`) is mapped to the same non-disclosing 404.
  const target = await resolveConnectionItemTarget(
    operations,
    session,
    connectionId,
  );
  if (!target) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  const { connection, rawConnectionId } = target;
  if (session.appIds !== undefined || (connection.ownerAccountId !== undefined && connection.ownerAccountId !== session.subject)) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  const workspaceId = connection.workspaceId;
  if (!workspaceId) {
    if (connection.scope === "personal" && connection.ownerAccountId === session.subject && session.workspaceId === undefined) {
      if (op === "test") return json(await operations.testConnection(rawConnectionId, undefined, session.subject));
      await operations.revokeConnection(rawConnectionId, undefined, session.subject);
      return new Response(null, { status: 204 });
    }
    return errorJson("connection_not_found", "connection not found", 404);
  }
  // Capture the exact Workspace-management tuple before authorization and keep
  // any refusal private until the existing non-disclosing ownership gate has
  // completed. Authorized callers then pass this unchanged into the Vault CAS.
  const captured = await (async () => {
    try {
      return {
        ok: true as const,
        authority: await operations.workspaces.captureManagementAuthority(
          workspaceId,
        ),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  const managementAuthority = (): WorkspaceManagementAuthority => {
    if (!captured.ok) throw captured.error;
    return captured.authority;
  };
  // Both test (re-verify) and revoke (delete the sealed blob) are write-scoped
  // mutations; the ownership failure must not disclose the connection's
  // existence, so a 403 from the gate is surfaced as a 404 here.
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId,
    session,
  });
  if (!auth.ok) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  if ((await operations.workspaces.getWorkspace(workspaceId)).ownerUserId !== session.subject) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  if (op === "test") {
    return json(
      await operations.testConnection(
        rawConnectionId,
        managementAuthority(),
        session.subject,
      ),
    );
  }
  await operations.revokeConnection(
    rawConnectionId,
    managementAuthority(),
    session.subject,
  );
  return new Response(null, { status: 204 });
}

async function resolveConnectionItemTarget(
  operations: ControlPlaneOperations,
  session: ControlSession,
  connectionId: string,
): Promise<
  | {
      readonly connection: ProviderConnection;
      readonly rawConnectionId: string;
    }
  | undefined
> {
  void session;
  try {
    return {
      connection: await operations.getConnection(connectionId),
      rawConnectionId: connectionId,
    };
  } catch (error) {
    if (controllerErrorCode(error) !== "not_found") throw error;
    return undefined;
  }
}

/**
 * Begins an optional provider-owned credential OAuth helper flow. Returns the
 * provider authorize URL the dashboard sends the user to. When the operator has
 * NOT wired the upstream OAuth client, the helper is absent and we return a
 * typed `feature_unavailable` (501) so the dashboard hides the OAuth button and
 * keeps the guided-token path; the dashboard never renders a dead OAuth button.
 */
async function startConnectionOAuth(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  url: URL,
  helperId: string,
): Promise<Response> {
  if (session.appIds !== undefined) return errorJson("app_access_denied", "An account credential is required.", 403);
  const helper = operations.connectionOAuth?.[helperId];
  if (!helper) return connectionOAuthUnavailable();
  const body = (await readJsonObject(request)) ?? {};
  const workspaceId =
    stringValue(body.workspaceId) ??
    stringValue(url.searchParams.get("workspaceId") ?? undefined);
  const personal = !workspaceId;
  if (personal && session.workspaceId !== undefined) return errorJson("app_access_denied", "An account credential is required.", 403);
  // Capture the exact Workspace-management tuple before authorization and the
  // provider-owned OAuth awaits. Keep refusal private until the existing
  // Workspace access gate has produced its normal response.
  const captured = await (async () => {
    if (personal) return { ok: true as const, authority: undefined };
    try {
      return {
        ok: true as const,
        authority: await operations.workspaces.captureManagementAuthority(
          workspaceId,
        ),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  const managementAuthority = (): WorkspaceManagementAuthority | undefined => {
    if (!captured.ok) throw captured.error;
    return captured.authority;
  };
  if (!personal) {
    const auth = await requireWorkspaceAccess({ operations, store, workspaceId: workspaceId!, session });
    if (!auth.ok) return auth.response;
    if ((await operations.workspaces.getWorkspace(workspaceId!)).ownerUserId !== session.subject) return errorJson("app_owner_only", "Only the connection owner can authorize this connection.", 403);
  }
  const started = await helper.start({
    // Bind the OAuth state to the authenticated subject so the cross-site
    // callback can authorize without depending on a session cookie.
    subject: session.subject,
    ...(workspaceId ? { workspaceId } : {}),
    scope: personal ? "personal" : "workspace",
    ownerAccountId: session.subject,
    ...(connectionScopeHints(body.scopeHints) ? { scopeHints: connectionScopeHints(body.scopeHints) } : {}),
    ...(stringValue(body.displayName)
      ? { displayName: stringValue(body.displayName) }
      : {}),
    ...(personal ? {} : { expectedWorkspaceManagementAuthority: managementAuthority() }),
  });
  const response = json(started);
  if (helper.browserBindingRequired) {
    const flow = (await stableJsonDigest(started.state)).slice(7);
    response.headers.append("set-cookie", `${url.protocol === "https:" ? "__Host-" : ""}takosumi_oauth_${flow}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${url.protocol === "https:" ? "; Secure" : ""}`);
  }
  response.headers.set("cache-control", "no-store");
  return response;
}

/**
 * Completes a provider-owned OAuth helper flow. This is the BACKEND callback the
 * upstream redirects to via a top-level CROSS-SITE redirect. The browser sends
 * no Authorization header, and cookie policy can withhold the session cookie.
 * This handler therefore does NOT call `requireAccountSession`; it authorizes
 * from the authenticated subject that the cookie-gated `start` signed INTO the
 * HMAC OAuth state. It exchanges the code, registers the resulting
 * Workspace-owned `generic_env_provider` Connection, and then REDIRECTS the
 * browser back to the dashboard `/connections` screen with a result query
 * (never a JSON body, never the token). No new SPA route is introduced — the
 * dashboard owns `/connections` already and reads the `connected` /
 * `connection_error` query.
 *
 * Called directly by {@link handleControlRoute} BEFORE the session gate (it is
 * the one cross-site control route); it is never reached through `dispatch`.
 */
export async function completeConnectionOAuth(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  url: URL,
  helperId: string,
  request?: Request,
): Promise<Response> {
  const helper = operations.connectionOAuth?.[helperId];
  if (!helper) return connectionOAuthUnavailable();
  const code = stringValue(url.searchParams.get("code") ?? undefined);
  const state = stringValue(url.searchParams.get("state") ?? undefined);
  if (!code || !state) {
    return redirectToConnections(url, { error: "missing_code" });
  }
  if (helper.browserBindingRequired) {
    const name = `${url.protocol === "https:" ? "__Host-" : ""}takosumi_oauth_${(await stableJsonDigest(state)).slice(7)}`;
    const cookie = request?.headers.get("cookie") ?? "";
    if (!cookie.split(";").some((item) => item.trim() === `${name}=1`)) {
      return redirectToConnections(url, { error: "oauth_failed" });
    }
  }
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  let completed: {
    readonly request: CreateConnectionRequest;
    readonly subject?: string;
    readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
  };
  try {
    completed = await helper.complete({ code, state, query });
  } catch {
    // Do not surface upstream/state failure detail in the redirect query. This
    // also covers a bad HMAC signature on the state (forged/stolen callback).
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  const createRequest = completed.request;
  const workspaceId = createRequest.workspaceId;
  // The subject is the account that initiated `start` (signed into the state).
  // Its absence means an unsigned/legacy state we will not trust for a mint.
  const subject = completed.subject;
  if (!subject) {
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  if (!workspaceId) {
    if (createRequest.scope !== "personal" || createRequest.ownerAccountId !== subject) {
      return redirectToConnections(url, { error: "oauth_failed" });
    }
    if (!await store.findAccount(subject as TakosumiSubject)) {
      return redirectToConnections(url, { error: "forbidden" });
    }
    try {
      const created = await operations.createConnection({ ...createRequest, scope: "personal", ownerAccountId: subject }, undefined, subject);
      let connectionStatus: TestConnectionResponse["status"] | undefined;
      try {
        connectionStatus = (await operations.testConnection(created.connection.id, undefined, subject)).status;
      } catch {
        connectionStatus = "pending";
      }
      return redirectToConnections(url, { connected: subject, connectionId: created.connection.id, connectionStatus });
    } catch {
      return redirectToConnections(url, { error: "oauth_failed" });
    }
  }
  // Re-check Workspace ownership against the SIGNED state's subject + workspaceId so a
  // stolen or forged callback cannot mint a Connection into a Workspace the
  // authenticated initiator does not own. This is the callback's only authz —
  // there is no session cookie on a cross-site redirect.
  // No bearer credential reaches this cross-site callback, so the state's
  // subject carries no Workspace restriction of its own.
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId,
    session: { subject, requiredAccess: "write" },
  });
  if (!auth.ok) return redirectToConnections(url, { error: "forbidden" });
  if ((await operations.workspaces.getWorkspace(workspaceId)).ownerUserId !== subject) return redirectToConnections(url, { error: "forbidden" });
  const expectedWorkspaceManagementAuthority =
    completed.expectedWorkspaceManagementAuthority;
  if (!expectedWorkspaceManagementAuthority) {
    // Valid legacy states can still verify, but they did not capture the
    // original Workspace epoch and cannot mint a new Connection.
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  try {
    assertWorkspaceManagementAuthorityInput(
      expectedWorkspaceManagementAuthority,
      workspaceId,
    );
  } catch {
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  let created: ConnectionResponse;
  try {
    // Force Workspace scope regardless of what the helper produced.
    created = await operations.createConnection({
      ...createRequest,
      scope: "workspace",
    }, expectedWorkspaceManagementAuthority, subject);
  } catch {
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  let connectionStatus: TestConnectionResponse["status"] | undefined;
  try {
    const result = await operations.testConnection(
      created.connection.id,
      expectedWorkspaceManagementAuthority,
      subject,
    );
    connectionStatus = result.status;
  } catch {
    connectionStatus = "pending";
  }
  return redirectToConnections(url, {
    connected: workspaceId,
    connectionId: created.connection.id,
    connectionStatus,
  });
}

function connectionOAuthUnavailable(): Response {
  return errorJson(
    "feature_unavailable",
    "The requested credential OAuth helper is not installed on this deployment.",
    501,
  );
}

/**
 * Same-origin redirect back to the dashboard connections screen. Only opaque
 * status keys (`connected` / `connection_error`) and the public Connection id /
 * verification status ride the query — never the token or any error detail.
 */
async function redirectToConnections(
  url: URL,
  result: {
    readonly connected?: string;
    readonly error?: string;
    readonly connectionId?: string;
    readonly connectionStatus?: TestConnectionResponse["status"];
  },
): Promise<Response> {
  const state = url.searchParams.get("state");
  // Correlate only this tab's attempt, without exposing state, code or tokens.
  const flow = state ? await stableJsonDigest(state) : undefined;
  if (url.searchParams.get("popup") === "1" && flow) {
    const nonce = crypto.randomUUID();
    const message = { kind: "connection-oauth", error: Boolean(result.error),
      ...(result.connectionId ? { connectionId: result.connectionId, connectionStatus: result.connectionStatus } : {}) };
    const script = `const c=new BroadcastChannel(${JSON.stringify(`takosumi.oauth.${flow}`)});c.postMessage(${JSON.stringify(message)});setTimeout(()=>{c.close();window.close()},200)`;
    return new Response(`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Takosumi</title><p>${result.error ? "Connection was not completed. Return to Takosumi to try again." : "Connection saved. Return to Takosumi."}</p><script nonce="${nonce}">${script}</script></html>`, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
        "set-cookie": `${url.protocol === "https:" ? "__Host-" : ""}takosumi_oauth_${flow.slice(7)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}`,
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` },
    });
  }
  const target = new URL("/connections", url.origin);
  if (flow) target.searchParams.set("connection_flow", flow);
  if (result.connected) target.searchParams.set("connected", "1");
  if (result.connectionId)
    target.searchParams.set("connection_id", result.connectionId);
  if (result.connectionStatus)
    target.searchParams.set("connection_status", result.connectionStatus);
  if (result.error) target.searchParams.set("connection_error", result.error);
  return new Response(null, {
    status: 303,
    headers: { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer",
      ...(flow ? { "set-cookie": `${url.protocol === "https:" ? "__Host-" : ""}takosumi_oauth_${flow.slice(7)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}` } : {}) },
  });
}
