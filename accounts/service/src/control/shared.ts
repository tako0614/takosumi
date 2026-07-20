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
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListCredentialRecipesResponse } from "takosumi-contract/credential-recipes";
import { consoleErrorRedacted } from "../redacted-log.ts";
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
import {
  isPublicManagedProviderConnection,
  type ProviderBinding,
  type ProviderBindings,
  type ProviderBindingSet,
  type ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type { OutputShare, OutputShareEntry } from "takosumi-contract/outputs";
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
export interface ControlDispatchContext {
  readonly request: Request;
  readonly url: URL;
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly issuer?: string;
  readonly managedPublicBaseDomain?: string;
  readonly session: { readonly subject: string };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PublicCapsuleInput = PublicCapsule &
  Partial<
    Pick<Capsule, "currentOutputId" | "autoUpdateAttemptSourceSnapshotId">
  >;

export function publicCapsule(capsule: PublicCapsuleInput): PublicCapsule {
  const {
    currentOutputId: _currentOutputId,
    autoUpdateAttemptSourceSnapshotId: _autoUpdateAttempt,
    ...publicRecord
  } = capsule;
  const currentStateVersionId = publicRecord.currentStateVersionId;
  return currentStateVersionId
    ? { ...publicRecord, currentStateVersionId }
    : publicRecord;
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

export type PublicDependency = Dependency;

/** Canonical account-plane Dependency view without pre-v1 id aliases. */
export function publicDependency(dependency: Dependency): PublicDependency {
  return {
    id: dependency.id,
    workspaceId: dependency.workspaceId,
    producerCapsuleId: dependency.producerCapsuleId,
    consumerCapsuleId: dependency.consumerCapsuleId,
    mode: dependency.mode,
    outputs: dependency.outputs,
    visibility: dependency.visibility,
    createdAt: dependency.createdAt,
  };
}

export type PublicOutputShare = OutputShare;

/** Canonical account-plane OutputShare view without pre-v1 id aliases. */
export function publicOutputShare(share: OutputShare): PublicOutputShare {
  return {
    id: share.id,
    fromWorkspaceId: share.fromWorkspaceId,
    toWorkspaceId: share.toWorkspaceId,
    producerCapsuleId: share.producerCapsuleId,
    outputs: share.outputs,
    status: share.status,
    createdAt: share.createdAt,
    ...(share.acceptedAt ? { acceptedAt: share.acceptedAt } : {}),
    ...(share.revokedAt ? { revokedAt: share.revokedAt } : {}),
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
): Promise<PublicRun> {
  const { providerResolutions, ...rest } = run;
  if (!providerResolutions || providerResolutions.length === 0) {
    return rest;
  }
  return {
    ...rest,
    providerResolutions: await Promise.all(
      providerResolutions.map((resolution) =>
        publicProviderResolution(operations, resolution),
      ),
    ),
  };
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
      providers: report.providers,
      ...(providerResolutions ? { providerResolutions } : {}),
    },
    ...(response.run ? { run: await publicRun(operations, response.run) } : {}),
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
 * code->HTTP-status mapping. Non-controller errors collapse to 500.
 */
export function controllerErrorResponse(error: unknown): Response {
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
  const reason = isRecord(details) ? details.reason : undefined;
  if (reason === "app_hostname_unavailable") {
    return {
      message: "app_hostname_unavailable: already exists",
      details: { reason: "app_hostname_unavailable" },
    };
  }
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
    if (!visibleById.has(binding.connectionId)) {
      return {
        ok: false,
        message: `bindings[${index}]: unknown provider connection`,
      };
    }
    resolved.push({
      provider: binding.provider,
      ...(binding.alias ? { alias: binding.alias } : {}),
      connectionId: binding.connectionId,
      ...(binding.region ? { region: binding.region } : {}),
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
  return isPublicManagedProviderConnection(connection);
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
  readonly subject: string;
  readonly workspaceId: string;
  readonly workspace?: Workspace;
}): Promise<WorkspaceAccessResult> {
  if (
    await canAccessWorkspace({
      operations: input.operations,
      store: input.store,
      subject: input.subject,
      workspaceId: input.workspaceId,
      ...(input.workspace ? { workspace: input.workspace } : {}),
    })
  ) {
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
  readonly subject: string;
  readonly workspaceId: string;
  readonly workspace?: Workspace;
}): Promise<boolean> {
  const workspace =
    input.workspace ??
    (await input.operations.workspaces.getWorkspace(input.workspaceId));
  if (workspace.ownerUserId === input.subject) return true;

  if (input.operations.members.getMember) {
    const member = await input.operations.members.getMember(
      input.workspaceId,
      input.subject,
    );
    return member?.status === "active";
  }
  const members = await input.operations.members.listMembers(input.workspaceId);
  return members.some(
    (member) =>
      member.accountId === input.subject && member.status === "active",
  );
}

export function jsonStatus(body: unknown, status: number): Response {
  return json(body, status);
}
