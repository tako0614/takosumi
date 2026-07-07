/**
 * Session-authed Capsule (`/api/v1/capsules`)
 * control routes: read/patch/destroy-plan, plan / destroy-plan / drift-check,
 * backups, state-versions (deployments) list, dependencies create/list,
 * provider-connection bindings. Extracted from `control-routes.ts` (P3 split).
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
  deployProjectionModeValue,
  saveProjectionStatusChange,
  syncDeployControlProjectionFromApply,
  syncDeployControlProjectionFromDeploy,
  syncDeployControlProjectionStatusFromRun,
} from "./projection.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/official_seed.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { appendLedgerEvent } from "../installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { canTransitionAppCapsuleStatus } from "../ledger.ts";
import { ensureTakosumiAccountsOidcForExistingCapsule } from "./capsule-oidc.ts";

export async function handleCapsules(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/capsules/:id ; .../plan ; .../destroy-plan ; .../dependencies,
  // normalized to the historical handler key.
  if (segments[0] === "installations" && segments.length >= 2) {
    const capsuleId = decodeURIComponent(segments[1] ?? "");
    const installation =
      await operations.installations.getCapsule(capsuleId);
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: installation.workspaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method === "GET") {
        return json({ capsule: publicCapsule(installation) });
      }
      if (method === "PATCH") {
        return await patchCapsule(request, operations, capsuleId);
      }
      if (method === "DELETE") {
        return await deleteCapsule(
          operations,
          store,
          installation,
          capsuleId,
        );
      }
      return methodNotAllowed("GET, PATCH, DELETE");
    }
    const leaf = segments[2];
    if (leaf === "plan" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const body = await readJsonObject(request.clone()).catch(() => null);
      const compatibilityReportId =
        typeof body?.compatibilityReportId === "string" &&
        body.compatibilityReportId.trim()
          ? body.compatibilityReportId.trim()
          : undefined;
      const runnerProfileId =
        typeof body?.runnerId === "string" && body.runnerId.trim()
          ? body.runnerId.trim()
          : typeof body?.runnerProfileId === "string" &&
              body.runnerProfileId.trim()
            ? body.runnerProfileId.trim()
            : undefined;
      await ensureTakosumiAccountsOidcForExistingCapsule({
        operations,
        store,
        issuer: ctx.issuer,
        capsule: installation,
      });
      const response = await operations.createCapsulePlan(
        capsuleId,
        compatibilityReportId || runnerProfileId
          ? {
              ...(compatibilityReportId ? { compatibilityReportId } : {}),
              ...(runnerProfileId ? { runnerProfileId } : {}),
            }
          : undefined,
      );
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    if (leaf === "destroy-plan" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const body = await readJsonObject(request.clone()).catch(() => null);
      const runnerProfileId =
        typeof body?.runnerId === "string" && body.runnerId.trim()
          ? body.runnerId.trim()
          : typeof body?.runnerProfileId === "string" &&
              body.runnerProfileId.trim()
            ? body.runnerProfileId.trim()
            : undefined;
      const response = await operations.createCapsuleDestroyPlan(
        capsuleId,
        runnerProfileId ? { runnerProfileId } : undefined,
      );
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    if (leaf === "drift-check" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const response =
        await operations.createCapsuleDriftCheck(capsuleId);
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    if (leaf === "backups" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const backup = await operations.backups.createBackup({
        workspaceId: installation.workspaceId,
        capsuleId: installation.id,
        environment: installation.environment,
      });
      return jsonStatus({ backup } satisfies CreateBackupResponse, 201);
    }
    if (leaf === "deployments" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await listCapsuleDeployments(operations, capsuleId, url);
    }
    if (leaf === "dependencies" && segments.length === 3) {
      if (method === "GET") {
        return json(
          await operations.dependencies.listForCapsule(capsuleId),
        );
      }
      if (method !== "POST") return methodNotAllowed("GET, POST");
      return await createDependency(
        request,
        operations,
        store,
        ctx.session.subject,
        capsuleId,
      );
    }
    if (leaf === "provider-connections" && segments.length === 3) {
      if (method === "GET") {
        return await getCapsuleProviderConnectionSet(
          operations,
          installation,
        );
      }
      if (method === "PUT") {
        return await putCapsuleProviderConnectionSet(
          request,
          operations,
          installation,
        );
      }
      return methodNotAllowed("GET, PUT");
    }
  }
  return undefined;
}

const API_PATCHABLE_INSTALLATION_STATUSES: ReadonlySet<Capsule["status"]> =
  new Set(["active", "stale", "error"]);

/**
 * Lists an Capsule's Deployment ledger for the dashboard session. The
 * caller has already resolved the Capsule and space-permission gated on its
 * Workspace (see dispatch); each row is projected to drop the raw Output
 * pointer and carries only the allowlist-projected `outputsPublic`.
 */
