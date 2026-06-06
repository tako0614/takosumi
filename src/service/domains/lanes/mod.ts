/**
 * Lanes domain service (Core Specification §6.3-§6.7).
 *
 * Owns the App / Environment / InstallProfile / DeploymentProfile lifecycle:
 *   - App binds a Source to one install type (validates the Source exists in the
 *     same Space and the InstallProfile, when supplied, exists).
 *   - Environment is one execution lane of an App with §6.4 automation defaults
 *     applied by name (production / preview).
 *   - InstallProfile is read-only here (seeded from the official template
 *     catalog at bootstrap); list/get only.
 *   - DeploymentProfile is the per-Environment Connection binding (upsert).
 *
 * No secret material ever flows through this service; DeploymentProfile bindings
 * reference Connection ids only.
 */

import type {
  App,
  CreateAppRequest,
  CreateEnvironmentRequest,
  DeploymentProfile,
  Environment,
  InstallProfile,
  PatchAppRequest,
  PatchEnvironmentRequest,
  PutDeploymentProfileRequest,
} from "takosumi-contract/lanes";
import {
  CONNECTION_BINDING_SLOTS,
  environmentDefaultsForName,
  INSTALL_TYPES,
} from "takosumi-contract/lanes";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";

export interface LanesServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
}

