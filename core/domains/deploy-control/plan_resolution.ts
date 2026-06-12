/**
 * Pre-dispatch plan resolution: the "what to run" computation that turns a plan
 * request + DeploymentProfile bindings + Installation into the resolved
 * providers / generated root / managed-hosting redirect BEFORE a run is
 * dispatched (spec §7 / §13).
 *
 * A cohesive collaborator pulled out of `OpenTofuDeploymentController`: it owns
 * the install-type plan derivation
 * ({@link PlanResolutionService.resolveInstallTypePlan} — generated-root install
 * type + provider aliases + flattened manual values + build override + the
 * operator-default managed signal), the managed cf-proxy base_url redirect +
 * signature injection ({@link PlanResolutionService.applyManagedProxyBaseUrl}),
 * and the template-backed plan resolution
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
 *   - `now` — mirrors the controller's clock so the cf-proxy signature expiry
 *     lines up;
 *   - `cfProxySigningSecret` — the PRIMARY control-plane secret the proxy
 *     verifies (a dedicated `TAKOSUMI_CF_PROXY_SIGNING_SECRET`, decoupled from
 *     the deploy-control bearer); a managed Cloudflare run fails closed when it
 *     is absent;
 *   - `resolveProviderBindingsForRun` — delegates to the controller's lazily
 *     constructed {@link ConnectionsService} so the SAME instance resolves the
 *     run-scoped bindings (operator-default fall-through) for rootgen here and for
 *     credential mint at run time.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  CloudflareApiProxyConfig,
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
  type RootProviderBinding,
  generateInstallationRoot,
  type GeneratedRootInstallType,
  generateRootModule,
} from "takosumi-rootgen";
import type { ResolvedProviderBinding } from "../connections/mod.ts";
import { canonicalProviderAddress } from "./provider_policy.ts";
import { isValidTenantScriptName } from "../../../providers/cloudflare/hosting/wfp_script_name.ts";
import { signCfProxyScope } from "../../../providers/cloudflare/hosting/cf_proxy_signature.ts";
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
  /** Provider mapping derived from the resolved provider bindings. */
  readonly providerBindings: readonly RootProviderBinding[];
  /**
   * Manual-mode provider values flattened into module input overrides (§13
   * decision: manual values override the InstallConfig variableMapping).
   */
  readonly manualValues: Readonly<Record<string, JsonValue>>;
  /** InstallConfig.build, when enabled (overrides the template build). */
  readonly build?: DispatchBuildSpec;
  /**
   * True when this run resolved a required provider to the operator-default
   * connection (spec §7.1 fall-through) — i.e. the managed (takosumi-hosted)
   * case. The control plane uses this to host a Cloudflare Worker capsule in the
   * operator's Workers-for-Platforms dispatch namespace instead of as a
   * standalone account-level Worker. Mirrors
   * `billing_service.#runUsesOperatorDefaultCredential`.
   */
  readonly usesOperatorDefaultCredential: boolean;
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
 * Ports the controller injects into {@link PlanResolutionService}. `now` /
 * `templateRegistry` mirror the controller's own handles; `cfProxySigningSecret`
 * threads the control-plane secret; `resolveProviderBindingsForRun` delegates to
 * the controller's lazily constructed {@link ConnectionsService} so the SAME
 * instance resolves the run-scoped bindings (operator-default fall-through) here
 * and on the mint path.
 */
export interface PlanResolutionServiceDependencies {
  readonly templateRegistry: TemplateRegistry;
  readonly now: () => number;
  readonly cfProxySigningSecret?: string;
  /**
   * Run-scoped provider binding resolution (explicit bindings + the
   * operator-default fall-through for the run's required providers, spec §7.1).
   * Delegates to the controller's shared {@link ConnectionsService}.
   */
  readonly resolveProviderBindingsForRun: (
    installation: Installation,
    requiredProviders: readonly string[],
  ) => Promise<readonly ResolvedProviderBinding[]>;
}

/**
 * Collaborator owning the pre-dispatch plan resolution: install-type plan
 * derivation, the managed cf-proxy base_url redirect, and template-backed plan
 * resolution. Behavior is identical to the prior inline controller methods.
 */
