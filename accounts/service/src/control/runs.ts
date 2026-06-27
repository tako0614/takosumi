/**
 * Session-authed Run (`/api/v1/runs`) and RunGroup (`/api/v1/run-groups`)
 * control routes: read, approve, apply, logs/events/cancel/cost, grouped-run
 * read/approve. Extracted from `control-routes.ts` (P3 god-file split).
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

export async function handleRuns(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/runs/:id ; .../apply ; .../approve ; .../logs ; .../cost
  if (segments[0] === "runs" && segments.length >= 2) {
    const runId = decodeURIComponent(segments[1] ?? "");
    const run = await operations.getRun(runId);
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: run.spaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      await syncDeployControlProjectionStatusFromRun({ store, run });
      return json({ run: await publicRun(operations, run) });
    }
    const leaf = segments[2];
    if (leaf === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRun(
        request,
        operations,
        runId,
        ctx.session.subject,
      );
    }
    if (leaf === "apply" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await applyPlanRun(
        request,
        operations,
        store,
        ctx.session.subject,
        runId,
      );
    }
    if (leaf === "logs" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getRunLogs(runId));
    }
    if (leaf === "events" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getRunEvents(runId));
    }
    if (leaf === "cancel" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return json({
        run: await publicRun(operations, await operations.cancelRun(runId)),
      });
    }
    if (leaf === "cost" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      // Public, non-secret cost projection: the billing reservation values the
      // controller already computed at plan time (estimated / available credits,
      // reservation status, credit-shortfall reasons). Space-gated above.
      return json({ cost: await operations.getRunCost(runId) });
    }
  }
  return undefined;
}

export async function handleRunGroups(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/run-groups/:id ; .../approve
  if (segments[0] === "run-groups" && segments.length >= 2) {
    const runGroupId = decodeURIComponent(segments[1] ?? "");
    const existing = await operations.runGroups.getRunGroup(runGroupId);
    if (!existing) return errorJson("not_found", "not found", 404);
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: existing.runGroup.spaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(existing);
    }
    if (segments[2] === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRunGroup(operations, runGroupId);
    }
  }
  return undefined;
}

async function approveRun(
  request: Request,
  operations: ControlPlaneOperations,
  runId: string,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request.clone()).catch(() => null);
  const reason = body ? stringValue(body.reason) : undefined;
  const run = await operations.approveRun(runId, {
    approvedBy: sessionSubject,
    ...(reason ? { reason } : {}),
  });
  return json({ run: await publicRun(operations, run) });
}

/**
 * Applies a reviewed PlanRun on behalf of the dashboard session (§31 GUI
 * deploy). The plan run is resolved first so the apply is space-permission gated
 * via the plan's OWNING Space (a session may not apply another Space's plan);
 * only then is the reviewed apply guard rebuilt server-side from that same plan
 * and handed to the controller, which independently re-checks every apply
 * precondition (succeeded plan / passed policy / immutable plan artifact / not a
 * drift_check / apply-once / destructive confirmation).
 */
async function applyPlanRun(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  planRunId: string,
): Promise<Response> {
  const body = await readJsonObject(request.clone()).catch(() => null);
  const confirmDestructive = body?.confirmDestructive === true;
  const { planRun } = await operations.getPlanRun(planRunId);
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId: planRun.spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const applyRequest: CreateApplyRunRequest = {
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
    ...(confirmDestructive ? { confirmDestructive: true } : {}),
  };
  const response = await operations.createApplyRun(applyRequest);
  const projectionError = await syncDeployControlProjectionFromApply({
    operations,
    store,
    sessionSubject: sessionSubject as TakosumiSubject,
    planRun,
    response,
  });
  if (projectionError) return projectionError;
  return jsonStatus(await publicApplyActionResponse(operations, response), 201);
}

/**
 * Rebuilds the `ApplyExpectedGuard` from the reviewed PlanRun. Mirrors the
 * service-side `applyExpectedGuardFromPlanRun` (deploy-control domain): the guard
 * pins the apply to the exact reviewed plan (digests + artifact + state guard),
 * and the controller structurally re-derives + compares it, so a tampered guard
 * cannot widen what is applied. Missing plan digest / artifact surface as a typed
 * `failed_precondition` from the controller (the plan has not completed).
 */
function applyExpectedGuardFromPlanRun(
  planRun: PublicPlanRun,
): ApplyExpectedGuard {
  return {
    planRunId: planRun.id,
    ...(planRun.installationId
      ? { installationId: planRun.installationId }
      : {}),
    ...(planRun.installationId
      ? { currentDeploymentId: planRun.installationCurrentDeploymentId ?? null }
      : {}),
    runnerProfileId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest ?? "",
    planArtifactDigest: planRun.planArtifact?.digest ?? "",
    ...(planRun.sourceCommit ? { sourceCommit: planRun.sourceCommit } : {}),
    ...(planRun.providerLockDigest
      ? { providerLockDigest: planRun.providerLockDigest }
      : {}),
    ...(planRun.resolvedProviderEnvBindingsDigest
      ? {
          resolvedProviderEnvBindingsDigest:
            planRun.resolvedProviderEnvBindingsDigest,
        }
      : {}),
  };
}

async function getRunGroup(
  operations: ControlPlaneOperations,
  runGroupId: string,
): Promise<Response> {
  const result = await operations.runGroups.getRunGroup(runGroupId);
  if (!result) return errorJson("not_found", "not found", 404);
  return json(result);
}

async function approveRunGroup(
  operations: ControlPlaneOperations,
  runGroupId: string,
): Promise<Response> {
  const result = await operations.runGroups.approveRunGroup(runGroupId);
  if (!result) return errorJson("not_found", "not found", 404);
  return json(result);
}
