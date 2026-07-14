/**
 * In-process credential Vault broker (Phase 1A credential core).
 *
 * Users register provider credentials as Connections; the Vault seals the
 * secret values into a per-ProviderConnection blob and, for a run, mints a
 * {@link CredentialBundle} of `{ env }` and runner-only files for the Run
 * dispatch path. The Run credential broker invokes this boundary for
 * source/plan/apply/destroy phases.
 *
 * Security invariants:
 *   - Secret values are write-only: they enter via `register` and leave only
 *     through `CredentialBundle.env` on the dispatch path. They are NEVER
 *     serialized into logs — the bundle's `toJSON` / `inspect` / `toString`
 *     return the opaque marker `"[credential-bundle]"`.
 *   - Env/file names are validated against the explicitly selected installed
 *     Credential Recipe; provider names never select credential material.
 *   - The secret blob is sealed with the opaque partition declared by the
 *     selected Credential Recipe. Provider names never choose partitions.
 */

import type {
  ProviderConnection,
  ConnectionScopeHints,
  CreateConnectionRequest,
} from "@takosumi/internal/deploy-control-api";
import {
  GIT_HTTPS_TOKEN_ENV,
  GIT_SSH_PRIVATE_KEY_ENV,
  type MintPhase,
  type MintedFile,
  type MintResponse,
  type SourceGitConnectionKind,
} from "takosumi-contract/sources";
import {
  canonicalProviderSource,
  sameProviderSource,
} from "takosumi-contract/provider-env-rules";
import {
  isPublicManagedProviderConnection,
  managedProviderProfile,
} from "takosumi-contract/connections";
import type { CredentialRecipe } from "takosumi-contract";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import {
  credentialRecipeDriverKey,
  type CredentialRecipeDriverRegistry,
  type CredentialRecipeRuntimeDriver,
} from "@takosumi/providers";
import { mintGitSourceCredential } from "@takosumi/providers/git/credentials.ts";
import { gitProviderSettings } from "@takosumi/providers/git/settings.ts";
import {
  DeclaredEnvRegistrationError,
  validateDeclaredEnvRegistration,
} from "./declared_env_registration.ts";
import { verifyDriverForConnection } from "./verify_drivers.ts";
import type {
  OpenTofuControlStore,
  StoredSecretBlob,
} from "../../domains/deploy-control/store.ts";
import type { SecretBoundaryCrypto } from "../secret-store/memory.ts";
import type { SecretPartition } from "../secret-store/types.ts";

const CREDENTIAL_BUNDLE_MARKER = "[credential-bundle]";
/**
 * AAD workspaceId label for operator-scoped connections (spec §8): they have no
 * owning Workspace, so their sealed blobs bind to this fixed partition label.
 */
const OPERATOR_SCOPE_AAD = "__operator__";
const SECRET_BLOB_KEY_SCHEME = "secret-boundary-aes-gcm/v1";

/**
 * Opaque carrier for minted credential env vars. The plaintext env is reachable
 * ONLY through the `env` getter (used by the dispatch path). Every serialization
 * seam (`JSON.stringify`, Node `util.inspect`, template strings, `console.log`
 * object inspection) collapses to {@link CREDENTIAL_BUNDLE_MARKER} so the values
 * cannot leak into logs.
 */
export class CredentialBundle {
  readonly #env: Readonly<Record<string, string>>;
  readonly #providerCredentialEvidence: readonly ProviderCredentialMintEvidence[];
  /** Non-secret warnings from the dispatch path. Never contains values. */
  readonly warnings: readonly string[];

  constructor(
    env: Readonly<Record<string, string>>,
    warnings: readonly string[] = [],
    providerCredentialEvidence: readonly ProviderCredentialMintEvidence[] = [],
  ) {
    this.#env = Object.freeze({ ...env });
    this.warnings = Object.freeze([...warnings]);
    this.#providerCredentialEvidence = Object.freeze([
      ...providerCredentialEvidence,
    ]);
  }

  /** Decrypted env vars. Dispatch-path only — do not log the result. */
  get env(): Readonly<Record<string, string>> {
    return this.#env;
  }

  get providerCredentialEvidence(): readonly ProviderCredentialMintEvidence[] {
    return this.#providerCredentialEvidence;
  }

  toJSON(): string {
    return CREDENTIAL_BUNDLE_MARKER;
  }

  toString(): string {
    return CREDENTIAL_BUNDLE_MARKER;
  }

  // Node's util.inspect custom hook so console.log(bundle) never prints values.
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return CREDENTIAL_BUNDLE_MARKER;
  }
}

export type RegisterConnectionInput = CreateConnectionRequest;

export interface ManagedProviderCredentialIssueRequest {
  readonly workspaceId: string;
  readonly capsuleId?: string;
  /** Exact service-side profile selected by the Provider Connection. */
  readonly managedProviderProfile: string;
  readonly connection: ProviderConnection;
  readonly phase?: MintPhase;
}

export interface ManagedProviderCredentialIssueResult {
  readonly values: Readonly<Record<string, string>>;
  readonly issuer: NonNullable<ProviderCredentialMintEvidence["issuer"]>;
  readonly temporary: boolean;
  readonly expiresAt?: string;
  readonly ttlSeconds?: number;
  readonly secretValueStored?: false;
}

export type ManagedProviderCredentialIssuer = (
  request: ManagedProviderCredentialIssueRequest,
) =>
  | ManagedProviderCredentialIssueResult
  | undefined
  | Promise<ManagedProviderCredentialIssueResult | undefined>;

function workspaceIdForConnectionInput(
  input: RegisterConnectionInput,
): string | undefined {
  return input.workspaceId;
}

export interface TestConnectionResult {
  readonly status: "verified" | "pending" | "expired";
  readonly detail?: string;
}

/**
 * Typed Vault error. Carries an error code aligned with the deploy-control error
 * codes and, for env-validation failures, the missing required env groups (no
 * values, ever).
 */
export class ConnectionVaultError extends Error {
  readonly code:
    | "invalid_argument"
    | "not_found"
    | "failed_precondition"
    | "not_implemented";
  readonly missingEnvGroups?: readonly (readonly string[])[];
  /** Stable semantic reason forwarded to Run diagnostics; never inferred from message. */
  readonly reason?: string;

  constructor(
    code: ConnectionVaultError["code"],
    message: string,
    missingEnvGroups?: readonly (readonly string[])[],
    reason?: string,
  ) {
    super(message);
    this.name = "ConnectionVaultError";
    this.code = code;
    if (missingEnvGroups) this.missingEnvGroups = missingEnvGroups;
    if (reason) this.reason = reason;
  }
}

/**
 * A per-phase mint request (spec §8.3 / §8.4). The vault enforces the phase
 * rules IN the vault:
 *   - `source`  -> ONLY git-kind connections; returns env + files.
 *   - `build`   -> ALWAYS empty; error if any connection / provider is asked for.
 *   - `plan` / `apply` / `destroy` -> ONLY provider env bindings; git excluded.
 */
