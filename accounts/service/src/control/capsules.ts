/**
 * Session-authed Capsule (`/api/v1/capsules`, legacy `/api/v1/installations`)
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
import type { Space, SpaceType } from "takosumi-contract/spaces";
import type {
  InstallationProviderEnvBindingSet,
  InstallConfig,
  Installation,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicInstallation,
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
  InstallationProviderConnectionBinding,
  InstallationProviderConnectionBindings,
  InstallationProviderEnvBinding,
  InstallationProviderEnvBindings,
  InstallationProviderConnectionSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type {
  OutputShare,
  OutputShareEntry,
} from "takosumi-contract/output-snapshots";
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
  AppInstallationMode,
  AppInstallationStatus,
  InstallationRecord,
  SpaceKind,
} from "../ledger.ts";
import type { SharedCellRuntimeAllocator } from "../runtime.ts";
import type { AccountsStore } from "../store.ts";
import type {
  ControlPlaneOperations,
  RunGroupWithRunsLike,
  ControlSpaceRole,
  ControlMembershipStatus,
  PublicSpaceMember,
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
  canAccessSpace,
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
  publicInstallation,
  publicPlanActionResponse,
  publicRun,
  requireSpaceAccess,
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
  parseInstallationProviderConnectionBinding,
  parseInstallationProviderConnectionBindings,
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
} from "../../../../core/domains/installations/official_seed.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { appendLedgerEvent } from "../installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { canTransitionAppInstallationStatus } from "../ledger.ts";

export async function handleCapsules(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/capsules/:id ; .../plan ; .../destroy-plan ; .../dependencies
  // (legacy-compatible: /api/v1/installations/:id)
  if (segments[0] === "installations" && segments.length >= 2) {
    const installationId = decodeURIComponent(segments[1] ?? "");
    const installation =
      await operations.installations.getInstallation(installationId);
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: installation.spaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method === "GET") {
        return json({ installation: publicInstallation(installation) });
      }
      if (method === "PATCH") {
        return await patchInstallation(request, operations, installationId);
      }
      if (method === "DELETE") {
        return await deleteInstallation(
          operations,
          store,
          installation,
          installationId,
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
      const response = await operations.createInstallationPlan(
        installationId,
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
      const response = await operations.createInstallationDestroyPlan(
        installationId,
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
        await operations.createInstallationDriftCheck(installationId);
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    if (leaf === "backups" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const backup = await operations.backups.createBackup({
        spaceId: installation.spaceId,
        installationId: installation.id,
        environment: installation.environment,
      });
      return jsonStatus({ backup } satisfies CreateBackupResponse, 201);
    }
    if (leaf === "deployments" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await listInstallationDeployments(operations, installationId, url);
    }
    if (leaf === "dependencies" && segments.length === 3) {
      if (method === "GET") {
        return json(
          await operations.dependencies.listForInstallation(installationId),
        );
      }
      if (method !== "POST") return methodNotAllowed("GET, POST");
      return await createDependency(
        request,
        operations,
        store,
        ctx.session.subject,
        installationId,
      );
    }
    if (leaf === "provider-connections" && segments.length === 3) {
      if (method === "GET") {
        return await getInstallationProviderConnectionSet(
          operations,
          installation,
        );
      }
      if (method === "PUT") {
        return await putInstallationProviderConnectionSet(
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

const API_PATCHABLE_INSTALLATION_STATUSES: ReadonlySet<Installation["status"]> =
  new Set(["active", "stale", "error"]);

/**
 * Lists an Installation's Deployment ledger for the dashboard session. The
 * caller has already resolved the Installation and space-permission gated on its
 * Space (see dispatch); each row is projected to drop the raw OutputSnapshot
 * pointer and carries only the allowlist-projected `outputsPublic`.
 */
