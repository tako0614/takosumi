/**
 * Capsules domain service (Core Specification §5 / §6 / §16).
 *
 * A Capsule is the OpenTofu execution unit directly under a Workspace / Project
 * (`@workspace/name`): one Capsule = one OpenTofu root execution, one tfstate
 * lineage, outputs, and activity. It is configured by a service-side
 * InstallConfig and pinned to one Git Source. The App / Environment /
 * InstallProfile lanes model is retired; `environment` is a column on the
 * Capsule (UNIQUE(project_id, name, environment)).
 *
 * This service owns Capsule creation + lookup and InstallConfig /
 * ProviderBindingSet record passthroughs with validation. No secret material
 * flows through it; bindings reference ProviderConnection ids only.
 */

import type { Capsule, CapsuleStatus } from "takosumi-contract/capsules";
import type {
  ProviderBindingSet,
  InstallConfig,
  InstallConfigLifecycleAction,
  InstallConfigPatchV1,
} from "takosumi-contract/install-configs";
import {
  clampPageLimit,
  DEFAULT_PAGE_LIMIT,
  pageFromProbe,
  type Page,
  type PageParams,
} from "takosumi-contract/pagination";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type {
  CapsuleListPageParams,
  OpenTofuControlStore,
} from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";
import { validateCapsuleInterfaceBlueprints } from "../interfaces/service.ts";
import { ProjectsService } from "../projects/mod.ts";
import {
  containsSecretLikeString,
  isSecretKey,
} from "takosumi-contract/redaction";
import { capsuleInterfaceBlueprintsNeedInstallingPrincipal } from "takosumi-contract/interfaces";
import { materializeInstallContextVariables } from "../deploy-control/validation.ts";
import { parseInstallConfigPatchV1 } from "./install_config_patch.ts";

/**
 * Capsule name grammar (spec §5): a DNS-style slug. The name doubles as the
 * `@workspace/name` segment and the derived `slug`, so it stays lowercase alnum
 * + hyphen.
 */
const CAPSULE_NAME_PATTERN = /^[a-z0-9-]+$/;

export interface CreateCapsuleRequest {
  readonly workspaceId: string;
  /** Defaults to the Workspace-qualified default Project. */
  readonly projectId?: string;
  readonly name: string;
  readonly environment: string;
  /** Registered Git Source. */
  readonly sourceId: string;
  readonly installConfigId: string;
  /** Auto-update opt-in (see {@link Capsule.autoUpdate}). Defaults to off. */
  readonly autoUpdate?: boolean;
}

