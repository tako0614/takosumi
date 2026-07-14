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
  InstallConfigLifecycleAction,
  InstallConfigVariableDefault,
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
  installExperienceValue,
  installConfigVariableDefaultValue,
  variablePresentationValue,
  outputShareEntries,
  outputShareSensitivePolicy,
  parseProviderBinding,
  parseProviderBindings,
  parseLimit,
  workspaceTypeValue,
  stringRecord,
  stringRecordValue,
} from "./parse.ts";
import { parseInterfaceBlueprintsValue } from "./interface-blueprints.ts";
import { defaultCapsuleOutputAllowlist } from "../../../../core/domains/capsules/default_install_config.ts";
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
    return await listInstallConfigs(
      operations,
      store,
      ctx.session.subject,
      url,
    );
  }
  if (segments.length === 2 && segments[0] === "capsule-configs") {
    if (method !== "GET" && method !== "PATCH") {
      return methodNotAllowed("GET, PATCH");
    }
    const installConfigId = decodeURIComponent(segments[1] ?? "");
    const config = await operations.capsules.getInstallConfig(installConfigId);
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
  const scopedWorkspaceId = config.workspaceId;
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
  const variablePresentationDefaults = body.variablePresentationDefaults;
  const variablePresentationPatch =
    body.variablePresentation === undefined
      ? undefined
      : variablePresentationValue(body.variablePresentation);
  const installExperiencePatch =
    body.installExperience === undefined
      ? undefined
      : installExperienceValue(body.installExperience);
  const outputAllowlistPatch =
    body.outputAllowlist === undefined
      ? undefined
      : outputAllowlistValue(body.outputAllowlist);
  const interfaceBlueprintsResult =
    body.interfaceBlueprints === undefined
      ? undefined
      : parseInterfaceBlueprintsValue(body.interfaceBlueprints);
  const interfaceBlueprintsPatch =
    interfaceBlueprintsResult?.ok === true
      ? interfaceBlueprintsResult.value
      : undefined;
  const lifecycleActionsPatch =
    body.lifecycleActions === undefined
      ? undefined
      : lifecycleActionsValue(body.lifecycleActions);
  const lifecycleActionPolicyPatch =
    body.lifecycleActionPolicy === undefined
      ? undefined
      : lifecycleActionPolicyValue(body.lifecycleActionPolicy);
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
    variablePresentationDefaults !== undefined &&
    !isPlainJsonObject(variablePresentationDefaults)
  ) {
    return errorJson(
      "invalid_request",
      "variablePresentationDefaults must be a JSON object",
      400,
    );
  }
  if (
    body.variablePresentation !== undefined &&
    variablePresentationPatch === undefined
  ) {
    return errorJson(
      "invalid_request",
      "variablePresentation must be an array of service-side variable declarations",
      400,
    );
  }
  if (
    body.installExperience !== undefined &&
    installExperiencePatch === undefined
  ) {
    return errorJson(
      "invalid_request",
      "installExperience must be a valid service-side projection declaration",
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
  if (
    interfaceBlueprintsResult !== undefined &&
    !interfaceBlueprintsResult.ok
  ) {
    return errorJson("invalid_request", interfaceBlueprintsResult.message, 400);
  }
  if (
    body.lifecycleActions !== undefined &&
    lifecycleActionsPatch === undefined
  ) {
    return errorJson(
      "invalid_request",
      "lifecycleActions must be versioned command action objects",
      400,
    );
  }
  if (
    body.lifecycleActionPolicy !== undefined &&
    lifecycleActionPolicyPatch === undefined
  ) {
    return errorJson(
      "invalid_request",
      "lifecycleActionPolicy must explicitly allow executors and runner capabilities, or be null",
      400,
    );
  }
  const variablePresentationDefaultValues: Record<
    string,
    InstallConfigVariableDefault
  > = {};
  for (const [key, value] of Object.entries(variableMappingPatch ?? {})) {
    if (!isJsonValue(value)) {
      return errorJson(
        "invalid_request",
        `variableMapping.${key} must be a JSON value`,
        400,
      );
    }
  }
  for (const [key, value] of Object.entries(
    variablePresentationDefaults ?? {},
  )) {
    const parsed = installConfigVariableDefaultValue(value);
    if (!parsed) {
      return errorJson(
        "invalid_request",
        `variablePresentationDefaults.${key} must be a literal, capsule_name, or workspace_scoped_capsule_name default`,
        400,
      );
    }
    variablePresentationDefaultValues[key] = parsed;
  }
  const nextVariablePresentation = (
    variablePresentationPatch ??
    config.variablePresentation ??
    []
  ).map((input) =>
    Object.prototype.hasOwnProperty.call(
      variablePresentationDefaultValues,
      input.name,
    )
      ? {
          ...input,
          defaultValue: variablePresentationDefaultValues[input.name],
        }
      : input,
  );
  const nextVariableMapping = { ...config.variableMapping };
  for (const name of removeVariables ?? []) {
    delete nextVariableMapping[name];
  }
  Object.assign(nextVariableMapping, variableMappingPatch ?? {});
  const nextPolicy = policyWithLifecycleActionPatch(
    config.policy,
    lifecycleActionPolicyPatch,
  );
  const now = new Date().toISOString();
  const updated = await operations.capsules.putInstallConfig({
    ...config,
    variableMapping: nextVariableMapping,
    variablePresentation: nextVariablePresentation,
    ...(installExperiencePatch
      ? { installExperience: installExperiencePatch }
      : {}),
    outputAllowlist: outputAllowlistPatch ?? config.outputAllowlist,
    interfaceBlueprints: interfaceBlueprintsPatch ?? config.interfaceBlueprints,
    lifecycleActions: lifecycleActionsPatch ?? config.lifecycleActions,
    policy: nextPolicy,
    updatedAt: now,
  });
  return json({ installConfig: publicInstallConfig(updated) });
}

function lifecycleActionsValue(
  value: unknown,
): readonly InstallConfigLifecycleAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: InstallConfigLifecycleAction[] = [];
  for (const item of value) {
    if (!isPlainJsonObject(item)) return undefined;
    if (
      item.apiVersion !== "takosumi.dev/v1alpha1" ||
      item.kind !== "command" ||
      typeof item.id !== "string" ||
      (item.phase !== "post_apply" && item.phase !== "pre_destroy") ||
      (item.executor !== "runner" && item.executor !== "operator") ||
      !Array.isArray(item.command) ||
      !item.command.every((part) => typeof part === "string") ||
      typeof item.runnerCapability !== "string" ||
      (item.workingDirectory !== undefined &&
        typeof item.workingDirectory !== "string") ||
      (item.timeoutSeconds !== undefined &&
        typeof item.timeoutSeconds !== "number") ||
      (item.useProviderCredentials !== undefined &&
        typeof item.useProviderCredentials !== "boolean") ||
      (item.env !== undefined && !stringRecordValue(item.env))
    ) {
      return undefined;
    }
    actions.push(item as unknown as InstallConfigLifecycleAction);
  }
  return actions;
}