async function listInstallationDeployments(
  operations: ControlPlaneOperations,
  installationId: string,
  url: URL,
): Promise<Response> {
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const { deployments, nextCursor } = await operations.listDeployments(
    installationId,
    page.params,
  );
  return json({
    deployments: deployments.map(publicDeployment),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

async function getInstallation(
  operations: ControlPlaneOperations,
  installationId: string,
): Promise<Response> {
  const installation =
    await operations.installations.getInstallation(installationId);
  return json({
    installation: publicInstallation(installation),
  });
}

async function patchInstallation(
  request: Request,
  operations: ControlPlaneOperations,
  installationId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const status = stringValue(body.status) as Installation["status"] | undefined;
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
  const installation = await operations.installations.patchInstallationStatus(
    installationId,
    status,
  );
  return json({ installation: publicInstallation(installation) });
}

async function deleteInstallation(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  installation: Installation,
  installationId: string,
): Promise<Response> {
  try {
    const response =
      await operations.createInstallationDestroyPlan(installationId);
    return jsonStatus(
      await publicPlanActionResponse(operations, response),
      202,
    );
  } catch (error) {
    const abandoned = await maybeAbandonUnappliedInstallation({
      error,
      operations,
      store,
      installation,
    });
    if (abandoned) return abandoned;
    throw error;
  }
}

async function maybeAbandonUnappliedInstallation(input: {
  readonly error: unknown;
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly installation: Installation;
}): Promise<Response | undefined> {
  if (
    input.installation.currentDeploymentId ||
    input.installation.currentStateGeneration > 0
  ) {
    return undefined;
  }
  const reason = unappliedInstallationAbandonReason(input.error);
  if (!reason) return undefined;
  const projection = await input.store.findAppInstallation(
    input.installation.id,
  );
  if (!projection) return undefined;
  const installation =
    await input.operations.installations.patchInstallationStatus(
      input.installation.id,
      "error",
    );
  await saveProjectionStatusChange({
    store: input.store,
    installation: projection,
    requestedStatus: "failed",
    reason,
  });
  const updatedProjection = await input.store.findAppInstallation(
    input.installation.id,
  );
  return jsonStatus(
    {
      installation: publicInstallation(installation),
      abandoned: true,
      projectionStatus: updatedProjection?.status ?? "failed",
    },
    202,
  );
}

function unappliedInstallationAbandonReason(
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
    /\bProvider Env\b/.test(message) &&
    /\bstatus\b/.test(message) &&
    /\bis not ready\b/.test(message)
  );
}

async function getInstallationProviderConnectionSet(
  operations: ControlPlaneOperations,
  installation: Installation,
): Promise<Response> {
  const profile =
    await operations.installations.getInstallationProviderEnvBindingSetByInstallation(
      installation.id,
      installation.environment,
    );
  return json({
    providerConnectionSet: profile
      ? await publicInstallationProviderConnectionSet(profile)
      : null,
  });
}

async function putInstallationProviderConnectionSet(
  request: Request,
  operations: ControlPlaneOperations,
  installation: Installation,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const parsed = parseInstallationProviderConnectionBindings(body.connections);
  if (!parsed.ok) {
    return errorJson("invalid_request", parsed.message, 400);
  }
  const resolved = await resolveProviderConnectionBindings(
    operations,
    installation.spaceId,
    parsed.bindings,
  );
  if (!resolved.ok) {
    return errorJson("invalid_request", resolved.message, 400);
  }
  const existing =
    await operations.installations.getInstallationProviderEnvBindingSetByInstallation(
      installation.id,
      installation.environment,
    );
  const now = new Date().toISOString();
  const profile =
    await operations.installations.putInstallationProviderEnvBindingSet({
      id:
        existing?.id ??
        `dpf_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      spaceId: installation.spaceId,
      installationId: installation.id,
      environment: installation.environment,
      bindings: resolved.bindings,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  return json({
    providerConnectionSet:
      await publicInstallationProviderConnectionSet(profile),
  });
}

function publicInstallationProviderConnectionSet(
  profile: InstallationProviderEnvBindingSet,
): InstallationProviderConnectionSet {
  return {
    id: profile.id,
    spaceId: profile.spaceId,
    installationId: profile.installationId,
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
  consumerInstallationId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const producerInstallationId = stringValue(body.producerInstallationId);
  if (!producerInstallationId) {
    return errorJson(
      "invalid_request",
      "producerInstallationId is required",
      400,
    );
  }
  // The consumer is the path Installation; resolve its Space so the edge is
  // created in the right Space (mirrors the §30 dependency-create handler).
  const consumer = await operations.installations.getInstallation(
    consumerInstallationId,
  );
  const consumerAuth = await requireSpaceAccess({
    operations,
    store,
    spaceId: consumer.spaceId,
    subject: sessionSubject,
  });
  if (!consumerAuth.ok) return consumerAuth.response;
  const producer = await operations.installations.getInstallation(
    producerInstallationId,
  );
  const producerAuth = await requireSpaceAccess({
    operations,
    store,
    spaceId: producer.spaceId,
    subject: sessionSubject,
  });
  if (!producerAuth.ok) return producerAuth.response;
  const dependency = await operations.dependencies.createDependency({
    spaceId: consumer.spaceId,
    producerInstallationId,
    consumerInstallationId,
    mode: dependencyModeValue(body.mode) ?? "variable_injection",
    outputs: isOutputsMapping(body.outputs) ? body.outputs : {},
    visibility: dependencyVisibilityValue(body.visibility) ?? "space",
  });
  return jsonStatus({ dependency }, 201);
}