export interface CapsulesServiceDependencies {
  readonly store: OpenTofuControlStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
  /** Workspace-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
  readonly projects?: ProjectsService;
}

export class CapsulesService {
  readonly #store: OpenTofuControlStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  readonly #activity: ActivityRecorder;
  readonly #projects: ProjectsService;

  constructor(deps: CapsulesServiceDependencies) {
    this.#store = deps.store;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
    this.#activity = deps.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#projects =
      deps.projects ?? new ProjectsService({ store: deps.store });
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
    const workspace = await this.#store.getWorkspace(request.workspaceId);
    if (!workspace) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "workspace does not exist",
      );
    }
    const project = request.projectId
      ? await this.#projects.getProject(request.projectId)
      : await this.#projects.ensureDefaultProject(request.workspaceId);
    if (project.workspaceId !== request.workspaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "project is not available to this workspace",
      );
    }
    requireNonEmptyString(request.sourceId, "sourceId");
    const source = await this.#store.getSource(request.sourceId);
    if (!source || source.workspaceId !== request.workspaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "source is not available to this workspace",
      );
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
    validateCapsuleInterfaceBlueprints(config.interfaceBlueprints ?? []);
    if (
      capsuleInterfaceBlueprintsNeedInstallingPrincipal(
        config.interfaceBlueprints,
      )
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "install config contains an unresolved installing Principal binding placeholder",
      );
    }
    // A workspace-scoped InstallConfig may only be used by its owning Workspace;
    // an operator catalog/default config without workspaceId is reusable.
    const configWorkspaceId = config.workspaceId;
    if (
      configWorkspaceId !== undefined &&
      configWorkspaceId !== request.workspaceId
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "install config is not available to this workspace",
      );
    }
    const existing = await this.#store.getCapsuleByName(
      project.id,
      request.name,
      request.environment,
    );
    if (existing && existing.status !== "destroyed") {
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
      id: this.#newId("cap"),
      workspaceId: request.workspaceId,
      projectId: project.id,
      name: request.name,
      // The name is already a slug; the column is kept distinct so a future
      // display name can diverge from the URL segment.
      slug: request.name,
      sourceId: request.sourceId,
      installConfigId: request.installConfigId,
      environment: request.environment,
      currentStateGeneration: 0,
      status: "pending",
      ...(request.autoUpdate === true ? { autoUpdate: true } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const created = await this.#store.putCapsule(capsule);
    // Activity (§27 / §34): a Capsule was created in the Workspace. Names /
    // ids only — no secret material.
    await this.#activity.record({
      workspaceId: created.workspaceId,
      action: "capsule.created",
      targetType: "capsule",
      targetId: created.id,
      metadata: {
        name: created.name,
        environment: created.environment,
        projectId: created.projectId,
        sourceId: created.sourceId,
        origin: "git",
      },
    });
    return created;
  }

  async getCapsule(id: string): Promise<Capsule> {
    return await this.#requireCapsule(id);
  }

  async listCapsules(workspaceId: string): Promise<readonly Capsule[]> {
    requireNonEmptyString(workspaceId, "workspaceId");
    return await this.#store.listCapsules(workspaceId);
  }

  async listCapsulesPage(
    workspaceId: string,
    params: CapsuleListPageParams,
  ): Promise<Page<Capsule>> {
    requireNonEmptyString(workspaceId, "workspaceId");
    return await this.#store.listCapsulesPage(workspaceId, params);
  }

  /**
   * Patches the lifecycle status of a Capsule. Other ledger cursors
   * (currentStateVersionId / currentStateGeneration / currentOutputId) are owned
   * by the apply pipeline through the guarded `patchCapsule` store accessor
   * and are not exposed here.
   */
  async patchCapsuleStatus(
    id: string,
    status: CapsuleStatus,
  ): Promise<Capsule> {
    await this.#requireCapsule(id);
    const updated = await this.#store.patchCapsule(id, {
      status,
      updatedAt: this.#now().toISOString(),
    });
    if (!updated) {
      throw new OpenTofuControllerError("not_found", `capsule ${id} not found`);
    }
    return updated;
  }

  /** Toggles the auto-update opt-in (see {@link Capsule.autoUpdate}). */
  async setCapsuleAutoUpdate(id: string, enabled: boolean): Promise<Capsule> {
    await this.#requireCapsule(id);
    const updated = await this.#store.patchCapsule(id, {
      autoUpdate: enabled,
      updatedAt: this.#now().toISOString(),
    });
    if (!updated) {
      throw new OpenTofuControllerError("not_found", `capsule ${id} not found`);
    }
    await this.#activity.record({
      workspaceId: updated.workspaceId,
      action: enabled
        ? "capsule.auto_update_enabled"
        : "capsule.auto_update_disabled",
      targetType: "capsule",
      targetId: updated.id,
      metadata: { name: updated.name, environment: updated.environment },
    });
    return updated;
  }

  /**
   * Abandons a Capsule that never reached a successful apply. This is not a
   * destroy operation: no remote resources are claimed to have been torn down.
   * It only closes the local ledger row and releases any pre-apply host claims
   * so the user can reinstall or choose the same public name again.
   */
  async abandonUnappliedCapsule(id: string, reason: string): Promise<Capsule> {
    const existing = await this.#requireCapsule(id);
    if (existing.currentStateVersionId || existing.currentStateGeneration > 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${id} has applied state and must use the destroy flow`,
      );
    }
    const now = this.#now().toISOString();
    const updated = await this.#store.patchCapsule(id, {
      status: "destroyed",
      updatedAt: now,
    });
    if (!updated) {
      throw new OpenTofuControllerError("not_found", `capsule ${id} not found`);
    }
    await this.#store.deleteProviderBindingSet(updated.id, updated.environment);
    await this.#store.releasePublicHostsForCapsule(id, now);
    await this.#activity.record({
      workspaceId: updated.workspaceId,
      action: "capsule.abandoned",
      targetType: "capsule",
      targetId: updated.id,
      metadata: {
        name: updated.name,
        environment: updated.environment,
        reason,
      },
    });
    return updated;
  }

  // --- InstallConfig (§11) --------------------------------------------------

  async putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    requireNonEmptyString(config.id, "id");
    requireNonEmptyString(config.name, "name");
    if (config.sourceBuild) validateSourceBuild(config.sourceBuild);
    validateLifecycleActions(config);
    materializeInstallContextVariables(config.installContextVariableMapping, {
      workspaceId: "workspace-validation",
      capsuleId: "capsule-validation",
    });
    const configWorkspaceId = config.workspaceId;
    if (configWorkspaceId !== undefined) {
      const workspace = await this.#store.getWorkspace(configWorkspaceId);
      if (!workspace) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "workspace does not exist",
        );
      }
    }
    validateCapsuleInterfaceBlueprints(config.interfaceBlueprints ?? []);
    return await this.#store.putInstallConfig(config);
  }

  /**
   * Apply a versioned, operator-selected mutable contribution to one exact
   * InstallConfig row. The caller chooses the target id explicitly; this
   * method never discovers a repository asset or selects a release.
   */
  async applyInstallConfigPatch(
    id: string,
    value: unknown,
  ): Promise<InstallConfig> {
    const patch = parseInstallConfigPatchV1(value);
    const current = await this.getInstallConfig(id);
    if (
      current.workspaceId !== undefined &&
      capsuleInterfaceBlueprintsNeedInstallingPrincipal(
        patch.interfaceBlueprints,
      )
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "installing Principal binding placeholders can be patched only on a shared pre-install config",
      );
    }
    const nextPolicy = patchPolicy(current.policy, patch);
    return await this.putInstallConfig({
      ...current,
      ...(hasOwn(patch, "variableMapping")
        ? { variableMapping: patch.variableMapping! }
        : {}),
      ...(hasOwn(patch, "variablePresentation")
        ? { variablePresentation: patch.variablePresentation! }
        : {}),
      ...(hasOwn(patch, "installExperience")
        ? { installExperience: patch.installExperience! }
        : {}),
      ...(hasOwn(patch, "outputAllowlist")
        ? { outputAllowlist: patch.outputAllowlist! }
        : {}),
      ...(hasOwn(patch, "interfaceBlueprints")
        ? { interfaceBlueprints: patch.interfaceBlueprints! }
        : {}),
      ...(hasOwn(patch, "lifecycleActions")
        ? { lifecycleActions: patch.lifecycleActions! }
        : {}),
      policy: nextPolicy,
      updatedAt: this.#now().toISOString(),
    });
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

  async getInstallConfigsByIds(
    ids: readonly string[],
  ): Promise<readonly InstallConfig[]> {
    for (const id of ids) requireNonEmptyString(id, "id");
    return await this.#store.getInstallConfigsByIds(ids);
  }

  async listInstallConfigs(
    workspaceId?: string,
    options: { readonly includeInternal?: boolean } = {},
  ): Promise<readonly InstallConfig[]> {
    const configs = await this.#store.listInstallConfigs(workspaceId);
    return options.includeInternal
      ? configs
      : configs.filter(isSelectableInstallConfig);
  }

  async listSharedInstallConfigs(
    options: { readonly includeInternal?: boolean } = {},
  ): Promise<readonly InstallConfig[]> {
    const configs = await this.#store.listSharedInstallConfigs();
    return options.includeInternal
      ? configs
      : configs.filter(isSelectableInstallConfig);
  }

  async listInstallConfigsPage(
    workspaceId: string,
    params: PageParams,
    options: { readonly includeInternal?: boolean } = {},
  ): Promise<Page<InstallConfig>> {
    requireNonEmptyString(workspaceId, "workspaceId");
    return filterInstallConfigPage(
      await this.#store.listInstallConfigsPage(workspaceId, params),
      options.includeInternal === true,
    );
  }

  async listSharedInstallConfigsPage(
    params: PageParams,
    options: { readonly includeInternal?: boolean } = {},
  ): Promise<Page<InstallConfig>> {
    return filterInstallConfigPage(
      await this.#store.listSharedInstallConfigsPage(params),
      options.includeInternal === true,
    );
  }

  /**
   * Bounded keyset page over the shared + one-Workspace union. Each exact
   * scope is paged in the durable store; the service only merges at most
   * `limit + 1` visible candidates from either side.
   */
  async listInstallConfigUnionPage(
    workspaceId: string | undefined,
    params: PageParams,
    options: {
      readonly view?: "all" | "store";
      readonly includeInternal?: boolean;
    } = {},
  ): Promise<Page<InstallConfig>> {
    if (workspaceId !== undefined) {
      requireNonEmptyString(workspaceId, "workspaceId");
    }
    const limit = clampPageLimit(params.limit);
    const visible = (config: InstallConfig): boolean => {
      if (!options.includeInternal && !isSelectableInstallConfig(config)) {
        return false;
      }
      return options.view !== "store" || isStoreInstallConfig(config);
    };
    const loads: Array<(page: PageParams) => Promise<Page<InstallConfig>>> = [
      (page) => this.#store.listSharedInstallConfigsPage(page),
    ];
    if (workspaceId !== undefined && options.view !== "store") {
      loads.push((page) =>
        this.#store.listInstallConfigsPage(workspaceId, page),
      );
    }
    const candidates = await Promise.all(
      loads.map((load) =>
        collectVisibleInstallConfigCandidates(
          load,
          params.cursor,
          limit + 1,
          visible,
        ),
      ),
    );
    return pageFromProbe(candidates.flat().sort(compareInstallConfigs), limit);
  }

  // --- Capsule provider env binding record ----------------------------------

  async putProviderBindingSet(
    profile: ProviderBindingSet,
  ): Promise<ProviderBindingSet> {
    requireNonEmptyString(profile.id, "id");
    const profileCapsuleId = profile.capsuleId;
    requireNonEmptyString(profileCapsuleId, "capsuleId");
    requireNonEmptyString(profile.environment, "environment");
    const capsule = await this.#requireCapsule(profileCapsuleId);
    if (capsule.workspaceId !== profile.workspaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "provider env binding set workspace does not match capsule workspace",
      );
    }
    if (capsule.status === "destroyed") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${profileCapsuleId} is deleted`,
      );
    }
    return await this.#store.putProviderBindingSet(profile);
  }

  async getProviderBindingSetByCapsule(
    capsuleId: string,
    environment: string,
  ): Promise<ProviderBindingSet | undefined> {
    requireNonEmptyString(capsuleId, "capsuleId");
    requireNonEmptyString(environment, "environment");
    const capsule = await this.#requireCapsule(capsuleId);
    if (capsule.status === "destroyed") return undefined;
    return await this.#store.getProviderBindingSetByCapsule(
      capsuleId,
      environment,
    );
  }

  async #requireCapsule(id: string): Promise<Capsule> {
    requireNonEmptyString(id, "id");
    const capsule = await this.#store.getCapsule(id);
    if (!capsule) {
      throw new OpenTofuControllerError("not_found", `capsule ${id} not found`);
    }
    return capsule;
  }
}

