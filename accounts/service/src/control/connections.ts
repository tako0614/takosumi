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
import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  ProviderBinding,
  ProviderBindings,
  ProviderBindingSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type { OutputShare, OutputShareEntry } from "takosumi-contract/outputs";
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
  dependencyModeValue,
  dependencyVisibilityValue,
  isJsonValue,
  isOutputsMapping,
  isPlainJsonObject,
  jsonRecordValue,
  modulePathValue,
  outputAllowlistValue,
  outputShareEntries,
  outputShareSensitivePolicy,
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

export async function handleConnections(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/connections?workspaceId=  (GET list / POST create)
  if (segments.length === 1 && segments[0] === "connections") {
    if (method === "GET") {
      return await listControlConnections(
        operations,
        store,
        ctx.session.subject,
        url,
      );
    }
    if (method === "POST") {
      return await createControlConnection(
        request,
        operations,
        store,
        ctx.session.subject,
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
      ctx.session.subject,
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
        ctx.session.subject,
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
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const workspaceId = stringValue(
    url.searchParams.get("workspaceId") ?? undefined,
  );
  // The accounts plane has no admin notion distinct from a normal session, so
  // a Workspace id is REQUIRED here; operator-scoped Connection listing stays on
  // the operator-bearer §30 surface. (If/when the accounts plane grows an admin
  // role, this can branch to listOperatorConnections.)
  if (!workspaceId) {
    return errorJson(
      "invalid_request",
      "workspaceId query parameter is required",
      400,
    );
  }
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const response = await operations.listConnections(workspaceId, page.params);
  return json({
    ...response,
    connections: response.connections.map(publicProviderConnection),
  });
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
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const workspaceId = stringValue(body.workspaceId);
  if (!workspaceId) {
    return errorJson("invalid_request", "workspaceId is required", 400);
  }
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
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
    workspaceId,
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
    scope: "workspace",
    ...(stringValue(body.displayName)
      ? { displayName: stringValue(body.displayName) }
      : {}),
    ...(scopeHints ? { scopeHints } : {}),
    values: values ?? {},
    ...(files.length > 0 ? { files } : {}),
  };
  const response = await operations.createConnection(createRequest);
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
  sessionSubject: string,
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
    sessionSubject,
    connectionId,
  );
  if (!target) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  const { connection, rawConnectionId } = target;
  const workspaceId = connection.workspaceId;
  if (!workspaceId) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  // Both test (re-verify) and revoke (delete the sealed blob) are write-scoped
  // mutations; the ownership failure must not disclose the connection's
  // existence, so a 403 from the gate is surfaced as a 404 here.
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  if (op === "test") {
    return json(await operations.testConnection(rawConnectionId));
  }
  await operations.revokeConnection(rawConnectionId);
  return new Response(null, { status: 204 });
}

async function resolveConnectionItemTarget(
  operations: ControlPlaneOperations,
  sessionSubject: string,
  connectionId: string,
): Promise<
  | {
      readonly connection: ProviderConnection;
      readonly rawConnectionId: string;
    }
  | undefined
> {
  void sessionSubject;
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
  sessionSubject: string,
  url: URL,
  helperId: string,
): Promise<Response> {
  const helper = operations.connectionOAuth?.[helperId];
  if (!helper) return connectionOAuthUnavailable();
  const body = (await readJsonObject(request)) ?? {};
  const workspaceId =
    stringValue(body.workspaceId) ??
    stringValue(url.searchParams.get("workspaceId") ?? undefined);
  if (!workspaceId) {
    return errorJson("invalid_request", "workspaceId is required", 400);
  }
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const started = await helper.start({
    // Bind the OAuth state to the authenticated subject so the cross-site
    // callback can authorize without depending on a session cookie.
    subject: sessionSubject,
    workspaceId,
    ...(stringValue(body.displayName)
      ? { displayName: stringValue(body.displayName) }
      : {}),
  });
  return json(started);
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
): Promise<Response> {
  const helper = operations.connectionOAuth?.[helperId];
  if (!helper) return connectionOAuthUnavailable();
  const code = stringValue(url.searchParams.get("code") ?? undefined);
  const state = stringValue(url.searchParams.get("state") ?? undefined);
  if (!code || !state) {
    return redirectToConnections(url, { error: "missing_code" });
  }
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  let completed: {
    readonly request: CreateConnectionRequest;
    readonly subject?: string;
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
  if (!workspaceId || !subject) {
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  // Re-check Workspace ownership against the SIGNED state's subject + workspaceId so a
  // stolen or forged callback cannot mint a Connection into a Workspace the
  // authenticated initiator does not own. This is the callback's only authz —
  // there is no session cookie on a cross-site redirect.
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId,
    subject,
  });
  if (!auth.ok) return redirectToConnections(url, { error: "forbidden" });
  let created: ConnectionResponse;
  try {
    // Force Workspace scope regardless of what the helper produced.
    created = await operations.createConnection({
      ...createRequest,
      scope: "workspace",
    });
  } catch {
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  let connectionStatus: TestConnectionResponse["status"] | undefined;
  try {
    const result = await operations.testConnection(created.connection.id);
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
function redirectToConnections(
  url: URL,
  result: {
    readonly connected?: string;
    readonly error?: string;
    readonly connectionId?: string;
    readonly connectionStatus?: TestConnectionResponse["status"];
  },
): Response {
  const target = new URL("/connections", url.origin);
  if (result.connected) target.searchParams.set("connected", "1");
  if (result.connectionId)
    target.searchParams.set("connection_id", result.connectionId);
  if (result.connectionStatus)
    target.searchParams.set("connection_status", result.connectionStatus);
  if (result.error) target.searchParams.set("connection_error", result.error);
  return new Response(null, {
    status: 303,
    headers: { location: target.toString() },
  });
}
