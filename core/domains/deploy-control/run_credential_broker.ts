/**
 * Run-credential mint broker (§9 per-phase credential mint; §13 per-alias split).
 *
 * A thin collaborator pulled out of `OpenTofuDeploymentController`: it owns the
 * just-before-dispatch provider-credential mint for a plan / apply / destroy run,
 * the post-mint provider-credential mint-policy assertion, and the non-secret
 * mint-event audit recording. Concentrating this here keeps the never-store /
 * never-log vault-mint security invariant in one auditable file — the minted
 * {@link RunCredentials} bundle is returned to the run engine, attached to the
 * runner dispatch ONLY, and never persisted or logged.
 *
 * The controller holds one instance and the run-engine call sites
 * (`#executePlan` / `#executeApply` / `#executeDestroyApply`) delegate to
 * `this.#credentials.mintRunCredentials(planRun, phase, auditRunId)` unchanged.
 *
 * The seams that stay on the controller are injected as ports rather than moved:
 *   - `vault` — the {@link ConnectionVault}, whose run-execution handle is shared
 *     (the Connection-lifecycle facade keeps its own);
 *   - `store` — for the mint-event ledger writes;
 *   - `resolveRunInstallationProviderEnvBindings` — the run-scoped Provider Env binding resolution
 *     that feeds rootgen, so the minted TF_VAR vars line up byte-for-byte;
 *   - `policyForPlanRun` — the layered policy lookup (root-only requirement +
 *     credential mint policy);
 *   - `newId` / `now` — mirror the controller's handles so ids / timestamps line
 *     up across both surfaces.
 */

import type {
  PlanRun,
  PolicyConfig,
} from "@takosumi/internal/deploy-control-api";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import {
  providerCredentialArgs,
  providerEnvRule,
} from "takosumi-contract/provider-env-rules";
import { CredentialBundle } from "../../adapters/vault/mod.ts";
import type {
  InstallationProviderEnvBindingMintEntry,
  ConnectionVault,
} from "../../adapters/vault/mod.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import { mapVaultError, OpenTofuControllerError } from "./errors.ts";
import { providerMatches } from "./policy.ts";
import { evaluateProviderCredentialMintPolicy } from "./provider_policy.ts";
import {
  resolvedProviderEnvBindingsDigest,
  type ResolvedInstallationProviderEnvBinding,
} from "../connections/mod.ts";
import type { RunCredentials } from "./mod.ts";

/**
 * Ports the controller injects into {@link RunCredentialBroker}. The vault and
 * `resolveRunInstallationProviderEnvBindings` stay owned by the controller and are passed as
 * handles / callbacks rather than moved; `store` / `newId` / `now` mirror the
 * controller's own handles so ids and timestamps line up across both surfaces.
 */
export interface RunCredentialBrokerDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  /** Run-execution Vault handle (absent on builds without provider credentials). */
  readonly vault?: ConnectionVault;
  /** Run-scoped Provider Env binding resolution (feeds rootgen and the per-alias split). */
  readonly resolveRunInstallationProviderEnvBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedInstallationProviderEnvBinding[] | undefined>;
  /** Layered policy lookup for the run's installation (root-only + mint policy). */
  readonly policyForPlanRun: (
    planRun: PlanRun,
  ) => Promise<PolicyConfig | undefined>;
}

/**
 * Collaborator owning the run-credential mint subsystem: the per-phase provider
 * credential mint, the post-mint mint-policy assertion, and the non-secret
 * mint-event audit recording. Behavior is identical to the prior inline
 * controller methods.
 */
