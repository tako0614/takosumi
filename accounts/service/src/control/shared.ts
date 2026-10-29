/**
 * Shared substrate for the session-authed `/api/v1` control surface: response
 * projections, the Workspace access gate, page-param parsing, controller-error
 * mapping, and the dispatch context type. Extracted from `control-routes.ts`
 * (P3 god-file split) so per-resource `control/<resource>.ts` modules import
 * cross-cutting helpers from one place.
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
  CapsuleUninstallRequester,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListCredentialRecipesResponse } from "takosumi-contract/credential-recipes";
import { consoleErrorRedacted } from "../redacted-log.ts";
import type { RunReadWaiter } from "./run-read-deadline.ts";
import {
  measureRequestPhaseOperation,
  type AppAccessShadowDiagnostic,
  type RequestPhaseObserver,
} from "../request-phase-diagnostics.ts";
import { WorkspaceManagementAdmissionConflictError } from "../../../../core/domains/deploy-control/store.ts";
import {
  bearerWorkspaceAllows,
  type AccountsBearerRequiredScope,
} from "../account-session.ts";
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
import {
  isWorkspaceBindableOperatorConnection,
  type ProviderBinding,
  type ProviderBindings,
  type ProviderBindingSet,
  type ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type {
  PublicStateVersion,
  StateVersion,
} from "takosumi-contract/state-versions";
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
import { appActionAllowed, type AppAccess, type AppAction } from "takosumi-contract/app-access";
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
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE } from "@takosumi/internal/deploy-control-api";

/**
 * Per-resource dispatch context: the inputs each `control/<resource>.ts`
 * handler receives from `handleControlRoute`'s dispatch table.
 */
/**
 * The authenticated control-plane caller. `workspaceId` is the credential's own
 * Workspace restriction (a workspace-scoped PAT, or an OAuth access token bound
 * to its Capsule's Workspace at issuance) and is absent for unrestricted
 * account sessions. It is carried alongside the subject so every Workspace
 * authorization decision can see it — see {@link canAccessWorkspace}.
 */
export interface ControlSession {
  readonly subject: string;
  /** Exact credential kind resolved by the Accounts bearer dispatcher. */
  readonly credential?: "session" | "personal-access-token" | "oauth-access-token";
  /** Trusted shared-account composition requires a current active membership,
   * including for the Workspace's recorded owner. Ordinary OSS sessions retain
   * their existing owner authority. Never read this option from an HTTP field. */
  readonly requireCurrentMembership?: true;
  /** Set only by the authenticated Accounts bearer dispatcher. */
  readonly uninstallRequester?: CapsuleUninstallRequester;
  readonly workspaceId?: string;
  readonly appIds?: readonly string[];
  /**
   * Authorization intent derived from the HTTP method at the authenticated
   * dispatch boundary. Workspace members may read; only owner/admin members
   * may mutate.
   */
  readonly requiredAccess?: Exclude<AccountsBearerRequiredScope, "admin">;
  /** Revalidate the exact request bearer at stream checkpoints. Installed by
   * the ordinary account credential dispatcher. */
  readonly reauthorizeBearer?: () => Promise<boolean>;
}

