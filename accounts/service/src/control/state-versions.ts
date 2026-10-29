/**
 * Session-authed StateVersion (`/api/v1/state-versions`) read +
 * rollback-plan control routes. Extracted from `control-routes.ts` (P3
 * god-file split).
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
  publicStateVersion,
  publicCapsule,
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
import { requireOwnerForDelegateCodeChange, requireResourceAccess } from "./app-authorization.ts";

export async function handleStateVersions(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/state-versions/:stateVersionId ; .../rollback-plan — session-authed
  // StateVersion read + rollback. Each resolves the stored state evidence to
  // learn its owning Workspace before projecting or mutating.
  if (segments[0] === "state-versions" && segments.length >= 2) {
    const stateVersionId = decodeURIComponent(segments[1] ?? "");
    const { stateVersion } = await operations.getStateVersion(stateVersionId);
    // A StateVersion belongs to its Capsule: reading is view, planning a
    // return to it is rollback.
    const auth = await requireResourceAccess({
      operations,
      store,
      workspaceId: stateVersion.workspaceId,
      capsuleId: stateVersion.capsuleId,
      action: method === "GET" || method === "HEAD" ? "view" : "rollback",
      session: ctx.session,
      ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
      ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({ stateVersion: publicStateVersion(stateVersion) });
    }
    if (segments[2] === "rollback-plan" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      // A rollback plans an earlier snapshot: for a designated delegate app
      // that changes what it deploys, which only its owner may do.
      if (stateVersion.capsuleId) {
        const codeChange = await requireOwnerForDelegateCodeChange({
          operations, store, session: ctx.session, workspaceId: stateVersion.workspaceId,
          capsuleIds: [stateVersion.capsuleId],
          ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
          ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
        });
        if (!codeChange.ok) return codeChange.response;
      }
      const response =
        await operations.createStateVersionRollbackPlan(stateVersionId, { actor: ctx.session.subject });
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    return errorJson("not_found", "not found", 404);
  }
  return undefined;
}
