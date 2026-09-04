/**
 * Session-authed Capsule creation config (`/api/v1/capsule-configs`) control
 * routes. Extracted from `control-routes.ts` (P3 god-file split).
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
  isOutputsMapping,
  jsonRecordValue,
  modulePathValue,
  outputShareEntries,
  outputShareSensitivePolicy,
  parseProviderBinding,
  parseProviderBindings,
  parseLimit,
  workspaceTypeValue,
  stringRecord,
  stringRecordValue,
} from "./parse.ts";
import { defaultCapsuleOutputAllowlist } from "../../../../core/domains/capsules/default_install_config.ts";
import { publicInstallConfigRecord } from "../../../../core/domains/capsules/public_install_config.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { base64UrlEncodeBytes } from "../encoding.ts";

export async function handleInstallConfigs(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/capsule-configs, normalized to the historical handler key.
  if (segments.length === 1 && segments[0] === "capsule-configs") {
    if (method !== "GET") return methodNotAllowed("GET");
    return await listInstallConfigs(operations, store, ctx.session, url);
  }
  if (segments.length === 2 && segments[0] === "capsule-configs") {
    const installConfigId = decodeURIComponent(segments[1] ?? "");
    const config = await operations.capsules.getInstallConfig(installConfigId);
    if (config.workspaceId !== undefined) {
      const auth = await requireWorkspaceAccess({
        operations,
        store,
        workspaceId: config.workspaceId,
        session: ctx.session,
      });
      if (!auth.ok) return auth.response;
    }
    if (method === "GET") {
      return json({ installConfig: publicInstallConfig(config) });
    }
    return methodNotAllowed("GET");
  }
  return undefined;
}

export function publicInstallConfig(
  config: InstallConfig,
): PublicInstallConfig {
  return publicInstallConfigRecord(config);
}

type InstallConfigListView = "all" | "store";

function parseInstallConfigListView(
  url: URL,
):
  | { readonly ok: true; readonly view: InstallConfigListView }
  | { readonly ok: false; readonly response: Response } {
  const raw = url.searchParams.get("view");
  if (raw === null || raw === "" || raw === "all") {
    return { ok: true, view: "all" };
  }
  if (raw === "store") {
    return { ok: true, view: "store" };
  }
  return {
    ok: false,
    response: errorJson("invalid_request", "view must be all or store", 400),
  };
}

async function listInstallConfigs(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  url: URL,
): Promise<Response> {
  const workspaceId = stringValue(
    url.searchParams.get("workspaceId") ?? undefined,
  );
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const view = parseInstallConfigListView(url);
  if (!view.ok) return view.response;
  if (workspaceId !== undefined) {
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId,
      session,
    });
    if (!auth.ok) return auth.response;
  }
  const listUnionPage = operations.capsules.listInstallConfigUnionPage;
  if (listUnionPage) {
    const { items, nextCursor } = await listUnionPage.call(
      operations.capsules,
      workspaceId,
      page.params,
      { view: view.view },
    );
    return json({
      installConfigs: items.map(publicInstallConfig),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    });
  }
  const [sharedRows, scopedRows] = await Promise.all([
    operations.capsules.listSharedInstallConfigs(),
    workspaceId === undefined || view.view === "store"
      ? Promise.resolve([])
      : operations.capsules.listInstallConfigs(workspaceId),
  ]);
  const sharedConfigs = sharedRows.filter(
    (config) =>
      config.workspaceId === undefined && isSelectableInstallConfig(config),
  );
  const scoped = scopedRows.filter(isSelectableInstallConfig);
  const merged = (
    view.view === "store"
      ? sharedConfigs.filter((config) => config.store?.source !== undefined)
      : [...sharedConfigs, ...scoped]
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

export function isSelectableInstallConfig(config: InstallConfig): boolean {
  if (config.internal?.reason === "per_install_overrides") return false;
  const scopedId = config.workspaceId;
  if (scopedId !== undefined && /^icfg_[0-9a-f]{16}$/iu.test(config.id)) {
    return false;
  }
  return true;
}