export class LanesService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;

  constructor(deps: LanesServiceDependencies) {
    this.#store = deps.store;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
  }

  // --- App (§6.3) -----------------------------------------------------------

  async createApp(request: CreateAppRequest): Promise<App> {
    requireNonEmptyString(request.spaceId, "spaceId");
    requireNonEmptyString(request.name, "name");
    requireNonEmptyString(request.sourceId, "sourceId");
    if (!INSTALL_TYPES.includes(request.installType)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `installType must be one of ${INSTALL_TYPES.join(", ")}`,
      );
    }
    const source = await this.#store.getSource(request.sourceId);
    if (!source || source.spaceId !== request.spaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `sourceId ${request.sourceId} does not exist in space ${request.spaceId}`,
      );
    }
    if (request.installProfileId !== undefined) {
      await this.#requireInstallProfile(request.installProfileId);
    }
    const nowIso = this.#now().toISOString();
    const app: App = {
      id: this.#newId("app"),
      spaceId: request.spaceId,
      name: request.name,
      sourceId: request.sourceId,
      installType: request.installType,
      ...(request.installProfileId
        ? { installProfileId: request.installProfileId }
        : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.#store.putApp(app);
    return app;
  }

  async listApps(spaceId: string): Promise<readonly App[]> {
    requireNonEmptyString(spaceId, "spaceId");
    return await this.#store.listApps(spaceId);
  }

  async getApp(id: string): Promise<App> {
    return await this.#requireApp(id);
  }

  async patchApp(id: string, patch: PatchAppRequest): Promise<App> {
    const app = await this.#requireApp(id);
    const next: App = { ...app };
    if (patch.name !== undefined) {
      requireNonEmptyString(patch.name, "name");
      (next as { name: string }).name = patch.name;
    }
    if (patch.installProfileId !== undefined) {
      if (patch.installProfileId === null) {
        delete (next as { installProfileId?: string }).installProfileId;
      } else {
        await this.#requireInstallProfile(patch.installProfileId);
        (next as { installProfileId?: string }).installProfileId =
          patch.installProfileId;
      }
    }
    (next as { updatedAt: string }).updatedAt = this.#now().toISOString();
    await this.#store.putApp(next);
    return next;
  }

  /**
   * Deletes an App. Refuses when the App still has Environments (the caller must
   * remove lanes first) so a delete cannot orphan execution targets.
   */
  async deleteApp(id: string): Promise<boolean> {
    await this.#requireApp(id);
    const environments = await this.#store.listEnvironments(id);
    if (environments.length > 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `app ${id} still has ${environments.length} environment(s); delete them first`,
      );
    }
    return await this.#store.deleteApp(id);
  }

  // --- Environment (§6.4) ---------------------------------------------------

  async createEnvironment(
    appId: string,
    request: CreateEnvironmentRequest,
  ): Promise<Environment> {
    const app = await this.#requireApp(appId);
    requireNonEmptyString(request.name, "name");
    const source = await this.#store.getSource(app.sourceId);
    const defaults = environmentDefaultsForName(request.name);
    const nowIso = this.#now().toISOString();
    const environment: Environment = {
      id: this.#newId("env"),
      appId,
      name: request.name,
      ref: nonEmpty(request.ref) ?? source?.defaultRef ?? "main",
      path: nonEmpty(request.path) ?? source?.defaultPath ?? ".",
      autoSync: request.autoSync ?? defaults.autoSync,
      autoPlan: request.autoPlan ?? defaults.autoPlan,
      autoApply: request.autoApply ?? defaults.autoApply,
      requireApproval: request.requireApproval ?? defaults.requireApproval,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.#store.putEnvironment(environment);
    return environment;
  }

  async listEnvironments(appId: string): Promise<readonly Environment[]> {
    await this.#requireApp(appId);
    return await this.#store.listEnvironments(appId);
  }

  async getEnvironment(id: string): Promise<Environment> {
    return await this.#requireEnvironment(id);
  }

  async patchEnvironment(
    id: string,
    patch: PatchEnvironmentRequest,
  ): Promise<Environment> {
    const environment = await this.#requireEnvironment(id);
    const next: Environment = { ...environment };
    if (patch.ref !== undefined) {
      (next as { ref: string }).ref = nonEmpty(patch.ref) ?? environment.ref;
    }
    if (patch.path !== undefined) {
      (next as { path: string }).path = nonEmpty(patch.path) ?? environment.path;
    }
    for (
      const flag of [
        "autoSync",
        "autoPlan",
        "autoApply",
        "requireApproval",
      ] as const
    ) {
      if (patch[flag] !== undefined) {
        (next as Record<typeof flag, boolean>)[flag] = patch[flag]!;
      }
    }
    (next as { updatedAt: string }).updatedAt = this.#now().toISOString();
    await this.#store.putEnvironment(next);
    return next;
  }

  // --- InstallProfile (§6.6; read-only) -------------------------------------

  async listInstallProfiles(): Promise<readonly InstallProfile[]> {
    return await this.#store.listInstallProfiles();
  }

  async getInstallProfile(id: string): Promise<InstallProfile> {
    return await this.#requireInstallProfile(id);
  }

  // --- DeploymentProfile (§6.7) ---------------------------------------------

  async getDeploymentProfile(
    environmentId: string,
  ): Promise<DeploymentProfile | undefined> {
    await this.#requireEnvironment(environmentId);
    return await this.#store.getDeploymentProfileByEnvironment(environmentId);
  }

  async putDeploymentProfile(
    environmentId: string,
    request: PutDeploymentProfileRequest,
  ): Promise<DeploymentProfile> {
    await this.#requireEnvironment(environmentId);
    this.#validateBindings(request.bindings);
    const existing = await this.#store.getDeploymentProfileByEnvironment(
      environmentId,
    );
    const nowIso = this.#now().toISOString();
    const profile: DeploymentProfile = {
      id: existing?.id ?? this.#newId("dpf"),
      environmentId,
      bindings: request.bindings,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    await this.#store.putDeploymentProfile(profile);
    return profile;
  }

  #validateBindings(
    bindings: PutDeploymentProfileRequest["bindings"],
  ): void {
    for (const slot of Object.keys(bindings)) {
      if (!CONNECTION_BINDING_SLOTS.includes(slot as never)) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `unknown deployment-profile binding slot: ${slot}`,
        );
      }
    }
    for (const slot of CONNECTION_BINDING_SLOTS) {
      const binding = bindings[slot];
      if (!binding) continue;
      if (
        (binding.mode === "service" || binding.mode === "customer") &&
        !binding.connectionId
      ) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `binding ${slot} in ${binding.mode} mode requires a connectionId`,
        );
      }
    }
  }

  async #requireApp(id: string): Promise<App> {
    requireNonEmptyString(id, "appId");
    const app = await this.#store.getApp(id);
    if (!app) {
      throw new OpenTofuControllerError("not_found", `app ${id} not found`);
    }
    return app;
  }

  async #requireEnvironment(id: string): Promise<Environment> {
    requireNonEmptyString(id, "environmentId");
    const environment = await this.#store.getEnvironment(id);
    if (!environment) {
      throw new OpenTofuControllerError(
        "not_found",
        `environment ${id} not found`,
      );
    }
    return environment;
  }

  async #requireInstallProfile(id: string): Promise<InstallProfile> {
    requireNonEmptyString(id, "installProfileId");
    const profile = await this.#store.getInstallProfile(id);
    if (!profile) {
      throw new OpenTofuControllerError(
        "not_found",
        `install profile ${id} not found`,
      );
    }
    return profile;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
