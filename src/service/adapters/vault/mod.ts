/**
 * In-process credential Vault broker (Phase 1A credential core).
 *
 * Users register provider credentials as Connections; the Vault seals the
 * secret values into a per-Connection blob and, for a run, mints a
 * {@link CredentialBundle} of `{ env }` for the dispatch path (consumed by
 * Phase 1B — NOT wired into plan/apply dispatch here).
 *
 * Security invariants:
 *   - Secret values are write-only: they enter via `register` and leave only
 *     through `CredentialBundle.env` on the dispatch path. They are NEVER
 *     serialized into logs — the bundle's `toJSON` / `inspect` / `toString`
 *     return the opaque marker `"[credential-bundle]"`.
 *   - Env names are validated against the canonical provider-env-rules table.
 *   - The secret blob is sealed with the partition-bound secret-boundary crypto
 *     (partition = the provider's cloud family).
 */

import type {
  Connection,
  ConnectionKind,
  ConnectionScopeHints,
  CreateConnectionRequest,
} from "@takosumi/internal/deploy-control-api";
import {
  GIT_HTTPS_TOKEN_ENV,
  GIT_SSH_PRIVATE_KEY_ENV,
  type MintPhase,
  type MintResponse,
  type SourceGitConnectionKind,
} from "takosumi-contract/sources";
import {
  allowedEnvNamesForProvider,
  cloudFamilyForProvider,
  providerCredentialArgs,
  providerEnvRule,
  requiredEnvGroupsForProvider,
  requiredEnvGroupsSatisfied,
} from "takosumi-contract/provider-env-rules";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import type {
  OpenTofuDeploymentStore,
  StoredSecretBlob,
  StoredSecretBlobKind,
} from "../../domains/deploy-control/store.ts";
import type { SecretBoundaryCrypto } from "../secret-store/memory.ts";
import type { CloudPartition } from "../secret-store/types.ts";

const CREDENTIAL_BUNDLE_MARKER = "[credential-bundle]";
/**
 * AAD spaceId label for operator-scoped connections (spec §8): they have no
 * owning Space, so their sealed blobs bind to this fixed partition label.
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

  constructor(
    code: ConnectionVaultError["code"],
    message: string,
    missingEnvGroups?: readonly (readonly string[])[],
  ) {
    super(message);
    this.name = "ConnectionVaultError";
    this.code = code;
    if (missingEnvGroups) this.missingEnvGroups = missingEnvGroups;
  }
}

/**
 * A per-phase mint request (spec §8.3 / §8.4). The vault enforces the phase
 * rules IN the vault:
 *   - `source`  -> ONLY git-kind connections; returns env + files.
 *   - `build`   -> ALWAYS empty; error if any connection / provider is asked for.
 *   - `plan` / `apply` / `destroy` -> ONLY provider connections; git excluded.
 */
export interface MintRequest {
  readonly spaceId: string;
  readonly phase: MintPhase;
  /** Provider short names / registry paths for the tofu phases. */
  readonly providers?: readonly string[];
  /**
   * The git source Connection id to mint for the `source` phase. None for a
   * public repo (the source phase then returns an empty bundle).
   */
  readonly sourceConnectionId?: string;
  /**
   * Provider-binding connection pool for the tofu phases (spec §9). When
   * present, provider selection draws ONLY from these connections (each must
   * be operator-scoped or belong to the space); when absent, the legacy
   * space-wide pool applies. The vault re-validates each id — caller claims
   * are never trusted.
   */
  readonly connectionIds?: readonly string[];
}

/** One provider binding credential mint entry. */
export interface ProviderBindingMintEntry {
  /** Provider rule, short (`cloudflare`) or registry form. */
  readonly provider: string;
  /** Optional OpenTofu provider alias declared by the generated root. */
  readonly alias?: string;
  /** The Connection this provider binding resolved to. */
  readonly connectionId: string;
}

export interface ConnectionVault {
  register(input: RegisterConnectionInput): Promise<Connection>;
  test(connectionId: string): Promise<TestConnectionResult>;
  revoke(id: string): Promise<boolean>;
  /**
   * Mints a {@link CredentialBundle} of env vars for the given providers within
   * a space. Only verified connections may mint. This is the backward-compatible
   * provider-mint path; it is equivalent to
   * `mintForPhase({ phase: "plan", providers })`.
   */
  mint(
    spaceId: string,
    providers: readonly string[],
    options?: { readonly connectionIds?: readonly string[] },
  ): Promise<CredentialBundle>;
  /**
   * Per-phase mint (spec §8.3 / §8.4). Enforces the phase rules in the vault and
   * returns a {@link MintResponse} carrying env (+ files for the source phase).
   * The result is wrapped so callers can attach it to a runner dispatch only.
   */
  mintForPhase(request: MintRequest): Promise<PhaseMintBundle>;
  /**
   * Per-binding credential mint. For each provider binding entry the
   * vault re-validates the id (existence + space ownership, like
   * {@link MintRequest.connectionIds}), opens the connection's sealed values, and
   * maps its credential env names to `TF_VAR_<provider>_<alias>_<arg>`
   * entries using the provider arg mapping (cloudflare: `api_token`; aws:
   * `access_key` / `secret_key` / `token`). A provider env set connection maps
   * its declared variables to `TF_VAR_<variable>`.
   * A connection whose provider has neither mapping contributes no TF_VAR.
   * Phase rule: tofu phases only (plan / apply / destroy). The returned bundle
   * carries ONLY the per-alias TF_VAR env. Never serialized into logs.
   */
  mintForProviderBindings(
    spaceId: string,
    entries: readonly ProviderBindingMintEntry[],
    options?: { readonly phase?: MintPhase },
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

  /** Materialized credential files (source phase). Dispatch-path only. */
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
}

interface AssumeAwsRoleInput {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly roleArn: string;
  readonly externalId?: string;
  readonly region: string;
  readonly sessionName: string;
}

interface AssumedAwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

interface MintedCloudflareToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

interface MintedProviderValues {
  readonly values: Readonly<Record<string, string>>;
  readonly evidence: ProviderCredentialMintEvidence;
}

type CloudflareTokenVendingConfig = NonNullable<
  ConnectionScopeHints["cloudflareTokenVending"]
>;

/** Injected fetch seam so `test()` is unit-testable without real network. */
export type VaultFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface StaticSecretConnectionVaultDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly crypto: SecretBoundaryCrypto;
  readonly fetch?: VaultFetch;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class StaticSecretConnectionVault implements ConnectionVault {
  readonly #store: OpenTofuDeploymentStore;
  readonly #crypto: SecretBoundaryCrypto;
  readonly #fetch: VaultFetch;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(deps: StaticSecretConnectionVaultDependencies) {
    this.#store = deps.store;
    this.#crypto = deps.crypto;
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? defaultConnectionId;
  }

