/**
 * Session-authed OutputShare (`/api/v1/output-shares`) control routes: list /
 * create / approve / revoke. Extracted from `control-routes.ts` (P3 split).
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
  publicOutputShare,
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

export async function handleOutputShares(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/output-shares ; /api/v1/output-shares/:id/{approve,revoke}
  if (segments[0] === "output-shares") {
    if (segments.length === 1) {
      if (method === "GET") {
        return await listOutputShares(operations, store, ctx.session, url);
      }
      if (method === "POST") {
        return await createOutputShare(request, operations, store, ctx.session);
      }
      return methodNotAllowed("GET, POST");
    }
    if (segments.length === 3) {
      const shareId = decodeURIComponent(segments[1] ?? "");
      const action = segments[2];
      if (action === "approve") {
        if (method !== "POST") return methodNotAllowed("POST");
        return await approveOutputShare(
          operations,
          store,
          ctx.session,
          shareId,
        );
      }
      if (action === "revoke") {
        if (method !== "POST") return methodNotAllowed("POST");
        return await revokeOutputShare(operations, store, ctx.session, shareId);
      }
    }
  }
  return undefined;
}

async function listOutputShares(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  url: URL,
): Promise<Response> {
  const workspaceId = stringValue(
    url.searchParams.get("workspaceId") ?? undefined,
  );
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
    session,
  });
  if (!auth.ok) return auth.response;
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const { items, nextCursor } =
    await operations.outputShares.listForWorkspacePage(
      workspaceId,
      page.params,
    );
  return json({
    shares: items.map(publicOutputShare),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

async function createOutputShare(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const fromWorkspaceId = stringValue(body.fromWorkspaceId);
  const toWorkspaceId = stringValue(body.toWorkspaceId);
  const producerCapsuleId = stringValue(body.producerCapsuleId);
  const outputs = outputShareEntries(body.outputs);
  const sensitivePolicy = outputShareSensitivePolicy(body.sensitivePolicy);
  if (!fromWorkspaceId || !toWorkspaceId || !producerCapsuleId || !outputs) {
    return errorJson(
      "invalid_request",
      "fromWorkspaceId, toWorkspaceId, producerCapsuleId, and outputs are required",
      400,
    );
  }
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId: fromWorkspaceId,
    session,
  });
  if (!auth.ok) return auth.response;
  const producer = await operations.capsules.getCapsule(producerCapsuleId);
  if (producer.workspaceId !== fromWorkspaceId) {
    const producerAuth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: producer.workspaceId,
      session,
    });
    if (!producerAuth.ok) return producerAuth.response;
    return errorJson(
      "invalid_request",
      "producerCapsuleId must belong to the source Workspace.",
      400,
    );
  }
  const share = await operations.outputShares.createShare({
    fromWorkspaceId,
    toWorkspaceId,
    producerCapsuleId,
    outputs,
    ...(sensitivePolicy ? { sensitivePolicy } : {}),
  });
  return jsonStatus({ share: publicOutputShare(share) }, 201);
}

async function approveOutputShare(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  shareId: string,
): Promise<Response> {
  const existing = await operations.outputShares.getShare(shareId);
  if (!existing) return errorJson("not_found", "not found", 404);
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId: existing.toWorkspaceId,
    session,
  });
  if (!auth.ok) return auth.response;
  return json({
    share: publicOutputShare(
      await operations.outputShares.approveShare(shareId),
    ),
  });
}

async function revokeOutputShare(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  shareId: string,
): Promise<Response> {
  const existing = await operations.outputShares.getShare(shareId);
  if (!existing) return errorJson("not_found", "not found", 404);
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId: existing.fromWorkspaceId,
    session,
  });
  if (!auth.ok) return auth.response;
  return json({
    share: publicOutputShare(
      await operations.outputShares.revokeShare(shareId),
    ),
  });
}
