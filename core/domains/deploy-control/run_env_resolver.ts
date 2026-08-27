/**
 * Run environment resolver v0.
 *
 * This is the first implementation boundary for the vNext RunEnvResolver model:
 * keep dispatch-time secret material (`credentials`) separate from non-secret
 * resolution evidence that can be persisted on Run records. It intentionally
 * delegates credential minting to the existing RunCredentialBroker until the
 * runner accepts a full structured RunEnvironment payload.
 */

import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { CapsuleProviderRequirement } from "takosumi-contract/capsules";
import { normalizeProviderSourceAddress } from "takosumi-contract/provider-env-rules";
import type {
  ProviderRequirement,
  ProviderRequirementPhase,
  ProviderResolution,
} from "takosumi-contract/provider-resolution";
import {
  emptyProviderConfigurationsEnvelope,
  providerConfigurationsEnvelope,
  type ProviderConfigurationsEnvelope,
} from "takosumi-contract";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import {
  resolvedProviderBindingsDigest,
  type ResolvedCapsuleProviderBinding,
  validateRequiredProviderBindingIdentities,
} from "../connections/mod.ts";
import type { RunCredentials } from "./mod.ts";
import type { RunCredentialBroker } from "./run_credential_broker.ts";
import {
  OpenTofuControllerError,
  PROVIDER_CONNECTION_CHANGED_REASON,
  PROVIDER_CONNECTION_SETUP_REQUIRED_REASON,
} from "./errors.ts";

export const RUN_ENV_REDACTION_PROFILE_ID = "redact_provider_material" as const;

type RunCredentialMintPort = Pick<
  RunCredentialBroker,
  "mintRunCredentials" | "mintReleaseCommandCredentials"
>;

export interface RunEnvResolverDependencies {
  readonly credentials: RunCredentialMintPort;
  readonly resolveRunProviderBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedCapsuleProviderBinding[] | undefined>;
}

export interface ResolveRunEnvironmentInput {
  readonly planRun: PlanRun;
  readonly phase: "plan" | "apply" | "destroy";
  readonly auditRunId: string;
  /** Exact canonical PlanRun/ApplyRun used for credential authority. */
  readonly credentialRunId?: string;
  readonly credentialContext?: "opentofu" | "release_command";
  /**
   * A lifecycle command without `useProviderCredentials` still needs the
   * reviewed ProviderBinding projection, including explicit empty provider
   * configuration. Set false to resolve and fence that projection without
   * minting credential material.
   */
  readonly mintCredentials?: boolean;
}

export interface ResolvedRunEnvironment {
  readonly credentials?: RunCredentials;
  readonly providerResolutions: readonly ProviderResolution[];
  readonly providerConfigurations: ProviderConfigurationsEnvelope;
  readonly runEnvironmentEvidenceDigest: string;
  readonly redactionProfileId: typeof RUN_ENV_REDACTION_PROFILE_ID;
}

export class RunEnvironmentResolutionError extends OpenTofuControllerError {
  readonly runEnvironment: ResolvedRunEnvironment;

  constructor(message: string, runEnvironment: ResolvedRunEnvironment) {
    super("failed_precondition", message, {
      reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON,
    });
    this.name = "RunEnvironmentResolutionError";
    this.runEnvironment = runEnvironment;
  }
}

export class RunEnvResolver {
  readonly #credentials: RunCredentialMintPort;
  readonly #resolveRunProviderBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedCapsuleProviderBinding[] | undefined>;

  constructor(dependencies: RunEnvResolverDependencies) {
    this.#credentials = dependencies.credentials;
    this.#resolveRunProviderBindings = dependencies.resolveRunProviderBindings;
  }