function filterInstallConfigPage(
  page: Page<InstallConfig>,
  includeInternal: boolean,
): Page<InstallConfig> {
  if (includeInternal) return page;
  return {
    items: page.items.filter(isSelectableInstallConfig),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

async function collectVisibleInstallConfigCandidates(
  load: (params: PageParams) => Promise<Page<InstallConfig>>,
  initialCursor: string | undefined,
  target: number,
  visible: (config: InstallConfig) => boolean,
): Promise<readonly InstallConfig[]> {
  const rows: InstallConfig[] = [];
  let cursor = initialCursor;
  do {
    const page = await load({
      limit: Math.min(DEFAULT_PAGE_LIMIT, Math.max(1, target - rows.length)),
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.items.filter(visible));
    cursor = page.nextCursor;
  } while (rows.length < target && cursor !== undefined);
  return rows;
}

function compareInstallConfigs(a: InstallConfig, b: InstallConfig): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function isStoreInstallConfig(config: InstallConfig): boolean {
  return config.workspaceId === undefined && config.store?.source !== undefined;
}

function patchPolicy(
  policy: InstallConfig["policy"],
  patch: InstallConfigPatchV1,
): InstallConfig["policy"] {
  if (!hasOwn(patch, "lifecycleActionPolicy")) return policy;
  if (patch.lifecycleActionPolicy !== null) {
    return { ...policy, lifecycleActions: patch.lifecycleActionPolicy };
  }
  const { lifecycleActions: _lifecycleActions, ...remaining } = policy;
  return remaining;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function validateSourceBuild(
  sourceBuild: NonNullable<InstallConfig["sourceBuild"]>,
): void {
  if (sourceBuild.commands.length === 0 || sourceBuild.commands.length > 8) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "sourceBuild.commands must contain 1-8 commands",
    );
  }
  if (sourceBuild.outputs.length === 0 || sourceBuild.outputs.length > 16) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "sourceBuild.outputs must contain 1-16 paths",
    );
  }
  for (const [index, command] of sourceBuild.commands.entries()) {
    if (command.argv.length === 0 || command.argv.length > 32) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `sourceBuild.commands[${index}].argv must contain 1-32 arguments`,
      );
    }
    for (const argument of command.argv) {
      if (
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 4096 ||
        argument.includes("\0")
      ) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `sourceBuild.commands[${index}].argv contains an invalid argument`,
        );
      }
    }
    if (command.workingDirectory) {
      assertSafeInstallConfigPath(
        command.workingDirectory,
        `sourceBuild.commands[${index}].workingDirectory`,
      );
    }
  }
  for (const [index, output] of sourceBuild.outputs.entries()) {
    assertSafeInstallConfigPath(output, `sourceBuild.outputs[${index}]`);
    if (/^\.[\\/]*$/u.test(output)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `sourceBuild.outputs[${index}] must name a produced path`,
      );
    }
  }
}