  async register(input: RegisterConnectionInput): Promise<Connection> {
    // spaceId is absent for an operator-scoped connection (spec §8); when
    // present it must be a real id.
    if (input.spaceId !== undefined || input.scope === "space") {
      requireNonEmpty(input.spaceId, "spaceId");
    }
    if (input.authMethod !== "static_secret") {
      // Phase 1 implements static_secret only; other methods are reserved.
      throw new ConnectionVaultError(
        "not_implemented",
        `authMethod ${String(input.authMethod)} is not implemented (Phase 1 supports static_secret)`,
      );
    }
    if (isSourceGitKind(input.kind)) {
      return await this.#registerGitConnection(input, input.kind);
    }
    requireNonEmpty(input.provider, "provider");
    const rule = providerEnvRule(input.provider);
    if (!rule) {
      return await this.#registerGenericProviderEnvSet(input);
    }
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
    const allowed = new Set(allowedEnvNamesForProvider(input.provider));
    const envNames = Object.keys(values);
    if (envNames.length === 0) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "values must supply at least one env name",
      );
    }
    for (const envName of envNames) {
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
    if (!requiredEnvGroupsSatisfied(input.provider, envNames)) {
      throw new ConnectionVaultError(
        "invalid_argument",
        `provider ${input.provider} requires one of these env-name groups`,
        requiredEnvGroupsForProvider(input.provider),
      );
    }

    const id = this.#newId();
    const cloudPartition = cloudFamilyForProvider(
      input.provider,
    ) as CloudPartition;
    const sealed = await this.#crypto.seal(
      JSON.stringify(values),
      cloudPartition,
    );
    const now = this.#now();
    const nowIso = now.toISOString();
    const connectionKind =
      input.kind ?? providerConnectionKindFor(input.provider);
    const blob = makeStoredSecretBlob({
      connectionId: id,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      provider: input.provider,
      connectionKind,
      sealed,
      cloudPartition,
      createdAt: nowIso,
    });
    await this.#store.putSecretBlob(blob);

    const expiresAt = normalizeConnectionExpiresAt(input.expiresAt, now);
    const connection: Connection = {
      id,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      provider: input.provider,
      kind: connectionKind,
      scope: input.scope ?? (input.spaceId ? "space" : "operator"),
      authMethod: "static_secret",
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "pending",
      ...(normalizeScope(input.scopeHints)
        ? { scopeHints: normalizeScope(input.scopeHints) }
        : {}),
      envNames: [...envNames].sort(),
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(expiresAt ? { expiresAt } : {}),
    };
    await this.#store.putConnection(connection);
    return connection;
  }

  async #registerGenericProviderEnvSet(
    input: RegisterConnectionInput,
  ): Promise<Connection> {
    if (!input.spaceId || input.scope === "operator") {
      throw new ConnectionVaultError(
        "failed_precondition",
        "user provider env sets for unknown providers must be Space-scoped",
      );
    }
    const values = input.values;
    if (
      values === null ||
      typeof values !== "object" ||
      Array.isArray(values)
    ) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "values must be an object of { variableName: value }",
      );
    }
    const envNames = Object.keys(values);
    if (envNames.length === 0) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "values must supply at least one provider env name",
      );
    }
    for (const name of envNames) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        throw new ConnectionVaultError(
          "invalid_argument",
          `env name ${name} must be an uppercase environment variable name`,
        );
      }
      if (typeof values[name] !== "string") {
        throw new ConnectionVaultError(
          "invalid_argument",
          `value for ${name} must be a string`,
        );
      }
    }
    const id = this.#newId();
    const cloudPartition = "local-adapters" as CloudPartition;
    const sealed = await this.#crypto.seal(
      JSON.stringify(values),
      cloudPartition,
    );
    const now = this.#now();
    const nowIso = now.toISOString();
    const connectionKind = input.kind ?? "static_secret";
    const blob = makeStoredSecretBlob({
      connectionId: id,
      spaceId: input.spaceId,
      provider: input.provider,
      connectionKind,
      sealed,
      cloudPartition,
      createdAt: nowIso,
    });
    await this.#store.putSecretBlob(blob);

    const expiresAt = normalizeConnectionExpiresAt(input.expiresAt, now);
    const connection: Connection = {
      id,
      spaceId: input.spaceId,
      provider: input.provider,
      kind: "provider_env_set",
      scope: "space",
      authMethod: "static_secret",
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "pending",
      ...(normalizeScope(input.scopeHints)
        ? { scopeHints: normalizeScope(input.scopeHints) }
        : {}),
      envNames: [...envNames].sort(),
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
   * Git connections are sealed under the `local-adapters` partition (no provider
   * cloud family) and recorded with `kind` so the mint phase rules can exclude
   * them from the tofu phases.
   */
  async #registerGitConnection(
    input: RegisterConnectionInput,
    kind: SourceGitConnectionKind,
  ): Promise<Connection> {
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
    if (kind === "source_git_ssh_key") {
      if (
        !scopeHints?.knownHostsEntry ||
        scopeHints.knownHostsEntry.trim().length === 0
      ) {
        throw new ConnectionVaultError(
          "invalid_argument",
          "source_git_ssh_key requires scopeHints.knownHostsEntry (the known_hosts line for the host)",
        );
      }
    }

    const id = this.#newId();
    const cloudPartition = "local-adapters" as CloudPartition;
    const sealed = await this.#crypto.seal(
      JSON.stringify(values),
      cloudPartition,
    );
    const now = this.#now();
    const nowIso = now.toISOString();
    const blob = makeStoredSecretBlob({
      connectionId: id,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      provider: kind,
      connectionKind: kind,
      sealed,
      cloudPartition,
      createdAt: nowIso,
    });
    await this.#store.putSecretBlob(blob);

    const expiresAt = normalizeConnectionExpiresAt(input.expiresAt, now);
    const connection: Connection = {
      id,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      provider: kind,
      kind,
      scope: input.scope ?? (input.spaceId ? "space" : "operator"),
      authMethod: "static_secret",
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "pending",
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
    const values = await this.#openValues(connection);
    let verified: { readonly ok: boolean; readonly detail?: string };
    if (isCloudflareProvider(connection.provider)) {
      const token = values.CLOUDFLARE_API_TOKEN ?? values.CF_API_TOKEN;
      if (!token) {
        return {
          status: "pending",
          detail:
            "no cloudflare api token to verify (CLOUDFLARE_API_TOKEN / CF_API_TOKEN)",
        };
      }
      verified = await this.#verifyCloudflareToken(token);
    } else if (isAwsProvider(connection.provider)) {
      verified = await this.#verifyAwsAssumeRole(connection, values);
    } else {
      return {
        status: "pending",
        detail: `no verification driver is configured for provider ${connection.provider}`,
      };
    }
    if (!verified.ok) {
      return { status: "pending", detail: verified.detail };
    }
    const verifiedAtIso = this.#now().toISOString();
    await this.#store.putConnection({
      ...connection,
      status: "verified",
      verifiedAt: verifiedAtIso,
      updatedAt: verifiedAtIso,
    });
    return { status: "verified" };
  }

  async revoke(id: string): Promise<boolean> {
    const existed = await this.#store.getConnection(id);
    await this.#store.deleteSecretBlob(id);
    const deleted = await this.#store.deleteConnection(id);
    return deleted || existed !== undefined;
  }

  async mint(
    spaceId: string,
    providers: readonly string[],
    options?: { readonly connectionIds?: readonly string[] },
  ): Promise<CredentialBundle> {
    requireNonEmpty(spaceId, "spaceId");
    const connections =
      options?.connectionIds !== undefined
        ? await this.#connectionPool(spaceId, options.connectionIds)
        : await this.#store.listConnections(spaceId);
    const env: Record<string, string> = {};
    const evidence: ProviderCredentialMintEvidence[] = [];
    for (const provider of providers) {
      const rule = providerEnvRule(provider);
      if (!rule) {
        throw new ConnectionVaultError(
          "invalid_argument",
          `unknown provider ${provider}`,
        );
      }
      const match = selectConnectionForProvider(
        connections,
        provider,
        this.#now(),
      );
      if (!match) {
        throw new ConnectionVaultError(
          "not_found",
          `no connection registered for provider ${provider} in space ${spaceId}`,
          requiredEnvGroupsForProvider(provider),
        );
      }
      assertConnectionVerified(match);
      const minted = await this.#mintProviderValues(match, "provider_env");
      evidence.push(minted.evidence);
      for (const [name, value] of Object.entries(minted.values)) {
        env[name] = value;
      }
    }
    return new CredentialBundle(env, [], evidence);
  }

  /**
   * Per-binding credential mint. See {@link ConnectionVault.mintForProviderBindings}.
   * Re-validates each connection id (existence + space ownership) before opening
   * any value, so a caller can never mint a connection from another space. Maps
   * each connection's credential env to `TF_VAR_<provider>_<alias>_<arg>`
   * using the provider arg mapping. Returns ONLY the TF_VAR env.
   */
  async mintForProviderBindings(
    spaceId: string,
    entries: readonly ProviderBindingMintEntry[],
    options?: { readonly phase?: MintPhase },
  ): Promise<PhaseMintBundle> {
    requireNonEmpty(spaceId, "spaceId");
    // Phase rule: per-alias provider credentials are tofu-phase only. A source /
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
        `mintForProviderBindings is tofu-phase only; ${phase} phase must not request provider credentials`,
      );
    }
    const env: Record<string, string> = {};
    const evidence: ProviderCredentialMintEvidence[] = [];
    for (const entry of entries) {
      requireNonEmpty(entry.provider, "provider");
      requireNonEmpty(entry.connectionId, "connectionId");
      // Re-validate the id like #connectionPool: existence + space ownership.
      const connection = await this.#store.getConnection(entry.connectionId);
      if (!connection) {
        throw new ConnectionVaultError(
          "not_found",
          `connection ${entry.connectionId} not found`,
        );
      }
      if (connection.scope === "space" && connection.spaceId !== spaceId) {
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${entry.connectionId} belongs to another space`,
        );
      }
      if (isSourceGitKind(connection.kind)) {
        // A git connection is never a provider alias credential (invariants 4/5).
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${entry.connectionId} is a git source connection and cannot back a provider binding`,
        );
      }
      assertConnectionVerified(connection);
      const argMap = providerCredentialArgs(connection.provider);
      if (argMap.length === 0) {
        const customBundle = await this.#mintCustomProviderVariables(
          connection,
          entry.alias,
        );
        if (!customBundle) {
          // No per-alias split for this provider: rootgen emits a credential-free
          // alias and no shared provider env is admitted by the runner.
          continue;
        }
        Object.assign(env, customBundle.env);
        evidence.push(customBundle.evidence);
        continue;
      }
      const minted = await this.#mintProviderValues(
        connection,
        "generated_root_variable",
      );
      evidence.push(minted.evidence);
      const localProvider = providerLocalName(connection.provider);
      for (const { envName, arg } of argMap) {
        const value = minted.values[envName];
        if (typeof value !== "string") continue;
        env[
          `TF_VAR_${providerCredentialVarName(localProvider, entry.alias, arg)}`
        ] = value;
      }
    }
    return new PhaseMintBundle({ env }, [], evidence);
  }

  async #mintCustomProviderVariables(
    connection: Connection,
    alias: string | undefined,
  ): Promise<
    | {
        readonly env: Readonly<Record<string, string>>;
        readonly evidence: ProviderCredentialMintEvidence;
      }
    | undefined
  > {
    void alias;
    if (connection.kind !== "provider_env_set") return undefined;
    if (connection.scope !== "space") {
      throw new ConnectionVaultError(
        "failed_precondition",
        `provider env set connection ${connection.id} must be Space-scoped`,
      );
    }
    const values = await this.#openValues(connection);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== "string") continue;
      env[`TF_VAR_${name}`] = value;
    }
    return {
      env,
      evidence: {
        provider: connection.provider,
        connectionId: connection.id,
        delivery: "generated_root_variable",
        rootOnly: true,
        temporary: false,
        ttlEnforced: false,
        issuer: "static_secret",
      },
    };
  }

  /**
   * Builds the provider-binding-resolved connection pool for a tofu-phase mint. Each
   * id is re-read from the store; a space-scoped connection must belong to the
   * requesting space and an operator-scoped one is instance-wide. Unknown ids
   * fail closed.
   */
  async #connectionPool(
    spaceId: string,
    connectionIds: readonly string[],
  ): Promise<readonly Connection[]> {
    const pool: Connection[] = [];
    for (const id of connectionIds) {
      const connection = await this.#store.getConnection(id);
      if (!connection) {
        throw new ConnectionVaultError(
          "not_found",
          `connection ${id} not found`,
        );
      }
      if (connection.scope === "space" && connection.spaceId !== spaceId) {
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${id} belongs to another space`,
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
   * A git connection is NEVER minted for a tofu phase, and a provider connection
   * is NEVER minted for the source phase.
   */
  async mintForPhase(request: MintRequest): Promise<PhaseMintBundle> {
    requireNonEmpty(request.spaceId, "spaceId");
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
        request.spaceId,
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
    const bundle = await this.mint(request.spaceId, providers, {
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
    spaceId: string,
    connectionId: string,
  ): Promise<PhaseMintBundle> {
    const connection = await this.#requireConnection(connectionId);
    if (connection.scope === "space" && connection.spaceId !== spaceId) {
      throw new ConnectionVaultError(
        "not_found",
        `connection ${connectionId} not found in space ${spaceId}`,
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

    if (connection.kind === "source_git_https_token") {
      const token = values[GIT_HTTPS_TOKEN_ENV];
      if (!token) {
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${connectionId} has no ${GIT_HTTPS_TOKEN_ENV}`,
        );
      }
      const username = connection.scopeHints?.username ?? "x-access-token";
      const askpass = gitAskpassScript(username, token);
      return new PhaseMintBundle(
        {
          env: {
            GIT_TERMINAL_PROMPT: "0",
          },
          files: [
            {
              path: "askpass.sh",
              mode: 0o700,
              content: askpass,
            },
          ],
        },
        [],
      );
    }

    // source_git_ssh_key
    const key = values[GIT_SSH_PRIVATE_KEY_ENV];
    if (!key) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connectionId} has no ${GIT_SSH_PRIVATE_KEY_ENV}`,
      );
    }
    const knownHosts = connection.scopeHints?.knownHostsEntry;
    if (!knownHosts) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connectionId} is missing its known_hosts entry`,
      );
    }
    const keyContent = key.endsWith("\n") ? key : `${key}\n`;
    const knownHostsContent = knownHosts.endsWith("\n")
      ? knownHosts
      : `${knownHosts}\n`;
    return new PhaseMintBundle(
      {
        env: {},
        files: [
          {
            path: "id_source",
            mode: 0o600,
            content: keyContent,
          },
          {
            path: "known_hosts",
            mode: 0o600,
            content: knownHostsContent,
          },
        ],
      },
      [],
    );
  }

  async #requireConnection(id: string): Promise<Connection> {
    const connection = await this.#store.getConnection(id);
    if (!connection) {
      throw new ConnectionVaultError("not_found", `connection ${id} not found`);
    }
    return connection;
  }

  async #markConnectionExpired(connection: Connection): Promise<void> {
    if (connection.status === "expired") return;
    const nowIso = this.#now().toISOString();
    await this.#store.putConnection({
      ...connection,
      status: "expired",
      updatedAt: nowIso,
    });
  }

  async #openValues(connection: Connection): Promise<Record<string, string>> {
    const blob = await this.#store.getSecretBlob(connection.id);
    if (!blob) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connection.id} has no secret blob`,
      );
    }
    const plaintext = await this.#crypto.open(
      base64ToBytes(blob.ciphertext),
      cloudPartitionFromSecretBlob(blob),
    );
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") values[name] = value;
    }
    return values;
  }

  async #mintProviderValues(
    connection: Connection,
    delivery: ProviderCredentialMintEvidence["delivery"],
  ): Promise<MintedProviderValues> {
    if (connectionIsExpired(connection, this.#now())) {
      await this.#markConnectionExpired(connection);
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connection.id} expired at ${connection.expiresAt}`,
      );
    }
    const values = await this.#openValues(connection);
    const staticEvidence = (): ProviderCredentialMintEvidence => {
      const expiresAtMs = connection.expiresAt
        ? Date.parse(connection.expiresAt)
        : Number.NaN;
      const ttlSeconds = Number.isFinite(expiresAtMs)
        ? Math.floor((expiresAtMs - this.#now().getTime()) / 1000)
        : undefined;
      return {
        connectionId: connection.id,
        provider: connection.provider,
        delivery,
        rootOnly: delivery === "generated_root_variable",
        temporary: false,
        ttlEnforced: ttlSeconds !== undefined && ttlSeconds > 0,
        ...(ttlSeconds !== undefined && ttlSeconds > 0 && connection.expiresAt
          ? { expiresAt: connection.expiresAt, ttlSeconds }
          : {}),
        issuer: "static_secret",
      };
    };
    if (
      isCloudflareProvider(connection.provider) &&
      connection.scopeHints?.cloudflareTokenVending
    ) {
      const bootstrapToken =
        values.CLOUDFLARE_API_TOKEN ?? values.CF_API_TOKEN ?? "";
      if (!bootstrapToken) {
        throw new ConnectionVaultError(
          "failed_precondition",
          `cloudflare token-vending connection ${connection.id} requires CLOUDFLARE_API_TOKEN or CF_API_TOKEN as the bootstrap credential`,
        );
      }
      const minted = await this.#mintCloudflareApiToken(
        connection,
        bootstrapToken,
      );
      return {
        values: {
          ...values,
          CLOUDFLARE_API_TOKEN: minted.token,
        },
        evidence: {
          connectionId: connection.id,
          provider: connection.provider,
          delivery,
          rootOnly: delivery === "generated_root_variable",
          temporary: true,
          ttlEnforced: true,
          expiresAt: minted.expiresAt,
          ttlSeconds: minted.ttlSeconds,
          issuer: "cloudflare_api_token_vending",
        },
      };
    }
    if (
      !isAwsProvider(connection.provider) ||
      !connection.scopeHints?.awsRoleArn
    ) {
      return { values, evidence: staticEvidence() };
    }
    if (values.AWS_WEB_IDENTITY_TOKEN_FILE && values.AWS_ROLE_ARN) {
      // Web-identity token files are runner-local files. The vault cannot safely
      // materialize them from sealed provider env today, so pass through the
      // explicit file-based contract when an operator has arranged the file in
      // the runner environment.
      return {
        values: {
          ...values,
          AWS_ROLE_ARN: values.AWS_ROLE_ARN || connection.scopeHints.awsRoleArn,
        },
        evidence: staticEvidence(),
      };
    }
    const accessKeyId = values.AWS_ACCESS_KEY_ID;
    const secretAccessKey = values.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `aws assume-role connection ${connection.id} requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as source credentials`,
      );
    }
    const region =
      connection.scopeHints.awsRegion ??
      values.AWS_REGION ??
      values.AWS_DEFAULT_REGION ??
      "us-east-1";
    const assumed = await this.#assumeAwsRole({
      accessKeyId,
      secretAccessKey,
      sessionToken: values.AWS_SESSION_TOKEN,
      roleArn: connection.scopeHints.awsRoleArn,
      externalId: connection.scopeHints.awsExternalId,
      region,
      sessionName: awsRoleSessionName(connection.id),
    });
    return {
      values: {
        AWS_ACCESS_KEY_ID: assumed.accessKeyId,
        AWS_SECRET_ACCESS_KEY: assumed.secretAccessKey,
        AWS_SESSION_TOKEN: assumed.sessionToken,
        AWS_REGION: region,
        AWS_DEFAULT_REGION: values.AWS_DEFAULT_REGION ?? region,
      },
      evidence: {
        connectionId: connection.id,
        provider: connection.provider,
        delivery,
        rootOnly: delivery === "generated_root_variable",
        temporary: true,
        ttlEnforced: true,
        expiresAt: assumed.expiresAt,
        ttlSeconds: assumed.ttlSeconds,
        issuer: "aws_sts_assume_role",
      },
    };
  }

  async #mintCloudflareApiToken(
    connection: Connection,
    bootstrapToken: string,
  ): Promise<MintedCloudflareToken> {
    const vending = connection.scopeHints?.cloudflareTokenVending;
    if (!vending || !Array.isArray(vending.policies)) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `cloudflare token-vending connection ${connection.id} requires scopeHints.cloudflareTokenVending.policies`,
      );
    }
    const now = this.#now();
    const ttlSeconds = cloudflareTokenTtlSeconds(vending.ttlSeconds);
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const body = {
      name: cloudflareTokenName(connection, now, vending.namePrefix),
      policies: vending.policies,
      expires_on: expiresAt,
      ...(vending.condition ? { condition: vending.condition } : {}),
    };
    let response: Response;
    try {
      response = await this.#fetch(
        "https://api.cloudflare.com/client/v4/user/tokens",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bootstrapToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `cloudflare api token create request failed: ${errorMessage(error)}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ConnectionVaultError(
        "failed_precondition",
        `cloudflare api token create returned http ${response.status} with non-JSON body`,
      );
    }
    if (!response.ok || !isRecord(payload) || payload.success !== true) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `cloudflare api token create returned http ${response.status}: ${cloudflareApiErrorCode(payload)}`,
      );
    }
    const result = isRecord(payload.result) ? payload.result : undefined;
    const token = typeof result?.value === "string" ? result.value : undefined;
    const returnedExpiresAt =
      typeof result?.expires_on === "string" ? result.expires_on : undefined;
    if (!token) {
      throw new ConnectionVaultError(
        "failed_precondition",
        "cloudflare api token create response did not include a token value",
      );
    }
    if (!returnedExpiresAt) {
      throw new ConnectionVaultError(
        "failed_precondition",
        "cloudflare api token create response did not include expires_on",
      );
    }
    const returnedExpiresAtMs = Date.parse(returnedExpiresAt);
    if (
      !Number.isFinite(returnedExpiresAtMs) ||
      returnedExpiresAtMs <= now.getTime()
    ) {
      throw new ConnectionVaultError(
        "failed_precondition",
        "cloudflare api token create response included an invalid expires_on",
      );
    }
    return {
      token,
      expiresAt: new Date(returnedExpiresAtMs).toISOString(),
      ttlSeconds: Math.floor((returnedExpiresAtMs - now.getTime()) / 1000),
    };
  }

  async #assumeAwsRole(
    input: AssumeAwsRoleInput,
  ): Promise<AssumedAwsCredentials> {
    const payload = formEncode({
      Action: "AssumeRole",
      Version: "2011-06-15",
      RoleArn: input.roleArn,
      RoleSessionName: input.sessionName,
      DurationSeconds: "3600",
      ...(input.externalId ? { ExternalId: input.externalId } : {}),
    });
    const host = `sts.${input.region}.amazonaws.com`;
    const url = `https://${host}/`;
    const now = this.#now();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      host,
      "x-amz-date": amzDate,
      ...(input.sessionToken
        ? { "x-amz-security-token": input.sessionToken }
        : {}),
    };
    const authorization = await awsSigV4Authorization({
      method: "POST",
      path: "/",
      query: "",
      headers,
      payload,
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      dateStamp,
      region: input.region,
      service: "sts",
    });
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          authorization,
        },
        body: payload,
      });
    } catch (error) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `aws sts AssumeRole request failed: ${errorMessage(error)}`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `aws sts AssumeRole returned http ${response.status}: ${awsXmlTag(text, "Code") ?? "unknown_error"}`,
      );
    }
    const credentials = {
      accessKeyId: awsXmlTag(text, "AccessKeyId"),
      secretAccessKey: awsXmlTag(text, "SecretAccessKey"),
      sessionToken: awsXmlTag(text, "SessionToken"),
      expiration: awsXmlTag(text, "Expiration"),
    };
    if (
      !credentials.accessKeyId ||
      !credentials.secretAccessKey ||
      !credentials.sessionToken ||
      !credentials.expiration
    ) {
      throw new ConnectionVaultError(
        "failed_precondition",
        "aws sts AssumeRole response did not include complete temporary credentials",
      );
    }
    const expirationMs = Date.parse(credentials.expiration);
    if (!Number.isFinite(expirationMs)) {
      throw new ConnectionVaultError(
        "failed_precondition",
        "aws sts AssumeRole response included an invalid Expiration",
      );
    }
    const ttlSeconds = Math.floor((expirationMs - now.getTime()) / 1000);
    if (ttlSeconds <= 0) {
      throw new ConnectionVaultError(
        "failed_precondition",
        "aws sts AssumeRole response returned already-expired credentials",
      );
    }
    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      expiresAt: new Date(expirationMs).toISOString(),
      ttlSeconds,
    };
  }

  async #verifyCloudflareToken(
    token: string,
  ): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    let response: Response;
    try {
      response = await this.#fetch(
        "https://api.cloudflare.com/client/v4/user/tokens/verify",
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
        },
      );
    } catch (error) {
      return {
        ok: false,
        detail: `token verify request failed: ${errorMessage(error)}`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        detail: `token verify returned http ${response.status}`,
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, detail: "token verify returned non-JSON body" };
    }
    if (isCloudflareVerifyOk(body)) return { ok: true };
    return {
      ok: false,
      detail: "token verify reported the token is not active",
    };
  }

  async #verifyAwsAssumeRole(
    connection: Connection,
    values: Record<string, string>,
  ): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!connection.scopeHints?.awsRoleArn) {
      return {
        ok: false,
        detail:
          "aws verification requires scopeHints.awsRoleArn for AssumeRole",
      };
    }
    const accessKeyId = values.AWS_ACCESS_KEY_ID;
    const secretAccessKey = values.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      return {
        ok: false,
        detail:
          "aws verification requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as source credentials",
      };
    }
    const region =
      connection.scopeHints.awsRegion ??
      values.AWS_REGION ??
      values.AWS_DEFAULT_REGION ??
      "us-east-1";
    try {
      await this.#assumeAwsRole({
        accessKeyId,
        secretAccessKey,
        sessionToken: values.AWS_SESSION_TOKEN,
        roleArn: connection.scopeHints.awsRoleArn,
        externalId: connection.scopeHints.awsExternalId,
        region,
        sessionName: awsRoleSessionName(connection.id),
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        detail: errorMessage(error),
      };
    }
  }
}

