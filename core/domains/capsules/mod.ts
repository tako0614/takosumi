/**
 * Capsules domain service (Core Specification §5 / §6 / §16).
 *
 * A Capsule is the OpenTofu execution unit directly under a Workspace / Project
 * (`@workspace/name`): one Capsule = one normalized generated root, one tfstate
 * lineage, outputs, and activity. It is configured by a service-side
 * InstallConfig and optionally pinned to one Source. The App / Environment /
 * InstallProfile lanes model is retired; `environment` is a column on the
 * Capsule (UNIQUE(project_id, name, environment)). Upload/artifact deploys omit
 * Source and still use the same Capsule ledger.
 *
 * This service owns Capsule creation + lookup and InstallConfig /
 * CapsuleProviderEnvBinding record passthroughs with validation. No secret
 * material flows through it; bindings reference Connection ids only.
 *
 * (Formerly `InstallationsService` / `Installation`. The transient
 * `Installation` contract alias and the spine store's `*Installation*` method
 * names stay until the rename converges.)
 */

import type { Capsule, CapsuleStatus } from "takosumi-contract/capsules";
import type {
  CapsuleProviderEnvBindingSet,
  InstallConfig,
} from "takosumi-contract/install-configs";
import type { Page } from "takosumi-contract/pagination";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type {
  CapsuleListPageParams,
  OpenTofuDeploymentStore,
} from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";
import {
  isRetiredOfficialInstallConfigId,
  officialInstallConfigs,
} from "./official_seed.ts";

/**
 * Capsule name grammar (spec §5): a DNS-style slug. The name doubles as the
 * `@workspace/name` segment and the derived `slug`, so it stays lowercase alnum
 * + hyphen.
 */
const CAPSULE_NAME_PATTERN = /^[a-z0-9-]+$/;

export interface CreateCapsuleRequest {
  readonly workspaceId: string;
  readonly name: string;
  readonly environment: string;
  /**
   * Registered git Source. Omit only for legacy source-less Capsules retained
   * for internal/operator compatibility with retired upload/artifact snapshots.
   */
  readonly sourceId?: string;
  readonly installConfigId: string;
}

