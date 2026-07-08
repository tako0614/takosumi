/**
 * Session-authed Source (`/api/v1/sources`) and Compatibility Report
 * (`/api/v1/compatibility-reports/:id`) control routes. Extracted from
 * `control-routes.ts` (P3 god-file split).
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
import type { OutputShare, OutputShareEntry } from "takosumi-contract/outputs";
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

function sourceWorkspaceId(
  source: Readonly<{ workspaceId?: string; spaceId?: string }>,
): string | undefined {
  return stringValue(source.workspaceId) ?? stringValue(source.spaceId);
}

function sourceWorkspaceIdentityMissing(): Response {
  return errorJson(
    "internal_error",
    "source is missing Workspace identity",
    500,
  );
}

export async function handleSources(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/sources ; /api/v1/sources/:id/sync ; .../snapshots ; .../compatibility-check
  if (segments[0] === "sources") {
    if (segments.length === 1) {
      if (method === "GET") {
        return await listSources(operations, store, ctx.session.subject, url);
      }
      if (method === "POST") {
        return await createSource(
          request,
          operations,
          store,
          ctx.session.subject,
        );
      }
      return methodNotAllowed("GET, POST");
    }
    if (segments.length === 3 && segments[2] === "sync") {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      if (method !== "POST") return methodNotAllowed("POST");
      const { source } = await operations.getSource(sourceId);
      const workspaceId = sourceWorkspaceId(source);
      if (!workspaceId) return sourceWorkspaceIdentityMissing();
      const auth = await requireWorkspaceAccess({
        operations,
        store,
        workspaceId,
        subject: ctx.session.subject,
      });
      if (!auth.ok) return auth.response;
      return jsonStatus(
        await operations.createSourceSync(sourceId, { dedupe: true }),
        201,
      );
    }
    if (segments.length === 3 && segments[2] === "snapshots") {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      if (method !== "GET") return methodNotAllowed("GET");
      const { source } = await operations.getSource(sourceId);
      const workspaceId = sourceWorkspaceId(source);
      if (!workspaceId) return sourceWorkspaceIdentityMissing();
      const auth = await requireWorkspaceAccess({
        operations,
        store,
        workspaceId,
        subject: ctx.session.subject,
      });
      if (!auth.ok) return auth.response;
      const page = parseControlPageParams(url);
      if (!page.ok) return page.response;
      return json(await operations.listSourceSnapshots(sourceId, page.params));
    }
    if (segments.length === 3 && segments[2] === "compatibility-check") {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      if (method !== "POST") return methodNotAllowed("POST");
      const { source } = await operations.getSource(sourceId);
      const workspaceId = sourceWorkspaceId(source);
      if (!workspaceId) return sourceWorkspaceIdentityMissing();
      const auth = await requireWorkspaceAccess({
        operations,
        store,
        workspaceId,
        subject: ctx.session.subject,
      });
      if (!auth.ok) return auth.response;
      const body = await readOptionalJsonObject(request);
      if (body === null) {
        return errorJson("invalid_json", "invalid json body", 400);
      }
      const sourceSnapshotId = stringValue(body.sourceSnapshotId);
      const modulePath = modulePathValue(body.modulePath);
      if (body.modulePath !== undefined && modulePath === undefined) {
        return errorJson(
          "invalid_request",
          "modulePath must be a safe relative OpenTofu module path.",
          400,
        );
      }
      const capsuleId = stringValue(body.capsuleId);
      // Curated store deep-link path: when no Capsule exists yet, gate
      // the pre-install check against the store's bounded InstallConfig so a
      // vetted first-party module is judged by its own minimal allowlist
      // (the instance-wide default allowlist is never widened — see
      // CreateSourceCompatibilityCheckRequest.installConfigId).
      const installConfigId = stringValue(body.installConfigId);
      const compatibilityRequest: CreateSourceCompatibilityCheckRequest = {
        ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
        ...(modulePath ? { modulePath } : {}),
        ...(capsuleId ? { capsuleId } : {}),
        ...(installConfigId ? { installConfigId } : {}),
      };
      return jsonStatus(
        await publicCompatibilityReportResponse(
          operations,
          await operations.createSourceCompatibilityCheck(
            sourceId,
            compatibilityRequest,
          ),
        ),
        201,
      );
    }
    if (segments.length === 2) {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      const { source } = await operations.getSource(sourceId);
      const workspaceId = sourceWorkspaceId(source);
      if (!workspaceId) return sourceWorkspaceIdentityMissing();
      const auth = await requireWorkspaceAccess({
        operations,
        store,
        workspaceId,
        subject: ctx.session.subject,
      });
      if (!auth.ok) return auth.response;
      if (method === "GET") {
        return json({ source });
      }
      if (method === "PATCH") {
        const body = await readOptionalJsonObject(request);
        if (body === null) {
          return errorJson("invalid_json", "invalid json body", 400);
        }
        return json(
          await operations.patchSource(sourceId, body as PatchSourceRequest),
        );
      }
      return methodNotAllowed("GET, PATCH");
    }
  }
  return undefined;
}

export async function handleCompatibilityReports(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  if (segments[0] === "compatibility-reports" && segments.length === 2) {
    if (method !== "GET") return methodNotAllowed("GET");
    const reportId = decodeURIComponent(segments[1] ?? "");
    const response = await operations.getCompatibilityReport(reportId);
    const report = response.report;
    const reportWorkspaceId = report.sourceId
      ? sourceWorkspaceId((await operations.getSource(report.sourceId)).source)
      : report.capsuleId
        ? (await operations.installations.getCapsule(report.capsuleId))
            .workspaceId
        : undefined;
    if (!reportWorkspaceId) {
      return errorJson("not_found", "compatibility report not found", 404);
    }
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: reportWorkspaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    return json(await publicCompatibilityReportResponse(operations, response));
  }
  return undefined;
}

async function listSources(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const workspaceId =
    stringValue(url.searchParams.get("workspaceId") ?? undefined) ??
    stringValue(url.searchParams.get("workspace_id") ?? undefined) ??
    stringValue(url.searchParams.get("workspaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
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
  return json(await operations.listSources(workspaceId, page.params));
}

async function createSource(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const workspaceId = stringValue(body.workspaceId);
  const name = stringValue(body.name);
  const sourceUrl = stringValue(body.url);
  if (!workspaceId || !name || !sourceUrl) {
    return errorJson(
      "invalid_request",
      "workspaceId, name, and url are required",
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
  const authConnectionId = stringValue(body.authConnectionId);
  if (authConnectionId) {
    const connection = await operations.getConnection(authConnectionId);
    if (
      connection.scope !== "space" ||
      connection.workspaceId !== workspaceId
    ) {
      const connectionWorkspaceId = connection.workspaceId;
      if (connectionWorkspaceId) {
        const connectionAuth = await requireWorkspaceAccess({
          operations,
          store,
          workspaceId: connectionWorkspaceId,
          subject: sessionSubject,
        });
        if (!connectionAuth.ok) return connectionAuth.response;
      }
      return errorJson(
        "invalid_request",
        "authConnectionId must belong to the target Workspace.",
        400,
      );
    }
  }
  const requestBody: CreateSourceRequest = {
    workspaceId,
    spaceId: workspaceId,
    name,
    url: sourceUrl,
    ...(stringValue(body.defaultRef)
      ? { defaultRef: stringValue(body.defaultRef) }
      : {}),
    ...(stringValue(body.defaultPath)
      ? { defaultPath: stringValue(body.defaultPath) }
      : {}),
    ...(authConnectionId ? { authConnectionId } : {}),
    ...(body.autoSync !== undefined
      ? { autoSync: booleanValue(body.autoSync) === true }
      : {}),
  };
  return jsonStatus(await operations.createSource(requestBody), 201);
}
