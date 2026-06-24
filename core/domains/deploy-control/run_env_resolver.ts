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
import { sameProviderFamily } from "takosumi-contract/provider-env-rules";
import type {
  ProviderRequirement,
  ProviderRequirementPhase,
  ProviderResolution,
} from "takosumi-contract/provider-resolution";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import type { ResolvedInstallationProviderEnvBinding } from "../connections/mod.ts";
import type { RunCredentials } from "./mod.ts";
import type { RunCredentialBroker } from "./run_credential_broker.ts";

export const RUN_ENV_REDACTION_PROFILE_ID = "redact_provider_material" as const;

type RunCredentialMintPort = Pick<RunCredentialBroker, "mintRunCredentials">;

export interface RunEnvResolverDependencies {
  readonly credentials: RunCredentialMintPort;
  readonly resolveRunInstallationProviderEnvBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedInstallationProviderEnvBinding[] | undefined>;
}

export interface ResolveRunEnvironmentInput {
  readonly planRun: PlanRun;
  readonly phase: "plan" | "apply" | "destroy";
  readonly auditRunId: string;
}

export interface ResolvedRunEnvironment {
  readonly credentials?: RunCredentials;
  readonly providerResolutions: readonly ProviderResolution[];
  readonly runEnvironmentEvidenceDigest: string;
  readonly redactionProfileId: typeof RUN_ENV_REDACTION_PROFILE_ID;
}

export class RunEnvironmentResolutionError extends Error {
  readonly runEnvironment: ResolvedRunEnvironment;

  constructor(message: string, runEnvironment: ResolvedRunEnvironment) {
    super(message);
    this.name = "RunEnvironmentResolutionError";
    this.runEnvironment = runEnvironment;
  }
}

export class RunEnvResolver {
  readonly #credentials: RunCredentialMintPort;
  readonly #resolveRunInstallationProviderEnvBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedInstallationProviderEnvBinding[] | undefined>;

  constructor(dependencies: RunEnvResolverDependencies) {
    this.#credentials = dependencies.credentials;
    this.#resolveRunInstallationProviderEnvBindings =
      dependencies.resolveRunInstallationProviderEnvBindings;
  }

  async resolveRunEnvironment(
    input: ResolveRunEnvironmentInput,
  ): Promise<ResolvedRunEnvironment> {
    const providerResolutions = await this.#providerResolutions(input);
    const blocked = providerResolutions.find((resolution) =>
      resolution.status.startsWith("blocked_"),
    );
    if (blocked) {
      const runEnvironment = await this.#buildRunEnvironmentEvidence(
        input,
        providerResolutions,
        undefined,
      );
      throw new RunEnvironmentResolutionError(
        blocked.blockedReason ??
          `provider_resolution_blocked: ${blocked.requirement.providerSource}`,
        runEnvironment,
      );
    }
    const credentials = await this.#credentials.mintRunCredentials(
      input.planRun,
      input.phase,
      input.auditRunId,
    );
    return await this.#buildRunEnvironmentEvidence(
      input,
      providerResolutions,
      credentials,
    );
  }

  async #buildRunEnvironmentEvidence(
    input: ResolveRunEnvironmentInput,
    providerResolutions: readonly ProviderResolution[],
    credentials: RunCredentials | undefined,
  ): Promise<ResolvedRunEnvironment> {
    const credentialEnvNames =
      credentialEnvNamesFromRunCredentials(credentials);
    const runEnvironmentEvidenceDigest = await stableJsonDigest({
      runId: input.auditRunId,
      phase: input.phase,
      providerResolutions,
      credentialEnvNames,
      redactionProfileId: RUN_ENV_REDACTION_PROFILE_ID,
    });
    return {
      ...(credentials ? { credentials } : {}),
      providerResolutions,
      runEnvironmentEvidenceDigest,
      redactionProfileId: RUN_ENV_REDACTION_PROFILE_ID,
    };
  }

  async #providerResolutions(
    input: ResolveRunEnvironmentInput,
  ): Promise<readonly ProviderResolution[]> {
    const planRun = input.planRun;
    if (planRun.requiredProviders.length === 0) return [];
    if (!planRun.installationContext) {
      return planRun.requiredProviders.map((provider) => {
        const requirement = providerRequirement(planRun, provider);
        return {
          requirement,
          status: "blocked_missing_env",
          blockedReason: `installation provider connection evidence is required for provider ${provider}`,
          evidence: {
            kind: "blocked",
            provider,
            reason: `installation provider connection evidence is required for provider ${provider}`,
          },
        };
      });
    }
    const resolved =
      await this.#resolveRunInstallationProviderEnvBindings(planRun);
    if (!resolved) {
      return planRun.requiredProviders.map((provider) => {
        const requirement = providerRequirement(planRun, provider);
        return {
          requirement,
          status: "blocked_missing_env",
          blockedReason: `installation provider connection resolution is required for provider ${provider}`,
          evidence: {
            kind: "blocked",
            provider,
            reason: `installation provider connection resolution is required for provider ${provider}`,
          },
        };
      });
    }

    return planRun.requiredProviders.map((provider) => {
      const match = resolved.find((entry) =>
        sameProviderFamily(provider, entry.provider),
      );
      const requirement = providerRequirement(planRun, provider);
      if (!match) {
        return {
          requirement,
          status: "blocked_missing_env",
          blockedReason: `provider connection is required for provider ${provider}`,
          evidence: {
            kind: "blocked",
            provider,
            reason: `provider connection is required for provider ${provider}`,
          },
        };
      }
      return providerResolutionFromResolved(input, requirement, match);
    });
  }
}

