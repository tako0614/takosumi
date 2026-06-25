/**
 * Upload deploy orchestration (`POST /api/deploy`).
 *
 * Composes the upload-origin deploy pipeline the way the dashboard cannot: it
 * takes a previously-ingested upload {@link SourceSnapshot}, resolves or creates
 * the target Installation `@space/name` (synthesizing a default InstallConfig
 * when the Installation is new), and returns the plan Run pinned to that
 * snapshot. Callers apply that reviewed plan through the normal apply route.
 * Everything heavy (Capsule Gate / generated root / plan) runs in the existing
 * controller pipeline; this only wires the create-or-update + plan steps.
 *
 * This is `takosumi deploy`'s server side. It never touches credential material:
 * providers bind through Connections inside the runner, per the per-phase mint
 * policy.
 */

import type {
  DeployResponse,
  InternalDeployRequest,
} from "takosumi-contract/deploy";
import type {
  InstallConfig,
  Installation,
  PublicInstallation,
} from "takosumi-contract/installations";
import type { InstallationProviderEnvBindings } from "takosumi-contract/provider-envs";
import type { JsonValue } from "takosumi-contract";
import type { OpenTofuDeploymentController } from "./mod.ts";
import type { DeployControlActorContext } from "./mod.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import type { InstallationsService } from "../installations/mod.ts";
import { defaultCapsuleOutputAllowlist } from "../installations/official_seed.ts";
import { validateInstallationProviderEnvBindings } from "../connections/mod.ts";

const DEFAULT_ENVIRONMENT = "production";

export interface DeployUploadDependencies {
  readonly installations: InstallationsService;
  readonly controller: OpenTofuDeploymentController;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
}

export async function deployUpload(
  deps: DeployUploadDependencies,
  request: InternalDeployRequest,
  context: DeployControlActorContext = {},
): Promise<DeployResponse> {
  requireNonEmptyString(request.spaceId, "spaceId");
  requireNonEmptyString(request.name, "name");
  requireNonEmptyString(request.snapshotId, "snapshotId");
  const newId = deps.newId ?? defaultId;
  const now = deps.now ?? (() => new Date());
  const environment = nonEmpty(request.environment) ?? DEFAULT_ENVIRONMENT;
  const providerEnvBindings =
    request.providerEnvBindings !== undefined
      ? validateInstallationProviderEnvBindings(request.providerEnvBindings)
      : undefined;

  // 1. The upload snapshot must exist, be upload-origin, and live in the Space.
  const snapshot = await deps.controller.getSourceSnapshot(request.snapshotId);
  if (snapshot.origin !== "upload" || snapshot.spaceId !== request.spaceId) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `snapshot ${request.snapshotId} is not an upload snapshot in space ${request.spaceId}`,
    );
  }

  // 2. Resolve or create the Installation @space/name.
  const existingForSpace = await deps.installations.listInstallations(
    request.spaceId,
  );
  let installation = existingForSpace.find(
    (row) => row.name === request.name && row.environment === environment,
  );
  let created = false;
  let installConfigId: string;
  if (installation) {
    if (installation.sourceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `installation @${request.spaceId}/${request.name} is bound to a git ` +
          `Source; deploy through its Source instead of an upload`,
      );
    }
    installConfigId = installation.installConfigId;
    // Re-deploy: refresh the variable mapping from the new request vars.
    await refreshInstallConfigVars(
      deps,
      installConfigId,
      request.vars,
      request.outputAllowlist,
      now,
    );
  } else {
    const config = buildDefaultInstallConfig({
      id: newId("icfg"),
      spaceId: request.spaceId,
      name: request.name,
      vars: request.vars,
      outputAllowlist: request.outputAllowlist,
      now,
    });
    await deps.installations.putInstallConfig(config);
    installation = await deps.installations.createInstallation({
      spaceId: request.spaceId,
      name: request.name,
      environment,
      installConfigId: config.id,
    });
    installConfigId = config.id;
    created = true;
  }
  try {
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
      request.runnerProfileId === undefined;
    const planResponse = await deps.controller.createInstallationPlan(
      installation.id,
      context,
      {
        sourceSnapshotId: snapshot.id,
        ...(shouldDeferCompatibilityReport
          ? { deferCompatibilityReport: true as const }
          : {}),
        ...(request.runnerProfileId
          ? { runnerProfileId: request.runnerProfileId }
          : {}),
      },
    );
    const run = await deps.controller.getRun(planResponse.planRun.id);
    const status = deployStatus(run);
    installation = await reconcileUploadInstallationStatus({
      deps,
      installation,
      created,
      status,
    });

    return {
      installation: toPublicInstallation(installation),
      installConfigId,
      run,
      planRun: run,
      status,
      created,
    };
  } catch (error) {
    if (created) {
      await markCreatedUploadInstallationError(deps, installation);
    }
    throw error;
  }
}

