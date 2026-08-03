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
import { toPublicSourceSnapshot } from "takosumi-contract/sources";
import { TAKOSUMI_REPOSITORY_MANIFEST_PATH } from "../../../../contract/repository-manifest.ts";
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
import { normalizeInstallConfigSourceUrl } from "takosumi-contract/install-configs";
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
  latestSourceSnapshotForSource,
  previewRepoOwnedInstallConfig,
  resolveRepoOwnedInstallModulePath,
} from "./repo-owned-install-config.ts";
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
      if (path === TAKOSUMI_REPOSITORY_MANIFEST_PATH) {
        return errorJson(
          "invalid_request",
          "repository manifest content is available only through validated section compilers",
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
      // Manual Git callers may select an existing DB-owned InstallConfig.
      // Store compilation below resolves its unique global policy config by
      // canonical repository URL; the client cannot choose that authority.
      const installConfigId = stringValue(body.installConfigId);
      const compileInstallUx = body.compileInstallUx === true;
      const capsuleName = stringValue(body.capsuleName);
      if (
        body.compileInstallUx !== undefined &&
        typeof body.compileInstallUx !== "boolean"
      ) {
        return errorJson(
          "invalid_request",
          "compileInstallUx must be a boolean.",
          400,
        );
      }
      if (compileInstallUx && (!capsuleName || capsuleId)) {
        return errorJson(
          "invalid_request",
          "compileInstallUx requires capsuleName before a Capsule exists.",
          400,
        );
      }
      if (
        compileInstallUx &&
        (body.modulePath !== undefined || body.installConfigId !== undefined)
      ) {
        return errorJson(
          "invalid_request",
          "compileInstallUx resolves installConfigId and modulePath server-side; Store callers must not select them.",
          400,
          request,
        );
      }
      let installUxSnapshot: SourceSnapshot | undefined;
      let installUxModulePath: string | undefined;
      let installUxBaseConfig: InstallConfig | undefined;
      if (compileInstallUx) {
        installUxSnapshot = await latestSourceSnapshotForSource(
          operations,
          source,
        );
        if (
          !installUxSnapshot ||
          (sourceSnapshotId !== undefined &&
            installUxSnapshot.id !== sourceSnapshotId)
        ) {
          return errorJson(
            "repository_install_ux_invalid",
            "The source changed during install UX preflight; sync and review the latest snapshot.",
            409,
            request,
            {},
            {
              diagnosticCode:
                "repository_install_ux_compatibility_report_mismatch",
            },
          );
        }
        const moduleSelection = resolveRepoOwnedInstallModulePath({
          sourceSnapshot: installUxSnapshot,
        });
        if (!moduleSelection.ok) {
          return errorJson(
            "repository_install_ux_invalid",
            moduleSelection.diagnostic.message,
            400,
            request,
            {},
            { diagnosticCode: moduleSelection.diagnostic.code },
          );
        }
        installUxModulePath = moduleSelection.modulePath;
        const baseConfigResolution = await resolveStoreBaseInstallConfig(
          operations,
          source,
        );
        if (!baseConfigResolution.ok) {
          return errorJson(
            "repository_install_ux_invalid",
            baseConfigResolution.diagnostic.message,
            400,
            request,
            {},
            { diagnosticCode: baseConfigResolution.diagnostic.code },
          );
        }
        installUxBaseConfig = baseConfigResolution.installConfig;
      }
      const compatibilityRequest: CreateSourceCompatibilityCheckRequest = {
        ...(installUxSnapshot
          ? { sourceSnapshotId: installUxSnapshot.id }
          : sourceSnapshotId
            ? { sourceSnapshotId }
            : {}),
        ...(installUxModulePath
          ? { modulePath: installUxModulePath }
          : modulePath
            ? { modulePath }
            : {}),
        ...(capsuleId ? { capsuleId } : {}),
        ...(installUxBaseConfig
          ? { installConfigId: installUxBaseConfig.id }
          : installConfigId
            ? { installConfigId }
            : {}),
      };
      const compatibility = await operations.createSourceCompatibilityCheck(
        sourceId,
        compatibilityRequest,
      );
      if (!compileInstallUx) {
        return jsonStatus(
          await publicCompatibilityReportResponse(operations, compatibility),
          201,
        );
      }
      const latestSnapshot = installUxSnapshot;
      const reportSnapshotId = compatibility.report.sourceSnapshotId;
      if (!latestSnapshot || latestSnapshot.id !== reportSnapshotId) {
        return jsonStatus(
          await publicCompatibilityReportResponse(operations, {
            ...compatibility,
            repositoryInstallUx: {
              status: "invalid",
              diagnosticCode:
                "repository_install_ux_compatibility_report_mismatch",
              message:
                "The source changed during install UX preflight; sync and review the latest snapshot.",
            },
          }),
          201,
        );
      }
      const baseConfig = installUxBaseConfig!;
      if (
        baseConfig.workspaceId !== undefined &&
        baseConfig.workspaceId !== workspaceId
      ) {
        return errorJson(
          "invalid_request",
          "installConfigId is not available to the target Workspace.",
          400,
        );
      }
      const preview = await previewRepoOwnedInstallConfig({
        operations,
        source,
        sourceSnapshot: latestSnapshot,
        baseConfig,
        modulePath: installUxModulePath,
        capsuleName: capsuleName!,
        workspaceId,
        installingPrincipalId: ctx.session.subject,
        compatibilityReport: compatibility.report,
      });
      const repositoryInstallUx =
        preview.status === "accepted"
          ? {
              status: "accepted" as const,
              installConfigId: preview.installConfig.id,
            }
          : preview.status === "invalid"
            ? {
                status: "invalid" as const,
                diagnosticCode: preview.diagnostic.code,
                message: preview.diagnostic.message,
              }
            : { status: "absent" as const };
      return jsonStatus(
        await publicCompatibilityReportResponse(operations, {
          ...compatibility,
          repositoryInstallUx,
        }),
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

const STORE_BASE_CONFIG_PAGE_SIZE = 100;
const STORE_BASE_CONFIG_SCAN_LIMIT = 1_000;

type StoreBaseInstallConfigResolution =
  | { readonly ok: true; readonly installConfig: InstallConfig }
  | {
      readonly ok: false;
      readonly diagnostic: {
        readonly code:
          | "repository_install_ux_base_config_missing"
          | "repository_install_ux_base_config_ambiguous";
        readonly message: string;
      };
    };

/**
 * Resolve the policy ceiling for URL-only Store handoff. Only a selectable,
 * global service declaration whose presentation URL and source-selector URL
 * both name the registered repository is eligible. Legacy module paths are
 * deliberately ignored: repository manifest selection owns that decision.
 */
async function resolveStoreBaseInstallConfig(
  operations: ControlPlaneOperations,
  source: Source,
): Promise<StoreBaseInstallConfigResolution> {
  const matches: InstallConfig[] = [];
  let scanned = 0;
  const inspect = (configs: readonly InstallConfig[]): boolean => {
    scanned += configs.length;
    for (const config of configs) {
      if (!storeBaseInstallConfigMatchesSource(config, source)) continue;
      matches.push(config);
      if (matches.length > 1) return false;
    }
    return true;
  };

  const listPage = operations.capsules.listSharedInstallConfigsPage;
  if (!listPage) {
    return ambiguousStoreBaseConfig(
      "Takosumi cannot prove a unique Store InstallConfig without bounded global catalog pagination.",
    );
  }
  let cursor: string | undefined;
  let pagesScanned = 0;
  const seenCursors = new Set<string>();
  do {
    const page = await listPage.call(
      operations.capsules,
      {
        limit: STORE_BASE_CONFIG_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      },
      // Count internal rows toward the hard scan bound, then reject them in
      // storeBaseInstallConfigMatchesSource. Filtering after pagination could
      // otherwise walk an unbounded catalog while reporting few visible rows.
      { includeInternal: true },
    );
    pagesScanned += 1;
    if (!inspect(page.items)) return ambiguousStoreBaseConfig();
    if (scanned > STORE_BASE_CONFIG_SCAN_LIMIT) {
      return ambiguousStoreBaseConfig(
        "Takosumi could not prove a unique Store InstallConfig within the bounded global catalog scan.",
      );
    }
    cursor = page.nextCursor;
    if (!cursor) break;
    if (
      seenCursors.has(cursor) ||
      scanned >= STORE_BASE_CONFIG_SCAN_LIMIT ||
      pagesScanned >=
        Math.ceil(
          STORE_BASE_CONFIG_SCAN_LIMIT / STORE_BASE_CONFIG_PAGE_SIZE,
        )
    ) {
      return ambiguousStoreBaseConfig(
        "Takosumi could not prove a unique Store InstallConfig within the bounded global catalog scan.",
      );
    }
    seenCursors.add(cursor);
  } while (true);

  if (matches.length === 0) {
    return {
      ok: false,
      diagnostic: {
        code: "repository_install_ux_base_config_missing",
        message:
          "No global Store InstallConfig is registered for the Source repository URL.",
      },
    };
  }
  return { ok: true, installConfig: matches[0]! };
}

function storeBaseInstallConfigMatchesSource(
  config: InstallConfig,
  source: Source,
): boolean {
  if (
    config.workspaceId !== undefined ||
    config.internal !== undefined ||
    !config.store?.source ||
    !config.sourceSelector
  ) {
    return false;
  }
  const sourceUrl = source.url.trim();
  const storeUrl = config.store.source.url.trim();
  const selectorUrl = config.sourceSelector.url.trim();
  if (!sourceUrl || !storeUrl || !selectorUrl) return false;
  const canonicalSourceUrl = normalizeInstallConfigSourceUrl(sourceUrl);
  return (
    normalizeInstallConfigSourceUrl(storeUrl) === canonicalSourceUrl &&
    normalizeInstallConfigSourceUrl(selectorUrl) === canonicalSourceUrl
  );
}

function ambiguousStoreBaseConfig(
  message = "Multiple global Store InstallConfigs match the Source repository URL.",
): StoreBaseInstallConfigResolution {
  return {
    ok: false,
    diagnostic: {
      code: "repository_install_ux_base_config_ambiguous",
      message,
    },
  };
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
  return toPublicSourceSnapshot(snapshot);
}

function publicSourceSyncRun(run: Record<string, unknown>) {
  return run;
}
