/**
 * Internal upload deploy compatibility orchestration (`POST /internal/v1/deploy`).
 *
 * Takes a previously-ingested upload or prepared-artifact {@link SourceSnapshot},
 * resolves an existing source-less legacy Capsule `@workspace/name`, and
 * returns the plan Run pinned to that snapshot. Callers apply that reviewed
 * plan through the normal apply route.
 * Everything heavy (Capsule Gate / generated root / plan) runs in the existing
 * controller pipeline; this only wires the update + plan steps.
 *
 * Public local upload deploy is retired. This seam is kept for operator
 * compatibility with existing source-less Capsules and never creates new public
 * Capsules. It never touches credential material: providers bind through
 * Connections inside the runner, per the per-phase mint policy.
 */

import type { DeployResponse } from "takosumi-contract/deploy";
import type { InternalDeployRequest } from "@takosumi/internal/deploy-control-api";
import type {
  InstallConfig,
  Capsule,
  PublicCapsule,
} from "takosumi-contract/install-configs";
import type { InstallationProviderEnvBindings } from "takosumi-contract/connections";
import type { JsonValue } from "takosumi-contract";
import type { OpenTofuDeploymentController } from "./mod.ts";
import type { DeployControlActorContext } from "./mod.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import type { CapsulesService } from "../capsules/mod.ts";
import { validateInstallationProviderEnvBindings } from "../connections/mod.ts";

const DEFAULT_ENVIRONMENT = "production";

export interface DeployUploadDependencies {
  readonly installations: CapsulesService;
  readonly controller: OpenTofuDeploymentController;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
}

export async function deployUpload(
  deps: DeployUploadDependencies,
  request: InternalDeployRequest,
  context: DeployControlActorContext = {},
): Promise<DeployResponse> {
  const workspaceId = request.workspaceId ?? request.spaceId;
  requireNonEmptyString(workspaceId, "spaceId");
  requireNonEmptyString(request.name, "name");
  requireNonEmptyString(request.snapshotId, "snapshotId");
  const newId = deps.newId ?? defaultId;
  const now = deps.now ?? (() => new Date());
  const environment = nonEmpty(request.environment) ?? DEFAULT_ENVIRONMENT;
  const modulePath = modulePathValue(request.modulePath);
  if (request.modulePath !== undefined && modulePath === undefined) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "modulePath must be a safe relative path inside the SourceSnapshot",
    );
  }
  const providerEnvBindings =
    request.providerEnvBindings !== undefined
      ? validateInstallationProviderEnvBindings(request.providerEnvBindings)
      : undefined;

  // 1. The no-git snapshot must exist and live in the Space.
  const snapshot = await deps.controller.getSourceSnapshot(request.snapshotId);
  if (
    (snapshot.origin !== "upload" && snapshot.origin !== "artifact") ||
    snapshot.workspaceId !== workspaceId
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `snapshot ${request.snapshotId} is not an upload/artifact snapshot in space ${workspaceId}`,
    );
  }

  // 2. Resolve the existing source-less legacy Capsule in the target workspace.
  const existingForSpace = await deps.installations.listCapsules(workspaceId);
  let installation = existingForSpace.find(
    (row) => row.name === request.name && row.environment === environment,
  );
  let installConfigId: string;
  let effectiveRunnerProfileId: string | undefined = request.runnerProfileId;
  if (installation) {
    if (installation.sourceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "the existing service is bound to a git Source; deploy through its Source instead of an upload",
      );
    }
    installConfigId = installation.installConfigId;
    // Re-deploy: refresh the variable mapping from the new request vars.
    const refreshed = await refreshInstallConfigVars(
      deps,
      installConfigId,
      request.vars,
      request.outputAllowlist,
      request.runnerProfileId,
      modulePath,
      now,
    );
    effectiveRunnerProfileId = refreshed.runnerId;
  } else {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "upload deploy can only update an existing source-less legacy Capsule; create a Git URL Source/Capsule and run plan/apply instead",
    );
  }
  if (providerEnvBindings !== undefined) {
    await putProviderConnections({
      deps,
      installation,
      connections: providerEnvBindings,
      id: newId("ipcset"),
      now,
    });
  }

  // 3. Plan Run pinned to the upload snapshot. The controller's installation
  //    plan path is upload-aware (synthesizes an in-memory Source from the
  //    snapshot) and gates the Capsule before the run.
  const shouldDeferCompatibilityReport =
    effectiveRunnerProfileId === undefined ||
    deps.controller.usesExternalRunQueue();
  const planResponse = await deps.controller.createInstallationPlan(
    installation.id,
    context,
    {
      sourceSnapshotId: snapshot.id,
      ...(shouldDeferCompatibilityReport
        ? { deferCompatibilityReport: true as const }
        : {}),
      ...(effectiveRunnerProfileId
        ? { runnerProfileId: effectiveRunnerProfileId }
        : {}),
    },
  );
  const run = await deps.controller.getRun(planResponse.planRun.id);
  const status = deployStatus(run);
  installation = await reconcileUploadInstallationStatus({
    deps,
    installation,
    status,
  });

  return {
    capsule: toPublicInstallation(installation),
    installation: toPublicInstallation(installation),
    installConfigId,
    run,
    planRun: run,
    status,
    created: false,
  };
}