export interface CapsulesServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
  /** Workspace-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
}

export class CapsulesService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  readonly #activity: ActivityRecorder;

  constructor(deps: CapsulesServiceDependencies) {
    this.#store = deps.store;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
    this.#activity = deps.activity ?? NOOP_ACTIVITY_RECORDER;
  }

  // --- Capsule (§5) ---------------------------------------------------------

  async createCapsule(request: CreateCapsuleRequest): Promise<Capsule> {
    requireNonEmptyString(request.workspaceId, "workspaceId");
    requireNonEmptyString(request.name, "name");
    requireNonEmptyString(request.environment, "environment");
    requireNonEmptyString(request.installConfigId, "installConfigId");
    if (!CAPSULE_NAME_PATTERN.test(request.name)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `name ${request.name} must match ${CAPSULE_NAME_PATTERN.source}`,
      );
    }
    if (isRetiredOfficialInstallConfigId(request.installConfigId)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `installConfigId ${request.installConfigId} is a retired built-in alias; use a Git URL Capsule config instead`,
      );
    }
    const workspace = await this.#store.getSpace(request.workspaceId);
    if (!workspace) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "workspace does not exist",
      );
    }
    // A git Source is optional only for legacy upload/artifact-origin Capsules.
    // When supplied it must resolve in the same Workspace.
    if (request.sourceId !== undefined) {
      requireNonEmptyString(request.sourceId, "sourceId");
      const source = await this.#store.getSource(request.sourceId);
      const sourceWorkspaceId = source?.workspaceId ?? source?.spaceId;
      if (!source || sourceWorkspaceId !== request.workspaceId) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "source is not available to this workspace",
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
          "install config does not exist",
        );
      }
      throw error;
    }
    if (isRetiredOfficialInstallConfigId(config.id)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "install config is retired; use a Git URL Capsule config instead",
      );
    }
    // A workspace-scoped InstallConfig may only be used by its owning Workspace;
    // a built-in shared config (no workspaceId) is usable by any Workspace.
    const configWorkspaceId = config.workspaceId ?? config.spaceId;
    if (
      configWorkspaceId !== undefined &&
      configWorkspaceId !== request.workspaceId
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "install config is not available to this workspace",
      );
    }
    const existing = await this.#store.getInstallationByName(
      request.workspaceId,
      request.name,
      request.environment,
    );
    if (existing) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "capsule already exists",
        {
          reason: "duplicate_capsule",
          name: request.name,
          environment: request.environment,
        },
      );
    }
    const nowIso = this.#now().toISOString();
    const capsule: Capsule = {
      id: this.#newId("inst"),
      workspaceId: request.workspaceId,
      // @deprecated mirror kept populated until the rename converges.
      spaceId: request.workspaceId,
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
    const created = await this.#store.putInstallation(capsule);
    // Activity (§27 / §34): a Capsule was created in the Workspace. Names /
    // ids only — no secret material.
    await this.#activity.record({
      workspaceId: created.workspaceId,
      spaceId: created.workspaceId,
      action: "capsule.created",
      targetType: "capsule",
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

  async getCapsule(id: string): Promise<Capsule> {
    return await this.#requireCapsule(id);
  }

  async listCapsules(workspaceId: string): Promise<readonly Capsule[]> {
    requireNonEmptyString(workspaceId, "workspaceId");
    return await this.#store.listInstallations(workspaceId);
  }

  async listCapsulesPage(
    workspaceId: string,
    params: CapsuleListPageParams,
  ): Promise<Page<Capsule>> {
    requireNonEmptyString(workspaceId, "workspaceId");
    return await this.#store.listInstallationsPage(workspaceId, params);
  }

  /**
   * Patches the lifecycle status of a Capsule. Other ledger cursors
   * (currentStateVersionId / currentStateGeneration / currentOutputId) are owned
   * by the apply pipeline through the guarded `patchInstallation` store accessor
   * and are not exposed here.
   */
  async patchCapsuleStatus(
    id: string,
    status: CapsuleStatus,
  ): Promise<Capsule> {
    await this.#requireCapsule(id);
    const updated = await this.#store.patchInstallation(id, {
      status,
      updatedAt: this.#now().toISOString(),
    });
    if (!updated) {
      throw new OpenTofuControllerError("not_found", `capsule ${id} not found`);
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
    if (config.build?.enabled && config.prebuiltArtifact) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "InstallConfig build and prebuiltArtifact are mutually exclusive",
      );
    }
    if (hasLegacyArtifactConfig(config)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "build/prebuiltArtifact are legacy artifact compatibility fields; new InstallConfigs must use Git-hosted OpenTofu modules with ordinary variables instead",
      );
    }
    if (config.prebuiltArtifact) {
      assertSafeInstallConfigPath(
        config.prebuiltArtifact.path,
        "prebuiltArtifact.path",
      );
    }
    const configWorkspaceId = config.workspaceId ?? config.spaceId;
    if (configWorkspaceId !== undefined) {
      const workspace = await this.#store.getSpace(configWorkspaceId);
      if (!workspace) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "workspace does not exist",
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
    workspaceId?: string,
  ): Promise<readonly InstallConfig[]> {
    const stored = (await this.#store.listInstallConfigs(workspaceId)).filter(
      (config) =>
        !isRetiredOfficialInstallConfigId(config.id) &&
        isSelectableInstallConfig(config),
    );
    if (workspaceId !== undefined) return stored;
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

  // --- Capsule provider env binding record ----------------------------------

  async putCapsuleProviderEnvBindingSet(
    profile: CapsuleProviderEnvBindingSet,
  ): Promise<CapsuleProviderEnvBindingSet> {
    requireNonEmptyString(profile.id, "id");
    const profileCapsuleId = profile.capsuleId ?? profile.installationId;
    requireNonEmptyString(profileCapsuleId, "capsuleId");
    requireNonEmptyString(profile.environment, "environment");
    const capsule = await this.#requireCapsule(profileCapsuleId);
    if (
      (capsule.workspaceId ?? capsule.spaceId) !==
      (profile.workspaceId ?? profile.spaceId)
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "provider env binding set workspace does not match capsule workspace",
      );
    }
    return await this.#store.putInstallationProviderEnvBindingSet(profile);
  }

  async getCapsuleProviderEnvBindingSetByCapsule(
    capsuleId: string,
    environment: string,
  ): Promise<CapsuleProviderEnvBindingSet | undefined> {
    requireNonEmptyString(capsuleId, "capsuleId");
    requireNonEmptyString(environment, "environment");
    return await this.#store.getInstallationProviderEnvBindingSetByInstallation(
      capsuleId,
      environment,
    );
  }

  // --- Transient deprecated aliases (removed at rename convergence) ----------

  /** @deprecated transient alias for {@link createCapsule}. */
  async createInstallation(
    request: CreateInstallationRequest,
  ): Promise<Capsule> {
    return await this.createCapsule({
      workspaceId: request.workspaceId ?? request.spaceId ?? "",
      name: request.name,
      environment: request.environment,
      ...(request.sourceId ? { sourceId: request.sourceId } : {}),
      installConfigId: request.installConfigId,
    });
  }

  /** @deprecated transient alias for {@link getCapsule}. */
  async getInstallation(id: string): Promise<Capsule> {
    return await this.getCapsule(id);
  }

  /** @deprecated transient alias for {@link listCapsules}. */
  async listInstallations(workspaceId: string): Promise<readonly Capsule[]> {
    return await this.listCapsules(workspaceId);
  }

  /** @deprecated transient alias for {@link listCapsulesPage}. */
  async listInstallationsPage(
    workspaceId: string,
    params: CapsuleListPageParams,
  ): Promise<Page<Capsule>> {
    return await this.listCapsulesPage(workspaceId, params);
  }

  /** @deprecated transient alias for {@link patchCapsuleStatus}. */
  async patchInstallationStatus(
    id: string,
    status: CapsuleStatus,
  ): Promise<Capsule> {
    return await this.patchCapsuleStatus(id, status);
  }

  /** @deprecated transient alias for {@link putCapsuleProviderEnvBindingSet}. */
  async putInstallationProviderEnvBindingSet(
    profile: CapsuleProviderEnvBindingSet,
  ): Promise<CapsuleProviderEnvBindingSet> {
    return await this.putCapsuleProviderEnvBindingSet(profile);
  }

  /** @deprecated transient alias for {@link getCapsuleProviderEnvBindingSetByCapsule}. */
  async getInstallationProviderEnvBindingSetByInstallation(
    capsuleId: string,
    environment: string,
  ): Promise<CapsuleProviderEnvBindingSet | undefined> {
    return await this.getCapsuleProviderEnvBindingSetByCapsule(
      capsuleId,
      environment,
    );
  }

  async #requireCapsule(id: string): Promise<Capsule> {
    requireNonEmptyString(id, "id");
    const capsule = await this.#store.getInstallation(id);
    if (!capsule) {
      throw new OpenTofuControllerError("not_found", `capsule ${id} not found`);
    }
    return capsule;
  }
}

/**
 * @deprecated transient alias for {@link CreateCapsuleRequest}. Accepts the old
 * `spaceId` field name during the rename convergence.
 */
export interface CreateInstallationRequest {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly name: string;
  readonly environment: string;
  readonly sourceId?: string;
  readonly installConfigId: string;
}

function assertSafeInstallConfigPath(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.startsWith("/") ||
    value.split(/[\\/]+/).some((part) => part === "..") ||
    value.includes("\0")
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be a safe relative path inside the SourceSnapshot`,
    );
  }
}

function hasLegacyArtifactConfig(config: InstallConfig): boolean {
  return config.build !== undefined || config.prebuiltArtifact !== undefined;
}

function isSelectableInstallConfig(config: InstallConfig): boolean {
  if (config.internal?.reason === "per_install_overrides") return false;
  if (
    config.workspaceId !== undefined &&
    /^icfg_[0-9a-f]{16}$/iu.test(config.id)
  ) {
    return false;
  }
  return true;
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
