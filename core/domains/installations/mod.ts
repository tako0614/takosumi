/**
 * Installations domain service (Core Specification §5 / §6 / §16).
 *
 * An Installation is the OpenTofu Capsule execution unit directly under a Space
 * (`@space/name`): one Installation = one Capsule normalized into a generated
 * root, one tfstate lineage, outputs, deployments, and activity. It is
 * configured by a service-side InstallConfig and pinned to one Source. The App /
 * Environment / InstallProfile lanes model is retired; `environment` is a
 * column on the Installation (UNIQUE(space_id, name, environment)).
 *
 * This service owns Installation creation + lookup and InstallConfig /
 * InstallationProviderEnvBinding record passthroughs with validation. No secret material flows
 * through it; bindings reference Connection ids only.
 */

import type {
  InstallationProviderEnvBindingSet,
  InstallConfig,
  Installation,
  InstallationStatus,
} from "takosumi-contract/installations";
import type { Page, PageParams } from "takosumi-contract/pagination";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";
import {
  isRetiredOfficialInstallConfigId,
  officialInstallConfigs,
} from "./official_seed.ts";

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
  /**
   * Registered git Source. Omit for an upload-origin Installation created by
   * `takosumi deploy`, which deploys an upload SourceSnapshot directly.
   */
  readonly sourceId?: string;
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
    requireNonEmptyString(request.installConfigId, "installConfigId");
    if (!INSTALLATION_NAME_PATTERN.test(request.name)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `name ${request.name} must match ${INSTALLATION_NAME_PATTERN.source}`,
      );
    }
    if (isRetiredOfficialInstallConfigId(request.installConfigId)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `installConfigId ${request.installConfigId} is a retired built-in alias; use a Git URL Capsule config instead`,
      );
    }
    const space = await this.#store.getSpace(request.spaceId);
    if (!space) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `spaceId ${request.spaceId} does not exist`,
      );
    }
    // A git Source is optional: upload-origin Installations (takosumi deploy)
    // have none. When supplied it must resolve in the same Space.
    if (request.sourceId !== undefined) {
      requireNonEmptyString(request.sourceId, "sourceId");
      const source = await this.#store.getSource(request.sourceId);
      if (!source || source.spaceId !== request.spaceId) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `sourceId ${request.sourceId} does not exist in space ${request.spaceId}`,
        );
      }
    }
    let config: InstallConfig;
    try {
      config = await this.getInstallConfig(request.installConfigId);
    } catch (error) {
      if (
        error instanceof OpenTofuControllerError &&
        error.code === "not_found"
      ) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `installConfigId ${request.installConfigId} does not exist`,
        );
      }
      throw error;
    }
    if (isRetiredOfficialInstallConfigId(config.id)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `installConfigId ${request.installConfigId} is a retired built-in alias; use a Git URL Capsule config instead`,
      );
    }
    // A space-scoped InstallConfig may only be used by its owning Space; an
    // Built-in shared config (no spaceId) is usable by any Space.
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
        {
          reason: "duplicate_installation",
          installationId: existing.id,
          spaceId: request.spaceId,
          name: request.name,
          environment: request.environment,
        },
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
      ...(request.sourceId ? { sourceId: request.sourceId } : {}),
      installType: config.installType,
      installConfigId: request.installConfigId,
      environment: request.environment,
      currentStateGeneration: 0,
      status: "pending",
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
        ...(created.sourceId ? { sourceId: created.sourceId } : {}),
        origin: created.sourceId ? "git" : "upload",
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

  async listInstallationsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<Installation>> {
    requireNonEmptyString(spaceId, "spaceId");
    return await this.#store.listInstallationsPage(spaceId, params);
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
    if (isRetiredOfficialInstallConfigId(config.id)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `install config ${config.id} is a retired built-in alias`,
      );
    }
    if (config.installType === "opentofu_root") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "opentofu_root is a legacy direct-root compatibility type; new InstallConfigs must use an OpenTofu Capsule install type",
      );
    }
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
    if (!config || isRetiredOfficialInstallConfigId(config.id)) {
      const fallback = this.#officialFallbackInstallConfigs().find(
        (official) => official.id === id,
      );
      if (fallback && !isRetiredOfficialInstallConfigId(fallback.id)) {
        return fallback;
      }
      throw new OpenTofuControllerError(
        "not_found",
        `install config ${id} not found`,
      );
    }
    return config;
  }

  async listInstallConfigs(
    spaceId?: string,
  ): Promise<readonly InstallConfig[]> {
    const stored = (await this.#store.listInstallConfigs(spaceId)).filter(
      (config) => !isRetiredOfficialInstallConfigId(config.id),
    );
    if (spaceId !== undefined) return stored;
    const byId = new Map<string, InstallConfig>(
      this.#officialFallbackInstallConfigs().map((config) => [
        config.id,
        config,
      ]),
    );
    for (const config of stored) byId.set(config.id, config);
    return [...byId.values()];
  }

  #officialFallbackInstallConfigs(): readonly InstallConfig[] {
    return officialInstallConfigs({ now: this.#now }).filter(
      (config) => !isRetiredOfficialInstallConfigId(config.id),
    );
  }

  // --- Installation provider env binding record ------------------------------

  async putInstallationProviderEnvBindingSet(
    profile: InstallationProviderEnvBindingSet,
  ): Promise<InstallationProviderEnvBindingSet> {
    requireNonEmptyString(profile.id, "id");
    requireNonEmptyString(profile.installationId, "installationId");
    requireNonEmptyString(profile.environment, "environment");
    const installation = await this.#requireInstallation(
      profile.installationId,
    );
    if (installation.spaceId !== profile.spaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `provider env binding set spaceId ${profile.spaceId} does not match ` +
          `installation ${profile.installationId} space ${installation.spaceId}`,
      );
    }
    return await this.#store.putInstallationProviderEnvBindingSet(profile);
  }

  async getInstallationProviderEnvBindingSetByInstallation(
    installationId: string,
    environment: string,
  ): Promise<InstallationProviderEnvBindingSet | undefined> {
    requireNonEmptyString(installationId, "installationId");
    requireNonEmptyString(environment, "environment");
    return await this.#store.getInstallationProviderEnvBindingSetByInstallation(
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
