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
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
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
    // A subject-bound Plan pins the complete resolved binding set even when
    // OpenTofu reported no required providers. Apply/destroy must re-resolve
    // that set so an empty reviewed set stays valid while a binding added
    // after review is still detected by the digest fence.
    const resolveBindings =
      planRun.requiredProviders.length > 0 ||
      input.credentialContext === "release_command" ||
      (input.phase !== "plan" &&
        planRun.resolvedProviderBindingsDigest !== undefined);
    if (!resolveBindings) {
      return {
        providerResolutions: [],
        resolvedBindings: undefined,
      };
    }
    if (!planRun.capsuleContext && !planRun.resourceContext) {
      return {
        providerResolutions: planRun.requiredProviders.map((provider) => {
          const requirement = providerRequirement(planRun, provider);
          return {
            requirement,
            status: "blocked_missing_connection",
            blockedReason: `capsule provider connection evidence is required for provider ${provider}`,
            evidence: {
              kind: "blocked",
              provider,
              reason: `capsule provider connection evidence is required for provider ${provider}`,
            },
          };
        }),
        resolvedBindings: undefined,
      };
    }
    const resolved = await this.#resolveRunProviderBindings(planRun);
    if (!resolved) {
      return {
        providerResolutions: planRun.requiredProviders.map((provider) => {
          const requirement = providerRequirement(planRun, provider);
          return {
            requirement,
            status: "blocked_missing_connection",
            blockedReason: `capsule provider connection resolution is required for provider ${provider}`,
            evidence: {
              kind: "blocked",
              provider,
              reason: `capsule provider connection resolution is required for provider ${provider}`,
            },
          };
        }),
        resolvedBindings: undefined,
      };
    }

    const resolutions: ProviderResolution[] = [];
    for (const provider of planRun.requiredProviders) {
      const match = resolvedBindingForProvider(resolved, provider);
      const requirement = providerRequirement(planRun, provider);
      if (!match) {
        // `resolveRunProviderBindings` has already enforced the
        // subset of providers whose RunnerProfile requires Takosumi-managed
        // credential material. Providers still present on PlanRun.requiredProviders
        // may be optional/no-op for this variable set, or intentionally handled
        // by a generic runner profile without Takosumi env injection.
        continue;
      }
      resolutions.push(
        providerResolutionFromResolved(input, requirement, match),
      );
    }
    return { providerResolutions: resolutions, resolvedBindings: resolved };
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
  provider: string,
): ResolvedCapsuleProviderBinding | undefined {
  return resolved
    .filter((entry) => sameProviderSource(provider, entry.provider))
    .sort((left, right) => {
      if (left.alias === right.alias) {
        return compareText(left.connection.id, right.connection.id);
      }
      if (left.alias === undefined) return -1;
      if (right.alias === undefined) return 1;
      return compareText(left.alias, right.alias);
    })[0];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  return providerConfigurationsEnvelope(
    resolved.map((entry) => ({
      provider: entry.provider,
      alias: entry.alias ?? null,
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
  provider: string,
): ProviderRequirement {
  return {
    providerSource: provider,
    providerName: providerName(provider),
    modulePath:
      planRun.source.kind === "operator_module"
        ? "."
        : (planRun.source.modulePath ?? "."),
    discoveredFrom: "required_providers",
    requiredForPhases: requiredPhases(planRun.operation),
  };
}

function providerResolutionFromResolved(
  _input: ResolveRunEnvironmentInput,
  requirement: ProviderRequirement,
  resolved: ResolvedCapsuleProviderBinding,
): ProviderResolution {
  const provider = resolved.provider;
  return {
    requirement,
    status: "resolved_provider_connection",
    connectionId: resolved.connection.id,
    materialization: resolved.materialization,
    evidence: {
      kind: "provider_connection",
      provider,
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