async function putProviderConnections(input: {
  readonly deps: DeployUploadDependencies;
  readonly installation: Installation;
  readonly connections: InstallationProviderEnvBindings;
  readonly id: string;
  readonly now: () => Date;
}): Promise<void> {
  const nowIso = input.now().toISOString();
  await input.deps.installations.putInstallationProviderEnvBindingSet({
    id: input.id,
    spaceId: input.installation.spaceId,
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
  readonly installation: Installation;
  readonly created: boolean;
  readonly status: NonNullable<DeployResponse["status"]>;
}): Promise<Installation> {
  if (input.created && input.status === "failed") {
    return await input.deps.installations.patchInstallationStatus(
      input.installation.id,
      "error",
    );
  }
  return input.installation;
}

async function markCreatedUploadInstallationError(
  deps: DeployUploadDependencies,
  installation: Installation,
): Promise<void> {
  try {
    await deps.installations.patchInstallationStatus(installation.id, "error");
  } catch {
    // Preserve the original deploy failure. A later status probe can still see
    // the failed run or the pending orphan that triggered this best-effort path.
  }
}

async function refreshInstallConfigVars(
  deps: DeployUploadDependencies,
  installConfigId: string,
  vars: Readonly<Record<string, JsonValue>> | undefined,
  outputAllowlist: InternalDeployRequest["outputAllowlist"] | undefined,
  now: () => Date,
): Promise<void> {
  const existing = await deps.installations.getInstallConfig(installConfigId);
  await deps.installations.putInstallConfig({
    ...existing,
    variableMapping: { ...(vars ?? {}) },
    outputAllowlist: refreshedOutputAllowlist(existing, outputAllowlist),
    updatedAt: now().toISOString(),
  });
}

function refreshedOutputAllowlist(
  existing: InstallConfig,
  outputAllowlist: InternalDeployRequest["outputAllowlist"] | undefined,
): InstallConfig["outputAllowlist"] {
  if (outputAllowlist !== undefined) return outputAllowlist;
  if (
    existing.sourceKind === "generic_capsule" &&
    Object.keys(existing.outputAllowlist).length === 0
  ) {
    return defaultCapsuleOutputAllowlist();
  }
  return existing.outputAllowlist;
}

function buildDefaultInstallConfig(input: {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly vars: Readonly<Record<string, JsonValue>> | undefined;
  readonly outputAllowlist:
    | InternalDeployRequest["outputAllowlist"]
    | undefined;
  readonly now: () => Date;
}): InstallConfig {
  const nowIso = input.now().toISOString();
  return {
    id: input.id,
    spaceId: input.spaceId,
    name: `${input.name}-upload`,
    // Generic OpenTofu Capsule (no template binding): the upload archive is the
    // child module copied under the Takosumi generated root.
    installType: "opentofu_module",
    trustLevel: "space",
    normalization: {
      allowBackendRewrite: true,
      allowProviderLift: true,
      allowAliasInjection: true,
    },
    variableMapping: { ...(input.vars ?? {}) },
    outputAllowlist: input.outputAllowlist ?? defaultCapsuleOutputAllowlist(),
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function toPublicInstallation(installation: Installation): PublicInstallation {
  const { installType: _installType, ...rest } = installation;
  return rest;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
