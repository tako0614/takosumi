/**
 * Session-authed Capsule (`/api/v1/capsules`)
 * control routes: read/patch/destroy-plan, plan / destroy-plan / drift-check,
 * backups, and state-versions (deployments) list,
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
  type ControlSession,
  canAccessWorkspace,
  controlPlaneUnavailable,
  controllerErrorResponse,
  isRecord,
  jsonStatus,
  parseControlPageParams,
  publicApplyActionResponse,
  publicCompatibilityReportResponse,
  publicStateVersion,
  publicCapsule,
  publicPlanActionResponse,
  publicRun,
  requireWorkspaceAccess,
} from "./shared.ts";
import {
  booleanValue,
  connectionCredentialFiles,
  connectionScopeHints,
  isJsonValue,
  isPlainJsonObject,
  jsonRecordValue,
  modulePathValue,
  outputAllowlistValue,
  parseProviderBinding,
  parseLimit,
  workspaceTypeValue,
  stringRecord,
  stringRecordValue,
} from "./parse.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/default_install_config.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { capsuleDeleteIsImmediate } from "../../../../core/domains/capsules/delete_request.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { handleCapsuleRevisionPlans } from "./revision-plans.ts";
import {
  capsuleInstallConfigReAdoptionGuard,
  handleCapsuleInstallConfigReAdoption,
} from "./install-config-re-adoptions.ts";
import { handleCapsuleConfigurationPlans } from "./configuration-plans.ts";
import { handleCapsuleApp, handleCapsuleRuns } from "./capsule-app.ts";
import {
  WorkspaceManagementAdmissionConflictError,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";

export async function handleCapsules(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/capsules/:id ; .../plan ; .../destroy-plan.
  if (segments[0] === "capsules" && segments.length >= 2) {
    const capsuleId = decodeURIComponent(segments[1] ?? "");
    const capsule = await operations.capsules.getCapsule(capsuleId);
    // Once the Capsule identifies its Workspace, retain the original epoch
    // across authorization. A stop/resume must not authorize an older request.
    const lifecycleMutation = (method === "PATCH" && segments.length === 2) ||
      (capsule.status !== "destroyed" && (
        (method === "DELETE" && segments.length === 2) ||
        (method === "POST" && segments.length === 3 && (
          segments[2] === "abandon" ||
          segments[2] === "uninstall" ||
          segments[2] === "cancel-uninstall"
        ))
      ));
    const capturedManagement = lifecycleMutation ||
        (method === "POST" && segments.length === 3 && segments[2] === "backups")
      ? await (async () => {
        try {
          return {
            ok: true as const,
            authority: await operations.workspaces.captureManagementAuthority(capsule.workspaceId),
          };
        } catch (error) {
          return { ok: false as const, error };
        }
      })()
      : undefined;
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: capsule.workspaceId,
      session: ctx.session,
    });
    // A refused caller must not append Activity to another Workspace by
    // repeatedly guessing a Capsule ID.
    if (!auth.ok) return auth.response;
    const requireCapturedManagement = (): WorkspaceManagementAuthority => {
      if (!capturedManagement) throw new Error("Capsule management authority was not captured");
      if (!capturedManagement.ok) throw capturedManagement.error;
      return capturedManagement.authority;
    };
    if (segments.length === 2) {
      if (method === "GET") {
        return json({
          capsule: await publicCapsuleWithAdoptedSourceRevision(
            operations,
            capsule,
          ),
          installConfigReAdoption: {
            authorityGuard: await capsuleInstallConfigReAdoptionGuard(
              operations,
              capsule,
            ),
          },
        });
      }
      if (method === "PATCH") {
        return await patchCapsule(request, operations, capsuleId, requireCapturedManagement);
      }
      if (method === "DELETE") {
        if (
          capsuleDeleteIsImmediate(url) ||
          capsule.status === "destroyed" ||
          !capsuleHasAppliedState(capsule)
        ) {
          return await deleteCapsule(
            operations,
            capsule,
            capsuleId,
            ctx.session.subject,
            lifecycleMutation ? requireCapturedManagement() : undefined,
          );
        }
        // Applied DELETE shares the exact uninstall admission below, including
        // its requester binding, revision CAS and captured management fence.
      }
      if (method !== "DELETE") return methodNotAllowed("GET, PATCH, DELETE");
    }
    const leaf = segments.length === 2 && method === "DELETE"
      ? "uninstall"
      : segments[2];
    if (leaf === "abandon" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      if (capsule.status === "destroyed") {
        return json({ capsule: publicCapsule(capsule), alreadyDeleted: true });
      }
      // This action is deliberately abandonment-only. The domain operation
      // rechecks durable state under its admission boundary and rejects an
      // applied Capsule; unlike generic DELETE it can never create a destroy
      // Plan if state changes while the user confirms the restart.
      return await abandonUnappliedCapsule({
        operations,
        capsule,
        reason: "restart requested before first successful apply",
        expectedWorkspaceManagementAuthority: requireCapturedManagement(),
      });
    }
    if (leaf === "uninstall" && (segments.length === 3 || method === "DELETE")) {
      if (segments.length === 3 && method !== "POST") return methodNotAllowed("POST");
      if (!ctx.session.uninstallRequester) {
        return errorJson(
          "forbidden",
          "Uninstall requires an authenticated Accounts requester.",
          403,
          undefined,
          {},
          { reason: "capsule_uninstall_requester_unavailable" },
        );
      }
      if (capsule.status === "destroyed") {
        return json({ capsule: publicCapsule(capsule), alreadyDeleted: true });
      }
      const schedule = operations.capsules.scheduleCapsuleUninstall;
      if (typeof schedule !== "function") {
        return capsuleUninstallUnavailable();
      }
      const updated = await schedule.call(operations.capsules, capsule.id, {
        actor: ctx.session.subject,
        requester: ctx.session.uninstallRequester,
        expectedWorkspaceManagementAuthority: requireCapturedManagement(),
      });
      return jsonStatus(
        {
          capsule: publicCapsule(updated),
          ...(typeof operations.capsules.uninstallGraceDays === "number"
            ? { graceDays: operations.capsules.uninstallGraceDays }
            : {}),
        },
        202,
      );
    }
    if (leaf === "cancel-uninstall" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const cancel = operations.capsules.cancelCapsuleUninstall;
      if (typeof cancel !== "function") {
        return capsuleUninstallUnavailable();
      }
      if (capsule.status === "destroyed") {
        return errorJson(
          "failed_precondition",
          "The Capsule was already deleted.",
          409,
          undefined,
          {},
          { reason: "capsule_not_uninstalled" },
        );
      }
      const updated = await cancel.call(operations.capsules, capsule.id, {
        actor: ctx.session.subject,
        expectedWorkspaceManagementAuthority: requireCapturedManagement(),
      });
      return json({ capsule: publicCapsule(updated) });
    }
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
    if (leaf === "configuration-plans" && segments.length === 3) {
      return await handleCapsuleConfigurationPlans(ctx, capsule, method);
    }
    if (leaf === "revision-plans" && segments.length === 3) {
      return await handleCapsuleRevisionPlans(ctx, capsule, method);
    }
    if (leaf === "install-config-re-adoptions" && segments.length === 3) {
      return await handleCapsuleInstallConfigReAdoption(ctx, capsule, method);
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
        {
          ...(runnerProfileId ? { runnerProfileId } : {}),
          actor: ctx.session.subject,
        },
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
        expectedWorkspaceManagementAuthority: requireCapturedManagement(),
      });
      return jsonStatus({ backup } satisfies CreateBackupResponse, 201);
    }
    if (leaf === "app" && segments.length === 3) {
      return await handleCapsuleApp(ctx, capsule, method);
    }
    if (leaf === "runs" && segments.length === 3) {
      return await handleCapsuleRuns(ctx, capsule, method);
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
    if (leaf === "current-resource-inventory" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getCurrentResourceInventory(capsuleId));
    }
    if (leaf === "provider-bindings" && segments.length === 3) {
      if (method === "GET") {
        return await getCapsuleProviderBindingSet(operations, capsule);
      }
      return methodNotAllowed("GET");
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
    capsule: await publicCapsuleWithAdoptedSourceRevision(
      operations,
      capsule,
    ),
  });
}

async function publicCapsuleWithAdoptedSourceRevision(
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<PublicCapsule> {
  const projected = publicCapsule(capsule);
  if (capsule.status === "destroyed" || !capsule.currentStateVersionId) return projected;
  const adoptedSourceRevision =
    await operations.getCapsuleAdoptedSourceRevision(capsule.id);
  return adoptedSourceRevision
    ? { ...projected, adoptedSourceRevision }
    : projected;
}

async function patchCapsule(
  request: Request,
  operations: ControlPlaneOperations,
  capsuleId: string,
  requireCapturedManagement: () => WorkspaceManagementAuthority,
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
  // Capture happened before auth; malformed requests retain their normal 400
  // response before a captured management refusal is disclosed or used.
  const expectedWorkspaceManagementAuthority = requireCapturedManagement();
  let capsule: Capsule | undefined;
  if (autoUpdate !== undefined) {
    capsule = await operations.capsules.setCapsuleAutoUpdate(
      capsuleId,
      autoUpdate,
      expectedWorkspaceManagementAuthority,
    );
  }
  if (status) {
    capsule = await operations.capsules.patchCapsuleStatus(
      capsuleId, status, expectedWorkspaceManagementAuthority,
    );
  }
  return json({ capsule: publicCapsule(capsule!) });
}

async function deleteCapsule(
  operations: ControlPlaneOperations,
  capsule: Capsule,
  capsuleId: string,
  actor: string,
  expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority | undefined,
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
    if (expectedWorkspaceManagementAuthority === undefined) {
      throw new WorkspaceManagementAdmissionConflictError(capsule.workspaceId);
    }
    return await abandonUnappliedCapsule({
      operations,
      capsule,
      reason: "delete requested before first successful apply",
      expectedWorkspaceManagementAuthority,
    });
  }
  const response = await operations.createCapsuleDestroyPlan(capsuleId, {
    actor,
  });
  return jsonStatus(await publicPlanActionResponse(operations, response), 202);
}

function capsuleUninstallUnavailable(): Response {
  return errorJson(
    "failed_precondition",
    "Scheduled uninstall is not available on this host.",
    409,
    undefined,
    {},
    { reason: "capsule_uninstall_unavailable" },
  );
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
  readonly expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority;
}): Promise<Response> {
  const abandon = input.operations.capsules.abandonUnappliedCapsule;
  if (typeof abandon !== "function") {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `capsule ${input.capsule.id} abandonment is unavailable`,
      { reason: "capsule_abandon_unavailable" },
    );
  }
  const capsule = await abandon.call(
    input.operations.capsules,
    input.capsule.id,
    input.reason,
    input.expectedWorkspaceManagementAuthority,
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
      ...(binding.moduleLocalName
        ? { moduleLocalName: binding.moduleLocalName }
        : {}),
      ...(binding.childAlias ? { childAlias: binding.childAlias } : {}),
      ...(binding.rootAlias ? { rootAlias: binding.rootAlias } : {}),
      connectionId: binding.connectionId,
      ...(binding.alias ? { alias: binding.alias } : {}),
      ...(binding.region ? { region: binding.region } : {}),
      ...(binding.runCredentialSettings
        ? { runCredentialSettings: binding.runCredentialSettings }
        : {}),
    })),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