/**
 * Local provider name used as the `<provider>` segment of the per-binding
 * credential var (`TF_VAR_<provider>_<alias>_<arg>`). Mirrors rootgen's
 * `providerLocalName`: the trailing type segment of the provider rule (e.g.
 * `cloudflare/cloudflare` / `cloudflare` -> `cloudflare`; `hashicorp/aws` ->
 * `aws`). The connection's `provider` is a registered short name in practice, so
 * this is usually identity; the split handles a registry-path provider too.
 */
function providerLocalName(provider: string): string {
  const parts = provider.split("/");
  return parts[parts.length - 1] ?? provider;
}

function providerCredentialVarName(
  localProvider: string,
  alias: string | undefined,
  arg: string,
): string {
  return alias ? `${localProvider}_${alias}_${arg}` : `${localProvider}_${arg}`;
}

function selectConnectionForProvider(
  connections: readonly Connection[],
  provider: string,
  now: Date,
): Connection | undefined {
  const matches = connections.filter(
    (c) =>
      c.status !== "revoked" &&
      c.status !== "expired" &&
      !connectionIsExpired(c, now) &&
      !isSourceGitKind(c.kind) &&
      providerMatches(c.provider, provider),
  );
  const sorted = matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sorted.find((c) => c.status === "verified") ?? sorted[0];
}

