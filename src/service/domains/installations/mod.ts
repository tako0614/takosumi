/**
 * Installations domain service (Core Specification §5 / §11).
 *
 * An Installation is the OpenTofu execution unit directly under a Space
 * (`@space/name`): one Installation = one OpenTofu root/state, configured by a
 * service-side InstallConfig and pinned to one Source. The App / Environment /
 * InstallProfile lanes model is retired; `environment` is a column on the
 * Installation (UNIQUE(space_id, name, environment)).
 *
 * This service owns Installation creation + lookup and InstallConfig /
 * DeploymentProfile passthroughs with validation. No secret material flows
 * through it; DeploymentProfile bindings reference Connection ids only.
 */

import type {
  DeploymentProfile,
  InstallConfig,
  Installation,
  InstallationStatus,
} from "takosumi-contract/installations";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";

/**
 * Installation name grammar (spec §5): a DNS-style slug. The name doubles as the
 * `@space/name` segment and the derived `slug`, so it stays lowercase alnum +
 * hyphen.
 */
const INSTALLATION_NAME_PATTERN = /^[a-z0-9-]+$/;

export interface CreateInstallationRequest {
  readonly spaceId: string;
  readonly name: string;
  readonly environment: string;
  readonly sourceId: string;
  readonly installConfigId: string;
}

export interface InstallationsServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
  /** Space-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
}

export class InstallationsService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  readonly #activity: ActivityRecorder;

  constructor(deps: InstallationsServiceDependencies) {
    this.#store = deps.store;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
    this.#activity = deps.activity ?? NOOP_ACTIVITY_RECORDER;
  }

  // --- Installation (§5) ----------------------------------------------------

  async createInstallation(
    request: CreateInstallationRequest,
  ): Promise<Installation> {
    requireNonEmptyString(request.spaceId, "spaceId");
    requireNonEmptyString(request.name, "name");
    requireNonEmptyString(request.environment, "environment");
    requireNonEmptyString(request.sourceId, "sourceId");
    requireNonEmptyString(request.installConfigId, "installConfigId");
    if (!INSTALLATION_NAME_PATTERN.test(request.name)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `name ${request.name} must match ${INSTALLATION_NAME_PATTERN.source}`,
      );
    }
    const space = await this.#store.getSpace(request.spaceId);
    if (!space) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `spaceId ${request.spaceId} does not exist`,
      );
    }
    const source = await this.#store.getSource(request.sourceId);
    if (!source || source.spaceId !== request.spaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `sourceId ${request.sourceId} does not exist in space ${request.spaceId}`,
      );
    }
    const config = await this.#store.getInstallConfig(request.installConfigId);
    if (!config) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `installConfigId ${request.installConfigId} does not exist`,
      );
    }
    // A space-scoped InstallConfig may only be used by its owning Space; an
    // official catalog config (no spaceId) is usable by any Space.
    if (config.spaceId !== undefined && config.spaceId !== request.spaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `installConfigId ${request.installConfigId} is not available to space ${request.spaceId}`,
      );
    }
    const existing = await this.#store.getInstallationByName(
      request.spaceId,
      request.name,
      request.environment,
    );
    if (existing) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `installation @${space.handle}/${request.name} (${request.environment}) already exists`,
      );
    }
    const nowIso = this.#now().toISOString();
    const installation: Installation = {
      id: this.#newId("inst"),
      spaceId: request.spaceId,
      name: request.name,
      // The name is already a slug; the column is kept distinct so a future
      // display name can diverge from the URL segment.
      slug: request.name,
      sourceId: request.sourceId,
      installType: config.installType,
      installConfigId: request.installConfigId,
      environment: request.environment,
      currentStateGeneration: 0,
      status: "installing",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const created = await this.#store.putInstallation(installation);
    // Activity (§27 / §34): an Installation was created in the Space. Names /
    // ids only — no secret material.
    await this.#activity.record({
      spaceId: created.spaceId,
      action: "installation.created",
      targetType: "installation",
      targetId: created.id,
      metadata: {
        name: created.name,
        environment: created.environment,
        installType: created.installType,
        sourceId: created.sourceId,
      },
    });
    return created;
  }

  async getInstallation(id: string): Promise<Installation> {
    return await this.#requireInstallation(id);
  }

  async listInstallations(spaceId: string): Promise<readonly Installation[]> {
    requireNonEmptyString(spaceId, "spaceId");
    return await this.#store.listInstallations(spaceId);
  }

  /**
   * Patches the lifecycle status of an Installation. Other ledger cursors
   * (currentDeploymentId / currentStateGeneration / currentOutputSnapshotId)
   * are owned by the apply pipeline through the guarded `patchInstallation`
   * store accessor and are not exposed here.
   */
  async patchInstallationStatus(
    id: string,
    status: InstallationStatus,
  ): Promise<Installation> {
    await this.#requireInstallation(id);
    const updated = await this.#store.patchInstallation(id, {
      status,
      updatedAt: this.#now().toISOString(),
    });
    if (!updated) {
      throw new OpenTofuControllerError(
        "not_found",
        `installation ${id} not found`,
      );
    }
    return updated;
  }

  // --- InstallConfig (§11) --------------------------------------------------

  async putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    requireNonEmptyString(config.id, "id");
    requireNonEmptyString(config.name, "name");
    if (config.spaceId !== undefined) {
      const space = await this.#store.getSpace(config.spaceId);
      if (!space) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `spaceId ${config.spaceId} does not exist`,
        );
      }
    }
    return await this.#store.putInstallConfig(config);
  }

  async getInstallConfig(id: string): Promise<InstallConfig> {
    requireNonEmptyString(id, "id");
    const config = await this.#store.getInstallConfig(id);
    if (!config) {
      throw new OpenTofuControllerError(
        "not_found",
        `install config ${id} not found`,
      );
    }
    return config;
  }

  async listInstallConfigs(spaceId?: string): Promise<readonly InstallConfig[]> {
    return await this.#store.listInstallConfigs(spaceId);
  }

  // --- DeploymentProfile (§9) -----------------------------------------------

  async putDeploymentProfile(
    profile: DeploymentProfile,
  ): Promise<DeploymentProfile> {
    requireNonEmptyString(profile.id, "id");
    requireNonEmptyString(profile.installationId, "installationId");
    requireNonEmptyString(profile.environment, "environment");
    const installation = await this.#requireInstallation(profile.installationId);
    if (installation.spaceId !== profile.spaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `deployment profile spaceId ${profile.spaceId} does not match ` +
          `installation ${profile.installationId} space ${installation.spaceId}`,
      );
    }
    return await this.#store.putDeploymentProfile(profile);
  }

  async getDeploymentProfileByInstallation(
    installationId: string,
    environment: string,
  ): Promise<DeploymentProfile | undefined> {
    requireNonEmptyString(installationId, "installationId");
    requireNonEmptyString(environment, "environment");
    return await this.#store.getDeploymentProfileByInstallation(
      installationId,
      environment,
    );
  }

  async #requireInstallation(id: string): Promise<Installation> {
    requireNonEmptyString(id, "id");
    const installation = await this.#store.getInstallation(id);
    if (!installation) {
      throw new OpenTofuControllerError(
        "not_found",
        `installation ${id} not found`,
      );
    }
    return installation;
  }
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