export interface MintRequest {
  readonly workspaceId: string;
  readonly phase: MintPhase;
  /** Explicit provider source addresses for the OpenTofu phases. */
  readonly providers?: readonly string[];
  /**
   * The git source ProviderConnection id to mint for the `source` phase. None for a
   * public repo (the source phase then returns an empty bundle).
   */
  readonly sourceConnectionId?: string;
  /**
   * Provider-binding connection pool for the tofu phases (spec §9). When
   * present, provider selection draws ONLY from these connections (each must
   * be operator-scoped or belong to the Workspace); when absent, the
   * Workspace-wide pool applies. The vault re-validates each id — caller claims
   * are never trusted.
   */
  readonly connectionIds?: readonly string[];
}

/** One provider env binding credential mint entry. */
export interface CapsuleProviderBindingMintEntry {
  /** Explicit provider source address selected by the Provider Binding. */
  readonly provider: string;
  /** Optional OpenTofu provider alias declared by the generated root. */
  readonly alias?: string;
  /** The ProviderConnection this provider env binding resolved to. */
  readonly connectionId: string;
}

export interface CapsuleProviderBindingMintOptions {
  readonly phase?: MintPhase;
  readonly capsuleId?: string;
}

export interface ConnectionVault {
  register(input: RegisterConnectionInput): Promise<ProviderConnection>;
  test(connectionId: string): Promise<TestConnectionResult>;
  revoke(id: string): Promise<boolean>;
  /**
   * Mints a {@link CredentialBundle} of env vars for the given providers within
   * a Workspace. Only verified connections may mint. This is the default
   * provider-mint helper for plan/apply callers; it is equivalent to
   * `mintForPhase({ phase: "plan", providers })`.
   */
  mint(
    workspaceId: string,
    providers: readonly string[],
    options?: { readonly connectionIds?: readonly string[] },
  ): Promise<CredentialBundle>;
  /**
   * Per-phase mint (spec §8.3 / §8.4). Enforces the phase rules in the vault and
   * returns a {@link MintResponse} carrying env plus any runner-only credential
   * files required by that phase.
   * The result is wrapped so callers can attach it to a runner dispatch only.
   */
  mintForPhase(request: MintRequest): Promise<PhaseMintBundle>;
  /**
   * Per-connection credential mint. For each provider env binding entry the
   * vault re-validates the id (existence + Workspace ownership, like
   * {@link MintRequest.connectionIds}), opens the connection's sealed values, and
   * materializes its Credential Recipe as run-scoped process env and/or files.
   * Built-in and user-declared recipes use the same path and keep their declared
   * env names (for example `CLOUDFLARE_API_TOKEN` or `SNOWFLAKE_PASSWORD`).
   * Phase rule: tofu phases only (plan / apply / destroy). The returned bundle
   * carries runner-dispatch env only and is never serialized into logs.
   */
  mintForCapsuleProviderBindings(
    workspaceId: string,
    entries: readonly CapsuleProviderBindingMintEntry[],
    options?: CapsuleProviderBindingMintOptions,
  ): Promise<PhaseMintBundle>;
}

/**
 * Opaque carrier for a per-phase mint result (env + files). Like
 * {@link CredentialBundle}, every serialization seam collapses to a marker so the
 * values cannot leak into logs.
 */
export class PhaseMintBundle {
  readonly #env: Readonly<Record<string, string>>;
  readonly #files: readonly MintedFileInternal[];
  readonly #providerCredentialEvidence: readonly ProviderCredentialMintEvidence[];
  readonly warnings: readonly string[];