export class PlanResolutionService {
  readonly #templateRegistry: TemplateRegistry;
  readonly #now: () => number;
  readonly #cfProxySigningSecret?: string;
  readonly #resolveProviderBindingsForRun: (
    installation: Installation,
    requiredProviders: readonly string[],
  ) => Promise<readonly ResolvedProviderBinding[]>;

  constructor(dependencies: PlanResolutionServiceDependencies) {
    this.#templateRegistry = dependencies.templateRegistry;
    this.#now = dependencies.now;
    this.#cfProxySigningSecret = dependencies.cfProxySigningSecret;
    this.#resolveProviderBindingsForRun =
      dependencies.resolveProviderBindingsForRun;
  }

  /**
   * Derives the §13 install-type plan context for a template-bound installation
   * config: the generated-root install type, the provider aliases
   * (from the installation's resolved provider bindings), the flattened manual-mode
   * values, and the build override. Provider bindings resolve through the
   * {@link ConnectionsService} so binding changes take effect on the next plan.
   * `disabled` provider bindings (and `manual`, which contributes values not a
   * provider credential) are skipped for provider-alias derivation.
   */
  async resolveInstallTypePlan(
    installation: Installation,
    installConfig: InstallConfig,
    installType: InstallType,
    requiredProviders: readonly string[],
  ): Promise<InstallTypePlanContext> {
    // Run-scoped resolution so the generated-root provider blocks include the
    // operator-default fall-through (spec §7.1) for unbound required providers.
    // `requiredProviders` MUST equal the value stored on the plan run so the
    // mint path (#resolveRunProviderBindings) resolves the identical set.
    const resolved = await this.#resolveProviderBindingsForRun(
      installation,
      requiredProviders,
    );
    const providerBindings = providerBindingsFromResolved(resolved);
    const manualValues = manualValuesFromResolved(resolved);
    // Managed signal: a required provider fell through to the operator-default
    // connection (§7.1). Same predicate as the billing path so a managed run is
    // detected identically for hosting and for spend accounting.
    const usesOperatorDefaultCredential = resolved.some(
      (entry) =>
        entry.mode === "default" && entry.connection?.scope === "operator",
    );
    return {
      // opentofu_root never reaches here (asserted in #installationPlanRequest);
      // core / opentofu_module / app_source map 1:1 to the generated-root types.
      installType: installType as GeneratedRootInstallType,
      providerBindings,
      manualValues,
      usesOperatorDefaultCredential,
      ...(installConfig.build?.enabled
        ? { build: installConfigBuildSpec(installConfig.build) }
        : {}),
    };
  }

  /**
   * Managed (takosumi-hosted) Worker hosting. When this run resolved the
   * cloudflare provider to the operator-default credential (managed) AND the
   * runner profile carries a cf-proxy config, redirect the cloudflare provider's
   * `base_url` to the Takosumi cf-proxy so a PLAIN `cloudflare_workers_script`
   * lands in the WfP dispatch namespace (the provider cannot place a script in a
   * namespace itself). The base_url path carries the namespace + the install
   * slug as the script-name prefix; the proxy rewrites + enforces both. The
   * capsule cannot override the redirect — the generated root passes providers
   * in, so a capsule's own provider block fails tofu plan (fail-closed).
   *
   * Self-host (an owned connection) and non-cloudflare/non-Worker runs are
   * returned unchanged, so their generated root is byte-identical.
   */
  async applyManagedProxyBaseUrl(
    installTypePlan: InstallTypePlanContext | undefined,
    profile: RunnerProfile,
    installation: Installation,
  ): Promise<InstallTypePlanContext | undefined> {
    if (!installTypePlan?.usesOperatorDefaultCredential) return installTypePlan;
    const wfp = profile.cloudflareWorkersForPlatforms;
    if (!wfp?.apiProxy) return installTypePlan;
    const slug = installation.name;
    if (!isValidTenantScriptName(slug)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `managed install slug ${JSON.stringify(slug)} is not a valid ` +
          `Workers-for-Platforms script-name prefix (1-63 char DNS label)`,
      );
    }
    // Fail closed: a managed run requires the cf-proxy signing secret so the
    // proxy can verify the scope. Without it the run cannot proceed (the proxy
    // would reject every forward anyway). The control plane signs with the
    // PRIMARY signing secret; the proxy accepts the primary or any rotation
    // secret (see {@link verifyCfProxyScope}).
    if (!this.#cfProxySigningSecret) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "managed cf-proxy signing secret is not configured " +
          "(TAKOSUMI_CF_PROXY_SIGNING_SECRET); managed Cloudflare runs are disabled",
      );
    }
    const signature = await signCfProxyScope(this.#cfProxySigningSecret, {
      namespace: wfp.dispatchNamespace,
      slug,
      expMs: this.#now() + CF_PROXY_SIGNATURE_TTL_MS,
    });
    const baseUrl = managedCloudflareProxyBaseUrl(
      wfp.apiProxy,
      wfp.dispatchNamespace,
      slug,
      signature,
    );
    const providerBindings = installTypePlan.providerBindings.map((binding) =>
      isCloudflareProvider(binding.provider)
        ? { ...binding, baseUrl }
        : binding,
    );
    return { ...installTypePlan, providerBindings };
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
   * the manual-mode provider values are merged into the template inputs with
   * manual values overriding the InstallConfig variableMapping (§13 decision:
   * manual values are per-installation overrides). When absent (the raw
   * `/v1/plan-runs` template path, no installation context = no provider bindings) the
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
    // Manual-mode provider values are per-installation overrides: they win on a
    // key collision with the InstallConfig variableMapping (which flows in via
    // request.inputs). Unknown keys fail closed instead of being silently
    // dropped, so manual inputs remain auditable and match the template contract.
    const mergedInputs = installTypePlan
      ? mergeManualInputs(
          template,
          request.inputs,
          installTypePlan.manualValues,
        )
      : request.inputs;
    const inputs = validateTemplateInputs(template, mergedInputs);
    // Installation-driven (§13): installType-aware generated root with
    // provider aliases + the app_source artifact_path wiring.
    // Raw template path (no installation context): the byte-stable wrapper.
    const baseGeneratedRoot = installTypePlan
      ? generateInstallationRoot({
          template,
          inputs,
          installType: installTypePlan.installType,
          ...(installTypePlan.providerBindings.length > 0
            ? { providerBindings: installTypePlan.providerBindings }
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

function providerBindingsFromResolved(
  resolved: readonly ResolvedProviderBinding[],
): readonly RootProviderBinding[] {
  const providers: RootProviderBinding[] = [];
  for (const entry of resolved) {
    const provider = entry.connection?.provider;
    if (!provider) continue;
    providers.push({
      provider,
      ...(entry.alias ? { alias: entry.alias } : {}),
    });
  }
  return providers;
}

/**
 * Flattens an installation's manual-mode provider binding values into module input
 * overrides (§13 decision). Manual values are per-installation overrides; only
 * JSON-scalar values flow through (the template input validator rejects unknown
 * keys downstream, and rootgen renders scalars only). Later bindings win on a
 * key collision in profile order.
 */
function manualValuesFromResolved(
  resolved: readonly ResolvedProviderBinding[],
): Readonly<Record<string, JsonValue>> {
  const merged: Record<string, JsonValue> = {};
  for (const entry of resolved) {
    if (entry.mode !== "manual" || !entry.values) continue;
    for (const [key, value] of Object.entries(entry.values)) {
      if (isJsonScalar(value)) merged[key] = value;
    }
  }
  return merged;
}

/**
 * Merges the manual-mode provider values OVER the InstallConfig variableMapping
 * (§13 decision: manual values are per-installation overrides and win on a key
 * collision). Returns `undefined` when neither side contributes a key so the
 * caller passes `undefined` (byte-identical to no inputs).
 */
function mergeManualInputs(
  template: TemplateDefinition,
  configInputs: Readonly<Record<string, JsonValue>> | undefined,
  manualValues: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> | undefined {
  const manualForTemplate: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(manualValues)) {
    if (!(key in template.inputs)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `manual provider value '${key}' is not declared by template ${template.id}`,
      );
    }
    manualForTemplate[key] = value;
  }
  if (
    (!configInputs || Object.keys(configInputs).length === 0) &&
    Object.keys(manualForTemplate).length === 0
  ) {
    return configInputs;
  }
  return { ...(configInputs ?? {}), ...manualForTemplate };
}

// Managed cf-proxy: the cloudflare provider local name (a binding's `provider`
// may be short `cloudflare`, `cloudflare/cloudflare`, or fully-qualified).
function isCloudflareProvider(provider: string): boolean {
  return provider.split("/").pop() === "cloudflare";
}

// cf-proxy signature lifetime. Covers the longest realistic plan+apply run (the
// signature is minted fresh per run, so this only needs to outlast one run's
// provider calls, not be long-lived).
const CF_PROXY_SIGNATURE_TTL_MS = 12 * 60 * 60 * 1000;

// Builds the cf-proxy provider base_url for a managed run. The path carries a
// control-plane signature segment + the dispatch namespace + the install slug
// (the script-name prefix) so the proxy verifies the scope, then rewrites
// `…/workers/scripts/{n}` -> `…/dispatch/namespaces/{ns}/scripts/{slug}-{n}` and
// passes other calls through. The signature stops the edge route being an
// unauthenticated open relay; the capsule cannot override the base_url (root-only
// provider config), and cannot forge the signature (control-plane secret only).
function managedCloudflareProxyBaseUrl(
  proxy: CloudflareApiProxyConfig,
  namespace: string,
  slug: string,
  signature: string,
): string {
  const origin = proxy.origin.replace(/\/+$/, "");
  const route = (proxy.route.startsWith("/") ? proxy.route : `/${proxy.route}`)
    .replace(/\/+$/, "");
  return (
    `${origin}${route}/${signature}/${encodeURIComponent(namespace)}/` +
    `${encodeURIComponent(slug)}/client/v4`
  );
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
