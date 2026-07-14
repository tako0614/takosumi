/**
 * Run-credential mint broker (§9 per-phase Credential Recipe materialization).
 *
 * A thin collaborator pulled out of `OpenTofuController`: it owns the
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
 *   - `resolveRunProviderBindings` — the run-scoped Provider
 *     Binding resolution shared by root generation and credential mint;
 *   - `policyForPlanRun` — the layered credential mint policy lookup;
 *   - `newId` / `now` — mirror the controller's handles so ids / timestamps line
 *     up across both surfaces.
 */

import type {
  PlanRun,
  PolicyConfig,
} from "@takosumi/internal/deploy-control-api";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import { CredentialBundle } from "../../adapters/vault/mod.ts";
import type {
  CapsuleProviderBindingMintEntry,
  ConnectionVault,
} from "../../adapters/vault/mod.ts";
import type { OpenTofuControlStore } from "./store.ts";
import {
  CREDENTIAL_MINT_FAILED_REASON,
  CREDENTIAL_POLICY_FAILED_REASON,
  CREDENTIAL_SERVICE_UNAVAILABLE_REASON,
  mapVaultError,
  OpenTofuControllerError,
  PROVIDER_CONNECTION_CHANGED_REASON,
  PROVIDER_CONNECTION_SETUP_REQUIRED_REASON,
  structuredErrorReason,
} from "./errors.ts";
import { evaluateProviderCredentialMintPolicy } from "./provider_policy.ts";
import {
  resolvedProviderBindingsDigest,
  type ResolvedCapsuleProviderBinding,
} from "../connections/mod.ts";
import type { RunCredentials } from "./mod.ts";
import type { RunCredentialRecipeManifest } from "takosumi-contract/credential-recipes";

/**
 * Ports the controller injects into {@link RunCredentialBroker}. The vault and
 * `resolveRunProviderBindings` stays owned by the controller and is passed as a
 * handles / callbacks rather than moved; `store` / `newId` / `now` mirror the
 * controller's own handles so ids and timestamps line up across both surfaces.
 */
