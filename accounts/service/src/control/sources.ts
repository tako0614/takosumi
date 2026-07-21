/**
 * Session-authed Source (`/api/v1/sources`) and Compatibility Report
 * (`/api/v1/compatibility-reports/:id`) control routes. Extracted from
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
  SourceSnapshotFileResponse,
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

function sourceWorkspaceId(
  source: Readonly<{ workspaceId?: string }>,
): string | undefined {
  return stringValue(source.workspaceId);
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
        return await listSources(operations, store, ctx.session, url);
      }
      if (method === "POST") {
        return await createSource(request, operations, store, ctx.session);
      }
      return methodNotAllowed("GET, POST");
    }
    if (segments.length === 3 && segments[2] === "sync") {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      if (method !== "POST") return methodNotAllowed("POST");
      const body = await readOptionalJsonObject(request);
      if (body === null) {
        return errorJson("invalid_json", "invalid json body", 400);
      }
      const intent = body.intent ?? "observe";
      if (intent !== "observe" && intent !== "manual_plan") {
        return errorJson(
          "invalid_request",
          "intent must be observe or manual_plan",
          400,
        );
      }
      const { source } = await operations.getSource(sourceId);
      const workspaceId = sourceWorkspaceId(source);
      if (!workspaceId) return sourceWorkspaceIdentityMissing();
      const auth = await requireWorkspaceAccess({
        operations,
        store,
        workspaceId,
        session: ctx.session,
      });
      if (!auth.ok) return auth.response;
      const response = await operations.createSourceSync(sourceId, {
        dedupe: true,
        intent,
      });
      return jsonStatus(
        isRecord(response) && isRecord(response.run)
          ? { ...response, run: publicSourceSyncRun(response.run) }
          : response,
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
        session: ctx.session,
      });
      if (!auth.ok) return auth.response;
      const page = parseControlPageParams(url);
      if (!page.ok) return page.response;
      const response = await operations.listSourceSnapshots(
        sourceId,
        page.params,
      );
      return json({
        ...response,
        snapshots: response.snapshots.map(publicSourceSnapshot),
      });
    }
    if (
      segments.length === 5 &&
      segments[2] === "snapshots" &&
      segments[4] === "file"
    ) {
      if (method !== "GET") return methodNotAllowed("GET");
      const sourceId = decodeURIComponent(segments[1] ?? "");
      const sourceSnapshotId = decodeURIComponent(segments[3] ?? "");
      const { source } = await operations.getSource(sourceId);
      const workspaceId = sourceWorkspaceId(source);
      if (!workspaceId) return sourceWorkspaceIdentityMissing();
      const auth = await requireWorkspaceAccess({
        operations,
        store,
        workspaceId,
        session: ctx.session,
      });
      if (!auth.ok) return auth.response;
      if (source.authConnectionId) {
        return errorJson(
          "failed_precondition",
          "presentation-file inspection is limited to credential-free public Sources",
          409,
        );
      }
      const snapshot = await operations.getSourceSnapshot(sourceSnapshotId);
      if (snapshot.sourceId !== sourceId) {
        return errorJson("not_found", "SourceSnapshot not found", 404);
      }
      const path = presentationFilePath(url.searchParams.get("path"));
      if (!path) {
        return errorJson(
          "invalid_request",
          "path must be a safe relative JSON file path",
          400,
        );
      }
      const file = await operations.readSourceSnapshotPresentationFile(
        sourceSnapshotId,
        path,
      );
      return json({
        sourceSnapshotId,
        ...file,
      } satisfies SourceSnapshotFileResponse);
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
        session: ctx.session,
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
      // Store deep-link path: when no Capsule exists yet, gate the pre-install
      // check against the selected DB-owned InstallConfig. The instance-wide
      // default allowlist is never widened (see
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
        session: ctx.session,
      });
      if (!auth.ok) return auth.response;
      if (method === "GET") {
        return json({ source: publicSource(source) });
      }
      if (method === "PATCH") {
        const body = await readOptionalJsonObject(request);
        if (body === null) {
          return errorJson("invalid_json", "invalid json body", 400);
        }
        const response = await operations.patchSource(
          sourceId,
          body as PatchSourceRequest,
        );
        return json({ ...response, source: publicSource(response.source) });
      }
      return methodNotAllowed("GET, PATCH");
    }
  }
  return undefined;
}

function presentationFilePath(value: string | null): string | undefined {
  const path = modulePathValue(value ?? undefined);
  if (!path || path.length > 1_024 || !path.toLowerCase().endsWith(".json")) {
    return undefined;
  }
  return path;
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
        ? (await operations.capsules.getCapsule(report.capsuleId)).workspaceId
        : undefined;
    if (!reportWorkspaceId) {
      return errorJson("not_found", "compatibility report not found", 404);
    }
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: reportWorkspaceId,
      session: ctx.session,
    });
    if (!auth.ok) return auth.response;
    return json(await publicCompatibilityReportResponse(operations, response));
  }
  return undefined;
}

async function listSources(
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
  const response = await operations.listSources(workspaceId, page.params);
  return json({
    ...response,
    sources: response.sources.map(publicSource),
  });
}

async function createSource(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
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
    session,
  });
  if (!auth.ok) return auth.response;
  const authConnectionId = stringValue(body.authConnectionId);
  if (authConnectionId) {
    const connection = await operations.getConnection(authConnectionId);
    if (
      connection.scope !== "workspace" ||
      connection.workspaceId !== workspaceId
    ) {
      const connectionWorkspaceId = connection.workspaceId;
      if (connectionWorkspaceId) {
        const connectionAuth = await requireWorkspaceAccess({
          operations,
          store,
          workspaceId: connectionWorkspaceId,
          session,
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
  const response = await operations.createSource(requestBody);
  return jsonStatus(
    { ...response, source: publicSource(response.source) },
    201,
  );
}

function publicSource(source: Source) {
  return source;
}

function publicSourceSnapshot(snapshot: SourceSnapshot) {
  return snapshot;
}

function publicSourceSyncRun(run: Record<string, unknown>) {
  return run;
}