export class RunCredentialBroker {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #vault?: ConnectionVault;
  readonly #resolveRunInstallationProviderEnvBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedInstallationProviderEnvBinding[] | undefined>;
  readonly #policyForPlanRun: (
    planRun: PlanRun,
  ) => Promise<PolicyConfig | undefined>;

  constructor(dependencies: RunCredentialBrokerDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#vault = dependencies.vault;
    this.#resolveRunInstallationProviderEnvBindings =
      dependencies.resolveRunInstallationProviderEnvBindings;
    this.#policyForPlanRun = dependencies.policyForPlanRun;
  }

  async mintRunCredentials(
    planRun: PlanRun,
    phase: "plan" | "apply" | "destroy",
    auditRunId: string,
  ): Promise<RunCredentials | undefined> {
    if (planRun.requiredProviders.length === 0) {
      return undefined;
    }
    try {
      if (!planRun.installationContext) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "credential_mint_failed: installation provider connection evidence is required",
        );
      }
      // Resolve the installation's provider env bindings ONCE: the same resolution
      // feeds the per-connection credential split (TF_VAR entries) so minted vars
      // line up byte-for-byte with rootgen.
      const resolved =
        await this.#resolveRunInstallationProviderEnvBindings(planRun);
      if (!resolved) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "credential_mint_failed: installation provider connection resolution is required",
        );
      }
      // plan→apply TOCTOU assert (S2): the plan pinned a digest of the bindings
      // it was reviewed against. At apply/destroy mint, re-hash the LIVE resolved
      // bindings and fail closed if they diverge — a Connection swap, a binding
      // mode flip, or a provider resolver repoint between plan and apply would
      // otherwise mint DIFFERENT credentials than the reviewer approved. The plan
      // mint is the pinning side, so it is never asserted here.
      if (
        (phase === "apply" || phase === "destroy") &&
        planRun.resolvedProviderEnvBindingsDigest !== undefined
      ) {
        const liveDigest = await resolvedProviderEnvBindingsDigest(resolved);
        if (liveDigest !== planRun.resolvedProviderEnvBindingsDigest) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `resolved_bindings_changed: plan run ${planRun.id} was reviewed ` +
              `against different provider connections than are now resolved; ` +
              `re-plan before apply`,
          );
        }
      }
      assertNoCloudOnlyGatewayMaterialization(planRun, resolved);
      // Per-connection split: the same resolved entries that produced the rootgen
      // provider blocks produce these TF_VAR_<provider>_<alias>_<arg> vars.
      // This is the only provider credential delivery path for Installation
      // runs; providers without a root-only arg mapping receive no shared env.
      const providerEntries = providerMintEntriesFromResolved(resolved);
      const missingRootOnly = missingRootOnlyCredentialProviders(
        planRun.requiredProviders,
        resolved,
      );
      const credentialPolicy = (await this.#policyForPlanRun(planRun))
        ?.providerCredentials;
      const rootOnlyRequired = credentialPolicy?.requireRootOnly === true;
      if (missingRootOnly.length > 0 && rootOnlyRequired) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `credential_mint_failed: root-only provider connection is required for providers: ${missingRootOnly.join(", ")}`,
        );
      }
      const vaultRequired = providerEntries.length > 0;
      const vault = this.#vault;
      if (vaultRequired && !vault) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "credential_mint_failed: connection vault is not configured for provider credentials",
        );
      }
      const bundle = new CredentialBundle({});
      if (providerEntries.length === 0) {
        await this.#recordProviderCredentialMintEvents(
          planRun,
          resolved,
          phase,
          auditRunId,
          bundle.providerCredentialEvidence,
        );
        await this.#assertProviderCredentialPolicy(
          planRun,
          bundle.providerCredentialEvidence,
          providerEntries.length,
        );
        return { ...bundle.env };
      }
      const perAlias = await vault!.mintForInstallationProviderEnvBindings(
        planRun.spaceId,
        providerEntries,
        { phase },
      );
      const evidence = [
        ...bundle.providerCredentialEvidence,
        ...perAlias.providerCredentialEvidence,
      ];
      await this.#recordProviderCredentialMintEvents(
        planRun,
        resolved,
        phase,
        auditRunId,
        evidence,
      );
      await this.#assertProviderCredentialPolicy(
        planRun,
        evidence,
        providerEntries.length,
      );
      return { ...bundle.env, ...perAlias.env };
    } catch (error) {
      const mapped = mapVaultError(error);
      if (mapped instanceof OpenTofuControllerError) {
        if (mapped.message.startsWith("credential_policy_failed:")) {
          throw mapped;
        }
        throw new OpenTofuControllerError(
          mapped.code,
          mapped.message.startsWith("credential_mint_failed:")
            ? mapped.message
            : `credential_mint_failed: ${mapped.message}`,
        );
      }
      throw mapped;
    }
  }

  async #assertProviderCredentialPolicy(
    planRun: PlanRun,
    evidence: readonly ProviderCredentialMintEvidence[],
    expectedCredentialEvidenceCount = 0,
  ): Promise<void> {
    const policy = await this.#policyForPlanRun(planRun);
    const result = evaluateProviderCredentialMintPolicy(
      evidence,
      policy,
      planRun.requiredProviders,
      expectedCredentialEvidenceCount,
    );
    if (result.reasons.length === 0) return;
    throw new OpenTofuControllerError(
      "failed_precondition",
      `credential_policy_failed: ${result.reasons[0]}`,
    );
  }

  async #recordProviderCredentialMintEvents(
    planRun: PlanRun,
    resolved: readonly ResolvedInstallationProviderEnvBinding[],
    phase: "plan" | "apply" | "destroy",
    auditRunId: string,
    evidence: readonly ProviderCredentialMintEvidence[] = [],
  ): Promise<void> {
    const byConnection = credentialMintAuditEntries(resolved);
    if (byConnection.length === 0) return;
    const createdAt = new Date(this.#now()).toISOString();
    const installationId =
      planRun.installationContext?.installationId ?? planRun.installationId;
    const evidenceByConnection = groupProviderCredentialEvidence(evidence);
    for (const entry of byConnection) {
      const providerCredentialEvidence =
        evidenceByConnection.get(entry.providerEnvId) ?? [];
      await this.#store.putCredentialMintEvent({
        id: this.#newId("credmint"),
        runId: auditRunId,
        spaceId: planRun.spaceId,
        ...(installationId ? { installationId } : {}),
        providerEnvId: entry.providerEnvId,
        ...(entry.connectionId ? { connectionId: entry.connectionId } : {}),
        phase,
        capabilities: entry.capabilities,
        ...(providerCredentialEvidence.length > 0
          ? { providerCredentialEvidence }
          : {}),
        createdAt,
      });
    }
  }
}

