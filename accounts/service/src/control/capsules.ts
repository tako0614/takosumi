/**
 * Session-authed Capsule (`/api/v1/capsules`)
 * control routes: read/patch/destroy-plan, plan / destroy-plan / drift-check,
 * backups, state-versions (deployments) list, dependencies create/list,
 * provider-connection bindings. Extracted from `control-routes.ts` (P3 split).
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
import {
  CURRENT_OUTPUT_INCONSISTENT_REASON,
  type Output,
  type OutputResponse,
  type OutputShare,
  type OutputShareEntry,
  type PublicOutput,
} from "takosumi-contract/outputs";
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
  controllerErrorResponse,
  isRecord,
  jsonStatus,
  parseControlPageParams,
  publicApplyActionResponse,
  publicCompatibilityReportResponse,
  publicDependency,
  publicStateVersion,
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
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/default_install_config.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { ensureTakosumiAccountsOidcForExistingCapsule } from "./capsule-oidc.ts";

export async function handleCapsules(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/capsules/:id ; .../plan ; .../destroy-plan ; .../dependencies.
  if (segments[0] === "capsules" && segments.length >= 2) {
    const capsuleId = decodeURIComponent(segments[1] ?? "");
    const capsule = await operations.capsules.getCapsule(capsuleId);
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: capsule.workspaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method === "GET") {
        return json({ capsule: publicCapsule(capsule) });
      }
      if (method === "PATCH") {
        return await patchCapsule(request, operations, capsuleId);
      }
      if (method === "DELETE") {
        return await deleteCapsule(operations, capsule, capsuleId);
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
        capsule,
        ...(ctx.managedPublicBaseDomain
          ? { managedPublicBaseDomain: ctx.managedPublicBaseDomain }
          : {}),
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
      const response = await operations.createCapsuleDriftCheck(capsuleId);
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    if (leaf === "backups" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const backup = await operations.backups.createBackup({
        workspaceId: capsule.workspaceId,
        capsuleId: capsule.id,
        environment: capsule.environment,
      });
      return jsonStatus({ backup } satisfies CreateBackupResponse, 201);
    }
    if (leaf === "usage-summary" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({
        summary: await operations.getCapsuleUsageSummary(capsuleId),
      });
    }
    if (leaf === "state-versions" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await listCapsuleStateVersions(operations, capsuleId, url);
    }
    if (leaf === "outputs" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await getCapsuleOutput(operations, capsule);
    }
    if (leaf === "dependencies" && segments.length === 3) {
      if (method === "GET") {
        const dependencies =
          await operations.dependencies.listForCapsule(capsuleId);
        return json({
          asProducer: dependencies.asProducer.map(publicDependency),
          asConsumer: dependencies.asConsumer.map(publicDependency),
        });
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
    if (leaf === "provider-bindings" && segments.length === 3) {
      if (method === "GET") {
        return await getCapsuleProviderBindingSet(operations, capsule);
      }
      if (method === "PUT") {
        return await putCapsuleProviderBindingSet(request, operations, capsule);
      }
      return methodNotAllowed("GET, PUT");
    }
  }
  return undefined;
}

const API_PATCHABLE_CAPSULE_STATUSES: ReadonlySet<Capsule["status"]> = new Set([
  "active",
  "stale",
  "error",
]);

/**
 * Lists a Capsule's StateVersion ledger for the dashboard session. The caller
 * has already resolved the Capsule and Workspace-permission gated it; storage
 * coordinates and digests stay on the internal seam.
 */
