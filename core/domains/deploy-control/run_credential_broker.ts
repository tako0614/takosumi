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
import {
  ConnectionVaultError,
  CredentialBundle,
  validatedProviderCredentialMintEvidence,
} from "../../adapters/vault/mod.ts";
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
  RUNTIME_INPUT_MATERIALIZER_UNAVAILABLE_REASON,
  RUNTIME_INPUTS_LIMIT_EXCEEDED_REASON,
  RUNTIME_INPUTS_NAME_SET_CHANGED_REASON,
  RUNTIME_INPUTS_NONCE_CHANGED_REASON,
  RUNTIME_INPUTS_REQUIRE_GENERATED_ROOT_REASON,
  structuredErrorReason,
} from "./errors.ts";
import {
  RUNTIME_INPUT_MAX_NAMES,
  RUNTIME_INPUT_MAX_TOTAL_BYTES,
  RUNTIME_INPUT_MAX_VALUE_BYTES,
  RUNTIME_INPUT_NAME_PATTERN,
  type RuntimeInputMaterializer,
} from "./runtime_input_materializer.ts";
import { runtimeInputWiringFromResolved } from "./runtime_input_wiring.ts";
import type { DispatchRuntimeInputs } from "@takosumi/internal/deploy-control-api";
import {
  evaluateProviderConnectionCredentialPolicy,
  evaluateProviderCredentialMintPolicy,
} from "./provider_policy.ts";
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
import {
  resolvedProviderBindingsDigest,
  type ResolvedCapsuleProviderBinding,
} from "../connections/mod.ts";
import type { RunCredentials, RunCredentialRuntimeInputs } from "./mod.ts";
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
  /**
   * Value-free run-scoped sensitive input wiring the Plan pinned into the
   * private run-inputs sidecar. Apply compares the live derivation against it.
   */
  readonly runtimeInputsForPlanRun?: (
    planRun: PlanRun,
  ) => Promise<readonly DispatchRuntimeInputs[] | undefined>;
  /** Host materializer for run-scoped sensitive provider inputs. */
  readonly runtimeInputMaterializer?: RuntimeInputMaterializer;
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
  readonly #runtimeInputsForPlanRun?: (
    planRun: PlanRun,
  ) => Promise<readonly DispatchRuntimeInputs[] | undefined>;
  readonly #runtimeInputMaterializer?: RuntimeInputMaterializer;

  constructor(dependencies: RunCredentialBrokerDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#vault = dependencies.vault;
    this.#resolveRunProviderBindings = dependencies.resolveRunProviderBindings;
    this.#policyForPlanRun = dependencies.policyForPlanRun;
    this.#runtimeInputsForPlanRun = dependencies.runtimeInputsForPlanRun;
    this.#runtimeInputMaterializer = dependencies.runtimeInputMaterializer;
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
    credentialRunId: string = auditRunId,
  ): Promise<RunCredentials | undefined> {
    return await this.#mintCredentials(
      planRun,
      phase,
      auditRunId,
      credentialRunId,
    );
  }

  async #mintCredentials(
    planRun: PlanRun,
    phase: "plan" | "apply" | "destroy",
    auditRunId: string,
    credentialRunId: string = auditRunId,
  ): Promise<RunCredentials | undefined> {
    if (planRun.requiredProviders.length === 0) {
      return undefined;
    }
    try {
      if (!planRun.capsuleContext) {
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
      //
      // Narrow to the providers the reviewed plan actually declared before
      // minting: a Capsule keeps one Provider Binding set for every provider it
      // has ever used, so an unnarrowed mint hands a run that needs only
      // `hashicorp/http` the live credentials of every other bound provider.
      // The digest fence above stays on the FULL resolved set — it pins what
      // the reviewer saw, not what this phase materializes.
      const mintable = resolved.filter((entry) =>
        planRun.requiredProviders.some((required) =>
          sameProviderSource(required, entry.provider),
        ),
      );
      const policy = await this.#policyForPlanRun(planRun);
      const connectionPolicyReasons = mintable.flatMap((entry) =>
        evaluateProviderConnectionCredentialPolicy(entry.connection, policy),
      );
      if (connectionPolicyReasons.length > 0) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `credential_policy_failed: ${connectionPolicyReasons[0]}`,
          { reason: CREDENTIAL_POLICY_FAILED_REASON },
        );
      }
      const providerEntries = providerMintEntriesFromResolved(mintable);
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
      // Run-scoped sensitive provider inputs travel on this same dispatch-only
      // bundle. They are minted here, and only here, because this is the one
      // channel that is never persisted and never logged.
      const runtimeInputs = await this.#mintRuntimeInputs(
        planRun,
        phase,
        mintable,
      );
      const bundle = new CredentialBundle({});
      if (providerEntries.length === 0) {
        await this.#recordProviderCredentialMintEvents(
          planRun,
          mintable,
          phase,
          auditRunId,
          bundle.providerCredentialEvidence,
        );
        await this.#assertProviderCredentialPolicy(
          planRun,
          bundle.providerCredentialEvidence,
          providerEntries.length,
          credentialEvidenceProviders,
          policy,
          mintable.map((entry) => entry.connection),
        );
        return {
          env: { ...bundle.env },
          manifest: credentialManifest(mintable),
          ...(runtimeInputs ? { runtimeInputs } : {}),
        };
      }
      const capsuleId = planRun.capsuleContext?.capsuleId ?? planRun.capsuleId;
      const recipeBundle = await vault!.mintForCapsuleProviderBindings(
        planRun.workspaceId,
        providerEntries,
        {
          phase,
          runId: credentialRunId,
          ...(capsuleId ? { capsuleId } : {}),
        },
      );
      const recipeResponse = recipeBundle.toMintResponse();
      // Treat a Vault implementation as an untrusted persistence boundary:
      // validate every evidence row against the exact resolved Connection and
      // all runner-only values before either audit storage or policy evaluation.
      // This is intentionally redundant with the in-process Vault validation so
      // alternate / future Vault implementations cannot persist a raw token.
      const evidence = validatedCredentialEvidenceForPersistence(
        [
          ...bundle.providerCredentialEvidence,
          ...recipeBundle.providerCredentialEvidence,
        ],
        mintable,
        recipeResponse,
      );
      // Vault mint is an external persistence/issuance boundary. Re-read the
      // layered Workspace + InstallConfig policy after it returns so a policy
      // change during issuance cannot turn into credentials handed to the
      // runner under the stale pre-mint snapshot.
      const postMintPolicy = await this.#policyForPlanRun(planRun);
      await this.#assertProviderCredentialPolicy(
        planRun,
        evidence,
        providerEntries.length,
        credentialEvidenceProviders,
        postMintPolicy,
        mintable.map((entry) => entry.connection),
      );
      await this.#recordProviderCredentialMintEvents(
        planRun,
        mintable,
        phase,
        auditRunId,
        evidence,
      );
      const env = { ...bundle.env, ...recipeResponse.env };
      const manifest = credentialManifest(mintable, recipeResponse.files);
      return {
        env,
        ...(recipeResponse.files && recipeResponse.files.length > 0
          ? { files: recipeResponse.files }
          : {}),
        manifest,
        ...(runtimeInputs ? { runtimeInputs } : {}),
      };
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

  /**
   * Mints the Apply-only sensitive map for the single provider instance whose
   * installed recipe declares the protocol.
   *
   * Every failure is fail-closed. In particular the nonce fence: the reviewed
   * generated root baked one nonce, and a provider derives its apply-idempotency
   * identity from it. If the live material generation now derives a different
   * nonce, applying the reviewed plan would silently target a different identity,
   * so the Run stops and asks for a re-plan.
   */
  async #mintRuntimeInputs(
    planRun: PlanRun,
    phase: "plan" | "apply" | "destroy",
    mintable: readonly ResolvedCapsuleProviderBinding[],
  ): Promise<readonly RunCredentialRuntimeInputs[] | undefined> {
    const wiring = runtimeInputWiringFromResolved(mintable);
    if (!wiring) return undefined;
    const descriptors = await this.#runtimeInputsForPlanRun?.(planRun);
    const descriptor = descriptors?.find(
      (entry) => entry.providerInstance === wiring.providerInstance,
    );
    if (!descriptor) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `runtime_inputs_not_reviewed: plan run ${planRun.id} did not wire ` +
          `run-scoped sensitive provider inputs into its generated root; ` +
          `re-plan before apply`,
        { reason: RUNTIME_INPUTS_REQUIRE_GENERATED_ROOT_REASON },
      );
    }
    assertRuntimeInputNames(descriptor.names);
    if (descriptor.variableName !== wiring.variableName) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `runtime_inputs_nonce_changed: plan run ${planRun.id} was reviewed ` +
          `against a different generated-root variable; re-plan before apply`,
        { reason: RUNTIME_INPUTS_NONCE_CHANGED_REASON },
      );
    }
    // A destroy plan's provider teardown never reads the map, and a plan never
    // reads it either. Both still declare the same ephemeral variable, so the
    // runner supplies an empty map to keep plan/apply variable symmetry.
    if (phase !== "apply") {
      return [
        {
          variableName: descriptor.variableName,
          names: [...descriptor.names],
          values: {},
        },
      ];
    }
    const materializer = this.#runtimeInputMaterializer;
    if (!materializer) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "credential_mint_failed: no runtime input materializer is configured for run-scoped sensitive provider inputs",
        { reason: RUNTIME_INPUT_MATERIALIZER_UNAVAILABLE_REASON },
      );
    }
    const capsuleId = planRun.capsuleContext?.capsuleId ?? planRun.capsuleId;
    const capsule = capsuleId
      ? await this.#store.getCapsule(capsuleId)
      : undefined;
    if (!capsule || capsule.workspaceId !== planRun.workspaceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "credential_mint_failed: run-scoped sensitive provider inputs require a current Capsule authority",
        { reason: RUNTIME_INPUT_MATERIALIZER_UNAVAILABLE_REASON },
      );
    }
    const minted = await materializer.materialize({
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      installConfigId: capsule.installConfigId,
      providerInstance: wiring.providerInstance,
      phase: "apply",
    });
    if (minted.nonce !== descriptor.nonce) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `runtime_inputs_nonce_changed: plan run ${planRun.id} was reviewed ` +
          `against a different run-scoped sensitive input generation; ` +
          `re-plan before apply`,
        { reason: RUNTIME_INPUTS_NONCE_CHANGED_REASON },
      );
    }
    const dispatch = minted.toRunnerDispatch();
    if (
      dispatch.profileDigest !== descriptor.profileDigest ||
      !sameNameSet(dispatch.names, descriptor.names)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `runtime_inputs_name_set_changed: the runtime binding profile changed ` +
          `since plan run ${planRun.id} was reviewed; re-plan before apply`,
        { reason: RUNTIME_INPUTS_NAME_SET_CHANGED_REASON },
      );
    }
    assertRuntimeInputValues(dispatch.names, dispatch.values);
    return [
      {
        variableName: descriptor.variableName,
        names: [...descriptor.names],
        values: dispatch.values,
      },
    ];
  }

  async #assertProviderCredentialPolicy(
    planRun: PlanRun,
    evidence: readonly ProviderCredentialMintEvidence[],
    expectedCredentialEvidenceCount = 0,
    credentialEvidenceProviders: readonly string[] = [],
    policy: PolicyConfig | undefined = undefined,
    resolvedConnections: readonly Pick<
      ResolvedCapsuleProviderBinding["connection"],
      "id" | "scope" | "credentialRecipe" | "credentialVerification"
    >[] = [],
  ): Promise<void> {
    const effectivePolicy =
      policy === undefined
        ? await this.#policyForPlanRun(planRun)
        : policy;
    const result = evaluateProviderCredentialMintPolicy(
      evidence,
      effectivePolicy,
      credentialEvidenceProviders,
      expectedCredentialEvidenceCount,
      resolvedConnections,
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

function validatedCredentialEvidenceForPersistence(
  evidence: readonly ProviderCredentialMintEvidence[],
  resolved: readonly ResolvedCapsuleProviderBinding[],
  response: {
    readonly env: Readonly<Record<string, string>>;
    readonly files?: readonly { readonly content: string }[];
  },
): readonly ProviderCredentialMintEvidence[] {
  const sensitiveValues = [
    ...Object.values(response.env),
    ...(response.files ?? []).map((file) => file.content),
  ];
  return Object.freeze(
    evidence.map((item) => {
      const expected = resolved.find(
        (entry) =>
          entry.connection.id === item?.connectionId &&
          entry.connection.provider === item?.provider,
      );
      if (!expected) {
        throw new ConnectionVaultError(
          "failed_precondition",
          "provider credential mint evidence does not match a resolved binding",
          undefined,
          "credential_service_unavailable",
        );
      }
      return validatedProviderCredentialMintEvidence({
        evidence: item,
        connectionId: expected.connection.id,
        provider: expected.connection.provider,
        sensitiveValues,
      });
    }),
  );
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
        ...((entry.rootAlias ?? entry.alias)
          ? { alias: entry.rootAlias ?? entry.alias }
          : {}),
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
      ...((entry.rootAlias ?? entry.alias)
        ? { alias: entry.rootAlias ?? entry.alias }
        : {}),
      connectionId: connection.id,
      ...(entry.runCredentialSettings
        ? { runCredentialSettings: entry.runCredentialSettings }
        : {}),
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

/**
 * Mirrors the provider's own name-set limits inside the control plane so an
 * over-wide profile fails here instead of at the provider.
 */
function assertRuntimeInputNames(names: readonly string[]): void {
  if (names.length === 0 || names.length > RUNTIME_INPUT_MAX_NAMES) {
    throw runtimeInputLimitExceeded(
      `run-scoped sensitive input name count must be 1..${RUNTIME_INPUT_MAX_NAMES}`,
    );
  }
  if (new Set(names).size !== names.length) {
    throw runtimeInputLimitExceeded(
      "run-scoped sensitive input names must be unique",
    );
  }
  for (const name of names) {
    if (!RUNTIME_INPUT_NAME_PATTERN.test(name)) {
      throw runtimeInputLimitExceeded(
        "run-scoped sensitive input name is not an accepted binding name",
      );
    }
  }
}

function assertRuntimeInputValues(
  names: readonly string[],
  values: Readonly<Record<string, string>>,
): void {
  let totalBytes = 0;
  for (const name of names) {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0) {
      throw runtimeInputLimitExceeded(
        "run-scoped sensitive input value is missing",
      );
    }
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > RUNTIME_INPUT_MAX_VALUE_BYTES) {
      throw runtimeInputLimitExceeded(
        `run-scoped sensitive input value exceeds ${RUNTIME_INPUT_MAX_VALUE_BYTES} bytes`,
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > RUNTIME_INPUT_MAX_TOTAL_BYTES) {
    throw runtimeInputLimitExceeded(
      `run-scoped sensitive inputs exceed ${RUNTIME_INPUT_MAX_TOTAL_BYTES} bytes in total`,
    );
  }
}

function runtimeInputLimitExceeded(message: string): OpenTofuControllerError {
  return new OpenTofuControllerError(
    "invalid_argument",
    `runtime_inputs_limit_exceeded: ${message}`,
    { reason: RUNTIME_INPUTS_LIMIT_EXCEEDED_REASON },
  );
}

function sameNameSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((name, index) => name === b[index]);
}
