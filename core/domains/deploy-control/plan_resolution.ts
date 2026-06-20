/**
 * Pre-dispatch plan resolution: the "what to run" computation that turns a plan
 * request + InstallationProviderEnvBindingSet + Installation into the resolved
 * providers / generated root BEFORE a run is
 * dispatched (spec §7 / §13).
 *
 * A cohesive collaborator pulled out of `OpenTofuDeploymentController`: it owns
 * the install-type plan derivation
 * ({@link PlanResolutionService.resolveInstallTypePlan} — generated-root install
 * type + provider aliases + build override + Cloud-only materialization guard), and the template-backed plan resolution
 * ({@link PlanResolutionService.resolveTemplatePlan} — resolved template, derived
 * required providers, generated root module, build phase).
 *
 * These transform a plan request into the resolved providers / generated root
 * BEFORE the run is dispatched; the run dispatch + the per-phase credential mint
 * + the policy engine stay on the controller (they are coupled to the run-engine
 * mutation path). Behavior is identical to the prior inline controller methods:
 * exact signatures, error codes (`invalid_argument` / `failed_precondition` with
 * the same messages), and ordering are preserved.
 *
 * Dependencies it needs are threaded in as ports:
 *   - `templateRegistry` — the shared {@link TemplateRegistry} (also held by the
 *     controller for the dispatch path);
 *   - `resolveInstallationProviderEnvBindingsForRun` — delegates to the controller's lazily
 *     constructed {@link ConnectionsService} so the SAME instance resolves the
 *     run-scoped Provider Env bindings for rootgen here and for
 *     credential mint at run time.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  CreatePlanRunRequest,
  DispatchBuildSpec,
  DispatchGeneratedRoot,
  InstallBuildConfig,
  InstallConfig,
  Installation,
  InstallType,
  RunnerProfile,
  TemplateDefinition,
} from "@takosumi/internal/deploy-control-api";
import {
  type TemplateInputValue,
  type TemplateRegistry,
  validateTemplateInputs,
} from "../templates/mod.ts";
import {
  type RootInstallationProviderEnvBinding,
  generateInstallationRoot,
  type GeneratedRootInstallType,
  generateRootModule,
} from "takosumi-rootgen";
import type { ResolvedInstallationProviderEnvBinding } from "../connections/mod.ts";
import { canonicalProviderAddress } from "./provider_policy.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";

/**
 * Install-type wiring for an installation-driven template plan (§13). Carried
 * through the controller's internal plan-creation context so `createPlanRun` can
 * drive `generateInstallationRoot` (installType-aware generated root + provider
 * aliases + the `app_source` build) instead of the raw {@link generateRootModule}.
 * Public `/api` calls always target an Installation; the low-level compatibility
 * path backfills this context from the Installation row when callers omit it.
 */
export interface InstallTypePlanContext {
  /** §13 generated-root install type (core / opentofu_module / app_source). */
  readonly installType: GeneratedRootInstallType;
  /** Provider mapping derived from the resolved provider env bindings. */
  readonly providerEnvBindings: readonly RootInstallationProviderEnvBinding[];
  /** Generic-env Connection env names that must be declared as root variables. */
  readonly genericEnvVarNames: readonly string[];
  /** InstallConfig.build, when enabled (overrides the template build). */
  readonly build?: DispatchBuildSpec;
  /**
   * True when a legacy/Cloud-only resolver row attempted to use gateway
   * materialization. OSS Takosumi fails closed instead of rewriting provider
   * endpoints.
   */
  readonly usesCloudOnlyGatewayMaterialization: boolean;
}

/** Internal resolution of a template-backed plan request (never persisted as-is). */
export interface ResolvedTemplatePlan {
  readonly template: TemplateDefinition;
  readonly inputs: Readonly<Record<string, TemplateInputValue>>;
  readonly generatedRoot: DispatchGeneratedRoot;
  readonly requiredProviders: readonly string[];
  readonly build?: DispatchBuildSpec;
}

/**
 * Ports the controller injects into {@link PlanResolutionService}. `templateRegistry`
 * mirrors the controller's own handle; `resolveInstallationProviderEnvBindingsForRun` delegates to
 * the controller's lazily constructed {@link ConnectionsService} so the SAME
 * instance resolves the run-scoped provider env bindings here and on the mint
 * path.
 */
