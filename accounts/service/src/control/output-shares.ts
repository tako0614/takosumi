/**
 * Session-authed OutputShare (`/api/v1/output-shares`) control routes: list /
 * create / approve / revoke. Extracted from `control-routes.ts` (P3 split).
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
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/installations/official_seed.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { appendLedgerEvent } from "../installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { canTransitionAppInstallationStatus } from "../ledger.ts";

export async function handleOutputShares(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/output-shares ; /api/v1/output-shares/:id/{approve,revoke}
  if (segments[0] === "output-shares") {
    if (segments.length === 1) {
      if (method === "GET") {
        return await listOutputShares(
          operations,
          store,
          ctx.session.subject,
          url,
        );
      }
      if (method === "POST") {
        return await createOutputShare(
          request,
          operations,
          store,
          ctx.session.subject,
        );
      }
      return methodNotAllowed("GET, POST");
    }
    if (segments.length === 3) {
      const shareId = decodeURIComponent(segments[1] ?? "");
      const action = segments[2];
      if (action === "approve") {
        if (method !== "POST") return methodNotAllowed("POST");
        return await approveOutputShare(
          operations,
          store,
          ctx.session.subject,
          shareId,
        );
      }
      if (action === "revoke") {
        if (method !== "POST") return methodNotAllowed("POST");
        return await revokeOutputShare(
          operations,
          store,
          ctx.session.subject,
          shareId,
        );
      }
    }
  }
  return undefined;
}

async function listOutputShares(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const spaceId =
    stringValue(url.searchParams.get("workspaceId") ?? undefined) ??
    stringValue(url.searchParams.get("workspace_id") ?? undefined) ??
    stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  if (!spaceId) {
    return errorJson(
      "invalid_request",
      "workspaceId query parameter is required",
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const { items, nextCursor } = await operations.outputShares.listForSpacePage(
    spaceId,
    page.params,
  );
  return json({
    shares: items,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

async function createOutputShare(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const fromSpaceId = stringValue(body.fromSpaceId);
  const toSpaceId = stringValue(body.toSpaceId);
  const producerInstallationId = stringValue(body.producerInstallationId);
  const outputs = outputShareEntries(body.outputs);
  const sensitivePolicy = outputShareSensitivePolicy(body.sensitivePolicy);
  if (!fromSpaceId || !toSpaceId || !producerInstallationId || !outputs) {
    return errorJson(
      "invalid_request",
      "fromSpaceId, toSpaceId, producerInstallationId, and outputs are required",
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId: fromSpaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const producer = await operations.installations.getInstallation(
    producerInstallationId,
  );
  if (producer.spaceId !== fromSpaceId) {
    const producerAuth = await requireSpaceAccess({
      operations,
      store,
      spaceId: producer.spaceId,
      subject: sessionSubject,
    });
    if (!producerAuth.ok) return producerAuth.response;
    return errorJson(
      "invalid_request",
      "producerInstallationId must belong to the source Space.",
      400,
    );
  }
  const share = await operations.outputShares.createShare({
    fromSpaceId,
    toSpaceId,
    producerInstallationId,
    outputs,
    ...(sensitivePolicy ? { sensitivePolicy } : {}),
  });
  return jsonStatus({ share }, 201);
}

async function approveOutputShare(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  shareId: string,
): Promise<Response> {
  const existing = await operations.outputShares.getShare(shareId);
  if (!existing) return errorJson("not_found", "not found", 404);
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId: existing.toSpaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  return json({ share: await operations.outputShares.approveShare(shareId) });
}

async function revokeOutputShare(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  shareId: string,
): Promise<Response> {
  const existing = await operations.outputShares.getShare(shareId);
  if (!existing) return errorJson("not_found", "not found", 404);
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId: existing.fromSpaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  return json({ share: await operations.outputShares.revokeShare(shareId) });
}