function credentialEnvNamesFromRunCredentials(
  credentials: RunCredentials | undefined,
): readonly string[] {
  if (!credentials) return [];
  if (isStructuredRunCredentials(credentials)) {
    return [
      ...Object.keys(credentials.env),
      ...(credentials.files ?? []).flatMap((file) =>
        file.envName ? [file.envName] : [],
      ),
    ].sort();
  }
  return Object.keys(credentials).sort();
}

function isStructuredRunCredentials(
  credentials: RunCredentials,
): credentials is Extract<
  RunCredentials,
  { readonly env: Readonly<Record<string, string>> }
> {
  return (
    credentials !== null &&
    typeof credentials === "object" &&
    "env" in credentials &&
    typeof credentials.env === "object" &&
    credentials.env !== null
  );
}

function providerRequirement(
  planRun: PlanRun,
  provider: string,
): ProviderRequirement {
  return {
    providerSource: provider,
    providerName: providerName(provider),
    modulePath: planRun.source.modulePath ?? ".",
    discoveredFrom: "required_providers",
    requiredForPhases: requiredPhases(planRun.operation),
  };
}

function providerResolutionFromResolved(
  _input: ResolveRunEnvironmentInput,
  requirement: ProviderRequirement,
  resolved: ResolvedInstallationProviderEnvBinding,
): ProviderResolution {
  const provider = resolved.provider;
  if ((resolved.materialization as string) === "gateway") {
    return {
      requirement,
      status: "blocked_policy",
      envId: resolved.env.id,
      materialization: resolved.materialization,
      blockedReason:
        "gateway materialization is Takosumi Cloud-only and is not available in OSS",
      evidence: {
        kind: "blocked",
        provider,
        envId: resolved.env.id,
        materialization: resolved.materialization,
        reason:
          "gateway materialization is Takosumi Cloud-only and is not available in OSS",
      },
    };
  }
  return {
    requirement,
    status: "resolved_provider_env",
    envId: resolved.env.id,
    materialization: resolved.materialization,
    evidence: {
      kind: "provider_env",
      provider,
      envId: resolved.env.id,
      materialization: resolved.materialization,
      requiredEnvNames: resolved.env.requiredEnvNames,
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