function assertConnectionVerified(connection: Connection): void {
  if (connection.status !== "verified") {
    throw new ConnectionVaultError(
      "failed_precondition",
      `connection ${connection.id} is ${connection.status} (not verified)`,
    );
  }
}

function providerMatches(left: string, right: string): boolean {
  if (left === right) return true;
  const lrule = providerEnvRule(left);
  const rrule = providerEnvRule(right);
  return lrule !== undefined && lrule === rrule;
}

function isAwsProvider(provider: string): boolean {
  return providerEnvRule(provider)?.shortName === "aws";
}

function isCloudflareProvider(provider: string): boolean {
  return providerEnvRule(provider)?.shortName === "cloudflare";
}

function isCloudflareVerifyOk(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const record = body as { success?: unknown; result?: unknown };
  if (record.success !== true) return false;
  const result = record.result;
  if (result === null || typeof result !== "object") return false;
  return (result as { status?: unknown }).status === "active";
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

function connectionIsExpired(connection: Connection, now: Date): boolean {
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
    accountId?: string;
    zoneId?: string;
    cloudflareTokenVending?: ConnectionScopeHints["cloudflareTokenVending"];
    username?: string;
    knownHostsEntry?: string;
    awsRoleArn?: string;
    awsExternalId?: string;
    awsRegion?: string;
    gcpServiceAccountEmail?: string;
    gcpProjectId?: string;
  } = {};
  if (typeof scope.accountId === "string" && scope.accountId.length > 0) {
    out.accountId = scope.accountId;
  }
  if (typeof scope.zoneId === "string" && scope.zoneId.length > 0) {
    out.zoneId = scope.zoneId;
  }
  const cloudflareTokenVending = normalizeCloudflareTokenVending(
    scope.cloudflareTokenVending,
  );
  if (cloudflareTokenVending) {
    out.cloudflareTokenVending = cloudflareTokenVending;
  }
  if (typeof scope.username === "string" && scope.username.length > 0) {
    out.username = scope.username;
  }
  if (
    typeof scope.knownHostsEntry === "string" &&
    scope.knownHostsEntry.length > 0
  ) {
    out.knownHostsEntry = scope.knownHostsEntry;
  }
  if (typeof scope.awsRoleArn === "string" && scope.awsRoleArn.length > 0) {
    out.awsRoleArn = scope.awsRoleArn;
  }
  if (
    typeof scope.awsExternalId === "string" &&
    scope.awsExternalId.length > 0
  ) {
    out.awsExternalId = scope.awsExternalId;
  }
  if (typeof scope.awsRegion === "string" && scope.awsRegion.length > 0) {
    out.awsRegion = scope.awsRegion;
  }
  if (
    typeof scope.gcpServiceAccountEmail === "string" &&
    scope.gcpServiceAccountEmail.length > 0
  ) {
    out.gcpServiceAccountEmail = scope.gcpServiceAccountEmail;
  }
  if (typeof scope.gcpProjectId === "string" && scope.gcpProjectId.length > 0) {
    out.gcpProjectId = scope.gcpProjectId;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeCloudflareTokenVending(
  value: ConnectionScopeHints["cloudflareTokenVending"] | undefined,
): ConnectionScopeHints["cloudflareTokenVending"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "scopeHints.cloudflareTokenVending must be an object",
    );
  }
  if (!Array.isArray(value.policies) || value.policies.length === 0) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "scopeHints.cloudflareTokenVending.policies must be a non-empty array",
    );
  }
  const policies: CloudflareTokenVendingConfig["policies"] = value.policies.map(
    (policy, index) => {
      if (!isRecord(policy)) {
        throw new ConnectionVaultError(
          "invalid_argument",
          `scopeHints.cloudflareTokenVending.policies[${index}] must be an object`,
        );
      }
      const effect = policy.effect;
      if (effect !== "allow" && effect !== "deny") {
        throw new ConnectionVaultError(
          "invalid_argument",
          `scopeHints.cloudflareTokenVending.policies[${index}].effect must be allow or deny`,
        );
      }
      if (
        !Array.isArray(policy.permission_groups) ||
        policy.permission_groups.length === 0
      ) {
        throw new ConnectionVaultError(
          "invalid_argument",
          `scopeHints.cloudflareTokenVending.policies[${index}].permission_groups must be a non-empty array`,
        );
      }
      const permission_groups = policy.permission_groups.map(
        (group, groupIndex) => {
          if (!isRecord(group) || typeof group.id !== "string" || !group.id) {
            throw new ConnectionVaultError(
              "invalid_argument",
              `scopeHints.cloudflareTokenVending.policies[${index}].permission_groups[${groupIndex}].id must be a non-empty string`,
            );
          }
          return {
            id: group.id,
            ...(isStringRecord(group.meta) ? { meta: group.meta } : {}),
            ...(typeof group.name === "string" && group.name.length > 0
              ? { name: group.name }
              : {}),
          };
        },
      );
      if (!isRecord(policy.resources)) {
        throw new ConnectionVaultError(
          "invalid_argument",
          `scopeHints.cloudflareTokenVending.policies[${index}].resources must be an object`,
        );
      }
      const normalizedPolicy: CloudflareTokenVendingConfig["policies"][number] =
        {
          ...(typeof policy.id === "string" && policy.id.length > 0
            ? { id: policy.id }
            : {}),
          effect,
          permission_groups,
          resources:
            policy.resources as CloudflareTokenVendingConfig["policies"][number]["resources"],
        };
      return normalizedPolicy;
    },
  );
  return {
    policies,
    ...(typeof value.ttlSeconds === "number"
      ? { ttlSeconds: cloudflareTokenTtlSeconds(value.ttlSeconds) }
      : {}),
    ...(typeof value.namePrefix === "string" && value.namePrefix.length > 0
      ? { namePrefix: value.namePrefix.slice(0, 80) }
      : {}),
    ...(isRecord(value.condition) ? { condition: value.condition } : {}),
  };
}

