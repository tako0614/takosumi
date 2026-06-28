/**
 * Session-authed local-upload deploy (`POST /api/v1/deploy`) control route. The
 * request carries no credential material; provider access resolves from public
 * Provider Connection ids. Extracted from `control-routes.ts` (P3 split).
 */
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  Connection,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  ConnectionScopeHints,
  CreateApplyRunRequest,
  CreateConnectionFile,
  CreateConnectionRequest,
  DeployControlErrorCode,
  Deployment,
  InternalDeployRequest,
  ListConnectionsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  OpenTofuModuleSource,
  PlanRunResponse,
  PublicPlanRun,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type {
  ArtifactSnapshotRequest,
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
  DeployResponse,
  PublicDeployResponse,
} from "takosumi-contract/deploy";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListProvidersResponse } from "takosumi-contract/providers";
import type { Workspace, WorkspaceType } from "takosumi-contract/workspaces";
import type {
  CapsuleProviderEnvBindingSet,
  InstallConfig,
  Capsule,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicCapsule,
} from "takosumi-contract/installations";
import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  CapsuleProviderConnectionBinding,
  CapsuleProviderConnectionBindings,
  CapsuleProviderEnvBinding,
  CapsuleProviderEnvBindings,
  CapsuleProviderConnectionSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type {
  OutputShare,
  OutputShareEntry,
} from "takosumi-contract/outputs";
import type { PublicDeployment } from "takosumi-contract/deployments";
import type {
  BackupRecord,
  CreateBackupResponse,
  CreateRestoreRequest,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  BillingSettings,
  CreditBalance,
  CreditReservation,
  UsageEvent,
} from "takosumi-contract/billing";
import type {
  ListRunsResponse,
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  PublicRun,
} from "takosumi-contract/runs";
import type { JsonValue } from "takosumi-contract";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  AppCapsuleMode,
  AppCapsuleStatus,
  CapsuleRecord,
  WorkspaceKind,
} from "../ledger.ts";
import type { SharedCellRuntimeAllocator } from "../runtime.ts";
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
  publicDeployResponse,
  publicDeployment,
  publicCapsule,
  publicPlanActionResponse,
  publicRun,
  requireWorkspaceAccess,
  resolveProviderConnectionBindings,
} from "./shared.ts";
import {
  booleanValue,
  connectionCredentialFiles,
  connectionScopeHints,
  connectionScopeHintsFromValues,
  dependencyModeValue,
  dependencyVisibilityValue,
  isGoogleCloudProvider,
  isJsonValue,
  isOutputsMapping,
  isPlainJsonObject,
  jsonRecordValue,
  modulePathValue,
  outputAllowlistValue,
  outputShareEntries,
  outputShareSensitivePolicy,
  parseCapsuleProviderConnectionBinding,
  parseCapsuleProviderConnectionBindings,
  parseLimit,
  spaceTypeValue,
  stringRecord,
  stringRecordValue,
} from "./parse.ts";
import {
  deployProjectionModeValue,
  saveProjectionStatusChange,
  syncDeployControlProjectionFromApply,
  syncDeployControlProjectionFromDeploy,
  syncDeployControlProjectionStatusFromRun,
} from "./projection.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/official_seed.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { appendLedgerEvent } from "../installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { canTransitionAppCapsuleStatus } from "../ledger.ts";

export async function handleDeploy(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // POST /api/v1/deploy — local-directory deploy uploaded by the CLI. The
  // request carries no credential material; provider access is resolved from
  // public Provider Connection ids before the internal deploy-control dispatch.
  if (segments.length === 1 && segments[0] === "deploy") {
    if (method !== "POST") return methodNotAllowed("POST");
    return await deployUploadedSnapshot(
      request,
      operations,
      store,
      ctx.session.subject,
      ctx.sharedCellRuntime,
    );
  }
  return undefined;
}