function assertNoCloudOnlyGatewayMaterialization(
  planRun: PlanRun,
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): void {
  if (
    !resolved.some((entry) => (entry.materialization as string) === "gateway")
  ) {
    return;
  }
  throw new OpenTofuControllerError(
    "failed_precondition",
    `credential_mint_failed: gateway materialization is Takosumi Cloud-only and is not available in OSS runner profile ${planRun.runnerProfileId}`,
  );
}

/**
 * Derives per-connection credential mint entries from resolved provider env bindings.
 * Mirrors `providerEnvBindingsFromResolved` so minted TF_VAR names line up
 * byte-for-byte with rootgen. The vault still re-validates each connection id.
 */
function providerMintEntriesFromResolved(
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): readonly InstallationProviderEnvBindingMintEntry[] {
  const entries: InstallationProviderEnvBindingMintEntry[] = [];
  for (const entry of resolved) {
    const connection = entry.connection;
    if (!connection) continue;
    entries.push({
      provider: connection.provider,
      ...(entry.alias ? { alias: entry.alias } : {}),
      connectionId: connection.id,
    });
  }
  return entries;
}

function missingRootOnlyCredentialProviders(
  requiredProviders: readonly string[],
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): readonly string[] {
  return requiredProviders
    .filter((provider) => providerEnvRule(provider))
    .filter((provider) => !rootOnlyProviderCovered(provider, resolved))
    .sort();
}

function rootOnlyProviderCovered(
  requiredProvider: string,
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): boolean {
  return resolved.some((entry) => {
    const provider = entry.connection?.provider ?? entry.provider;
    if (providerCredentialArgs(provider).length === 0) {
      return false;
    }
    return providerMatches(requiredProvider, provider);
  });
}

/**
 * Produces the non-secret audit rows for provider credential mints. The legacy
 * `capabilities` field carries provider keys until the physical column is
 * migrated.
 */
function credentialMintAuditEntries(
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): readonly {
  readonly providerEnvId: string;
  readonly connectionId?: string;
  readonly capabilities: readonly string[];
}[] {
  const byProviderEnv = new Map<
    string,
    { readonly connectionId?: string; readonly providers: Set<string> }
  >();
  for (const entry of resolved) {
    const providerEnvId = entry.env.id;
    let bucket = byProviderEnv.get(providerEnvId);
    if (!bucket) {
      bucket = {
        ...(entry.connection ? { connectionId: entry.connection.id } : {}),
        providers: new Set<string>(),
      };
      byProviderEnv.set(providerEnvId, bucket);
    }
    bucket.providers.add(
      entry.connection?.provider ?? entry.env.providerSource,
    );
  }
  return Array.from(byProviderEnv.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([providerEnvId, bucket]) => ({
      providerEnvId,
      ...(bucket.connectionId ? { connectionId: bucket.connectionId } : {}),
      capabilities: Array.from(bucket.providers).sort(),
    }));
}

function groupProviderCredentialEvidence(
  evidence: readonly ProviderCredentialMintEvidence[],
): ReadonlyMap<string, readonly ProviderCredentialMintEvidence[]> {
  const byProviderEnv = new Map<string, ProviderCredentialMintEvidence[]>();
  const seen = new Set<string>();
  for (const item of evidence) {
    const key = [
      item.providerEnvId,
      item.connectionId ?? "",
      item.provider,
      item.delivery,
      item.rootOnly ? "root" : "shared",
      item.temporary ? "temporary" : "static",
      item.ttlEnforced ? "ttl" : "no-ttl",
      item.expiresAt ?? "",
      item.ttlSeconds ?? "",
      item.issuer ?? "",
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = byProviderEnv.get(item.providerEnvId) ?? [];
    existing.push(item);
    byProviderEnv.set(item.providerEnvId, existing);
  }
  for (const [providerEnvId, entries] of byProviderEnv) {
    byProviderEnv.set(
      providerEnvId,
      entries.sort((a, b) =>
        `${a.delivery}:${a.provider}:${a.expiresAt ?? ""}`.localeCompare(
          `${b.delivery}:${b.provider}:${b.expiresAt ?? ""}`,
        ),
      ),
    );
  }
  return byProviderEnv;
}
