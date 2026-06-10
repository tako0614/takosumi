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
 *   - `resolveRunProviderBindings` — the run-scoped provider-binding resolution
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
  ProviderBindingMintEntry,
  ConnectionVault,
} from "../../adapters/vault/mod.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import { mapVaultError, OpenTofuControllerError } from "./errors.ts";
import { providerMatches } from "./policy.ts";
import { evaluateProviderCredentialMintPolicy } from "./provider_policy.ts";
import {
  mintableConnectionIds,
  type ResolvedProviderBinding,
} from "../connections/mod.ts";
import type { RunCredentials } from "./mod.ts";

/**
 * Ports the controller injects into {@link RunCredentialBroker}. The vault and
 * `resolveRunProviderBindings` stay owned by the controller and are passed as
 * handles / callbacks rather than moved; `store` / `newId` / `now` mirror the
 * controller's own handles so ids and timestamps line up across both surfaces.
 */
export interface RunCredentialBrokerDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  /** Run-execution Vault handle (absent on builds without provider credentials). */
  readonly vault?: ConnectionVault;
  /** Run-scoped provider-binding resolution (feeds rootgen and the per-alias split). */
  readonly resolveRunProviderBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedProviderBinding[] | undefined>;
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
  readonly #resolveRunProviderBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedProviderBinding[] | undefined>;
  readonly #policyForPlanRun: (
    planRun: PlanRun,
  ) => Promise<PolicyConfig | undefined>;

  constructor(dependencies: RunCredentialBrokerDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#vault = dependencies.vault;
    this.#resolveRunProviderBindings = dependencies.resolveRunProviderBindings;
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
    if (!this.#vault) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "credential_mint_failed: connection vault is not configured for provider credentials",
      );
    }
    try {
      // Resolve the installation's provider bindings ONCE: the same resolution
      // feeds the per-binding credential split (TF_VAR entries) so minted vars
      // line up byte-for-byte with rootgen.
      const resolved = await this.#resolveRunProviderBindings(planRun);
      // Per-binding split: the same resolved entries that produced the rootgen
      // provider blocks produce these TF_VAR_<provider>_<alias>_<arg> vars.
      // This is the only provider credential delivery path for Installation
      // runs; providers without a root-only arg mapping receive no shared env.
      const providerEntries = resolved
        ? providerMintEntriesFromResolved(resolved)
        : [];
      if (resolved) {
        const missingRootOnly = missingRootOnlyCredentialProviders(
          planRun.requiredProviders,
          resolved,
        );
        const credentialPolicy = (await this.#policyForPlanRun(planRun))
          ?.providerCredentials;
        const rootOnlyRequired =
          credentialPolicy?.requireRootOnly === true ||
          resolved.some((entry) => entry.mode === "disabled");
        if (missingRootOnly.length > 0 && rootOnlyRequired) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `credential_mint_failed: root-only provider binding is required for providers: ${missingRootOnly.join(", ")}`,
          );
        }
      }
      const sharedProviders = resolved ? [] : planRun.requiredProviders;
      const connectionIds =
        resolved && sharedProviders.length > 0
          ? mintableConnectionIds(resolved)
          : resolved
            ? []
            : undefined;
      const bundle =
        sharedProviders.length > 0
          ? await this.#vault.mintForPhase({
              spaceId: planRun.spaceId,
              phase,
              providers: sharedProviders,
              ...(connectionIds !== undefined ? { connectionIds } : {}),
            })
          : new CredentialBundle({});
      if (providerEntries.length === 0) {
        if (resolved) {
          await this.#recordProviderCredentialMintEvents(
            planRun,
            resolved,
            phase,
            auditRunId,
            bundle.providerCredentialEvidence,
          );
        }
        await this.#assertProviderCredentialPolicy(
          planRun,
          bundle.providerCredentialEvidence,
          resolved ? providerEntries.length : 0,
        );
        return bundle.env;
      }
      const perAlias = await this.#vault.mintForProviderBindings(
        planRun.spaceId,
        providerEntries,
        { phase },
      );
      const evidence = [
        ...bundle.providerCredentialEvidence,
        ...perAlias.providerCredentialEvidence,
      ];
      if (resolved) {
        await this.#recordProviderCredentialMintEvents(
          planRun,
          resolved,
          phase,
          auditRunId,
          evidence,
        );
      }
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
    resolved: readonly ResolvedProviderBinding[],
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
        evidenceByConnection.get(entry.connectionId) ?? [];
      await this.#store.putCredentialMintEvent({
        id: this.#newId("credmint"),
        runId: auditRunId,
        spaceId: planRun.spaceId,
        ...(installationId ? { installationId } : {}),
        connectionId: entry.connectionId,
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

/**
 * Derives per-binding credential mint entries from resolved provider bindings.
 * Mirrors `providerBindingsFromResolved` so minted TF_VAR names line up
 * byte-for-byte with rootgen. The vault still re-validates each connection id.
 */
function providerMintEntriesFromResolved(
  resolved: readonly ResolvedProviderBinding[],
): readonly ProviderBindingMintEntry[] {
  const entries: ProviderBindingMintEntry[] = [];
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
  resolved: readonly ResolvedProviderBinding[],
): readonly string[] {
  return requiredProviders
    .filter((provider) => providerEnvRule(provider))
    .filter((provider) => !rootOnlyProviderCovered(provider, resolved))
    .sort();
}

function rootOnlyProviderCovered(
  requiredProvider: string,
  resolved: readonly ResolvedProviderBinding[],
): boolean {
  return resolved.some((entry) => {
    if (!entry.connection) return false;
    if (providerCredentialArgs(entry.connection.provider).length === 0) {
      return false;
    }
    return providerMatches(requiredProvider, entry.connection.provider);
  });
}

/**
 * Produces the non-secret audit rows for provider credential mints. The legacy
 * `capabilities` field carries provider keys until the physical column is
 * migrated.
 */
function credentialMintAuditEntries(
  resolved: readonly ResolvedProviderBinding[],
): readonly {
  readonly connectionId: string;
  readonly capabilities: readonly string[];
}[] {
  const byConnection = new Map<string, Set<string>>();
  for (const entry of resolved) {
    if (!entry.connection) continue;
    let providers = byConnection.get(entry.connection.id);
    if (!providers) {
      providers = new Set<string>();
      byConnection.set(entry.connection.id, providers);
    }
    providers.add(entry.connection.provider);
  }
  return Array.from(byConnection.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([connectionId, providers]) => ({
      connectionId,
      capabilities: Array.from(providers).sort(),
    }));
}

function groupProviderCredentialEvidence(
  evidence: readonly ProviderCredentialMintEvidence[],
): ReadonlyMap<string, readonly ProviderCredentialMintEvidence[]> {
  const byConnection = new Map<string, ProviderCredentialMintEvidence[]>();
  const seen = new Set<string>();
  for (const item of evidence) {
    const key = [
      item.connectionId,
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
    const existing = byConnection.get(item.connectionId) ?? [];
    existing.push(item);
    byConnection.set(item.connectionId, existing);
  }
  for (const [connectionId, entries] of byConnection) {
    byConnection.set(
      connectionId,
      entries.sort((a, b) =>
        `${a.delivery}:${a.provider}:${a.expiresAt ?? ""}`.localeCompare(
          `${b.delivery}:${b.provider}:${b.expiresAt ?? ""}`,
        ),
      ),
    );
  }
  return byConnection;
}