type LifecycleActionPolicy = NonNullable<PolicyConfig["lifecycleActions"]>;

function lifecycleActionPolicyValue(
  value: unknown,
): LifecycleActionPolicy | null | undefined {
  if (value === null) return null;
  if (!isPlainJsonObject(value)) return undefined;
  if (
    !Array.isArray(value.allowedExecutors) ||
    !value.allowedExecutors.every(
      (executor) => executor === "runner" || executor === "operator",
    ) ||
    !Array.isArray(value.allowedRunnerCapabilities) ||
    !value.allowedRunnerCapabilities.every(
      (capability) => typeof capability === "string",
    ) ||
    (value.allowProviderCredentials !== undefined &&
      typeof value.allowProviderCredentials !== "boolean")
  ) {
    return undefined;
  }
  return value as unknown as LifecycleActionPolicy;
}

function policyWithLifecycleActionPatch(
  policy: PolicyConfig,
  patch: LifecycleActionPolicy | null | undefined,
): PolicyConfig {
  if (patch === undefined) return policy;
  if (patch !== null) return { ...policy, lifecycleActions: patch };
  const { lifecycleActions: _lifecycleActions, ...withoutLifecycleActions } =
    policy;
  return withoutLifecycleActions;
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
  const { runnerId: _runnerId, internal: _internal, ...publicRecord } = config;
  const store = config.store;
  return {
    ...publicRecord,
    ...(store ? { store } : {}),
  };
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
  return config.store?.source !== undefined;
}

async function listInstallConfigs(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const workspaceId = stringValue(
    url.searchParams.get("workspaceId") ?? undefined,
  );
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const view = parseInstallConfigListView(url);
  if (!view.ok) return view.response;
  // Without a workspaceId only shared configs (workspaceId-less configs) are
  // returned; with one, shared configs plus that Workspace's own configs —
  // mirroring the §30 `/api/v1/capsule-configs` projection. The shared +
  // scoped union is a small set, so it is materialized, merge-sorted by
  // (createdAt, id), and bounded with the in-memory keyset pager.
  const sharedConfigs = (await operations.capsules.listInstallConfigs()).filter(
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
    workspaceId === undefined || view.view === "store"
      ? []
      : (await operations.capsules.listInstallConfigs(workspaceId)).filter(
          isSelectableInstallConfig,
        );
  const merged = (
    view.view === "store"
      ? sharedConfigs.filter(isStoreInstallConfig)
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
