/**
 * Session-authed StateVersion (`/api/v1/state-versions`) read +
 * rollback-plan control routes. Extracted from `control-routes.ts` (P3
 * god-file split).
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
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/install_config_bootstrap.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { appendLedgerEvent } from "../installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { canTransitionAppCapsuleStatus } from "../ledger.ts";

export async function handleStateVersions(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/state-versions/:stateVersionId ; .../rollback-plan — session-authed
  // StateVersion read + rollback. Each resolves the stored apply evidence to
  // learn its owning Workspace, then Workspace-permission gates before projecting /
  // mutating. The read returns ONLY the allowlist-projected outputsPublic (no
  // raw output envelope, no outputId pointer, no sensitive values).
  if (segments[0] === "deployments" && segments.length >= 2) {
    const deploymentId = decodeURIComponent(segments[1] ?? "");
    const deployment = await operations.getDeployment(deploymentId);
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: deployment.spaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({ deployment: publicDeployment(deployment) });
    }
    if (segments[2] === "rollback-plan" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const response =
        await operations.createDeploymentRollbackPlan(deploymentId);
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    return errorJson("not_found", "not found", 404);
  }
  return undefined;
}