export interface PlanResolutionServiceDependencies {
  readonly templateRegistry: TemplateRegistry;
  readonly now: () => number;
  /**
   * Run-scoped provider env binding resolution. Every required provider must have
   * an explicit Installation provider env binding.
   * Delegates to the controller's shared {@link ConnectionsService}.
   */
  readonly resolveInstallationProviderEnvBindingsForRun: (
    installation: Installation,
    requiredProviders: readonly string[],
  ) => Promise<readonly ResolvedInstallationProviderEnvBinding[]>;
}

/**
 * Collaborator owning the pre-dispatch plan resolution: install-type plan
 * derivation, Cloud-only materialization rejection, and template-backed plan
 * resolution. Behavior is identical to the prior inline controller methods.
 */
export class PlanResolutionService {
  readonly #templateRegistry: TemplateRegistry;
  readonly #resolveInstallationProviderEnvBindingsForRun: (
    installation: Installation,
    requiredProviders: readonly string[],
  ) => Promise<readonly ResolvedInstallationProviderEnvBinding[]>;

  constructor(dependencies: PlanResolutionServiceDependencies) {
    this.#templateRegistry = dependencies.templateRegistry;
    this.#resolveInstallationProviderEnvBindingsForRun =
      dependencies.resolveInstallationProviderEnvBindingsForRun;
  }

  /**
   * Derives the §13 install-type plan context for a template-bound installation
   * config: the generated-root install type, the provider aliases from the
   * installation's resolved provider env bindings, and the build override.
   * Provider Env bindings resolve through the {@link ConnectionsService} so
   * connection changes take effect on the next plan.
   */
  async resolveInstallTypePlan(
    installation: Installation,
    installConfig: InstallConfig,
    installType: InstallType,
    requiredProviders: readonly string[],
  ): Promise<InstallTypePlanContext> {
    // Run-scoped resolution so generated-root provider blocks come from the
    // reviewed Installation provider env bindings only. `requiredProviders` MUST
    // equal the value stored on the plan run so the mint path
    // (#resolveRunInstallationProviderEnvBindings) resolves the identical set.
    const resolved = await this.#resolveInstallationProviderEnvBindingsForRun(
      installation,
      requiredProviders,
    );
    const providerEnvBindings = providerEnvBindingsFromResolved(resolved);
    const genericEnvVarNames = genericEnvVarNamesFromResolved(resolved);
    const usesCloudOnlyGatewayMaterialization = resolved.some(
      (entry) => (entry.materialization as string) === "gateway",
    );
    return {
      // opentofu_root never reaches here (asserted in #installationPlanRequest);
      // core / opentofu_module / app_source map 1:1 to the generated-root types.
      installType: installType as GeneratedRootInstallType,
      providerEnvBindings,
      genericEnvVarNames,
      usesCloudOnlyGatewayMaterialization,
      ...(installConfig.build?.enabled
        ? { build: installConfigBuildSpec(installConfig.build) }
        : {}),
    };
  }

  /** OSS Takosumi does not rewrite provider base_url through a Gateway. */
  async applyGatewayEndpointBaseUrl(
    installTypePlan: InstallTypePlanContext | undefined,
    _profile: RunnerProfile,
    _installation: Installation,
  ): Promise<InstallTypePlanContext | undefined> {
    if (!installTypePlan?.usesCloudOnlyGatewayMaterialization) {
      return installTypePlan;
    }
    throw new OpenTofuControllerError(
      "failed_precondition",
      "gateway_base_url_injection_failed: gateway materialization is Takosumi Cloud-only and is not available in OSS",
    );
  }

  /**
   * Resolves a template-backed plan request into its resolved template, derived
   * required providers, generated root module, and optional build phase. Returns
   * `undefined` only when the caller should use the generic Capsule generated
   * root path. Throws on a malformed template request
   * (missing version, conflicting requiredProviders, unknown template, invalid
   * inputs).
   *
   * `installTypePlan` is present only for an installation-driven plan (§13). When
   * present the generated root comes from {@link generateInstallationRoot}
   * (installType-aware, provider aliases, the `app_source` build);
   * no installation context = no provider env bindings) the
   * generated root stays on {@link generateRootModule} byte-for-byte.
   */
  resolveTemplatePlan(
    request: CreatePlanRunRequest,
    installTypePlan?: InstallTypePlanContext,
  ): ResolvedTemplatePlan | undefined {
    if (request.templateId === undefined) {
      // A bare inputs/templateVersion without templateId is a request error: it
      // would otherwise silently fall back to a generic Capsule plan that ignores
      // template-only fields.
      if (
        request.templateVersion !== undefined ||
        request.inputs !== undefined
      ) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "templateVersion/inputs require templateId",
        );
      }
      return undefined;
    }
    requireNonEmptyString(request.templateId, "templateId");
    requireNonEmptyString(request.templateVersion, "templateVersion");
    if (request.requiredProviders !== undefined) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "requiredProviders is derived from the template; do not pass it with templateId",
      );
    }
    const template = this.#templateRegistry.require(
      request.templateId,
      request.templateVersion!,
    );
    const inputs = validateTemplateInputs(template, request.inputs);
    // Installation-driven (§13): installType-aware generated root with
    // provider aliases + the app_source artifact_path wiring.
    // Raw template path (no installation context): the byte-stable wrapper.
    const baseGeneratedRoot = installTypePlan
      ? generateInstallationRoot({
          template,
          inputs,
          installType: installTypePlan.installType,
          ...(installTypePlan.providerEnvBindings.length > 0
            ? { providerEnvBindings: installTypePlan.providerEnvBindings }
            : {}),
          ...(installTypePlan.genericEnvVarNames.length > 0
            ? { genericEnvVarNames: installTypePlan.genericEnvVarNames }
            : {}),
        })
      : generateRootModule(template, inputs);
    const generatedRoot: DispatchGeneratedRoot = {
      ...baseGeneratedRoot,
      moduleFiles: this.#templateRegistry.requireModuleFiles(
        template.id,
        template.version,
      ),
    };
    // Build phase precedence: an installation-driven app_source InstallConfig.build
    // (when enabled) overrides the template's own build; otherwise the template
    // build is used (§13 / M5 decision: InstallConfig.build takes precedence).
    const build = installTypePlan?.build ?? templateBuildSpec(template);
    return {
      template,
      inputs,
      generatedRoot,
      // Canonicalize the template's provider rules (OpenTofu source form, e.g.
      // `cloudflare/cloudflare`) to fully-qualified registry addresses so they
      // satisfy a runner profile allowlist (whose rules are fully-qualified or
      // short — `providerMatches` admits a fully-qualified provider against
      // either form, but not a short provider against a fully-qualified rule).
      requiredProviders: template.policy.allowedProviders.map(
        canonicalProviderAddress,
      ),
      ...(build ? { build } : {}),
    };
  }
}