async function listCapsuleDeployments(
  operations: ControlPlaneOperations,
  capsuleId: string,
  url: URL,
): Promise<Response> {
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const { deployments, nextCursor } = await operations.listDeployments(
    capsuleId,
    page.params,
  );
  return json({
    deployments: deployments.map(publicDeployment),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

async function getCapsule(
  operations: ControlPlaneOperations,
  capsuleId: string,
): Promise<Response> {
  const installation =
    await operations.installations.getCapsule(capsuleId);
  return json({
    capsule: publicCapsule(installation),
  });
}

async function patchCapsule(
  request: Request,
  operations: ControlPlaneOperations,
  capsuleId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const status = stringValue(body.status) as Capsule["status"] | undefined;
  if (!status) {
    return errorJson("invalid_request", "status is required", 400);
  }
  if (!API_PATCHABLE_INSTALLATION_STATUSES.has(status)) {
    return errorJson(
      "invalid_request",
      "status may only be patched to active, stale, or error; destroy states must use the destroy flow",
      400,
    );
  }
  const installation = await operations.installations.patchCapsuleStatus(
    capsuleId,
    status,
  );
  return json({ capsule: publicCapsule(installation) });
}

async function deleteCapsule(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  installation: Capsule,
  capsuleId: string,
): Promise<Response> {
  try {
    const response =
      await operations.createCapsuleDestroyPlan(capsuleId);
    return jsonStatus(
      await publicPlanActionResponse(operations, response),
      202,
    );
  } catch (error) {
    const abandoned = await maybeAbandonUnappliedCapsule({
      error,
      operations,
      store,
      installation,
    });
    if (abandoned) return abandoned;
    throw error;
  }
}

async function maybeAbandonUnappliedCapsule(input: {
  readonly error: unknown;
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly installation: Capsule;
}): Promise<Response | undefined> {
  if (
    input.installation.currentDeploymentId ||
    input.installation.currentStateGeneration > 0
  ) {
    return undefined;
  }
  const reason = unappliedCapsuleAbandonReason(input.error);
  if (!reason) return undefined;
  const projection = await input.store.findAppCapsule(
    input.installation.id,
  );
  if (!projection) return undefined;
  const installation =
    await input.operations.installations.patchCapsuleStatus(
      input.installation.id,
      "error",
    );
  await saveProjectionStatusChange({
    store: input.store,
    installation: projection,
    requestedStatus: "failed",
    reason,
  });
  const updatedProjection = await input.store.findAppCapsule(
    input.installation.id,
  );
  return jsonStatus(
    {
      capsule: publicCapsule(installation),
      abandoned: true,
      projectionStatus: updatedProjection?.status ?? "failed",
    },
    202,
  );
}

function unappliedCapsuleAbandonReason(
  error: unknown,
): string | undefined {
  if (isUploadOriginSnapshotMissingError(error)) {
    return "delete requested before first upload-origin apply";
  }
  if (isProviderConnectionNotReadyForDestroyError(error)) {
    return "delete requested before first apply while provider connection is not ready";
  }
  return undefined;
}

function isUploadOriginSnapshotMissingError(error: unknown): boolean {
  if (controllerErrorCode(error) !== "failed_precondition") return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    (message.includes("is upload-origin") ||
      message.includes("has no git Source")) &&
    (message.includes("pinned upload SourceSnapshot") ||
      message.includes("pinned upload/artifact SourceSnapshot"))
  );
}

function isProviderConnectionNotReadyForDestroyError(error: unknown): boolean {
  if (controllerErrorCode(error) !== "failed_precondition") return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    (/\bProvider Env\b/.test(message) &&
      /\bstatus\b/.test(message) &&
      /\bis not ready\b/.test(message)) ||
    (/credential_mint_failed:/u.test(message) &&
      /\bconnection\b/u.test(message) &&
      /\bpending\b/u.test(message)) ||
    (/\bconnection\b/u.test(message) &&
      /\bis pending\b/u.test(message) &&
      /\bnot verified\b/u.test(message))
  );
}

async function getCapsuleProviderConnectionSet(
  operations: ControlPlaneOperations,
  installation: Capsule,
): Promise<Response> {
  const profile =
    await operations.installations.getCapsuleProviderEnvBindingSetByCapsule(
      installation.id,
      installation.environment,
    );
  return json({
    providerConnectionSet: profile
      ? await publicCapsuleProviderConnectionSet(profile)
      : null,
  });
}

async function putCapsuleProviderConnectionSet(
  request: Request,
  operations: ControlPlaneOperations,
  installation: Capsule,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const parsed = parseCapsuleProviderConnectionBindings(body.connections);
  if (!parsed.ok) {
    return errorJson("invalid_request", parsed.message, 400);
  }
  const resolved = await resolveProviderConnectionBindings(
    operations,
    installation.workspaceId,
    parsed.bindings,
  );
  if (!resolved.ok) {
    return errorJson("invalid_request", resolved.message, 400);
  }
  const existing =
    await operations.installations.getCapsuleProviderEnvBindingSetByCapsule(
      installation.id,
      installation.environment,
    );
  const now = new Date().toISOString();
  const profile =
    await operations.installations.putCapsuleProviderEnvBindingSet({
      id:
        existing?.id ??
        `dpf_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      workspaceId: installation.workspaceId,
      spaceId: installation.workspaceId,
      capsuleId: installation.id,
      installationId: installation.id,
      environment: installation.environment,
      bindings: resolved.bindings,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  return json({
    providerConnectionSet:
      await publicCapsuleProviderConnectionSet(profile),
  });
}

function publicCapsuleProviderConnectionSet(
  profile: CapsuleProviderEnvBindingSet,
): CapsuleProviderConnectionSet {
  return {
    id: profile.id,
    workspaceId: profile.workspaceId,
    spaceId: profile.workspaceId,
    capsuleId: profile.capsuleId,
    installationId: profile.capsuleId,
    environment: profile.environment,
    bindings: profile.bindings.map((binding) => ({
      provider: binding.provider,
      connectionId: binding.connectionId,
      ...(binding.alias ? { alias: binding.alias } : {}),
      ...(binding.region ? { region: binding.region } : {}),
    })),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

// --- Dependencies ----------------------------------------------------------

async function createDependency(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  consumerCapsuleId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const producerCapsuleId = stringValue(body.producerCapsuleId);
  if (!producerCapsuleId) {
    return errorJson(
      "invalid_request",
      "producerCapsuleId is required",
      400,
    );
  }
  // The consumer is the path Capsule; resolve its Workspace so the edge is
  // created in the right Workspace (mirrors the §30 dependency-create handler).
  const consumer = await operations.installations.getCapsule(
    consumerCapsuleId,
  );
  const consumerAuth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId: consumer.workspaceId,
    subject: sessionSubject,
  });
  if (!consumerAuth.ok) return consumerAuth.response;
  const producer = await operations.installations.getCapsule(
    producerCapsuleId,
  );
  const producerAuth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId: producer.workspaceId,
    subject: sessionSubject,
  });
  if (!producerAuth.ok) return producerAuth.response;
  const dependency = await operations.dependencies.createDependency({
    workspaceId: consumer.workspaceId,
    producerCapsuleId,
    consumerCapsuleId,
    mode: dependencyModeValue(body.mode) ?? "variable_injection",
    outputs: isOutputsMapping(body.outputs) ? body.outputs : {},
    visibility: dependencyVisibilityValue(body.visibility) ?? "space",
  });
  return jsonStatus({ dependency }, 201);
}
