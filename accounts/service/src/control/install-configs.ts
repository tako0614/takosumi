/**
 * Session-authed Capsule creation config (`/api/v1/capsule-configs`) control
 * routes. Extracted from `control-routes.ts` (P3 god-file split).
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
import { defaultCapsuleOutputAllowlist } from "../../../../core/domains/capsules/official_seed.ts";
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
  // /api/v1/capsule-configs, normalized to the historical handler key.
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
    if (method !== "GET" && method !== "PATCH") {
      return methodNotAllowed("GET, PATCH");
    }
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
    if (method === "GET") {
      return json({ installConfig: publicInstallConfig(config) });
    }
    return await patchScopedInstallConfig(request, operations, config);
  }
  return undefined;
}

async function patchScopedInstallConfig(
  request: Request,
  operations: ControlPlaneOperations,
  config: InstallConfig,
): Promise<Response> {
  const scopedWorkspaceId = config.workspaceId ?? config.spaceId;
  if (
    !scopedWorkspaceId ||
    config.internal?.reason !== "per_install_overrides"
  ) {
    return errorJson(
      "invalid_request",
      "only Workspace-scoped per-install Capsule configs can be patched",
      400,
    );
  }
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const variableMappingPatch = body.variableMapping;
  const removeVariables = stringArrayValue(body.removeVariables);
  const storeInputDefaults = body.storeInputDefaults;
  const outputAllowlistPatch =
    body.outputAllowlist === undefined
      ? undefined
      : outputAllowlistValue(body.outputAllowlist);
  if (
    variableMappingPatch !== undefined &&
    !isPlainJsonObject(variableMappingPatch)
  ) {
    return errorJson(
      "invalid_request",
      "variableMapping must be a JSON object",
      400,
    );
  }
  if (
    storeInputDefaults !== undefined &&
    !isPlainJsonObject(storeInputDefaults)
  ) {
    return errorJson(
      "invalid_request",
      "storeInputDefaults must be a JSON object",
      400,
    );
  }
  if (body.removeVariables !== undefined && removeVariables === undefined) {
    return errorJson(
      "invalid_request",
      "removeVariables must be an array of variable names",
      400,
    );
  }
  if (
    body.outputAllowlist !== undefined &&
    outputAllowlistPatch === undefined
  ) {
    return errorJson(
      "invalid_request",
      "outputAllowlist must be an object of { from, type, required? } entries",
      400,
    );
  }
  const storeInputDefaultStrings: Record<string, string> = {};
  for (const [key, value] of Object.entries(variableMappingPatch ?? {})) {
    if (!isJsonValue(value)) {
      return errorJson(
        "invalid_request",
        `variableMapping.${key} must be a JSON value`,
        400,
      );
    }
  }
  for (const [key, value] of Object.entries(storeInputDefaults ?? {})) {
    if (typeof value !== "string") {
      return errorJson(
        "invalid_request",
        `storeInputDefaults.${key} must be a string`,
        400,
      );
    }
    storeInputDefaultStrings[key] = value;
  }
  const existingStore = config.store;
  const nextVariableMapping = { ...config.variableMapping };
  for (const name of removeVariables ?? []) {
    delete nextVariableMapping[name];
  }
  Object.assign(nextVariableMapping, variableMappingPatch ?? {});
  const now = new Date().toISOString();
  const updated = await operations.installations.putInstallConfig({
    ...config,
    variableMapping: nextVariableMapping,
    outputAllowlist: outputAllowlistPatch ?? config.outputAllowlist,
    store:
      existingStore && storeInputDefaults
        ? {
            ...existingStore,
            inputs: existingStore.inputs.map((input) =>
              Object.prototype.hasOwnProperty.call(
                storeInputDefaultStrings,
                input.name,
              )
                ? {
                    ...input,
                    defaultValue: storeInputDefaultStrings[input.name],
                  }
                : input,
            ),
          }
        : existingStore,
    updatedAt: now,
  });
  return json({ installConfig: publicInstallConfig(updated) });
}

function stringArrayValue(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

export function publicInstallConfig(
  config: InstallConfig,
): PublicInstallConfig {
  const {
    installType: _installType,
    templateBinding: _templateBinding,
    sourceKind: _sourceKind,
    runnerId: _runnerId,
    internal: _internal,
    build: _build,
    prebuiltArtifact: _prebuiltArtifact,
    ...publicRecord
  } = config;
  const store = config.store;
  return {
    ...publicRecord,
    ...(store ? { store } : {}),
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

function isStoreInstallConfig(config: InstallConfig): boolean {
  if (config.workspaceId !== undefined) return false;
  if (config.store?.source === undefined) return false;
  if (config.sourceKind !== "generic_capsule") return false;
  return config.trustLevel === "trusted";
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
      config.workspaceId === undefined &&
      config.spaceId === undefined &&
      isSelectableInstallConfig(config),
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
    workspaceId === undefined || view.view === "store"
      ? []
      : (await operations.installations.listInstallConfigs(workspaceId)).filter(
          isSelectableInstallConfig,
        );
  const merged = (
    view.view === "store"
      ? official.filter(isStoreInstallConfig)
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

export function isSelectableInstallConfig(config: InstallConfig): boolean {
  if (config.internal?.reason === "per_install_overrides") return false;
  const scopedId = config.workspaceId ?? config.spaceId;
  if (scopedId !== undefined && /^icfg_[0-9a-f]{16}$/iu.test(config.id)) {
    return false;
  }
  return true;
}