  constructor(
    response: MintResponse,
    warnings: readonly string[] = [],
    providerCredentialEvidence: readonly ProviderCredentialMintEvidence[] = [],
  ) {
    this.#env = Object.freeze({ ...response.env });
    this.#files = Object.freeze(
      (response.files ?? []).map((f) => Object.freeze({ ...f })),
    );
    this.warnings = Object.freeze([...warnings]);
    this.#providerCredentialEvidence = Object.freeze([
      ...providerCredentialEvidence,
    ]);
  }

  /** Decrypted env vars. Dispatch-path only — do not log the result. */
  get env(): Readonly<Record<string, string>> {
    return this.#env;
  }

  /** Materialized credential files. Dispatch-path only. */
  get files(): readonly MintedFileInternal[] {
    return this.#files;
  }

  get providerCredentialEvidence(): readonly ProviderCredentialMintEvidence[] {
    return this.#providerCredentialEvidence;
  }

  /** Plain {@link MintResponse} for the dispatch payload. Do not log. */
  toMintResponse(): MintResponse {
    return this.#files.length > 0
      ? { env: this.#env, files: this.#files.map((f) => ({ ...f })) }
      : { env: this.#env };
  }

  toJSON(): string {
    return CREDENTIAL_BUNDLE_MARKER;
  }

  toString(): string {
    return CREDENTIAL_BUNDLE_MARKER;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return CREDENTIAL_BUNDLE_MARKER;
  }
}

interface MintedFileInternal {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
  readonly envName?: string;
}

interface MintedProviderValues {
  readonly values: Readonly<Record<string, string>>;
  readonly evidence: ProviderCredentialMintEvidence;
  readonly files?: readonly MintedFile[];
}

interface ProviderSecretMaterial {
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly MintedFile[];
}

/** Injected fetch implementation so `test()` is unit-testable without real network. */
export type VaultFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface StaticSecretConnectionVaultDependencies {
  readonly store: OpenTofuControlStore;
  readonly crypto: SecretBoundaryCrypto;
  readonly fetch?: VaultFetch;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly managedProviderCredentialIssuer?: ManagedProviderCredentialIssuer;
  /**
   * Complete installed recipe lookup. When omitted, no recipes are installed;
   * unknown recipe ids always fail closed.
   */
  readonly credentialRecipeResolver?: (
    id: string,
  ) => CredentialRecipe | undefined;
  readonly credentialDrivers?: CredentialRecipeDriverRegistry;
}

export class StaticSecretConnectionVault implements ConnectionVault {
  readonly #store: OpenTofuControlStore;
  readonly #crypto: SecretBoundaryCrypto;
  readonly #fetch: VaultFetch;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #managedProviderCredentialIssuer?: ManagedProviderCredentialIssuer;
  readonly #credentialRecipeResolver: (
    id: string,
  ) => CredentialRecipe | undefined;
  readonly #credentialDrivers: CredentialRecipeDriverRegistry;

  constructor(deps: StaticSecretConnectionVaultDependencies) {
    this.#store = deps.store;
    this.#crypto = deps.crypto;
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? defaultConnectionId;
    this.#managedProviderCredentialIssuer =
      deps.managedProviderCredentialIssuer;
    // An omitted catalog means no provider recipe is installed. The Vault must
    // never turn a bundled discovery asset into admission authority.
    this.#credentialRecipeResolver =
      deps.credentialRecipeResolver ?? (() => undefined);
    this.#credentialDrivers = deps.credentialDrivers ?? {};
  }

  async register(input: RegisterConnectionInput): Promise<ProviderConnection> {
    const workspaceId = workspaceIdForConnectionInput(input);
    // workspaceId is absent for a global helper connection; when
    // present it must be a real id.
    if (workspaceId !== undefined || input.scope === "workspace") {
      requireNonEmpty(workspaceId, "workspaceId");
    }
    // Privilege-escalation guard: a global helper connection has NO owning
    // Workspace, so a caller-supplied `scope: "operator"` must never win against a
    // present workspaceId. A hybrid `{ workspaceId, scope: "operator" }` row would
    // otherwise bypass the `scope === "workspace" && workspaceId mismatch` cross-tenant
    // guard at mint time, letting any Workspace bind another Workspace's secret.
    if (workspaceId !== undefined && input.scope === "operator") {
      throw new ConnectionVaultError(
        "invalid_argument",
        "operator-scoped connections must not have an owning Workspace (omit workspaceId for scope: operator)",
      );
    }
    if (isSourceGitKind(input.kind)) {
      return await this.#registerGitConnection(input, input.kind);
    }
    requireNonEmpty(input.provider, "provider");
    if (
      input.materialization !== undefined &&
      !isSecretPartitionToken(input.materialization)
    ) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "materialization must be a non-blank audit label without whitespace",
      );
    }
    const requestedRecipe = normalizeCredentialRecipe(input);
    if (!requestedRecipe) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "credentialRecipe is required for new Provider Connections",
      );
    }
    const recipeDefinition = this.#credentialRecipeResolver(requestedRecipe.id);
    if (!recipeDefinition) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `credential recipe ${requestedRecipe.id} is not installed`,
      );
    }
    const recipeMode = recipeDefinition.authModes[requestedRecipe.authMode];
    if (!recipeMode) {
      throw new ConnectionVaultError(
        "invalid_argument",
        `credential recipe ${requestedRecipe.id} has no auth mode ${requestedRecipe.authMode}`,
      );
    }
    if (
      recipeDefinition.terraformSource !== "*" &&
      !recipeDefinition.terraformSource.some((source) =>
        sameProviderSource(source, input.provider),
      )
    ) {
      throw new ConnectionVaultError(
        "invalid_argument",
        `credential recipe ${requestedRecipe.id} does not declare provider source ${input.provider}`,
      );
    }
    const declaredEnvRegistration =
      recipeDefinition.declaredEnv === true
        ? validateDeclaredEnvInput(input)
        : undefined;
    if (!declaredEnvRegistration && input.files && input.files.length > 0) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "provider credential files require an installed declared-env recipe",
      );
    }
    const values = declaredEnvRegistration?.values ?? input.values;
    if (
      values === null ||
      typeof values !== "object" ||
      Array.isArray(values)
    ) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "values must be an object of { envName: value }",
      );
    }
    const valueEnvNames = Object.keys(values);
    const envNames = declaredEnvRegistration?.envNames ?? valueEnvNames;
    if (envNames.length === 0) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "values must supply at least one env name",
      );
    }
    const allowed = new Set(
      declaredEnvRegistration
        ? declaredEnvRegistration.envNames
        : (recipeDefinition.envNames ?? []),
    );
    for (const envName of valueEnvNames) {
      if (!allowed.has(envName)) {
        throw new ConnectionVaultError(
          "invalid_argument",
          `env name ${envName} is not allowed for provider ${input.provider}`,
        );
      }
      if (typeof values[envName] !== "string") {
        throw new ConnectionVaultError(
          "invalid_argument",
          `value for ${envName} must be a string`,
        );
      }
    }
    if (
      !declaredEnvRegistration &&
      !requiredRecipeGroupsSatisfied(
        recipeDefinition.requiredEnvGroups ?? [],
        valueEnvNames,
      )
    ) {
      throw new ConnectionVaultError(
        "invalid_argument",
        `provider ${input.provider} requires one of these env-name groups`,
        recipeDefinition.requiredEnvGroups ?? [],
      );
    }

    const credentialRecipe: NonNullable<
      ProviderConnection["credentialRecipe"]
    > = {
      id: requestedRecipe.id,
      authMode: requestedRecipe.authMode,
      ...(requestedRecipe.secretPartition
        ? { secretPartition: requestedRecipe.secretPartition }
        : {}),
      envNames: [...envNames].sort(),
      fileEnvNames: [...(declaredEnvRegistration?.fileEnvNames ?? [])].sort(),
      requiredEnvGroups: (recipeDefinition.requiredEnvGroups ?? []).map(
        (group) => [...group],
      ),
      ...(recipeDefinition.declaredEnv === true ? { declaredEnv: true } : {}),
      ...(recipeMode.preRun ? { preRunAction: recipeMode.preRun.type } : {}),
    };

    // Validate every non-secret field before sealing or persisting credential
    // material. In particular, provider configuration and module defaults are
    // public connection metadata and must never become an alternate secret
    // transport around Credential Recipes.
    const scopeHints = normalizeScope(input.scopeHints);
    const connectionScope =
      input.scope ?? (workspaceId ? "workspace" : "operator");
    assertManagedProviderOperatorOwnership(
      scopeHints,
      workspaceId,
      connectionScope,
    );
    const now = this.#now();
    const expiresAt = normalizeConnectionExpiresAt(input.expiresAt, now);
    const id = this.#newId();
    const secretPartition = secretPartitionForRegistration(credentialRecipe);
    const secretMaterial = declaredEnvRegistration
      ? {
          env: values,
          files: declaredEnvRegistration.files,
        }
      : values;
    const sealed = await this.#crypto.seal(
      JSON.stringify(secretMaterial),
      secretPartition,
      secretEnvelopeAad({
        secretPartition,
        ...(workspaceId ? { workspaceId: workspaceId } : {}),
        connectionId: id,
        provider: input.provider,
      }),
    );
    const nowIso = now.toISOString();
    const blob = makeStoredSecretBlob({
      connectionId: id,
      ...(workspaceId ? { workspaceId: workspaceId } : {}),
      provider: input.provider,
      sealed,
      secretPartition,
      createdAt: nowIso,
      crypto: this.#crypto,
    });
    await this.#store.putSecretBlob(blob);

    const connection: ProviderConnection = {
      id,
      ...(workspaceId ? { workspaceId } : {}),
      provider: input.provider,
      providerSource: canonicalProviderSource(input.provider),
      credentialRecipe,
      secretPartition,
      scope: connectionScope,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "pending",
      materialization: input.materialization ?? "secret",
      ...(scopeHints ? { scopeHints } : {}),
      envNames: [...envNames].sort(),
      ...(declaredEnvRegistration &&
      declaredEnvRegistration.fileEnvNames.length > 0
        ? { fileEnvNames: declaredEnvRegistration.fileEnvNames }
        : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(expiresAt ? { expiresAt } : {}),
    };
    await this.#store.putConnection(connection);
    return connection;
  }

  /**
   * Registers a git source credential (`source_git_https_token` /
   * `source_git_ssh_key`). The value shape and required scope are enforced here:
   *   - https token: `values.GIT_HTTPS_TOKEN` (string, non-empty). Optional
   *     `scope.username`.
   *   - ssh key: `values.GIT_SSH_PRIVATE_KEY` (string, non-empty). REQUIRES
   *     `scope.knownHostsEntry` so the runner can pin the host key
   *     (StrictHostKeyChecking=yes always; =no is forbidden).
   *
   * Git connections are sealed under the explicit `source:git` partition and
   * recorded with `kind` so the mint phase rules can exclude
   * them from the tofu phases.
   */
  async #registerGitConnection(
    input: RegisterConnectionInput,
    kind: SourceGitConnectionKind,
  ): Promise<ProviderConnection> {
    const workspaceId = workspaceIdForConnectionInput(input);
    const values = input.values;
    if (
      values === null ||
      typeof values !== "object" ||
      Array.isArray(values)
    ) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "values must be an object of { envName: value }",
      );
    }
    const expectedEnv =
      kind === "source_git_https_token"
        ? GIT_HTTPS_TOKEN_ENV
        : GIT_SSH_PRIVATE_KEY_ENV;
    const envNames = Object.keys(values);
    if (envNames.length !== 1 || envNames[0] !== expectedEnv) {
      throw new ConnectionVaultError(
        "invalid_argument",
        `${kind} requires exactly one value: ${expectedEnv}`,
      );
    }
    if (
      typeof values[expectedEnv] !== "string" ||
      values[expectedEnv].length === 0
    ) {
      throw new ConnectionVaultError(
        "invalid_argument",
        `value for ${expectedEnv} must be a non-empty string`,
      );
    }
    const scopeHints = normalizeScope(input.scopeHints);
    const connectionScope =
      input.scope ?? (workspaceId ? "workspace" : "operator");
    assertManagedProviderOperatorOwnership(
      scopeHints,
      workspaceId,
      connectionScope,
    );
    if (kind === "source_git_ssh_key") {
      if (!gitProviderSettings(scopeHints).knownHostsEntry) {
        throw new ConnectionVaultError(
          "invalid_argument",
          "source_git_ssh_key requires scopeHints.providerSettings.knownHostsEntry (the known_hosts line for the host)",
        );
      }
    }

    const now = this.#now();
    const expiresAt = normalizeConnectionExpiresAt(input.expiresAt, now);
    const id = this.#newId();
    const secretPartition: SecretPartition = "source:git";
    // A git connection stores `provider: kind`, so the AAD binds to `kind` to
    // match the open-time derivation in `connectionEnvelopeAad`.
    const sealed = await this.#crypto.seal(
      JSON.stringify(values),
      secretPartition,
      secretEnvelopeAad({
        secretPartition,
        ...(workspaceId ? { workspaceId: workspaceId } : {}),
        connectionId: id,
        provider: kind,
      }),
    );
    const nowIso = now.toISOString();
    const blob = makeStoredSecretBlob({
      connectionId: id,
      ...(workspaceId ? { workspaceId: workspaceId } : {}),
      provider: kind,
      sealed,
      secretPartition,
      createdAt: nowIso,
      crypto: this.#crypto,
    });
    await this.#store.putSecretBlob(blob);

    const connection: ProviderConnection = {
      id,
      ...(workspaceId ? { workspaceId } : {}),
      provider: kind,
      providerSource: canonicalProviderSource(kind),
      secretPartition,
      kind,
      scope: connectionScope,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "pending",
      materialization: "secret",
      ...(scopeHints ? { scopeHints } : {}),
      envNames: [expectedEnv],
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(expiresAt ? { expiresAt } : {}),
    };
    await this.#store.putConnection(connection);
    return connection;
  }

  async test(connectionId: string): Promise<TestConnectionResult> {
    const connection = await this.#requireConnection(connectionId);
    if (connection.status === "revoked") {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connectionId} is revoked`,
      );
    }
    if (connectionIsExpired(connection, this.#now())) {
      await this.#markConnectionExpired(connection);
      return {
        status: "expired",
        detail: `connection ${connectionId} expired at ${connection.expiresAt}`,
      };
    }
    const material = await this.#openProviderSecretMaterial(connection);
    const values = material.env;
    let verified: { readonly ok: boolean; readonly detail?: string };
    if (isSourceGitKind(connection.kind)) {
      // Git is the v1 Source transport, so its HTTPS/SSH verification stays in
      // the Source credential path. OpenTofu providers use only the explicitly
      // installed Credential Recipe driver below.
      const driver = verifyDriverForConnection(connection);
      if (!driver) {
        return {
          status: "pending",
          detail: `no verification driver is configured for connection kind ${connection.kind ?? "(unknown)"} (provider ${connection.provider})`,
        };
      }
      verified = await driver({ connection, values, fetch: this.#fetch });
    } else {
      const driver = this.#credentialDriver(connection);
      if (!driver?.verify) {
        if (connection.credentialRecipe?.preRunAction && !driver?.mint) {
          return {
            status: "pending",
            detail: `no mint driver is installed for pre-run credential recipe ${recipeLabel(connection)}`,
          };
        }
        verified = verifyStaticCredentialMaterial(connection, material);
      } else {
        verified = await driver.verify({
          connection,
          values,
          files: material.files,
          fetch: this.#fetch,
          now: this.#now,
          staticEvidence: () =>
            staticCredentialEvidence(connection, this.#now()),
        });
      }
    }
    if (!verified.ok) {
      return { status: "pending", detail: verified.detail };
    }
    const verifiedAtIso = this.#now().toISOString();
    const verifiedConnection: ProviderConnection = {
      ...connection,
      status: "verified",
      verifiedAt: verifiedAtIso,
      updatedAt: verifiedAtIso,
    };
    await this.#store.putConnection(verifiedConnection);
    return { status: "verified" };
  }

  async revoke(id: string): Promise<boolean> {
    const existed = await this.#store.getConnection(id);
    await this.#store.deleteSecretBlob(id);
    const deleted = await this.#store.deleteConnection(id);
    return deleted || existed !== undefined;
  }

  async mint(
    workspaceId: string,
    providers: readonly string[],
    options?: { readonly connectionIds?: readonly string[] },
  ): Promise<CredentialBundle> {
    requireNonEmpty(workspaceId, "workspaceId");
    const connections =
      options?.connectionIds !== undefined
        ? await this.#connectionPool(workspaceId, options.connectionIds)
        : await this.#store.listConnections(workspaceId);
    const env: Record<string, string> = {};
    const evidence: ProviderCredentialMintEvidence[] = [];
    for (const provider of providers) {
      const match = selectConnectionForProvider(
        connections,
        provider,
        this.#now(),
      );
      if (!match) {
        throw new ConnectionVaultError(
          "not_found",
          `no connection registered for provider ${provider} in Workspace ${workspaceId}`,
          [],
        );
      }
      assertConnectionVerifiedUnlessManagedProvider(match);
      const minted =
        (await this.#mintManagedProviderValues(workspaceId, match, {})) ??
        (await this.#mintProviderValues(match));
      evidence.push(minted.evidence);
      for (const [name, value] of Object.entries(minted.values)) {
        env[name] = value;
      }
    }
    return new CredentialBundle(env, [], evidence);
  }

  /**
   * Per-connection credential mint. See {@link ConnectionVault.mintForCapsuleProviderBindings}.
   * Re-validates each connection id (existence + Workspace ownership) before opening
   * any value, so a caller can never mint a connection from another Workspace.
   * Every CredentialRecipe returns its declared process env and runner-only
   * credential files; the vault never infers provider HCL arguments.
   */
  async mintForCapsuleProviderBindings(
    workspaceId: string,
    entries: readonly CapsuleProviderBindingMintEntry[],
    options?: CapsuleProviderBindingMintOptions,
  ): Promise<PhaseMintBundle> {
    requireNonEmpty(workspaceId, "workspaceId");
    // Phase rule: provider credentials are tofu-phase only. A source /
    // build phase must never request provider credentials (invariants 3-5).
    const phase = options?.phase;
    if (
      phase !== undefined &&
      phase !== "plan" &&
      phase !== "apply" &&
      phase !== "destroy"
    ) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `mintForCapsuleProviderBindings is tofu-phase only; ${phase} phase must not request provider credentials`,
      );
    }
    const env: Record<string, string> = {};
    const files: MintedFileInternal[] = [];
    const evidence: ProviderCredentialMintEvidence[] = [];
    for (const entry of entries) {
      requireNonEmpty(entry.provider, "provider");
      requireNonEmpty(entry.connectionId, "connectionId");
      // Re-validate the id like #connectionPool: existence + Workspace ownership.
      const connection = await this.#store.getConnection(entry.connectionId);
      if (!connection) {
        throw new ConnectionVaultError(
          "not_found",
          `connection ${entry.connectionId} not found`,
          undefined,
          "provider_connection_setup_required",
        );
      }
      if (
        connection.scope === "workspace" &&
        connection.workspaceId !== workspaceId
      ) {
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${entry.connectionId} belongs to another Workspace`,
          undefined,
          "provider_connection_setup_required",
        );
      }
      if (isSourceGitKind(connection.kind)) {
        // A git connection is never a provider alias credential (invariants 4/5).
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${entry.connectionId} is a git source connection and cannot back a provider env binding`,
          undefined,
          "provider_connection_setup_required",
        );
      }
      if (!sameProviderSource(entry.provider, connection.providerSource)) {
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${entry.connectionId} provider ${connection.provider} does not match CapsuleProviderEnvBinding provider ${entry.provider}`,
          undefined,
          "provider_connection_setup_required",
        );
      }
      assertConnectionVerifiedUnlessManagedProvider(connection);
      const minted =
        (await this.#mintManagedProviderValues(workspaceId, connection, {
          phase,
          ...(options?.capsuleId ? { capsuleId: options.capsuleId } : {}),
        })) ?? (await this.#mintProviderValues(connection));
      evidence.push(minted.evidence);
      mergeCredentialEnv(env, minted.values, entry);
      if (minted.files) files.push(...minted.files);
    }
    return new PhaseMintBundle(
      { env, ...(files.length > 0 ? { files } : {}) },
      [],
      evidence,
    );
  }

  async #mintManagedProviderValues(
    workspaceId: string,
    connection: ProviderConnection,
    options: {
      readonly capsuleId?: string;
      readonly phase?: MintPhase;
    },
  ): Promise<MintedProviderValues | undefined> {
    if (connection.scopeHints?.managedProvider !== true) return undefined;
    if (!isPublicManagedProviderConnection(connection)) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `managed provider connection ${connection.id} requires explicit operator ownership and a managedProviderProfile`,
        undefined,
        "credential_service_unavailable",
      );
    }
    const profile = managedProviderProfile(connection.scopeHints);
    if (!profile) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `managed provider connection ${connection.id} requires an explicit managedProviderProfile`,
        undefined,
        "credential_service_unavailable",
      );
    }
    const issuer = this.#managedProviderCredentialIssuer;
    if (!issuer) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `managed provider connection ${connection.id} requires a managed provider credential issuer`,
        undefined,
        "credential_service_unavailable",
      );
    }
    const issued = await issuer({
      workspaceId,
      ...(options.capsuleId ? { capsuleId: options.capsuleId } : {}),
      managedProviderProfile: profile,
      connection,
      ...(options.phase ? { phase: options.phase } : {}),
    });
    if (!issued) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `managed provider connection ${connection.id} could not mint a run-scoped provider token`,
        undefined,
        "credential_service_unavailable",
      );
    }
    return {
      values: issued.values,
      evidence: {
        connectionId: connection.id,
        provider: connection.provider,
        temporary: issued.temporary,
        ttlEnforced: issued.ttlSeconds !== undefined && issued.ttlSeconds > 0,
        ...(issued.expiresAt ? { expiresAt: issued.expiresAt } : {}),
        ...(issued.ttlSeconds !== undefined && issued.ttlSeconds > 0
          ? { ttlSeconds: issued.ttlSeconds }
          : {}),
        issuer: issued.issuer,
        ...(issued.secretValueStored === false
          ? { secretValueStored: false }
          : {}),
      },
    };
  }

  /**
   * Builds the provider-connection-resolved connection pool for a tofu-phase mint. Each
   * id is re-read from the store; a space-scoped connection must belong to the
   * requesting space and an operator-scoped one is instance-wide. Unknown ids
   * fail closed.
   */
  async #connectionPool(
    workspaceId: string,
    connectionIds: readonly string[],
  ): Promise<readonly ProviderConnection[]> {
    const pool: ProviderConnection[] = [];
    for (const id of connectionIds) {
      const connection = await this.#store.getConnection(id);
      if (!connection) {
        throw new ConnectionVaultError(
          "not_found",
          `connection ${id} not found`,
        );
      }
      if (
        connection.scope === "workspace" &&
        connection.workspaceId !== workspaceId
      ) {
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${id} belongs to another Workspace`,
        );
      }
      if (connectionIsExpired(connection, this.#now())) {
        await this.#markConnectionExpired(connection);
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${id} expired at ${connection.expiresAt}`,
        );
      }
      pool.push(connection);
    }
    return pool;
  }

  /**
   * Per-phase mint (spec §8.3 / §8.4). Enforces the phase rules IN the vault:
   *
   *   1. `source`  + provider asked -> rejected (source phase is git-only).
   *   2. `source`  + git connection -> env + files (askpass / ssh key file).
   *   3. `source`  + no connection (public repo) -> empty bundle.
   *   4. `build`   + anything asked -> rejected (build NEVER gets credentials).
   *   5. `build`   + nothing asked -> empty bundle.
   *   6. `plan`    + providers      -> provider env only (git excluded).
   *   7. `apply`   + providers      -> provider env only (git excluded).
   *   8. `destroy` + providers      -> provider env only (git excluded).
   *
   * A git connection is NEVER minted for a tofu phase, and a provider env binding
   * is NEVER minted for the source phase.
   */
  async mintForPhase(request: MintRequest): Promise<PhaseMintBundle> {
    requireNonEmpty(request.workspaceId, "workspaceId");
    const phase = request.phase;

    if (phase === "build") {
      // Rule 4/5: the build phase gets NO credentials, ever.
      if (
        (request.providers && request.providers.length > 0) ||
        request.sourceConnectionId
      ) {
        throw new ConnectionVaultError(
          "failed_precondition",
          "build phase must not request any credentials",
        );
      }
      return new PhaseMintBundle({ env: {} });
    }

    if (phase === "source") {
      // Rule 1: the source phase is git-only; providers are forbidden.
      if (request.providers && request.providers.length > 0) {
        throw new ConnectionVaultError(
          "failed_precondition",
          "source phase must not request provider credentials",
        );
      }
      // Rule 3: public repo (no connection) -> empty.
      if (!request.sourceConnectionId) {
        return new PhaseMintBundle({ env: {} });
      }
      // Rule 2: git connection -> env + files.
      return await this.#mintSourceGit(
        request.workspaceId,
        request.sourceConnectionId,
      );
    }

    // Rules 6/7/8: plan / apply / destroy -> provider-only.
    const providers = request.providers ?? [];
    if (request.sourceConnectionId) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `${phase} phase must not request a git source connection`,
      );
    }
    const bundle = await this.mint(request.workspaceId, providers, {
      ...(request.connectionIds !== undefined
        ? { connectionIds: request.connectionIds }
        : {}),
    });
    return new PhaseMintBundle(
      { env: bundle.env },
      bundle.warnings,
      bundle.providerCredentialEvidence,
    );
  }

  /**
   * Mints a git source credential for the source phase. Verifies the connection
   * is a git kind in the right space, opens the sealed value, and returns the
   * runner-facing files: an askpass script (HTTPS) or the ssh key file plus
   * pinned known_hosts (SSH; StrictHostKeyChecking=yes is constructed by the
   * runner after materializing files into its per-run credential directory).
   */
  async #mintSourceGit(
    workspaceId: string,
    connectionId: string,
  ): Promise<PhaseMintBundle> {
    const connection = await this.#requireConnection(connectionId);
    if (
      connection.scope === "workspace" &&
      connection.workspaceId !== workspaceId
    ) {
      throw new ConnectionVaultError(
        "not_found",
        "connection not found in this workspace",
      );
    }
    if (connection.status === "revoked") {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connectionId} is revoked`,
      );
    }
    if (connectionIsExpired(connection, this.#now())) {
      await this.#markConnectionExpired(connection);
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connectionId} expired at ${connection.expiresAt}`,
      );
    }
    if (!isSourceGitKind(connection.kind)) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connectionId} is not a git source connection`,
      );
    }
    assertConnectionVerified(connection);
    const values = await this.#openValues(connection);

    // The git source driver (`@takosumi/providers/git`) turns the opened secret
    // values + the connection context into the runner-facing askpass / ssh key
    // files. Crypto / connection-state validation stayed in core above; the
    // driver's typed error is mapped onto the Vault's stable
    // `failed_precondition` surface.
    try {
      const settings = gitProviderSettings(connection.scopeHints);
      const response = mintGitSourceCredential(values, {
        connectionId,
        kind: connection.kind,
        ...(settings.username ? { username: settings.username } : {}),
        ...(settings.knownHostsEntry
          ? { knownHostsEntry: settings.knownHostsEntry }
          : {}),
      });
      return new PhaseMintBundle(response, []);
    } catch (error) {
      throw wrapDriverError(error);
    }
  }

  async #requireConnection(id: string): Promise<ProviderConnection> {
    const connection = await this.#store.getConnection(id);
    if (!connection) {
      throw new ConnectionVaultError("not_found", `connection ${id} not found`);
    }
    return connection;
  }

  async #markConnectionExpired(connection: ProviderConnection): Promise<void> {
    if (connection.status === "expired") return;
    const nowIso = this.#now().toISOString();
    const expiredConnection: ProviderConnection = {
      ...connection,
      status: "expired",
      updatedAt: nowIso,
    };
    await this.#store.putConnection(expiredConnection);
  }

  async #openProviderSecretMaterial(
    connection: ProviderConnection,
  ): Promise<ProviderSecretMaterial> {
    const blob = await this.#store.getSecretBlob(connection.id);
    if (!blob) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connection.id} has no secret blob`,
      );
    }
    // Partition and AAD are derived from the CONNECTION ROW — never from the
    // blob's self-described AAD partition — so a swapped or tampered blob
    // cannot select its provider env/AAD and fails the AES-GCM auth tag.
    const plaintext = await this.#crypto.open(
      base64ToBytes(blob.ciphertext),
      secretPartitionForConnection(connection),
      connectionEnvelopeAad(connection, secretEnvelopeVersionForBlob(blob)),
    );
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    if (isRecord(parsed.env)) {
      return {
        env: stringRecord(parsed.env),
        files: mintedFilesFromSecretMaterial(parsed.files),
      };
    }
    return { env: stringRecord(parsed), files: [] };
  }

  async #openValues(
    connection: ProviderConnection,
  ): Promise<Record<string, string>> {
    return { ...(await this.#openProviderSecretMaterial(connection)).env };
  }

  async #mintProviderValues(
    connection: ProviderConnection,
  ): Promise<MintedProviderValues> {
    if (connectionIsExpired(connection, this.#now())) {
      await this.#markConnectionExpired(connection);
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connection.id} expired at ${connection.expiresAt}`,
      );
    }
    const material = await this.#openProviderSecretMaterial(connection);
    const staticEvidence = () =>
      staticCredentialEvidence(connection, this.#now());
    const driver = this.#credentialDriver(connection);
    if (!driver?.mint) {
      if (connection.credentialRecipe?.preRunAction) {
        throw new ConnectionVaultError(
          "not_implemented",
          `credential recipe driver ${connection.credentialRecipe.preRunAction} is not installed`,
          undefined,
          "credential_service_unavailable",
        );
      }
      return {
        values: material.env,
        ...(material.files.length > 0 ? { files: material.files } : {}),
        evidence: staticEvidence(),
      };
    }
    try {
      const minted = await driver.mint({
        connection,
        values: material.env,
        files: material.files,
        fetch: this.#fetch,
        now: this.#now,
        staticEvidence,
      });
      return {
        values: minted.env,
        ...(minted.files ? { files: minted.files } : {}),
        evidence: minted.evidence,
      };
    } catch (error) {
      throw wrapDriverError(error);
    }
  }

  #credentialDriver(
    connection: ProviderConnection,
  ): CredentialRecipeRuntimeDriver | undefined {
    const recipe = connection.credentialRecipe;
    return recipe
      ? this.#credentialDrivers[credentialRecipeDriverKey(recipe)]
      : undefined;
  }
}

function mergeCredentialEnv(
  target: Record<string, string>,
  source: Readonly<Record<string, string>>,
  entry: CapsuleProviderBindingMintEntry,
): void {
  for (const [name, value] of Object.entries(source)) {
    const existing = target[name];
    if (existing !== undefined && existing !== value) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `provider credential env ${name} has conflicting values for provider ${entry.provider}` +
          `${entry.alias ? ` alias ${entry.alias}` : ""}` +
          ` connection ${entry.connectionId}`,
      );
    }
    target[name] = value;
  }
}

function selectConnectionForProvider(
  connections: readonly ProviderConnection[],
  provider: string,
  now: Date,
): ProviderConnection | undefined {
  const matches = connections.filter(
    (c) =>
      c.status !== "revoked" &&
      c.status !== "expired" &&
      !connectionIsExpired(c, now) &&
      !isSourceGitKind(c.kind) &&
      sameProviderSource(c.providerSource, provider),
  );
  const sorted = matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sorted.find((c) => c.status === "verified") ?? sorted[0];
}

function assertConnectionVerified(connection: ProviderConnection): void {
  if (connection.status !== "verified") {
    throw new ConnectionVaultError(
      "failed_precondition",
      `connection ${connection.id} is ${connection.status} (not verified)`,
      undefined,
      "provider_connection_not_ready",
    );
  }
}

function assertConnectionVerifiedUnlessManagedProvider(
  connection: ProviderConnection,
): void {
  if (isPublicManagedProviderConnection(connection)) return;
  assertConnectionVerified(connection);
}

function staticCredentialEvidence(
  connection: ProviderConnection,
  now: Date,
): ProviderCredentialMintEvidence {
  const expiresAtMs = connection.expiresAt
    ? Date.parse(connection.expiresAt)
    : Number.NaN;
  const ttlSeconds = Number.isFinite(expiresAtMs)
    ? Math.floor((expiresAtMs - now.getTime()) / 1000)
    : undefined;
  return {
    connectionId: connection.id,
    provider: connection.provider,
    temporary: false,
    ttlEnforced: ttlSeconds !== undefined && ttlSeconds > 0,
    ...(ttlSeconds !== undefined && ttlSeconds > 0 && connection.expiresAt
      ? { expiresAt: connection.expiresAt, ttlSeconds }
      : {}),
    issuer: "static_secret",
  };
}

/**
 * Verifies a static recipe without assigning provider-specific meaning to its
 * material. Registration pins the installed recipe's resolved env/file names
 * on the ProviderConnection; test() only confirms that the sealed material
 * still contains that complete declaration. A recipe with a pre-run action
 * reaches this fallback only when its explicitly installed mint driver has no
 * stronger verifier; without that mint driver test() fails closed earlier.
 */
function verifyStaticCredentialMaterial(
  connection: ProviderConnection,
  material: ProviderSecretMaterial,
): { readonly ok: boolean; readonly detail?: string } {
  const recipe = connection.credentialRecipe;
  if (!recipe) {
    return {
      ok: false,
      detail: `connection ${connection.id} has no resolved credential recipe`,
    };
  }

  const availableEnvNames = new Set(Object.keys(material.env));
  const availableFileEnvNames = new Set(
    material.files.flatMap((file) => (file.envName ? [file.envName] : [])),
  );
  const availableDeliveryNames = new Set([
    ...availableEnvNames,
    ...availableFileEnvNames,
  ]);
  const missingEnvNames = (recipe.envNames ?? connection.envNames).filter(
    (name) => !availableDeliveryNames.has(name),
  );
  const missingFileEnvNames = (recipe.fileEnvNames ?? []).filter(
    (name) => !availableFileEnvNames.has(name),
  );
  const requiredGroups = recipe.requiredEnvGroups ?? [];
  const suppliedNames = availableDeliveryNames;

  if (
    missingEnvNames.length === 0 &&
    missingFileEnvNames.length === 0 &&
    requiredRecipeGroupsSatisfied(requiredGroups, suppliedNames)
  ) {
    return { ok: true };
  }

  const missing = [...missingEnvNames, ...missingFileEnvNames];
  return {
    ok: false,
    detail:
      missing.length > 0
        ? `static credential material is missing declared names: ${missing.join(", ")}`
        : "static credential material no longer satisfies a required env-name group",
  };
}

function recipeLabel(connection: ProviderConnection): string {
  const recipe = connection.credentialRecipe;
  return recipe ? credentialRecipeDriverKey(recipe) : "legacy/unresolved";
}

function normalizeConnectionExpiresAt(
  value: unknown,
  now: Date,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "expiresAt must be an ISO timestamp when provided",
    );
  }
  const expiresAtMs = Date.parse(value);
  if (!Number.isFinite(expiresAtMs)) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "expiresAt must be an ISO timestamp when provided",
    );
  }
  if (expiresAtMs <= now.getTime()) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "expiresAt must be in the future",
    );
  }
  return new Date(expiresAtMs).toISOString();
}

function connectionIsExpired(
  connection: ProviderConnection,
  now: Date,
): boolean {
  if (connection.status === "expired") return true;
  if (!connection.expiresAt) return false;
  const expiresAtMs = Date.parse(connection.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime();
}

function normalizeScope(
  scope: ConnectionScopeHints | undefined,
): ConnectionScopeHints | undefined {
  if (!scope) return undefined;
  const out: {
    managedProvider?: boolean;
    providerConfig?: ConnectionScopeHints["providerConfig"];
    moduleInputDefaults?: ConnectionScopeHints["moduleInputDefaults"];
    providerSettings?: ConnectionScopeHints["providerSettings"];
    managedProviderProfile?: string;
    managedPublicBaseDomain?: string;
  } = {};
  const profile = managedProviderProfile(scope);
  if (scope.managedProvider === true) {
    if (!profile) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "scopeHints.managedProviderProfile is required when managedProvider is true",
      );
    }
    out.managedProvider = true;
    out.managedProviderProfile = profile;
  } else if (profile) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "scopeHints.managedProviderProfile requires managedProvider: true",
    );
  }
  const providerConfig = normalizeNonSecretJsonRecord(
    scope.providerConfig,
    "scopeHints.providerConfig",
  );
  if (providerConfig) out.providerConfig = providerConfig;
  const moduleInputDefaults = normalizeNonSecretJsonRecord(
    scope.moduleInputDefaults,
    "scopeHints.moduleInputDefaults",
  );
  if (moduleInputDefaults) out.moduleInputDefaults = moduleInputDefaults;
  const providerSettings = normalizeNonSecretJsonRecord(
    scope.providerSettings,
    "scopeHints.providerSettings",
  );
  if (providerSettings) out.providerSettings = providerSettings;
  if (
    typeof scope.managedPublicBaseDomain === "string" &&
    scope.managedPublicBaseDomain.length > 0
  ) {
    out.managedPublicBaseDomain = scope.managedPublicBaseDomain;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function assertManagedProviderOperatorOwnership(
  scopeHints: ConnectionScopeHints | undefined,
  workspaceId: string | undefined,
  scope: ProviderConnection["scope"],
): void {
  if (scopeHints?.managedProvider !== true) return;
  if (scope !== "operator" || workspaceId !== undefined) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "managed provider connections must be operator-scoped and must not have an owning Workspace",
    );
  }
}

const SECRET_CONFIG_KEYS = new Set([
  "access_key",
  "access_token",
  "accesskey",
  "accesstoken",
  "api_key",
  "api_token",
  "apikey",
  "apitoken",
  "authorization",
  "bearer_token",
  "bearertoken",
  "client_secret",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "passwd",
  "private_key",
  "privatekey",
  "refresh_token",
  "refreshtoken",
  "secret",
  "secret_key",
  "secretkey",
  "token",
]);

function normalizeNonSecretJsonRecord(
  value: unknown,
  fieldName: string,
): Readonly<Record<string, import("takosumi-contract").JsonValue>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ConnectionVaultError(
      "invalid_argument",
      `${fieldName} must be a JSON object when provided`,
    );
  }
  const out: Record<string, import("takosumi-contract").JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !isJsonValue(item)) {
      throw new ConnectionVaultError(
        "invalid_argument",
        `${fieldName}.${key} must be a valid identifier with a JSON value`,
      );
    }
    assertNonSecretJsonValue(item, `${fieldName}.${key}`, key);
    out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function assertNonSecretJsonValue(
  value: import("takosumi-contract").JsonValue,
  path: string,
  key: string,
): void {
  if (SECRET_CONFIG_KEYS.has(key.toLowerCase())) {
    throw new ConnectionVaultError(
      "invalid_argument",
      `${path} is credential-shaped; store secret material in Provider ProviderConnection values/files and inject it through a Credential Recipe`,
    );
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNonSecretJsonValue(item, `${path}[${index}]`, String(index));
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    assertNonSecretJsonValue(childValue, `${path}.${childKey}`, childKey);
  }
}

function isJsonValue(
  value: unknown,
): value is import("takosumi-contract").JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[name] = entry;
  }
  return out;
}

function mintedFilesFromSecretMaterial(value: unknown): readonly MintedFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const path = typeof entry.path === "string" ? entry.path : undefined;
    const content =
      typeof entry.content === "string" ? entry.content : undefined;
    const mode = typeof entry.mode === "number" ? entry.mode : undefined;
    if (!path || content === undefined || mode === undefined) return [];
    const envName =
      typeof entry.envName === "string" ? entry.envName : undefined;
    return [
      {
        path,
        content,
        mode,
        ...(envName ? { envName } : {}),
      },
    ];
  });
}

function isSourceGitKind(
  kind: ProviderConnection["kind"] | undefined,
): kind is SourceGitConnectionKind {
  return kind === "source_git_https_token" || kind === "source_git_ssh_key";
}

function requireNonEmpty(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConnectionVaultError(
      "invalid_argument",
      `${field} must be a non-empty string`,
    );
  }
}

function defaultConnectionId(): string {
  return `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function validateDeclaredEnvInput(
  input: RegisterConnectionInput,
): ReturnType<typeof validateDeclaredEnvRegistration> {
  try {
    return validateDeclaredEnvRegistration(input);
  } catch (error) {
    if (error instanceof DeclaredEnvRegistrationError) {
      throw new ConnectionVaultError(error.code, error.message);
    }
    throw error;
  }
}

function normalizeCredentialRecipe(
  input: RegisterConnectionInput,
): ProviderConnection["credentialRecipe"] | undefined {
  const explicit = input.credentialRecipe;
  if (explicit) {
    requireNonEmpty(explicit.id, "credentialRecipe.id");
    requireNonEmpty(explicit.authMode, "credentialRecipe.authMode");
  }
  return explicit;
}

/**
 * Re-wraps a provider credential driver error into the Vault's own
 * {@link ConnectionVaultError} surface. Provider drivers raise their own typed
 * failures; the Vault maps them to its
 * provider-neutral `failed_precondition` contract. Any non-Error value is
 * rethrown unchanged so unexpected failures are not masked.
 */
function wrapDriverError(error: unknown): unknown {
  if (error instanceof Error) {
    return new ConnectionVaultError("failed_precondition", error.message);
  }
  return error;
}

/**
 * Identity fields bound into the at-rest secret envelope's canonical AAD. The
 * AAD ties a sealed blob to the CONNECTION ROW it belongs to so that opening it
 * under a different connection / Workspace / provider / partition fails the AES-GCM
 * auth tag (a swapped or tampered blob never decrypts). `workspaceId` falls back to
 * {@link OPERATOR_SCOPE_AAD} for operator-scoped rows that have no owning Workspace.
 */
interface SecretEnvelopeIdentity {
  readonly secretPartition: SecretPartition;
  readonly workspaceId?: string;
  readonly connectionId: string;
  readonly provider: string;
}

/**
 * Derives the canonical AES-GCM AAD bytes from a connection row's identity. The
 * same identity MUST be reconstructed at seal and open time; at open we derive
 * `secretPartition` from the connection row (never from the blob's
 * self-described partition) so a tampered/swapped blob cannot select its key.
 */
function secretEnvelopeAad(
  identity: SecretEnvelopeIdentity,
  version: 1 | 2 = 2,
): Uint8Array {
  const canonical = JSON.stringify({
    v: version,
    ...(version === 1
      ? { cloudPartition: identity.secretPartition }
      : { secretPartition: identity.secretPartition }),
    workspaceId: identity.workspaceId ?? OPERATOR_SCOPE_AAD,
    connectionId: identity.connectionId,
    provider: identity.provider,
  });
  return new TextEncoder().encode(canonical);
}

/**
 * Reconstructs the at-rest AAD identity from the stored connection row. The
 * blob's own `aad` partition field is never trusted at open time.
 */
function connectionEnvelopeAad(
  connection: ProviderConnection,
  version: 1 | 2,
): Uint8Array {
  return secretEnvelopeAad(
    {
      secretPartition: secretPartitionForConnection(connection),
      ...(connection.workspaceId
        ? { workspaceId: connection.workspaceId }
        : {}),
      connectionId: connection.id,
      provider: connection.provider,
    },
    version,
  );
}

function secretEnvelopeVersionForBlob(blob: StoredSecretBlob): 1 | 2 {
  try {
    const metadata = JSON.parse(blob.aad) as Record<string, unknown>;
    return Object.hasOwn(metadata, "secretPartition") ? 2 : 1;
  } catch {
    // Historical blobs used v1 before the generic secret-partition metadata
    // field existed. The parsed blob metadata never supplies a key or identity.
    return 1;
  }
}

function secretPartitionForConnection(
  connection: ProviderConnection,
): SecretPartition {
  if (isSecretPartitionToken(connection.secretPartition)) {
    return connection.secretPartition;
  }
  throw new ConnectionVaultError(
    "failed_precondition",
    `connection ${connection.id} has no explicit secret partition; migrate the row before opening credential material`,
  );
}

function secretPartitionForRegistration(
  recipe: ProviderConnection["credentialRecipe"] | undefined,
): SecretPartition {
  const explicit = recipe?.secretPartition;
  if (explicit !== undefined) {
    if (!isSecretPartitionToken(explicit)) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "credentialRecipe.secretPartition must be a non-blank token without whitespace",
      );
    }
    return explicit;
  }
  throw new ConnectionVaultError(
    "invalid_argument",
    "credentialRecipe.secretPartition is required for new Provider Connections",
  );
}

function requiredRecipeGroupsSatisfied(
  groups: readonly (readonly string[])[],
  suppliedEnvNames: Iterable<string>,
): boolean {
  const supplied = new Set(suppliedEnvNames);
  if (groups.length === 0) return supplied.size > 0;
  return groups.some((group) => group.every((name) => supplied.has(name)));
}

function isSecretPartitionToken(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/\s/u.test(value);
}

function makeStoredSecretBlob(input: {
  readonly connectionId: string;
  readonly workspaceId?: string;
  readonly provider: string;
  readonly sealed: Uint8Array;
  readonly secretPartition: SecretPartition;
  readonly createdAt: string;
  readonly crypto: SecretBoundaryCrypto;
}): StoredSecretBlob {
  const aad = {
    secretPartition: input.secretPartition,
    workspaceId: input.workspaceId ?? OPERATOR_SCOPE_AAD,
    provider: input.provider,
  };
  return {
    id: `secret_${input.connectionId}`,
    connectionId: input.connectionId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    // `kind` is a historical column name. Its current value is the explicit,
    // provider-neutral encryption partition, not a compiled credential family.
    kind: input.secretPartition,
    ciphertext: bytesToBase64(input.sealed),
    encryptedDek: `${SECRET_BLOB_KEY_SCHEME}/${input.secretPartition}`,
    // The IV is the ciphertext prefix; `nonce` is a non-load-bearing mirror of
    // it kept for the persisted `NOT NULL` column (never read for decryption).
    nonce: bytesToBase64(input.sealed.slice(0, 12)),
    aad: JSON.stringify(aad),
    // Real key-version fingerprint of the active passphrase (rotation-detectable)
    // when the crypto exposes one; falls back to the legacy `1` for keyless
    // (placeholder / dev) crypto so existing dev blobs keep a stable version.
    keyVersion: input.crypto.keyVersion?.(input.secretPartition) ?? 1,
    createdAt: input.createdAt,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
