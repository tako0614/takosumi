/**
 * Pre-dispatch plan resolution: the "what to run" computation that turns a plan
 * request + InstallationProviderEnvBindingSet + Installation into the resolved
 * providers / generated root BEFORE a run is
 * dispatched (spec §7 / §13).
 *
 * A cohesive collaborator pulled out of `OpenTofuDeploymentController`: it owns
 * the install-type plan derivation
 * ({@link PlanResolutionService.resolveInstallTypePlan} — generated-root install
 * type + provider aliases + Cloud-only materialization guard), and the
 * template-backed plan resolution
 * ({@link PlanResolutionService.resolveTemplatePlan} — resolved template,
 * derived required providers, generated root module).
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
  DispatchGeneratedRoot,
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
import { normalizeProviders } from "./validation.ts";
import { sameProviderFamily } from "takosumi-contract/provider-env-rules";

/**
 * Install-type wiring for an installation-driven template plan (§13). Carried
 * through the controller's internal plan-creation context so `createPlanRun` can
 * drive `generateInstallationRoot` (installType-aware generated root + provider
 * aliases) instead of the raw {@link generateRootModule}.
 * Public `/api` calls always target an Installation; the low-level compatibility
 * path backfills this context from the Installation row when callers omit it.
 */
export interface InstallTypePlanContext {
  /** §13 generated-root install type (core / opentofu_module / app_source). */
  readonly installType: GeneratedRootInstallType;
  /** Provider mapping derived from the resolved provider env bindings. */
  readonly providerEnvBindings: readonly RootInstallationProviderEnvBinding[];
  /** Fully-qualified provider addresses derived from explicit Provider Bindings. */
  readonly requiredProvidersFromBindings: readonly string[];
  /**
   * Non-secret provider scope metadata available to fill requested Capsule
   * inputs. The controller only applies these defaults under keys already
   * declared by InstallConfig.variableMapping; Provider Connections must not
   * invent module input schema for arbitrary OpenTofu Capsules.
   */
  readonly providerInputDefaults: Readonly<Record<string, JsonValue>>;
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
   * Run-scoped provider env binding resolution. The controller passes the subset
   * of required providers that need Takosumi-managed credential material; other
   * providers may run without env/file injection or with explicit generic-env
   * bindings.
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
   * config: the generated-root install type and the provider aliases from the
   * Capsule's resolved ProviderBindings.
   * Provider Env bindings resolve through the {@link ConnectionsService} so
   * connection changes take effect on the next plan.
   */
  async resolveInstallTypePlan(
    installation: Installation,
    installConfig: InstallConfig,
    installType: InstallType,
    credentialRequiredProviders: readonly string[],
  ): Promise<InstallTypePlanContext> {
    // Run-scoped resolution so generated-root provider blocks come from the
    // reviewed ProviderBinding records only. The caller filters the
    // full required provider set down to providers that require credential
    // material; no-credential providers remain on PlanRun.requiredProviders but
    // do not force a ProviderConnection.
    const resolved = await this.#resolveInstallationProviderEnvBindingsForRun(
      installation,
      credentialRequiredProviders,
    );
    const providerEnvBindings = providerEnvBindingsFromResolved(resolved);
    const providerInputDefaults = providerInputDefaultsFromResolved(resolved);
    const usesCloudOnlyGatewayMaterialization = resolved.some(
      (entry) => (entry.materialization as string) === "gateway",
    );
    return {
      // opentofu_root never reaches here (asserted in #installationPlanRequest);
      // core / opentofu_module / app_source map 1:1 to the generated-root types.
      installType: installType as GeneratedRootInstallType,
      providerEnvBindings,
      requiredProvidersFromBindings: requiredProvidersFromResolved(resolved),
      providerInputDefaults,
      usesCloudOnlyGatewayMaterialization,
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
   * required providers, and generated root module. Returns
   * `undefined` only when the caller should use the generic Capsule generated
   * root path. Throws on a malformed template request
   * (missing version, conflicting requiredProviders, unknown template, invalid
   * inputs).
   *
   * `installTypePlan` is present only for an installation-driven plan (§13). When
   * present the generated root comes from {@link generateInstallationRoot}
   * (installType-aware, provider aliases);
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
    // provider aliases. Takosumi does not dispatch app build/artifact handling;
    // app release inputs must be ordinary OpenTofu variables.
    // Raw template path (no installation context): the byte-stable wrapper.
    const baseGeneratedRoot = installTypePlan
      ? generateInstallationRoot({
          template,
          inputs,
          installType: installTypePlan.installType,
          ...(installTypePlan.providerEnvBindings.length > 0
            ? { providerEnvBindings: installTypePlan.providerEnvBindings }
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
    };
  }
}

export function providerEnvBindingsFromResolved(
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): readonly RootInstallationProviderEnvBinding[] {
  const providers: RootInstallationProviderEnvBinding[] = [];
  for (const entry of resolved) {
    const provider = entry.provider;
    const credentialDelivery =
      entry.connection?.kind === "generic_env_provider"
        ? "provider_env"
        : "generated_root_variable";
    providers.push({
      provider,
      ...(entry.alias ? { alias: entry.alias } : {}),
      credentialDelivery,
    });
  }
  return providers;
}

function requiredProvidersFromResolved(
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): readonly string[] {
  return normalizeProviders(
    resolved.map((entry) =>
      canonicalProviderAddress(entry.connection.providerSource),
    ),
  );
}

function providerInputDefaultsFromResolved(
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): Readonly<Record<string, JsonValue>> {
  const inputs: Record<string, JsonValue> = {};
  for (const entry of resolved) {
    const connection = entry.connection;
    if (!connection) continue;
    if (sameProviderFamily(entry.provider, "cloudflare")) {
      const accountId = nonEmptyString(connection.scopeHints?.accountId);
      if (accountId) {
        inputs.cloudflare_account_id = accountId;
        inputs.account_id = accountId;
        mergeObjectInput(inputs, "cloudflare", { account_id: accountId });
      }
    }
  }
  return inputs;
}

function mergeObjectInput(
  target: Record<string, JsonValue>,
  key: string,
  patch: Readonly<Record<string, JsonValue>>,
): void {
  const existing = target[key];
  if (isJsonObject(existing)) {
    target[key] = { ...existing, ...patch };
    return;
  }
  target[key] = { ...patch };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is {
  readonly [key: string]: JsonValue;
} {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isJsonScalar(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}
