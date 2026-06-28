/**
 * Session-authed Capsule creation config (`/api/v1/capsule-configs`, legacy
 * `/api/v1/install-configs`) control routes. Extracted from `control-routes.ts`
 * (P3 god-file split).
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
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/official_seed.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { appendLedgerEvent } from "../installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { canTransitionAppCapsuleStatus } from "../ledger.ts";

export async function handleInstallConfigs(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/capsule-configs (legacy-compatible: /api/v1/install-configs)
  if (segments.length === 1 && segments[0] === "install-configs") {
    if (method !== "GET") return methodNotAllowed("GET");
    return await listInstallConfigs(
      operations,
      store,
      ctx.session.subject,
      url,
    );
  }
  if (segments.length === 2 && segments[0] === "install-configs") {
    if (method !== "GET") return methodNotAllowed("GET");
    const installConfigId = decodeURIComponent(segments[1] ?? "");
    const config =
      await operations.installations.getInstallConfig(installConfigId);
    if (config.workspaceId !== undefined) {
      const auth = await requireWorkspaceAccess({
        operations,
        store,
        workspaceId: config.workspaceId,
        subject: ctx.session.subject,
      });
      if (!auth.ok) return auth.response;
    }
    return json({ installConfig: publicInstallConfig(config) });
  }
  return undefined;
}

function publicInstallConfig(config: InstallConfig): PublicInstallConfig {
  const {
    installType: _installType,
    templateBinding: _templateBinding,
    sourceKind: _sourceKind,
    runnerId: _runnerId,
    internal: _internal,
    ...publicRecord
  } = config;
  return {
    ...publicRecord,
    sourceKind: publicInstallConfigSourceKind(config),
  };
}

function publicInstallConfigSourceKind(
  config: InstallConfig,
): PublicInstallConfig["sourceKind"] {
  if (config.sourceKind === "generic_capsule") return "generic_capsule";
  if (
    config.sourceKind === "first_party_capsule" ||
    config.sourceKind === "official_template" ||
    config.templateBinding
  ) {
    return "first_party_capsule";
  }
  return "generic_capsule";
}

type InstallConfigListView = "all" | "starter-catalog";

function parseInstallConfigListView(
  url: URL,
):
  | { readonly ok: true; readonly view: InstallConfigListView }
  | { readonly ok: false; readonly response: Response } {
  const raw =
    url.searchParams.get("view") ?? url.searchParams.get("catalogView");
  if (raw === null || raw === "" || raw === "all") {
    return { ok: true, view: "all" };
  }
  if (raw === "starter-catalog") {
    return { ok: true, view: "starter-catalog" };
  }
  return {
    ok: false,
    response: errorJson(
      "invalid_request",
      "view must be all or starter-catalog",
      400,
    ),
  };
}

function isStarterCatalogInstallConfig(config: InstallConfig): boolean {
  if (config.workspaceId !== undefined) return false;
  if (config.id === DEFAULT_CAPSULE_INSTALL_CONFIG_ID) return true;
  return (
    config.trustLevel === "official" && config.catalog?.source !== undefined
  );
}

async function listInstallConfigs(
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
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const view = parseInstallConfigListView(url);
  if (!view.ok) return view.response;
  // Without a workspaceId only built-in shared configs (workspaceId-less configs) are
  // returned; with one, built-ins plus that Workspace's own configs —
  // mirroring the §30 `/api/v1/capsule-configs` projection. The official +
  // scoped union is a small set, so it is materialized, merge-sorted by
  // (createdAt, id), and bounded with the in-memory keyset pager.
  const official = (await operations.installations.listInstallConfigs()).filter(
    (config) =>
      config.workspaceId === undefined && isSelectableInstallConfig(config),
  );
  if (workspaceId !== undefined) {
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId,
      subject: sessionSubject,
    });
    if (!auth.ok) return auth.response;
  }
  const scoped =
    workspaceId === undefined
      ? []
      : (await operations.installations.listInstallConfigs(workspaceId)).filter(
          isSelectableInstallConfig,
        );
  const merged = (
    view.view === "starter-catalog"
      ? official.filter(isStarterCatalogInstallConfig)
      : [...official, ...scoped]
  ).sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const { items, nextCursor } = pageSorted(merged, page.params);
  return json({
    installConfigs: items.map(publicInstallConfig),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

function isSelectableInstallConfig(config: InstallConfig): boolean {
  if (config.internal?.reason === "per_install_overrides") return false;
  if (config.workspaceId !== undefined && /^icfg_[0-9a-f]{16}$/iu.test(config.id)) {
    return false;
  }
  return true;
}