const LIFECYCLE_ACTION_ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/u;
const LIFECYCLE_ACTION_RESERVED_ENV_RE = /^(?:TAKOSUMI_|OPENTOFU_|TF_)/u;
const LIFECYCLE_ACTION_RESERVED_ENV_NAMES = new Set(["PATH", "HOME", "PWD"]);

function validateLifecycleActions(config: InstallConfig): void {
  const actions = config.lifecycleActions ?? [];
  if (actions.length === 0) return;
  if (actions.length > 20) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "lifecycleActions must contain at most 20 actions",
    );
  }
  const policy = config.policy.lifecycleActions;
  if (!policy) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "lifecycleActions require policy.lifecycleActions",
    );
  }
  const ids = new Set<string>();
  for (const [index, action] of actions.entries()) {
    validateLifecycleAction(action, index);
    if (ids.has(action.id)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `lifecycleActions[${index}].id must be unique`,
      );
    }
    ids.add(action.id);
    if (!policy.allowedExecutors.includes(action.executor)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `lifecycleActions[${index}].executor is not allowed by policy.lifecycleActions`,
      );
    }
    if (!policy.allowedRunnerCapabilities.includes(action.runnerCapability)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `lifecycleActions[${index}].runnerCapability is not allowed by policy.lifecycleActions`,
      );
    }
    if (action.useProviderCredentials === true) {
      if (action.executor !== "runner") {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `lifecycleActions[${index}].useProviderCredentials is supported only by runner actions`,
        );
      }
      if (policy.allowProviderCredentials !== true) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `lifecycleActions[${index}].useProviderCredentials is not allowed by policy.lifecycleActions`,
        );
      }
    }
  }
}