async function deployUploadedSnapshot(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  sharedCellRuntime?: SharedCellRuntimeAllocator,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body)
    return errorJson("invalid_argument", "invalid request", 400, request);
  const workspaceId = stringValue(body.workspaceId);
  const name = stringValue(body.name);
  const snapshotId = stringValue(body.snapshotId);
  if (!workspaceId || !name || !snapshotId) {
    return errorJson(
      "invalid_argument",
      "workspaceId, name, and snapshotId are required",
      400,
      request,
    );
  }
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const vars = jsonRecordValue(body.vars);
  if (body.vars !== undefined && vars === undefined) {
    return errorJson(
      "invalid_argument",
      "vars must be an object of JSON values keyed by OpenTofu variable names",
      400,
      request,
    );
  }
  const outputAllowlist = outputAllowlistValue(body.outputAllowlist);
  if (body.outputAllowlist !== undefined && outputAllowlist === undefined) {
    return errorJson(
      "invalid_argument",
      "outputAllowlist must be an object of { from, type, required? } entries",
      400,
      request,
    );
  }
  const environment = stringValue(body.environment);
  const modulePath = modulePathValue(body.modulePath);
  if (body.modulePath !== undefined && modulePath === undefined) {
    return errorJson(
      "invalid_argument",
      "modulePath must be a safe relative OpenTofu module path.",
      400,
      request,
    );
  }
  const runnerProfileId =
    stringValue(body.runnerId) ?? stringValue(body.runnerProfileId);
  let providerEnvBindings: CapsuleProviderEnvBindings | undefined;
  if (body.providerEnvBindings !== undefined) {
    return errorJson(
      "invalid_argument",
      "providerEnvBindings is internal-only; use providerConnections",
      400,
      request,
    );
  }
  if (body.providerConnections !== undefined) {
    const parsed = parseCapsuleProviderConnectionBindings(
      body.providerConnections,
    );
    if (!parsed.ok) {
      return errorJson(
        "invalid_argument",
        `providerConnections: ${parsed.message}`,
        400,
        request,
      );
    }
    const resolved = await resolveProviderConnectionBindings(
      operations,
      workspaceId,
      parsed.bindings,
    );
    if (!resolved.ok) {
      return errorJson(
        "invalid_argument",
        `providerConnections: ${resolved.message}`,
        400,
        request,
      );
    }
    providerEnvBindings = resolved.bindings;
  }
  const planOnly = booleanValue(body.planOnly);
  const autoApprove = booleanValue(body.autoApprove);
  const projectionMode =
    body.projectionMode === undefined
      ? undefined
      : deployProjectionModeValue(body.projectionMode);
  if (body.projectionMode !== undefined && !projectionMode) {
    return errorJson(
      "invalid_argument",
      "projectionMode must be self-hosted or shared-cell",
      400,
      request,
    );
  }
  if (projectionMode === "shared-cell" && !sharedCellRuntime) {
    return errorJson(
      "feature_unavailable",
      "shared-cell projection runtime is not configured",
      503,
      request,
    );
  }
  const deployRequest: InternalDeployRequest = {
    workspaceId,
    name,
    ...(environment ? { environment } : {}),
    snapshotId,
    ...(modulePath ? { modulePath } : {}),
    ...(runnerProfileId ? { runnerProfileId } : {}),
    ...(vars ? { vars } : {}),
    ...(outputAllowlist ? { outputAllowlist } : {}),
    ...(providerEnvBindings ? { providerEnvBindings } : {}),
    ...(planOnly !== undefined ? { planOnly } : {}),
    ...(autoApprove !== undefined ? { autoApprove } : {}),
  };
  try {
    const deployResponse = await operations.deployUpload(deployRequest);
    const projectionError = await syncDeployControlProjectionFromDeploy({
      operations,
      store,
      sessionSubject: sessionSubject as TakosumiSubject,
      deployResponse,
      projectionMode,
      sharedCellRuntime,
    });
    if (projectionError) return projectionError;
    return json(await publicDeployResponse(operations, deployResponse));
  } catch (error) {
    logDeployUploadFailure(error, {
      method: request.method,
      path: new URL(request.url).pathname,
      workspaceId,
      name,
      snapshotId,
      environment: environment ?? "production",
      hasVars: vars !== undefined,
      providerConnectionCount: Array.isArray(body.providerConnections)
        ? body.providerConnections.length
        : 0,
    });
    throw error;
  }
}

function logDeployUploadFailure(
  error: unknown,
  context: {
    readonly method: string;
    readonly path: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly snapshotId: string;
    readonly environment: string;
    readonly hasVars: boolean;
    readonly providerConnectionCount: number;
  },
): void {
  console.error("Takosumi control deploy upload failed", {
    ...context,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
}
