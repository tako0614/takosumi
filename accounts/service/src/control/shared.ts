/**
 * Shared substrate for the session-authed `/api/v1` control surface: response
 * projections, the Space access gate, page-param parsing, controller-error
 * mapping, and the dispatch context type. Extracted from `control-routes.ts`
 * (P3 god-file split) so per-resource `control/<resource>.ts` modules import
 * cross-cutting helpers from one place.
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
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE } from "@takosumi/internal/deploy-control-api";

/**
 * Per-resource dispatch context: the inputs each `control/<resource>.ts`
 * handler receives from `handleControlRoute`'s dispatch table.
 */
export interface ControlDispatchContext {
  readonly request: Request;
  readonly url: URL;
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly session: { readonly subject: string };
  readonly sharedCellRuntime?: SharedCellRuntimeAllocator;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PublicInstallationInput = PublicInstallation &
  Partial<Pick<Installation, "installType" | "currentOutputSnapshotId">>;

export function publicInstallation(
  installation: PublicInstallationInput,
): PublicInstallation {
  const {
    installType: _installType,
    currentOutputSnapshotId: _currentOutputSnapshotId,
    ...publicRecord
  } = installation;
  return publicRecord;
}

/**
 * Public projection of a Deployment for the account-plane session surface. It
 * keeps the allowlist-projected `outputsPublic` map (sensitive outputs never
 * enter the ledger row) and drops the `outputSnapshotId` pointer to the raw
 * encrypted OutputSnapshot, so the dashboard read never exposes a handle to the
 * un-projected output envelope. The raw envelope is reachable only through the
 * explicit OutputShare flow, not this read.
 */
export function publicDeployment(deployment: Deployment): PublicDeployment {
  const { outputSnapshotId: _outputSnapshotId, ...rest } = deployment;
  return rest;
}

export async function publicRun(
  operations: ControlPlaneOperations,
  run: Run,
): Promise<PublicRun> {
  const { providerResolutions, ...rest } = run;
  if (!providerResolutions || providerResolutions.length === 0) {
    return rest;
  }
  return {
    ...rest,
    providerResolutions: await Promise.all(
      providerResolutions.map((resolution) =>
        publicProviderResolution(operations, resolution),
      ),
    ),
  };
}

async function publicProviderResolution(
  operations: ControlPlaneOperations,
  resolution: ProviderResolution,
): Promise<PublicProviderResolution> {
  const connectionId = resolution.envId ?? undefined;
  return {
    requirement: resolution.requirement,
    status: publicProviderResolutionStatus(resolution),
    ...(connectionId ? { connectionId } : {}),
    ...(resolution.blockedReason
      ? { blockedReason: publicProviderBlockedReason(resolution.blockedReason) }
      : {}),
    evidence: await publicProviderResolutionEvidence(operations, resolution),
  };
}

function publicProviderResolutionStatus(
  resolution: ProviderResolution,
): PublicProviderResolution["status"] {
  if (resolution.status === "resolved_provider_env") {
    return "resolved_provider_connection";
  }
  if (resolution.status === "blocked_missing_env") {
    return "blocked_missing_connection";
  }
  return resolution.status;
}

async function publicProviderResolutionEvidence(
  operations: ControlPlaneOperations,
  resolution: ProviderResolution,
): Promise<PublicProviderResolution["evidence"]> {
  const evidence = resolution.evidence;
  void operations;
  if (evidence.kind === "provider_env") {
    return {
      kind: "provider_connection",
      provider: evidence.provider,
      connectionId: evidence.envId,
      requiredEnvNames: evidence.requiredEnvNames,
    };
  }
  return {
    kind: "blocked",
    provider: evidence.provider,
    reason: publicProviderBlockedReason(evidence.reason),
  };
}

function publicProviderBlockedReason(reason: string): string {
  return reason.replace(/\bProvider Env\b/g, "Provider Connection");
}

export async function publicCompatibilityReportResponse(
  operations: ControlPlaneOperations,
  response: CapsuleCompatibilityReportResponse,
): Promise<PublicCapsuleCompatibilityReportResponse> {
  const { providerResolutions: internalProviderResolutions, ...report } =
    response.report;
  const providerResolutions = internalProviderResolutions
    ? await Promise.all(
        internalProviderResolutions.map((resolution) =>
          publicProviderResolution(operations, resolution),
        ),
      )
    : undefined;
  return {
    report: {
      ...report,
      providers: report.providers,
      ...(providerResolutions ? { providerResolutions } : {}),
    },
    ...(response.run ? { run: await publicRun(operations, response.run) } : {}),
  };
}

export async function publicDeployResponse(
  operations: ControlPlaneOperations,
  response: DeployResponse,
): Promise<PublicDeployResponse> {
  const { run, planRun, applyRun, ...rest } = response;
  return {
    ...rest,
    run: await publicRun(operations, run),
    ...(planRun ? { planRun: await publicRun(operations, planRun) } : {}),
    ...(applyRun ? { applyRun: await publicRun(operations, applyRun) } : {}),
  };
}

interface PublicPlanActionResponse {
  readonly run: PublicRun;
  readonly planSummary?: PublicPlanRun["summary"];
  readonly cost?: RunCostInfo;
}

interface PublicApplyActionResponse {
  readonly run: PublicRun;
  readonly installation?: PublicInstallation;
  readonly deployment?: PublicDeployment;
}

export async function publicPlanActionResponse(
  operations: ControlPlaneOperations,
  response: PlanRunResponse,
): Promise<PublicPlanActionResponse> {
  const run = await operations.getRun(response.planRun.id);
  const cost = await operations
    .getRunCost(response.planRun.id)
    .catch(() => undefined);
  return {
    run: await publicRun(operations, run),
    ...(response.planRun.summary
      ? { planSummary: response.planRun.summary }
      : {}),
    ...(cost ? { cost } : {}),
  };
}

export async function publicApplyActionResponse(
  operations: ControlPlaneOperations,
  response: ApplyRunResponse,
): Promise<PublicApplyActionResponse> {
  const run = await operations.getRun(response.applyRun.id);
  return {
    run: await publicRun(operations, run),
    ...(response.installation
      ? { installation: publicInstallation(response.installation) }
      : {}),
    ...(response.deployment
      ? { deployment: publicDeployment(response.deployment) }
      : {}),
  };
}

/**
 * Renders an `OpenTofuControllerError` (carrying a `.code`) to the contract's
 * code->HTTP-status mapping. Non-controller errors collapse to 500.
 */
export function controllerErrorResponse(error: unknown): Response {
  const code = controllerErrorCode(error);
  if (code) {
    return errorJson(
      code,
      error instanceof Error ? error.message : String(error),
      DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE[code],
      undefined,
      {},
      isRecord(error) ? error.details : undefined,
    );
  }
  return errorJson("internal_error", "internal error", 500);
}

export function controllerErrorCode(
  error: unknown,
): DeployControlErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" &&
    code in DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE
    ? (code as DeployControlErrorCode)
    : undefined;
}