function cloudflareTokenTtlSeconds(value: unknown): number {
  if (value === undefined) return 3600;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 60 ||
    value > 86400
  ) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "scopeHints.cloudflareTokenVending.ttlSeconds must be an integer between 60 and 86400",
    );
  }
  return value;
}

function cloudflareTokenName(
  connection: Connection,
  now: Date,
  prefix?: string,
): string {
  const safePrefix =
    prefix && prefix.trim().length > 0
      ? prefix
          .trim()
          .replace(/[^A-Za-z0-9_.:-]+/g, "-")
          .slice(0, 80)
      : "takosumi-run";
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${safePrefix}-${connection.id}-${stamp}`.slice(0, 120);
}

function cloudflareApiErrorCode(payload: unknown): string {
  if (!isRecord(payload)) return "unknown_error";
  const errors = payload.errors;
  if (!Array.isArray(errors) || errors.length === 0) return "unknown_error";
  const first = errors[0];
  if (!isRecord(first)) return "unknown_error";
  const code = typeof first.code === "number" ? String(first.code) : undefined;
  const message = typeof first.message === "string" ? first.message : undefined;
  return [code, message].filter(Boolean).join(": ") || "unknown_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isSourceGitKind(
  kind: Connection["kind"] | undefined,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function awsRoleSessionName(connectionId: string): string {
  const suffix = connectionId.replace(/[^A-Za-z0-9+=,.@-]/g, "-").slice(0, 32);
  return `takosumi-${suffix}`.slice(0, 64);
}

function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function formEncode(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

async function awsSigV4Authorization(input: {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly dateStamp: string;
  readonly region: string;
  readonly service: string;
}): Promise<string> {
  const canonicalHeaderEntries = Object.entries(input.headers)
    .map(
      ([name, value]) =>
        [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const,
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const signedHeaders = canonicalHeaderEntries.map(([name]) => name).join(";");
  const canonicalHeaders = canonicalHeaderEntries
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const payloadHash = await sha256Hex(input.payload);
  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const amzDate = input.headers["x-amz-date"] ?? input.headers["X-Amz-Date"];
  if (!amzDate) {
    throw new ConnectionVaultError(
      "failed_precondition",
      "aws sts signing requires x-amz-date",
    );
  }
  const credentialScope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await awsSigV4SigningKey(
    input.secretAccessKey,
    input.dateStamp,
    input.region,
    input.service,
  );
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
  return [
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
}

async function awsSigV4SigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256(utf8(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, "aws4_request");
}

async function hmacSha256(
  keyBytes: Uint8Array,
  data: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    arrayBufferFromBytes(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, arrayBufferFromBytes(utf8(data))),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    arrayBufferFromBytes(utf8(value)),
  );
  return bytesToHex(new Uint8Array(digest));
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  const copy = new Uint8Array(buffer);
  copy.set(bytes);
  return buffer;
}

function awsXmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Builds a GIT_ASKPASS script that echoes the username on the first prompt and
 * the token on the password prompt. Git invokes the script with the prompt text
 * as `$1`; a prompt containing "Username" yields the user, anything else (the
 * password prompt) yields the token. Single quotes in the values are escaped so
 * the script cannot break out of the quoting.
 */
function gitAskpassScript(username: string, token: string): string {
  const u = shellSingleQuote(username);
  const t = shellSingleQuote(token);
  return [
    "#!/bin/sh",
    `case "$1" in`,
    `  *sername*) printf '%s' ${u} ;;`,
    `  *) printf '%s' ${t} ;;`,
    "esac",
    "",
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultConnectionId(): string {
  return `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function makeStoredSecretBlob(input: {
  readonly connectionId: string;
  readonly spaceId?: string;
  readonly provider: string;
  readonly connectionKind?: ConnectionKind;
  readonly sealed: Uint8Array;
  readonly cloudPartition: CloudPartition;
  readonly createdAt: string;
}): StoredSecretBlob {
  const aad = {
    cloudPartition: input.cloudPartition,
    spaceId: input.spaceId ?? OPERATOR_SCOPE_AAD,
    provider: input.provider,
  };
  return {
    id: `secret_${input.connectionId}`,
    connectionId: input.connectionId,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    kind: secretBlobKindFor(input.provider, input.connectionKind),
    ciphertext: bytesToBase64(input.sealed),
    encryptedDek: `${SECRET_BLOB_KEY_SCHEME}/${input.cloudPartition}`,
    nonce: bytesToBase64(input.sealed.slice(0, 12)),
    aad: JSON.stringify(aad),
    keyVersion: 1,
    createdAt: input.createdAt,
  };
}