async function putProviderConnections(input: {
  readonly deps: DeployUploadDependencies;
  readonly installation: Capsule;
  readonly connections: InstallationProviderEnvBindings;
  readonly id: string;
  readonly now: () => Date;
}): Promise<void> {
  const nowIso = input.now().toISOString();
  await input.deps.installations.putCapsuleProviderEnvBindingSet({
    id: input.id,
    workspaceId: input.installation.workspaceId,
    spaceId: input.installation.workspaceId ?? input.installation.spaceId,
    capsuleId: input.installation.id,
    installationId: input.installation.id,
    environment: input.installation.environment,
    bindings: input.connections,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

function deployStatus(
  planRun: DeployResponse["run"],
): NonNullable<DeployResponse["status"]> {
  if (planRun.status === "waiting_approval") return "waiting_approval";
  if (planRun.status === "failed") return "failed";
  return "planned";
}

async function reconcileUploadInstallationStatus(input: {
  readonly deps: DeployUploadDependencies;
  readonly installation: Capsule;
  readonly status: NonNullable<DeployResponse["status"]>;
}): Promise<Capsule> {
  void input.deps;
  void input.status;
  return input.installation;
}

async function refreshInstallConfigVars(
  deps: DeployUploadDependencies,
  installConfigId: string,
  vars: Readonly<Record<string, JsonValue>> | undefined,
  outputAllowlist: InternalDeployRequest["outputAllowlist"] | undefined,
  runnerProfileId: string | undefined,
  modulePath: string | undefined,
  now: () => Date,
): Promise<InstallConfig> {
  const existing = await deps.installations.getInstallConfig(installConfigId);
  const { modulePath: _existingModulePath, ...existingWithoutModulePath } =
    existing;
  const base = modulePath === "" ? existingWithoutModulePath : existing;
  return await deps.installations.putInstallConfig({
    ...base,
    variableMapping: { ...(vars ?? {}) },
    outputAllowlist: refreshedOutputAllowlist(existing, outputAllowlist),
    ...(runnerProfileId !== undefined ? { runnerId: runnerProfileId } : {}),
    ...(modulePath ? { modulePath } : {}),
    updatedAt: now().toISOString(),
  });
}

function refreshedOutputAllowlist(
  existing: InstallConfig,
  outputAllowlist: InternalDeployRequest["outputAllowlist"] | undefined,
): InstallConfig["outputAllowlist"] {
  if (outputAllowlist !== undefined) return outputAllowlist;
  return existing.outputAllowlist;
}

function toPublicInstallation(installation: Capsule): PublicCapsule {
  const { installType: _installType, ...rest } = installation;
  return rest;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function modulePathValue(value: string | undefined): string | undefined {
  const raw = nonEmpty(value);
  if (!raw) return undefined;
  if (
    raw.includes("\0") ||
    raw.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(raw)
  ) {
    return undefined;
  }
  const parts = raw
    .replace(/\\/g, "/")
    .replace(/^\.\/+/u, "")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) return "";
  if (parts.some((part) => part === "..")) {
    return undefined;
  }
  return parts.join("/");
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