  async resolveRunEnvironment(
    input: ResolveRunEnvironmentInput,
  ): Promise<ResolvedRunEnvironment> {
    const resolution = await this.#providerResolutionContext(input);
    await assertPlanFencedResolvedBindings(input, resolution.resolvedBindings);
    const providerResolutions = resolution.providerResolutions;
    const providerConfigurations = providerConfigurationsFromResolved(
      resolution.resolvedBindings,
    );
    const blocked = providerResolutions.find(
      (resolution) => resolution.evidence.kind === "blocked",
    );
    if (blocked) {
      const runEnvironment = await this.#buildRunEnvironmentEvidence(
        input,
        providerResolutions,
        providerConfigurations,
        undefined,
      );
      throw new RunEnvironmentResolutionError(
        blocked.blockedReason ??
          `provider_resolution_blocked: ${blocked.requirement.providerSource}`,
        runEnvironment,
      );
    }
    const credentials =
      input.mintCredentials === false
        ? undefined
        : input.credentialContext === "release_command"
          ? await this.#credentials.mintReleaseCommandCredentials(
              input.planRun,
              releaseCommandCredentialPhase(input.phase),
              input.auditRunId,
              input.credentialRunId ?? input.auditRunId,
            )
          : await this.#credentials.mintRunCredentials(
              input.planRun,
              input.phase,
              input.auditRunId,
            );
    return await this.#buildRunEnvironmentEvidence(
      input,
      providerResolutions,
      providerConfigurations,
      credentials,
    );
  }

  async #buildRunEnvironmentEvidence(
    input: ResolveRunEnvironmentInput,
    providerResolutions: readonly ProviderResolution[],
    providerConfigurations: ProviderConfigurationsEnvelope,
    credentials: RunCredentials | undefined,
  ): Promise<ResolvedRunEnvironment> {
    const credentialEnvNames =
      credentialEnvNamesFromRunCredentials(credentials);
    const runEnvironmentEvidenceDigest = await stableJsonDigest({
      runId: input.auditRunId,
      credentialRunId: input.credentialRunId ?? input.auditRunId,
      phase: input.phase,
      credentialContext: input.credentialContext ?? "opentofu",
      providerResolutions,
      providerConfigurations,
      credentialEnvNames,
      credentialManifest: credentials?.manifest ?? null,
      credentialMaterialRequested: input.mintCredentials !== false,
      redactionProfileId: RUN_ENV_REDACTION_PROFILE_ID,
    });
    return {
      ...(credentials ? { credentials } : {}),
      providerResolutions,
      providerConfigurations,
      runEnvironmentEvidenceDigest,
      redactionProfileId: RUN_ENV_REDACTION_PROFILE_ID,
    };
  }

  async #providerResolutionContext(
    input: ResolveRunEnvironmentInput,
  ): Promise<ProviderResolutionContext> {
    const planRun = input.planRun;
    const requiredProviderRequirements =
      requiredProviderRequirementsForPlanRun(planRun);
    // A subject-bound Plan pins only bindings selected by its exact provider
    // requirements. An explicit empty requirement set therefore stays empty;
    // unrelated bindings added later are neither dispatched nor evidence.
    const resolveBindings =
      requiredProviderRequirements.length > 0 ||
      input.credentialContext === "release_command" ||
      (input.phase !== "plan" &&
        planRun.resolvedProviderBindingsDigest !== undefined);
    if (!resolveBindings) {
      return {
        providerResolutions: [],
        resolvedBindings: undefined,
      };
    }
    if (!planRun.capsuleContext) {
      return {
        providerResolutions: requiredProviderRequirements.map((provider) => {
          const requirement = providerRequirement(planRun, provider);
          const identity = formatProviderRequirementIdentity(provider);
          return {
            requirement,
            status: "blocked_missing_connection",
            blockedReason: `capsule provider connection evidence is required for provider ${identity}`,
            evidence: {
              kind: "blocked",
              provider: provider.source,
              reason: `capsule provider connection evidence is required for provider ${identity}`,
            },
          };
        }),
        resolvedBindings: undefined,
      };
    }
    const resolved = await this.#resolveRunProviderBindings(planRun);
    if (!resolved) {
      return {
        providerResolutions: requiredProviderRequirements.map((provider) => {
          const requirement = providerRequirement(planRun, provider);
          const identity = formatProviderRequirementIdentity(provider);
          return {
            requirement,
            status: "blocked_missing_connection",
            blockedReason: `capsule provider connection resolution is required for provider ${identity}`,
            evidence: {
              kind: "blocked",
              provider: provider.source,
              reason: `capsule provider connection resolution is required for provider ${identity}`,
            },
          };
        }),
        resolvedBindings: undefined,
      };
    }

    const resolutions: ProviderResolution[] = [];
    const selectedBindings: ResolvedCapsuleProviderBinding[] = [];
    const allowLegacySourceOnlyBinding =
      planRun.requiredProviderRequirements === undefined ||
      planRun.source.kind === "operator_module";
    for (const provider of requiredProviderRequirements) {
      const match = resolvedBindingForProvider(
        resolved,
        provider,
        allowLegacySourceOnlyBinding,
      );
      const requirement = providerRequirement(planRun, provider);
      if (!match) {
        // `resolveRunProviderBindings` has already enforced the
        // subset of providers whose RunnerProfile requires Takosumi-managed
        // credential material. Providers still present on PlanRun.requiredProviders
        // may be optional/no-op for this variable set, or intentionally handled
        // by a generic runner profile without Takosumi env injection.
        continue;
      }
      selectedBindings.push(match);
      resolutions.push(
        providerResolutionFromResolved(input, requirement, match),
      );
    }
    return {
      providerResolutions: resolutions,
      resolvedBindings: selectedBindings,
    };
  }
}