async function listCapsuleStateVersions(
  operations: ControlPlaneOperations,
  capsuleId: string,
  url: URL,
): Promise<Response> {
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const { stateVersions, nextCursor } = await operations.listStateVersions(
    capsuleId,
    page.params,
  );
  return json({
    stateVersions: stateVersions.map(publicStateVersion),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

/**
 * Follows the already-authorized Capsule's internal current Output cursor.
 * A missing cursor is the normal pre-apply state. A dangling or mismatched
 * cursor is ledger corruption and fails closed instead of returning unrelated
 * Workspace data.
 */
async function getCapsuleOutput(
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<Response> {
  const outputId = capsule.currentOutputId;
  if (!outputId) {
    return json({ output: null } satisfies OutputResponse);
  }
  const output = await operations.getOutput(outputId);
  if (!isCurrentOutputForCapsule(output, capsule, outputId)) {
    return errorJson(
      "failed_precondition",
      "Capsule current Output is inconsistent.",
      409,
      undefined,
      {},
      { reason: CURRENT_OUTPUT_INCONSISTENT_REASON },
    );
  }
  return json({ output: publicOutput(output) } satisfies OutputResponse);
}

function isCurrentOutputForCapsule(
  output: Output | undefined,
  capsule: Capsule,
  outputId: string,
): output is Output {
  return Boolean(
    output &&
    output.id === outputId &&
    output.workspaceId === capsule.workspaceId &&
    output.capsuleId === capsule.id &&
    output.stateGeneration === capsule.currentStateGeneration,
  );
}

function publicOutput(output: Output): PublicOutput {
  const { rawArtifactRef: _rawArtifactRef, ...publicRecord } = output;
  return publicRecord;
}

async function getCapsule(
  operations: ControlPlaneOperations,
  capsuleId: string,
): Promise<Response> {
  const capsule = await operations.capsules.getCapsule(capsuleId);
  return json({
    capsule: publicCapsule(capsule),
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
  const autoUpdate =
    typeof body.autoUpdate === "boolean" ? body.autoUpdate : undefined;
  if (!status && autoUpdate === undefined) {
    return errorJson(
      "invalid_request",
      "status or autoUpdate is required",
      400,
    );
  }
  if (status && !API_PATCHABLE_CAPSULE_STATUSES.has(status)) {
    return errorJson(
      "invalid_request",
      "status may only be patched to active, stale, or error; destroy states must use the destroy flow",
      400,
    );
  }
  let capsule: Capsule | undefined;
  if (autoUpdate !== undefined) {
    capsule = await operations.capsules.setCapsuleAutoUpdate(
      capsuleId,
      autoUpdate,
    );
  }
  if (status) {
    capsule = await operations.capsules.patchCapsuleStatus(capsuleId, status);
  }
  return json({ capsule: publicCapsule(capsule!) });
}

async function deleteCapsule(
  operations: ControlPlaneOperations,
  capsule: Capsule,
  capsuleId: string,
): Promise<Response> {
  if (capsule.status === "destroyed") {
    return jsonStatus(
      {
        capsule: publicCapsule(capsule),
        alreadyDeleted: true,
      },
      200,
    );
  }
  if (!capsuleHasAppliedState(capsule)) {
    return await abandonUnappliedCapsule({
      operations,
      capsule,
      reason: "delete requested before first successful apply",
    });
  }
  const response = await operations.createCapsuleDestroyPlan(capsuleId);
  return jsonStatus(await publicPlanActionResponse(operations, response), 202);
}

function capsuleHasAppliedState(capsule: Capsule): boolean {
  return Boolean(
    capsule.currentStateVersionId || capsule.currentStateGeneration > 0,
  );
}

async function abandonUnappliedCapsule(input: {
  readonly operations: ControlPlaneOperations;
  readonly capsule: Capsule;
  readonly reason: string;
}): Promise<Response> {
  const capsule =
    input.operations.capsules.abandonUnappliedCapsule !== undefined
      ? await input.operations.capsules.abandonUnappliedCapsule(
          input.capsule.id,
          input.reason,
        )
      : await input.operations.capsules.patchCapsuleStatus(
          input.capsule.id,
          "destroyed",
        );
  return jsonStatus(
    {
      capsule: publicCapsule(capsule),
      abandoned: true,
    },
    202,
  );
}

async function getCapsuleProviderBindingSet(
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<Response> {
  if (capsule.status === "destroyed") {
    return json({ providerBindingSet: null });
  }
  const profile = await operations.capsules.getProviderBindingSetByCapsule(
    capsule.id,
    capsule.environment,
  );
  return json({
    providerBindingSet: profile
      ? await publicProviderBindingSet(profile)
      : null,
  });
}

async function putCapsuleProviderBindingSet(
  request: Request,
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<Response> {
  if (capsule.status === "destroyed") {
    return errorJson(
      "invalid_request",
      "deleted Capsules cannot update provider connections",
      400,
    );
  }
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const parsed = parseProviderBindings(body.bindings);
  if (!parsed.ok) {
    return errorJson("invalid_request", parsed.message, 400);
  }
  const resolved = await resolveProviderBindings(
    operations,
    capsule.workspaceId,
    parsed.bindings,
  );
  if (!resolved.ok) {
    return errorJson("invalid_request", resolved.message, 400);
  }
  const existing = await operations.capsules.getProviderBindingSetByCapsule(
    capsule.id,
    capsule.environment,
  );
  const now = new Date().toISOString();
  const profile = await operations.capsules.putProviderBindingSet({
    id:
      existing?.id ??
      `dpf_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    bindings: resolved.bindings,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  return json({
    providerBindingSet: await publicProviderBindingSet(profile),
  });
}

function publicProviderBindingSet(
  profile: ProviderBindingSet,
): ProviderBindingSet {
  return {
    id: profile.id,
    workspaceId: profile.workspaceId,
    capsuleId: profile.capsuleId,
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
    return errorJson("invalid_request", "producerCapsuleId is required", 400);
  }
  // The consumer is the path Capsule; resolve its Workspace so the edge is
  // created in the right Workspace (mirrors the §30 dependency-create handler).
  const consumer = await operations.capsules.getCapsule(consumerCapsuleId);
  const consumerAuth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId: consumer.workspaceId,
    subject: sessionSubject,
  });
  if (!consumerAuth.ok) return consumerAuth.response;
  const producer = await operations.capsules.getCapsule(producerCapsuleId);
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
    visibility: dependencyVisibilityValue(body.visibility) ?? "workspace",
  });
  return jsonStatus({ dependency: publicDependency(dependency) }, 201);
}