function secretBlobKindFor(
  provider: string,
  connectionKind?: ConnectionKind,
): StoredSecretBlobKind {
  if (connectionKind === "source_git_https_token") return "source_https_token";
  if (connectionKind === "source_git_ssh_key") return "source_ssh_private_key";
  if (connectionKind === "cloudflare_oauth") {
    return "cloudflare_oauth_refresh_token";
  }
  if (connectionKind === "cloudflare_api_token" || provider === "cloudflare") {
    return "cloudflare_api_token";
  }
  if (connectionKind === "aws_assume_role" || provider === "aws") {
    return "aws_external_id";
  }
  if (
    connectionKind === "gcp_oauth_bootstrap" ||
    connectionKind === "gcp_service_account_impersonation"
  ) {
    return "gcp_oauth_refresh_token";
  }
  return "static_secret";
}

function providerConnectionKindFor(provider: string): ConnectionKind {
  if (provider === "cloudflare") return "cloudflare_api_token";
  if (provider === "aws") return "aws_assume_role";
  if (provider === "gcp" || provider === "google") {
    return "gcp_service_account_impersonation";
  }
  return "static_secret";
}

function cloudPartitionFromSecretBlob(blob: StoredSecretBlob): CloudPartition {
  const parsed = JSON.parse(blob.aad) as { readonly cloudPartition?: unknown };
  if (typeof parsed.cloudPartition !== "string") {
    throw new ConnectionVaultError(
      "failed_precondition",
      `secret blob ${blob.id} has invalid aad`,
    );
  }
  return parsed.cloudPartition as CloudPartition;
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