function validateLifecycleAction(
  action: InstallConfigLifecycleAction,
  index: number,
): void {
  const field = `lifecycleActions[${index}]`;
  if (action.apiVersion !== "takosumi.dev/v1alpha1") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field}.apiVersion is unsupported`,
    );
  }
  if (action.kind !== "command") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field}.kind is unsupported`,
    );
  }
  if (!action.id || action.id.length > 128 || /[\0\r\n]/u.test(action.id)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field}.id is invalid`,
    );
  }
  if (action.phase !== "post_apply" && action.phase !== "pre_destroy") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field}.phase is unsupported`,
    );
  }
  if (action.executor !== "runner" && action.executor !== "operator") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field}.executor is unsupported`,
    );
  }
  if (action.command.length === 0 || action.command.length > 40) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field}.command must contain 1-40 arguments`,
    );
  }
  for (const argument of action.command) {
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      argument.length > 4096 ||
      /[\0\r\n]/u.test(argument)
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `${field}.command contains an invalid argument`,
      );
    }
  }
  if (action.workingDirectory) {
    assertSafeInstallConfigPath(
      action.workingDirectory,
      `${field}.workingDirectory`,
    );
  }
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/u.test(action.runnerCapability)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field}.runnerCapability is invalid`,
    );
  }
  if (
    action.timeoutSeconds !== undefined &&
    (!Number.isInteger(action.timeoutSeconds) ||
      action.timeoutSeconds < 1 ||
      action.timeoutSeconds > 6 * 60 * 60)
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field}.timeoutSeconds must be an integer between 1 and 21600`,
    );
  }
  const envEntries = Object.entries(action.env ?? {});
  if (envEntries.length > 64) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field}.env must contain at most 64 entries`,
    );
  }
  for (const [name, value] of envEntries) {
    if (
      !LIFECYCLE_ACTION_ENV_NAME_RE.test(name) ||
      LIFECYCLE_ACTION_RESERVED_ENV_RE.test(name) ||
      LIFECYCLE_ACTION_RESERVED_ENV_NAMES.has(name) ||
      isSecretKey(name) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 4096 ||
      /[\0\r\n]/u.test(value) ||
      containsSecretLikeString(value)
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `${field}.env contains an invalid or secret-like entry`,
      );
    }
  }
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