function providerEnvBindingsFromResolved(
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): readonly RootInstallationProviderEnvBinding[] {
  const providers: RootInstallationProviderEnvBinding[] = [];
  for (const entry of resolved) {
    const provider = entry.provider;
    providers.push({
      provider,
      ...(entry.alias ? { alias: entry.alias } : {}),
    });
  }
  return providers;
}

function genericEnvVarNamesFromResolved(
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): readonly string[] {
  const names = new Set<string>();
  for (const entry of resolved) {
    const connection = entry.connection;
    if (!connection) continue;
    if (
      connection.kind !== "generic_env_provider" &&
      connection.credentialDriver !== "generic_env"
    ) {
      continue;
    }
    for (const name of connection.envNames) names.add(name);
  }
  return [...names].sort();
}


function isJsonScalar(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

/** Maps a TemplateDefinition's optional build into a DispatchBuildSpec. */
function templateBuildSpec(
  template: TemplateDefinition,
): DispatchBuildSpec | undefined {
  if (!template.build) return undefined;
  return {
    runtime: template.build.runtime,
    commands: [...template.build.commands],
    artifactPath: template.build.artifactPath,
  };
}

/**
 * Maps an enabled InstallConfig.build into the DispatchBuildSpec the runner build
 * phase consumes (M5 decision: same DispatchBuildSpec threading the template
 * build uses; the build runs in the Container with ZERO credentials — invariant
 * 3). `artifactPath` defaults to `dist` when the config omits it.
 */
export function installConfigBuildSpec(
  build: InstallBuildConfig,
): DispatchBuildSpec {
  return {
    runtime: "bun",
    commands: [...build.commands],
    artifactPath: build.artifactPath ?? "dist",
  };
}