export interface RunStreamTiming {
  readonly now: () => number;
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ControlDispatchContext {
  readonly diagnostics?: RequestPhaseObserver;
  readonly request: Request;
  readonly url: URL;
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly issuer?: string;
  readonly session: ControlSession;
  /** True when the legacy Workspace create/member compatibility surfaces are frozen. */
  readonly workspaceMutationsFrozen?: boolean;
  /** Injectable request-local clock for deterministic stream tests. */
  readonly runStreamTiming?: RunStreamTiming;
  /** Stops new work after the enclosing ordinary Run GET read budget expires. */
  readonly assertActive?: () => void;
  readonly withinRunReadDeadline?: RunReadWaiter;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PublicCapsuleInput = PublicCapsule &
  Partial<
    Pick<
      Capsule,
      | "currentOutputId"
      | "autoUpdateAttemptSourceSnapshotId"
      | "installingPrincipalId"
    >
  >;

export function publicCapsule(capsule: PublicCapsuleInput): PublicCapsule {
  const {
    currentOutputId: _currentOutputId,
    autoUpdateAttemptSourceSnapshotId: _autoUpdateAttempt,
    installingPrincipalId: _installingPrincipalId,
    ...publicRecord
  } = capsule;
  const uninstall = publicRecord.uninstall === undefined
    ? undefined
    : (({ requester: _requester, ...rest }) => rest)(
      publicRecord.uninstall as Capsule["uninstall"] & Record<string, unknown>,
    );
  const safeRecord = {
    ...publicRecord,
    ...(uninstall === undefined ? {} : { uninstall }),
  };
  const currentStateVersionId = safeRecord.currentStateVersionId;
  return currentStateVersionId
    ? { ...safeRecord, currentStateVersionId }
    : safeRecord;
}

/**
 * Public projection of a StateVersion for the account-plane session surface.
 * Runner storage coordinates and state digests stay on the internal control
 * seam and never become browser-visible handles.
 */
export function publicStateVersion(
  stateVersion: StateVersion,
): PublicStateVersion {
  return {
    id: stateVersion.id,
    workspaceId: stateVersion.workspaceId,
    capsuleId: stateVersion.capsuleId,
    environment: stateVersion.environment,
    generation: stateVersion.generation,
    createdByRunId: stateVersion.createdByRunId,
    createdAt: stateVersion.createdAt,
  };
}

export type PublicProviderConnection = ProviderConnection;

/** Canonical account-plane Provider Connection view. */
export function publicProviderConnection(
  connection: ProviderConnection,
): PublicProviderConnection {
  return connection;
}

export async function publicRun(
  operations: ControlPlaneOperations,
  run: Run,
  assertActive?: () => void,
): Promise<PublicRun> {
  assertActive?.();
  const { providerResolutions, ...rest } = run;
  if (!providerResolutions || providerResolutions.length === 0) {
    return rest;
  }
  const publicProviderResolutions = await Promise.all(
    providerResolutions.map((resolution) =>
      publicProviderResolution(operations, resolution),
    ),
  );
  assertActive?.();
  return { ...rest, providerResolutions: publicProviderResolutions };
}

async function publicProviderResolution(
  operations: ControlPlaneOperations,
  resolution: ProviderResolution,
): Promise<PublicProviderResolution> {
  const connectionId = resolution.connectionId;
  return {
    requirement: resolution.requirement,
    status: publicProviderResolutionStatus(resolution),
    ...(connectionId ? { connectionId } : {}),
    ...(resolution.blockedReason
      ? { blockedReason: publicProviderBlockedReason(resolution.blockedReason) }
      : {}),
    evidence: await publicProviderResolutionEvidence(operations, resolution),
  };
}

function publicProviderResolutionStatus(
  resolution: ProviderResolution,
): PublicProviderResolution["status"] {
  return resolution.status;
}

async function publicProviderResolutionEvidence(
  operations: ControlPlaneOperations,
  resolution: ProviderResolution,
): Promise<PublicProviderResolution["evidence"]> {
  const evidence = resolution.evidence;
  void operations;
  if (evidence.kind === "provider_connection") {
    return {
      kind: "provider_connection",
      provider: evidence.provider,
      connectionId: evidence.connectionId,
      requiredEnvNames: evidence.requiredEnvNames,
    };
  }
  return {
    kind: "blocked",
    provider: evidence.provider,
    reason: publicProviderBlockedReason(evidence.reason),
  };
}

function publicProviderBlockedReason(reason: string): string {
  return reason;
}

export async function publicCompatibilityReportResponse(
  operations: ControlPlaneOperations,
  response: CapsuleCompatibilityReportResponse,
): Promise<PublicCapsuleCompatibilityReportResponse> {
  const { providerResolutions: internalProviderResolutions, ...report } =
    response.report;
  const providerResolutions = internalProviderResolutions
    ? await Promise.all(
        internalProviderResolutions.map((resolution) =>
          publicProviderResolution(operations, resolution),
        ),
      )
    : undefined;
  return {
    report: {
      ...report,
      ...(providerResolutions ? { providerResolutions } : {}),
    },
    ...(response.run ? { run: await publicRun(operations, response.run) } : {}),
    ...(response.repositoryInstallUx
      ? { repositoryInstallUx: response.repositoryInstallUx }
      : {}),
  };
}

interface PublicPlanActionResponse {
  readonly run: PublicRun;
  readonly planSummary?: PublicPlanRun["summary"];
  readonly cost?: RunCostInfo;
}

interface PublicApplyActionResponse {
  readonly run: PublicRun;
  readonly capsule?: PublicCapsule;
}

export async function publicPlanActionResponse(
  operations: ControlPlaneOperations,
  response: PlanRunResponse,
): Promise<PublicPlanActionResponse> {
  const run = await operations.getRun(response.planRun.id);
  const cost = await operations
    .getRunCost(response.planRun.id)
    .catch(() => undefined);
  return {
    run: await publicRun(operations, run),
    ...(response.planRun.summary
      ? { planSummary: response.planRun.summary }
      : {}),
    ...(cost ? { cost } : {}),
  };
}

export async function publicApplyActionResponse(
  operations: ControlPlaneOperations,
  response: ApplyRunResponse,
): Promise<PublicApplyActionResponse> {
  const run = await operations.getRun(response.applyRun.id);
  const capsule = response.capsule;
  return {
    run: await publicRun(operations, run),
    ...(capsule ? { capsule: publicCapsule(capsule) } : {}),
  };
}

/**
 * Renders an `OpenTofuControllerError` (carrying a `.code`) to the contract's
 * code->HTTP-status mapping. Workspace admission loss is a precondition failure;
 * other non-controller errors collapse to 500.
 */
export function controllerErrorResponse(error: unknown): Response {
  if (error instanceof WorkspaceManagementAdmissionConflictError) {
    return errorJson(
      "failed_precondition",
      "Workspace is not accepting this management operation.",
      409,
      undefined,
      {},
      { reason: "workspace_management_admission_conflict" },
    );
  }
  const code = controllerErrorCode(error);
  if (code) {
    const publicError = publicControllerError(error);
    return errorJson(
      code,
      publicError.message,
      DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE[code],
      undefined,
      {},
      publicError.details,
    );
  }
  // A non-controller error is a real defect: the public body stays an opaque
  // internal_error, but the operator log must carry the (redacted) cause —
  // otherwise 500s are undiagnosable.
  consoleErrorRedacted("control.internal_error", error);
  return errorJson("internal_error", "internal error", 500);
}

function publicControllerError(error: unknown): {
  readonly message: string;
  readonly details?: unknown;
} {
  const message = error instanceof Error ? error.message : String(error);
  const details = isRecord(error) ? error.details : undefined;
  return {
    message,
    ...(details !== undefined ? { details } : {}),
  };
}

export function controllerErrorCode(
  error: unknown,
): DeployControlErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" &&
    code in DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE
    ? (code as DeployControlErrorCode)
    : undefined;
}

export function controlPlaneUnavailable(): Response {
  return errorJson(
    "feature_unavailable",
    "The control plane is temporarily unavailable.",
    503,
  );
}

export function parseControlPageParams(
  url: URL,
):
  | { readonly ok: true; readonly params: PageParams }
  | { readonly ok: false; readonly response: Response } {
  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      return {
        ok: false,
        response: errorJson(
          "invalid_request",
          "limit must be a positive integer",
          400,
        ),
      };
    }
    limit = Number(rawLimit);
  }
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && rawCursor !== "") {
    if (decodeCursor(rawCursor) === undefined) {
      return {
        ok: false,
        response: errorJson("invalid_request", "cursor is malformed", 400),
      };
    }
  }
  return {
    ok: true,
    params: {
      ...(limit !== undefined ? { limit } : {}),
      ...(rawCursor !== null && rawCursor !== "" ? { cursor: rawCursor } : {}),
    },
  };
}