async function assertPlanFencedResolvedBindings(
  input: ResolveRunEnvironmentInput,
  resolved: readonly ResolvedCapsuleProviderBinding[] | undefined,
): Promise<void> {
  const expected = input.planRun.resolvedProviderBindingsDigest;
  if (input.phase === "plan" || expected === undefined) return;
  if (!resolved) {
    throwResolvedBindingsChanged(input);
  }
  const actual = await resolvedProviderBindingsDigest(resolved);
  if (actual === expected) return;
  throwResolvedBindingsChanged(input);
}

function throwResolvedBindingsChanged(
  input: ResolveRunEnvironmentInput,
): never {
  throw new OpenTofuControllerError(
    "failed_precondition",
    `resolved_bindings_changed: plan run ${input.planRun.id} was reviewed against different provider connections than are now resolved; re-plan before ${input.phase}`,
    { reason: PROVIDER_CONNECTION_CHANGED_REASON },
  );
}

function resolvedBindingForProvider(
  resolved: readonly ResolvedCapsuleProviderBinding[],
  provider: CapsuleProviderRequirement,
  allowLegacySourceOnlyBinding: boolean,
): ResolvedCapsuleProviderBinding | undefined {
  const matches = resolved.filter(
    (entry) =>
      entry.alias === undefined &&
      normalizeProviderSourceAddress(entry.provider) === provider.source &&
      (entry.moduleLocalName === provider.moduleLocalName ||
        (allowLegacySourceOnlyBinding &&
          entry.moduleLocalName === undefined &&
          providerName(entry.provider) === provider.moduleLocalName)) &&
      entry.childAlias === provider.childAlias,
  );
  if (matches.length > 1) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `duplicate provider binding identity: ${formatProviderRequirementIdentity(provider)}`,
      { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
    );
  }
  return matches[0];
}

interface ProviderResolutionContext {
  readonly providerResolutions: readonly ProviderResolution[];
  readonly resolvedBindings:
    readonly ResolvedCapsuleProviderBinding[] | undefined;
}