export interface RunCredentialBrokerDependencies {
  readonly store: OpenTofuControlStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  /** Run-execution Vault handle (absent on builds without provider credentials). */
  readonly vault?: ConnectionVault;
  /** Run-scoped Provider Binding resolution shared with root generation. */
  readonly resolveRunProviderBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedCapsuleProviderBinding[] | undefined>;
  /** Layered credential mint policy lookup for the Run subject. */
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
  readonly #store: OpenTofuControlStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #vault?: ConnectionVault;
  readonly #resolveRunProviderBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedCapsuleProviderBinding[] | undefined>;
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
    return await this.#mintCredentials(planRun, phase, auditRunId);
  }

  async mintReleaseCommandCredentials(
    planRun: PlanRun,
    phase: "apply" | "destroy",
    auditRunId: string,
  ): Promise<RunCredentials | undefined> {
    return await this.#mintCredentials(planRun, phase, auditRunId);
  }

  async #mintCredentials(
    planRun: PlanRun,
    phase: "plan" | "apply" | "destroy",
    auditRunId: string,
  ): Promise<RunCredentials | undefined> {
    if (planRun.requiredProviders.length === 0) {
      return undefined;
    }
    try {
      if (!planRun.capsuleContext && !planRun.resourceContext) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "credential_mint_failed: provider connection evidence is required",
          { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
        );
      }
      // Resolve the Capsule's Provider Bindings once. The same resolution feeds
      // rootgen's non-secret provider configuration and run-scoped recipe mint.
      const resolved = await this.#resolveRunProviderBindings(planRun);
      if (!resolved) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "credential_mint_failed: capsule provider connection resolution is required",
          { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
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
        planRun.resolvedProviderBindingsDigest !== undefined
      ) {
        const liveDigest = await resolvedProviderBindingsDigest(resolved);
        if (liveDigest !== planRun.resolvedProviderBindingsDigest) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `resolved_bindings_changed: plan run ${planRun.id} was reviewed ` +
              `against different provider connections than are now resolved; ` +
              `re-plan before apply`,
            { reason: PROVIDER_CONNECTION_CHANGED_REASON },
          );
        }
      }
      // The same resolved entries that produced rootgen provider blocks select
      // the Credential Recipes materialized for the runner dispatch.
      // Every recipe uses the same provider-neutral env/file path. Rootgen may
      // render explicit non-secret providerConfig, but never credential args.
      const providerEntries = providerMintEntriesFromResolved(resolved);
      const credentialEvidenceProviders = providerEntries.map(
        (entry) => entry.provider,
      );
      const vaultRequired = providerEntries.length > 0;
      const vault = this.#vault;
      if (vaultRequired && !vault) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "credential_mint_failed: connection vault is not configured for provider credentials",
          { reason: CREDENTIAL_SERVICE_UNAVAILABLE_REASON },
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
          credentialEvidenceProviders,
        );
        return {
          env: { ...bundle.env },
          manifest: credentialManifest(resolved),
        };
      }
      const capsuleId = planRun.capsuleContext?.capsuleId ?? planRun.capsuleId;
      const recipeBundle = await vault!.mintForCapsuleProviderBindings(
        planRun.workspaceId,
        providerEntries,
        { phase, ...(capsuleId ? { capsuleId } : {}) },
      );
      const evidence = [
        ...bundle.providerCredentialEvidence,
        ...recipeBundle.providerCredentialEvidence,
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
        credentialEvidenceProviders,
      );
      const recipeResponse = recipeBundle.toMintResponse();
      const env = { ...bundle.env, ...recipeResponse.env };
      const manifest = credentialManifest(resolved, recipeResponse.files);
      return recipeResponse.files && recipeResponse.files.length > 0
        ? { env, files: recipeResponse.files, manifest }
        : { env, manifest };
    } catch (error) {
      const mapped = mapVaultError(error);
      if (mapped instanceof OpenTofuControllerError) {
        if (structuredErrorReason(mapped)) throw mapped;
        throw new OpenTofuControllerError(mapped.code, mapped.message, {
          reason: CREDENTIAL_MINT_FAILED_REASON,
        });
      }
      throw mapped;
    }
  }

  async #assertProviderCredentialPolicy(
    planRun: PlanRun,
    evidence: readonly ProviderCredentialMintEvidence[],
    expectedCredentialEvidenceCount = 0,
    credentialEvidenceProviders: readonly string[] = [],
  ): Promise<void> {
    const policy = await this.#policyForPlanRun(planRun);
    const result = evaluateProviderCredentialMintPolicy(
      evidence,
      policy,
      credentialEvidenceProviders,
      expectedCredentialEvidenceCount,
    );
    if (result.reasons.length === 0) return;
    throw new OpenTofuControllerError(
      "failed_precondition",
      `credential_policy_failed: ${result.reasons[0]}`,
      { reason: CREDENTIAL_POLICY_FAILED_REASON },
    );
  }

  async #recordProviderCredentialMintEvents(
    planRun: PlanRun,
    resolved: readonly ResolvedCapsuleProviderBinding[],
    phase: "plan" | "apply" | "destroy",
    auditRunId: string,
    evidence: readonly ProviderCredentialMintEvidence[] = [],
  ): Promise<void> {
    const byConnection = credentialMintAuditEntries(resolved);
    if (byConnection.length === 0) return;
    const createdAt = new Date(this.#now()).toISOString();
    const capsuleId = planRun.capsuleContext?.capsuleId ?? planRun.capsuleId;
    const evidenceByConnection = groupProviderCredentialEvidence(evidence);
    for (const entry of byConnection) {
      const providerCredentialEvidence =
        evidenceByConnection.get(entry.connectionId) ?? [];
      await this.#store.putCredentialMintEvent({
        id: this.#newId("credmint"),
        runId: auditRunId,
        workspaceId: planRun.workspaceId,
        ...(capsuleId ? { capsuleId } : {}),
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

function credentialManifest(
  resolved: readonly ResolvedCapsuleProviderBinding[],
  files: readonly {
    readonly path: string;
    readonly mode: number;
    readonly envName?: string;
  }[] = [],
): RunCredentialRecipeManifest {
  return {
    bindings: resolved
      .map((entry) => ({
        providerSource: entry.provider,
        ...(entry.alias ? { alias: entry.alias } : {}),
        connectionId: entry.connection.id,
        recipeId: entry.connection.credentialRecipe?.id ?? "legacy",
        authMode: entry.connection.credentialRecipe?.authMode ?? "legacy",
        envNames: [...entry.connection.envNames].sort(),
        fileEnvNames: [...(entry.connection.fileEnvNames ?? [])].sort(),
        requiredEnvGroups: (
          entry.connection.credentialRecipe?.requiredEnvGroups ?? []
        ).map((group) => [...group].sort()),
      }))
      .sort(
        (left, right) =>
          left.providerSource.localeCompare(right.providerSource) ||
          String(left.alias).localeCompare(String(right.alias)),
      ),
    ...(files.length > 0
      ? {
          files: files.map((file) => ({
            path: file.path,
            mode: file.mode,
            ...(file.envName ? { envName: file.envName } : {}),
          })),
        }
      : {}),
  };
}

/**
 * Derives per-connection credential mint entries from resolved Provider Bindings.
 * Mirrors `providerBindingsFromResolved` so minted TF_VAR names line up
 * byte-for-byte with rootgen. The vault still re-validates each connection id.
 */
function providerMintEntriesFromResolved(
  resolved: readonly ResolvedCapsuleProviderBinding[],
): readonly CapsuleProviderBindingMintEntry[] {
  const entries: CapsuleProviderBindingMintEntry[] = [];
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

/**
 * Produces the non-secret audit rows for provider credential mints. The legacy
 * `capabilities` field carries provider keys until the physical column is
 * migrated.
 */
function credentialMintAuditEntries(
  resolved: readonly ResolvedCapsuleProviderBinding[],
): readonly {
  readonly connectionId: string;
  readonly capabilities: readonly string[];
}[] {
  const byConnection = new Map<string, Set<string>>();
  for (const entry of resolved) {
    const connectionId = entry.connection.id;
    let bucket = byConnection.get(connectionId);
    if (!bucket) {
      bucket = new Set<string>();
      byConnection.set(connectionId, bucket);
    }
    bucket.add(entry.connection.provider);
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
        `${a.provider}:${a.expiresAt ?? ""}`.localeCompare(
          `${b.provider}:${b.expiresAt ?? ""}`,
        ),
      ),
    );
  }
  return byConnection;
}