export async function resolveProviderBindings(
  operations: ControlPlaneOperations,
  workspaceId: string,
  bindings: ProviderBindings,
  appOwnerAccountId?: string,
): Promise<
  | { readonly ok: true; readonly bindings: ProviderBindings }
  | { readonly ok: false; readonly message: string }
> {
  const visibleById = new Map<string, ProviderConnection>();
  for (const connection of await operations.connections.listProviderConnections(
    workspaceId,
  )) {
    if (isBindableProviderConnection(connection, workspaceId)) {
      visibleById.set(connection.id, connection);
    }
  }
  const resolved: ProviderBinding[] = [];
  for (const [index, binding] of bindings.entries()) {
    let connection = visibleById.get(binding.connectionId);
    // Personal connections have no legacy namespace. Resolve only explicitly
    // selected IDs; members never receive the owner's connection inventory.
    if (!connection || (appOwnerAccountId && connection.scope !== "operator" && connection.ownerAccountId !== appOwnerAccountId)) {
      try {
        const candidate = await operations.getConnection(binding.connectionId);
        const owner = appOwnerAccountId ?? (await operations.workspaces.getWorkspace(workspaceId)).ownerUserId;
        if (candidate.scope !== "operator" && candidate.ownerAccountId === owner) connection = candidate;
        else connection = undefined;
      } catch (error) {
        if (controllerErrorCode(error) !== "not_found") throw error;
        connection = undefined;
      }
    }
    if (!connection) {
      return {
        ok: false,
        message: `bindings[${index}]: unknown provider connection`,
      };
    }
    if (
      binding.runCredentialSettings !== undefined &&
      !isWorkspaceBindableOperatorConnection(connection)
    ) {
      return {
        ok: false,
        message: `bindings[${index}]: provider connection does not accept run credential settings`,
      };
    }
    // Release-owned operator policy is code authority. Persist its current
    // bounded settings even when the client submitted an older copy so newly
    // written bindings and Run-time resolution agree.
    const runCredentialSettings =
      isWorkspaceBindableOperatorConnection(connection) &&
      connection.runCredentialSettings !== undefined
        ? connection.runCredentialSettings
        : binding.runCredentialSettings;
    resolved.push({
      provider: binding.provider,
      ...(binding.moduleLocalName
        ? { moduleLocalName: binding.moduleLocalName }
        : {}),
      ...(binding.childAlias ? { childAlias: binding.childAlias } : {}),
      ...(binding.rootAlias ? { rootAlias: binding.rootAlias } : {}),
      ...(binding.alias ? { alias: binding.alias } : {}),
      connectionId: binding.connectionId,
      ...(binding.region ? { region: binding.region } : {}),
      ...(runCredentialSettings
        ? { runCredentialSettings }
        : {}),
    });
  }
  return { ok: true, bindings: resolved };
}