function providerConfigurationsFromResolved(
  resolved: readonly ResolvedCapsuleProviderBinding[] | undefined,
): ProviderConfigurationsEnvelope {
  if (!resolved || resolved.length === 0) {
    return emptyProviderConfigurationsEnvelope();
  }
  const ambiguous = resolved.find((entry) => entry.alias !== undefined);
  if (ambiguous) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `deprecated ambiguous ProviderBinding alias cannot produce provider configuration: ${ambiguous.alias}`,
      { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
    );
  }
  return providerConfigurationsEnvelope(
    resolved.map((entry) => ({
      provider: entry.provider,
      alias: entry.rootAlias ?? null,
      configuration: entry.connection.scopeHints?.providerConfig ?? {},
    })),
  );
}

function releaseCommandCredentialPhase(
  phase: ResolveRunEnvironmentInput["phase"],
): "apply" | "destroy" {
  if (phase === "apply" || phase === "destroy") return phase;
  throw new Error(
    "release command credentials are only valid for apply/destroy",
  );
}

function credentialEnvNamesFromRunCredentials(
  credentials: RunCredentials | undefined,
): readonly string[] {
  if (!credentials) return [];
  return [
    ...Object.keys(credentials.env),
    ...(credentials.files ?? []).flatMap((file) =>
      file.envName ? [file.envName] : [],
    ),
  ].sort();
}

function providerRequirement(
  planRun: PlanRun,
  provider: CapsuleProviderRequirement,
): ProviderRequirement {
  return {
    providerSource: provider.source,
    providerName: provider.moduleLocalName,
    ...(provider.childAlias ? { alias: provider.childAlias } : {}),
    ...(provider.version
      ? { versionConstraint: provider.version }
      : {}),
    modulePath:
      planRun.source.kind === "operator_module"
        ? "."
        : (planRun.source.modulePath ?? "."),
    discoveredFrom: "required_providers",
    requiredForPhases: requiredPhases(planRun.operation),
  };
}

function requiredProviderRequirementsForPlanRun(
  planRun: PlanRun,
): readonly CapsuleProviderRequirement[] {
  if (planRun.requiredProviderRequirements === undefined) {
    return planRun.requiredProviders.map((source) => ({
      source: normalizeProviderSourceAddress(source),
      moduleLocalName: providerName(source),
      allowed: true,
    }));
  }
  const requiredProviderRequirements = validateRequiredProviderBindingIdentities(
    planRun.requiredProviderRequirements,
  );
  const declaredSources = new Set(
    planRun.requiredProviders.map(normalizeProviderSourceAddress),
  );
  const exactSources = new Set(
    requiredProviderRequirements.map((entry) => entry.source),
  );
  if (
    declaredSources.size !== exactSources.size ||
    [...declaredSources].some((source) => !exactSources.has(source))
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "required provider requirements do not match requiredProviders",
      { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
    );
  }
  return requiredProviderRequirements;
}

function formatProviderRequirementIdentity(
  requirement: Pick<
    CapsuleProviderRequirement,
    "source" | "moduleLocalName" | "childAlias"
  >,
): string {
  return `${requirement.source} (${requirement.moduleLocalName}${requirement.childAlias ? `.${requirement.childAlias}` : " default"})`;
}

function providerResolutionFromResolved(
  _input: ResolveRunEnvironmentInput,
  requirement: ProviderRequirement,
  resolved: ResolvedCapsuleProviderBinding,
): ProviderResolution {
  return {
    requirement,
    status: "resolved_provider_connection",
    connectionId: resolved.connection.id,
    materialization: resolved.materialization,
    evidence: {
      kind: "provider_connection",
      provider: requirement.providerSource,
      connectionId: resolved.connection.id,
      materialization: resolved.materialization,
      requiredEnvNames: resolved.connection.envNames,
    },
  };
}

function requiredPhases(
  operation: PlanRun["operation"],
): readonly ProviderRequirementPhase[] {
  return operation === "destroy" ? ["plan", "destroy"] : ["plan", "apply"];
}

function providerName(providerSource: string): string {
  const parts = providerSource.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? providerSource;
}