export function controlPlaneUnavailable(): Response {
  return errorJson(
    "feature_unavailable",
    "The control plane is temporarily unavailable.",
    503,
  );
}

export function parseControlPageParams(
  url: URL,
):
  | { readonly ok: true; readonly params: PageParams }
  | { readonly ok: false; readonly response: Response } {
  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      return {
        ok: false,
        response: errorJson(
          "invalid_request",
          "limit must be a positive integer",
          400,
        ),
      };
    }
    limit = Number(rawLimit);
  }
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && rawCursor !== "") {
    if (decodeCursor(rawCursor) === undefined) {
      return {
        ok: false,
        response: errorJson("invalid_request", "cursor is malformed", 400),
      };
    }
  }
  return {
    ok: true,
    params: {
      ...(limit !== undefined ? { limit } : {}),
      ...(rawCursor !== null && rawCursor !== "" ? { cursor: rawCursor } : {}),
    },
  };
}

export async function resolveProviderConnectionBindings(
  operations: ControlPlaneOperations,
  spaceId: string,
  bindings: InstallationProviderConnectionBindings,
): Promise<
  | { readonly ok: true; readonly bindings: InstallationProviderEnvBindings }
  | { readonly ok: false; readonly message: string }
> {
  const visibleById = new Map<string, ProviderConnection>();
  for (const connection of await operations.connections.listProviderConnections(
    spaceId,
  )) {
    if (connection.spaceId !== undefined) visibleById.set(connection.id, connection);
  }
  const resolved: InstallationProviderEnvBinding[] = [];
  for (const [index, binding] of bindings.entries()) {
    if (!visibleById.has(binding.connectionId)) {
      return {
        ok: false,
        message: `connections[${index}]: unknown provider connection`,
      };
    }
    resolved.push({
      provider: binding.provider,
      ...(binding.alias ? { alias: binding.alias } : {}),
      connectionId: binding.connectionId,
      ...(binding.region ? { region: binding.region } : {}),
    });
  }
  return { ok: true, bindings: resolved };
}

// --- Space authorization ---------------------------------------------------

type SpaceAccessResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly response: Response;
    };

export async function requireSpaceAccess(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly subject: string;
  readonly spaceId: string;
  readonly space?: Space;
}): Promise<SpaceAccessResult> {
  if (
    await canAccessSpace({
      operations: input.operations,
      store: input.store,
      subject: input.subject,
      spaceId: input.spaceId,
      ...(input.space ? { space: input.space } : {}),
    })
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    response: errorJson(
      "forbidden",
      "The authenticated session cannot access this Space.",
      403,
    ),
  };
}

export async function canAccessSpace(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly subject: string;
  readonly spaceId: string;
  readonly space?: Space;
}): Promise<boolean> {
  const space =
    input.space ?? (await input.operations.spaces.getSpace(input.spaceId));
  if (space.ownerUserId === input.subject) return true;

  const ledgerSpace = await input.store.findSpace(input.spaceId);
  if (!ledgerSpace) return false;
  const ledgerAccount = await input.store.findLedgerAccount(
    ledgerSpace.accountId,
  );
  return ledgerAccount?.legalOwnerSubject === input.subject;
}

export function jsonStatus(body: unknown, status: number): Response {
  return json(body, status);
}