function isBindableProviderConnection(
  connection: ProviderConnection,
  workspaceId: string,
): boolean {
  if (connection.workspaceId === workspaceId) {
    return true;
  }
  return isWorkspaceBindableOperatorConnection(connection);
}

// --- Workspace authorization ---------------------------------------------------

type WorkspaceAccessResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly response: Response;
    };

export async function requireWorkspaceAccess(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly session: ControlSession;
  readonly workspaceId: string;
  readonly workspace?: Workspace;
  readonly capsuleId?: string;
  readonly appAction?: AppAction;
  readonly assertActive?: () => void;
  readonly diagnostics?: RequestPhaseObserver;
}): Promise<WorkspaceAccessResult> {
  input.assertActive?.();
  const canAccess = await canAccessWorkspace({
    operations: input.operations,
    store: input.store,
    session: input.session,
    workspaceId: input.workspaceId,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.capsuleId ? { capsuleId: input.capsuleId } : {}),
    ...(input.appAction ? { appAction: input.appAction } : {}),
    ...(input.assertActive ? { assertActive: input.assertActive } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  input.assertActive?.();
  if (canAccess) {
    return { ok: true };
  }
  return {
    ok: false,
    response: errorJson(
      "forbidden",
      "The authenticated session cannot access this Workspace.",
      403,
    ),
  };
}

export async function canAccessWorkspace(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly session: ControlSession;
  readonly workspaceId: string;
  readonly workspace?: Workspace;
  readonly capsuleId?: string;
  readonly appAction?: AppAction;
  readonly assertActive?: () => void;
  readonly diagnostics?: RequestPhaseObserver;
}): Promise<boolean> {
  input.assertActive?.();
  // A Workspace-restricted credential must not reach any other Workspace, even
  // one whose membership its subject legitimately holds: a PAT scoped to
  // workspace A, or an OAuth token issued for a Capsule in A, would otherwise
  // read B's Capsules, Runs, and Outputs through every id-addressed route.
  // The restriction is applied before membership, never instead of it.
  const bearerAllowed = bearerWorkspaceAllows(input.session, input.workspaceId);
  const finish = async (workspaceAllowed: boolean): Promise<boolean> => {
    if (input.capsuleId) {
      try {
        if (!input.operations.appAccess && !input.diagnostics?.observeAppAccessShadow) return workspaceAllowed;
        await observeAppAccessShadow({
          operations: input.operations,
          session: input.session,
          workspaceId: input.workspaceId,
          capsuleId: input.capsuleId,
          appAction: input.appAction,
          bearerAllowed,
          workspaceAllowed,
          workspace: input.workspace,
          diagnostics: input.diagnostics,
        });
      } catch {
        // The shadow port cannot replace or fail the legacy authorization result.
      }
    }
    return workspaceAllowed;
  };
  // App-only credentials without an issuance-time Workspace binding have no
  // legacy Workspace authority, even when their subject is a member there.
  if (!bearerAllowed || (input.session.appIds !== undefined && !input.session.workspaceId)) {
    return await finish(false);
  }


  const workspace =
    input.workspace ??
    (await measureRequestPhaseOperation(
      input.diagnostics,
      "run_get_workspace",
      () => input.operations.workspaces.getWorkspace(input.workspaceId),
    ));
  input.assertActive?.();
  if (workspace.id !== input.workspaceId) return await finish(false);
  if (!input.session.requireCurrentMembership &&
    workspace.ownerUserId === input.session.subject) return await finish(true);

  const mayUseMember = (member: PublicWorkspaceMember | undefined): boolean =>
    member?.status === "active" &&
    (!input.session.requireCurrentMembership ||
      (member.workspaceId === input.workspaceId && member.accountId === input.session.subject)) &&
    (!input.session.requireCurrentMembership ||
      member.roles.some((role) => ["owner", "admin", "member", "viewer"].includes(role))) &&
    (input.session.requiredAccess !== "write" ||
      member.roles.includes("owner") ||
      member.roles.includes("admin"));
  if (input.operations.members.getMember) {
    const member = await measureRequestPhaseOperation(
      input.diagnostics,
      "run_get_member",
      () => input.operations.members.getMember!(
        input.workspaceId,
        input.session.subject,
      ),
    );
    input.assertActive?.();
    return await finish(mayUseMember(member));
  }
  const members = await measureRequestPhaseOperation(
    input.diagnostics,
    "run_get_member",
    () => input.operations.members.listMembers(input.workspaceId),
  );
  input.assertActive?.();
  return await finish(mayUseMember(
    members.find((member) => member.accountId === input.session.subject),
  ));
}

/**
 * Best-effort Phase 3 comparison only. It deliberately runs after the legacy
 * answer is computed, does not delay or replace that answer, and only reports
 * booleans and coarse roles through the opt-in diagnostic observer.
 */
async function observeAppAccessShadow(input: {
  readonly operations: ControlPlaneOperations;
  readonly session: ControlSession;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly appAction?: AppAction;
  readonly bearerAllowed: boolean;
  readonly workspaceAllowed: boolean;
  readonly workspace?: Workspace;
  readonly diagnostics?: RequestPhaseObserver;
}): Promise<void> {
  const resolver = input.operations.appAccess;
  const diagnostic = input.diagnostics?.observeAppAccessShadow;
  if (!resolver && !diagnostic) return;
  let appAccess: AppAccess | undefined;
  let resolverSucceeded = false;
  let workspaceRole: "owner" | "member" | null = null;
  const action = input.appAction ?? (input.session.requiredAccess === "write" ? "change_settings" : "view");
  const [appResult, workspaceRoleResult] = await Promise.allSettled([
    resolver?.resolveAppAccess(input.session.subject, input.capsuleId) ?? Promise.resolve(undefined),
    resolveWorkspaceRole(input),
  ]);
  if (appResult.status === "fulfilled" &&
    (!appResult.value || appResult.value.capsuleId === input.capsuleId)) {
    appAccess = appResult.value;
    resolverSucceeded = resolver !== undefined;
  }
  if (workspaceRoleResult.status === "fulfilled") workspaceRole = workspaceRoleResult.value;
  const appRole = appAccess?.role ?? null;
  const appAllowed = input.bearerAllowed && appAccess !== undefined &&
    appActionAllowed(appAccess.role, action);
  let roleDiff: "same" | "workspace_only" | "app_only" | "role_mismatch" | "unavailable";
  if (!resolverSucceeded || workspaceRoleResult.status !== "fulfilled") roleDiff = "unavailable";
  else if (workspaceRole === appRole) roleDiff = "same";
  else if (workspaceRole === null) roleDiff = "app_only";
  else if (appRole === null) roleDiff = "workspace_only";
  else roleDiff = "role_mismatch";
  const observation: AppAccessShadowDiagnostic = {
      resolverAvailable: resolver !== undefined,
      resolverSucceeded,
      bearerWorkspaceAllowed: input.bearerAllowed,
      workspaceAllowed: input.workspaceAllowed,
      appAllowed,
      workspaceRole,
      appRole,
      roleDiff,
  };
  try {
    await diagnostic?.call(input.diagnostics, observation);
  } catch {
    // Diagnostics have no authority and must not affect the route response.
  }
  if (resolverSucceeded && (input.workspaceAllowed !== appAllowed || roleDiff !== "same")) {
    try {
      console.warn(JSON.stringify({ event: "app_access_shadow_mismatch", ...observation }));
    } catch {
      // Value-free warning output is still best-effort only.
    }
  }
}

async function resolveWorkspaceRole(input: {
  readonly operations: ControlPlaneOperations;
  readonly session: ControlSession;
  readonly workspaceId: string;
  readonly workspace?: Workspace;
}): Promise<"owner" | "member" | null> {
  const workspace = input.workspace ?? await input.operations.workspaces.getWorkspace(input.workspaceId);
  if (workspace.id !== input.workspaceId) return null;
  if (!input.session.requireCurrentMembership && workspace.ownerUserId === input.session.subject) return "owner";
  const member = input.operations.members.getMember
    ? await input.operations.members.getMember(input.workspaceId, input.session.subject)
    : (await input.operations.members.listMembers(input.workspaceId)).find((row) => row.accountId === input.session.subject);
  if (member?.status !== "active" ||
    (input.session.requireCurrentMembership &&
      (member.workspaceId !== input.workspaceId || member.accountId !== input.session.subject ||
        !member.roles.some((role) => ["owner", "admin", "member", "viewer"].includes(role))))) return null;
  if (workspace.ownerUserId === input.session.subject &&
    (member.roles.includes("owner") || member.roles.includes("admin"))) return "owner";
  return member.roles.includes("member") || member.roles.includes("viewer") ? "member" : null;
}

export function jsonStatus(body: unknown, status: number): Response {
  return json(body, status);
}
