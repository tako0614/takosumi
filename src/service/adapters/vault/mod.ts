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
  ConnectionScopeHints,
  CreateConnectionRequest,
} from "takosumi-contract/deploy-control-api";
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
import type {
  OpenTofuDeploymentStore,
  StoredSecretBlob,
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
  /**
   * Connections that supplied this bundle but were only `pending` (not yet
   * verified). Surfaced as a non-secret warning by the controller / dispatch
   * path. Never contains values.
   */
  readonly warnings: readonly string[];

  constructor(
    env: Readonly<Record<string, string>>,
    warnings: readonly string[] = [],
  ) {
    this.#env = Object.freeze({ ...env });
    this.warnings = Object.freeze([...warnings]);
  }

  /** Decrypted env vars. Dispatch-path only — do not log the result. */
  get env(): Readonly<Record<string, string>> {
    return this.#env;
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
  readonly status: "verified" | "pending";
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
   * Capability-resolved connection pool for the tofu phases (spec §9). When
   * present, provider selection draws ONLY from these connections (each must
   * be operator-scoped or belong to the space); when absent, the legacy
   * space-wide pool applies. The vault re-validates each id — caller claims
   * are never trusted.
   */
  readonly connectionIds?: readonly string[];
}

/**
 * One (capability, connection) pair for the §13 per-alias credential mint. The
 * capability label is the alias the generated root declared the provider under;
 * the connectionId is the Connection that capability resolved to. The vault
 * re-validates the id (existence + space ownership) — caller claims are never
 * trusted — and maps the connection's credential env into
 * `TF_VAR_<provider>_<capability>_<arg>` entries.
 */
export interface CapabilityMintEntry {
  /** Provider-alias capability label (e.g. `compute` / `dns` / `storage`). */
  readonly capability: string;
  /** The Connection this capability resolved to. */
  readonly connectionId: string;
}

export interface ConnectionVault {
  register(input: RegisterConnectionInput): Promise<Connection>;
  test(connectionId: string): Promise<TestConnectionResult>;
  revoke(id: string): Promise<boolean>;
  /**
   * Mints a {@link CredentialBundle} of env vars for the given providers within
   * a space. Phase 1: static pass-through of decrypted values for matching
   * verified connections (falls back to pending with a flagged warning). This is
   * the backward-compatible provider-mint path; it is equivalent to
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
   * §13 per-alias credential mint. For each (capability, connectionId) entry the
   * vault re-validates the id (existence + space ownership, like
   * {@link MintRequest.connectionIds}), opens the connection's sealed values, and
   * maps its credential env names to `TF_VAR_<provider>_<capability>_<arg>`
   * entries using the provider arg mapping (cloudflare: `api_token`; aws:
   * `access_key` / `secret_key` / `token`). A connection whose provider has no arg
   * mapping contributes no TF_VAR (its alias inherits the shared provider env).
   * Phase rule: tofu phases only (plan / apply / destroy). The returned bundle
   * carries ONLY the per-alias TF_VAR env; the caller merges it on top of the
   * shared provider mint. Never serialized into logs.
   */
  mintForCapabilities(
    spaceId: string,
    entries: readonly CapabilityMintEntry[],
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
  readonly warnings: readonly string[];

  constructor(
    response: MintResponse,
    warnings: readonly string[] = [],
  ) {
    this.#env = Object.freeze({ ...response.env });
    this.#files = Object.freeze(
      (response.files ?? []).map((f) => Object.freeze({ ...f })),
    );
    this.warnings = Object.freeze([...warnings]);
  }

  /** Decrypted env vars. Dispatch-path only — do not log the result. */
  get env(): Readonly<Record<string, string>> {
    return this.#env;
  }

  /** Materialized credential files (source phase). Dispatch-path only. */
  get files(): readonly MintedFileInternal[] {
    return this.#files;
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
    this.#fetch = deps.fetch ??
      ((input, init) => fetch(input, init));
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
      throw new ConnectionVaultError(
        "invalid_argument",
        `unknown provider ${input.provider}`,
      );
    }
    const values = input.values;
    if (
      values === null || typeof values !== "object" || Array.isArray(values)
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
    const cloudPartition = cloudFamilyForProvider(input.provider) as CloudPartition;
    const sealed = await this.#crypto.seal(
      JSON.stringify(values),
      cloudPartition,
    );
    const blob: StoredSecretBlob = {
      connectionId: id,
      ciphertext: bytesToBase64(sealed),
      iv: bytesToBase64(sealed.slice(0, 12)),
      keyVersion: `${SECRET_BLOB_KEY_SCHEME}/${cloudPartition}`,
      aad: {
        cloudPartition,
        spaceId: input.spaceId ?? OPERATOR_SCOPE_AAD,
        provider: input.provider,
      },
    };
    await this.#store.putSecretBlob(blob);

    const nowIso = this.#now().toISOString();
    const connection: Connection = {
      id,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      provider: input.provider,
      kind: "provider",
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
      values === null || typeof values !== "object" || Array.isArray(values)
    ) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "values must be an object of { envName: value }",
      );
    }
    const expectedEnv = kind === "source_git_https_token"
      ? GIT_HTTPS_TOKEN_ENV
      : GIT_SSH_PRIVATE_KEY_ENV;
    const envNames = Object.keys(values);
    if (envNames.length !== 1 || envNames[0] !== expectedEnv) {
      throw new ConnectionVaultError(
        "invalid_argument",
        `${kind} requires exactly one value: ${expectedEnv}`,
      );
    }
    if (typeof values[expectedEnv] !== "string" || values[expectedEnv].length === 0) {
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
    const blob: StoredSecretBlob = {
      connectionId: id,
      ciphertext: bytesToBase64(sealed),
      iv: bytesToBase64(sealed.slice(0, 12)),
      keyVersion: `${SECRET_BLOB_KEY_SCHEME}/${cloudPartition}`,
      aad: {
        cloudPartition,
        spaceId: input.spaceId ?? OPERATOR_SCOPE_AAD,
        provider: kind,
      },
    };
    await this.#store.putSecretBlob(blob);

    const nowIso = this.#now().toISOString();
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
    const family = cloudFamilyForProvider(connection.provider);
    if (family !== "cloudflare") {
      // Phase 1 only verifies cloudflare end-to-end; others stay pending.
      return { status: "pending", detail: `verification not implemented for provider ${connection.provider}` };
    }
    const values = await this.#openValues(connection);
    const token = values.CLOUDFLARE_API_TOKEN ?? values.CF_API_TOKEN;
    if (!token) {
      return {
        status: "pending",
        detail: "no cloudflare api token to verify (CLOUDFLARE_API_TOKEN / CF_API_TOKEN)",
      };
    }
    const verified = await this.#verifyCloudflareToken(token);
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
    const connections = options?.connectionIds !== undefined
      ? await this.#capabilityPool(spaceId, options.connectionIds)
      : await this.#store.listConnections(spaceId);
    const env: Record<string, string> = {};
    const warnings: string[] = [];
    for (const provider of providers) {
      const rule = providerEnvRule(provider);
      if (!rule) {
        throw new ConnectionVaultError(
          "invalid_argument",
          `unknown provider ${provider}`,
        );
      }
      const match = selectConnectionForProvider(connections, provider);
      if (!match) {
        throw new ConnectionVaultError(
          "not_found",
          `no connection registered for provider ${provider} in space ${spaceId}`,
          requiredEnvGroupsForProvider(provider),
        );
      }
      if (match.status === "pending") {
        warnings.push(
          `connection ${match.id} for provider ${provider} is pending (not verified)`,
        );
      }
      const values = await this.#openValues(match);
      for (const [name, value] of Object.entries(values)) {
        env[name] = value;
      }
    }
    return new CredentialBundle(env, warnings);
  }

  /**
   * §13 per-alias credential mint. See {@link ConnectionVault.mintForCapabilities}.
   * Re-validates each connection id (existence + space ownership) before opening
   * any value, so a caller can never mint a connection from another space. Maps
   * each connection's credential env to `TF_VAR_<provider>_<capability>_<arg>`
   * using the provider arg mapping. Returns ONLY the TF_VAR env.
   */
  async mintForCapabilities(
    spaceId: string,
    entries: readonly CapabilityMintEntry[],
    options?: { readonly phase?: MintPhase },
  ): Promise<PhaseMintBundle> {
    requireNonEmpty(spaceId, "spaceId");
    // Phase rule: per-alias provider credentials are tofu-phase only. A source /
    // build phase must never request provider credentials (invariants 3-5).
    const phase = options?.phase;
    if (phase !== undefined && phase !== "plan" && phase !== "apply" && phase !== "destroy") {
      throw new ConnectionVaultError(
        "failed_precondition",
        `mintForCapabilities is tofu-phase only; ${phase} phase must not request provider credentials`,
      );
    }
    const env: Record<string, string> = {};
    const warnings: string[] = [];
    for (const entry of entries) {
      requireNonEmpty(entry.capability, "capability");
      requireNonEmpty(entry.connectionId, "connectionId");
      // Re-validate the id like #capabilityPool: existence + space ownership.
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
          `connection ${entry.connectionId} is a git source connection and cannot back a provider capability`,
        );
      }
      const argMap = providerCredentialArgs(connection.provider);
      if (argMap.length === 0) {
        // No per-alias split for this provider: its alias inherits the shared
        // provider env credential (rootgen emits a credential-free alias).
        continue;
      }
      if (connection.status === "pending") {
        warnings.push(
          `connection ${connection.id} for capability ${entry.capability} is pending (not verified)`,
        );
      }
      const values = await this.#openValues(connection);
      const localProvider = providerLocalName(connection.provider);
      for (const { envName, arg } of argMap) {
        const value = values[envName];
        if (typeof value !== "string") continue;
        env[`TF_VAR_${localProvider}_${entry.capability}_${arg}`] = value;
      }
    }
    return new PhaseMintBundle({ env }, warnings);
  }

  /**
   * Builds the capability-resolved connection pool for a tofu-phase mint. Each
   * id is re-read from the store; a space-scoped connection must belong to the
   * requesting space and an operator-scoped one is instance-wide. Unknown ids
   * fail closed.
   */
  async #capabilityPool(
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
    return new PhaseMintBundle({ env: bundle.env }, bundle.warnings);
  }

  /**
   * Mints a git source credential for the source phase. Verifies the connection
   * is a git kind in the right space, opens the sealed value, and returns the
   * runner-facing env + files: an askpass script (HTTPS) or the ssh key file plus
   * GIT_SSH_COMMAND with the pinned known_hosts (SSH; StrictHostKeyChecking=yes).
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
    if (!isSourceGitKind(connection.kind)) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connectionId} is not a git source connection`,
      );
    }
    const values = await this.#openValues(connection);
    const warnings = connection.status === "pending"
      ? [`connection ${connection.id} is pending (not verified)`]
      : [];

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
      return new PhaseMintBundle({
        env: {
          GIT_ASKPASS: "/work/.git-credentials/askpass.sh",
          GIT_TERMINAL_PROMPT: "0",
        },
        files: [
          {
            path: "/work/.git-credentials/askpass.sh",
            mode: 0o700,
            content: askpass,
          },
        ],
      }, warnings);
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
    return new PhaseMintBundle({
      env: {
        // StrictHostKeyChecking=yes always; the pinned known_hosts is the only
        // trusted source. StrictHostKeyChecking=no is forbidden by the spec.
        GIT_SSH_COMMAND:
          "ssh -i /work/.git-credentials/id_source " +
          "-o IdentitiesOnly=yes " +
          "-o StrictHostKeyChecking=yes " +
          "-o UserKnownHostsFile=/work/.git-credentials/known_hosts",
      },
      files: [
        {
          path: "/work/.git-credentials/id_source",
          mode: 0o600,
          content: keyContent,
        },
        {
          path: "/work/.git-credentials/known_hosts",
          mode: 0o600,
          content: knownHostsContent,
        },
      ],
    }, warnings);
  }

  async #requireConnection(id: string): Promise<Connection> {
    const connection = await this.#store.getConnection(id);
    if (!connection) {
      throw new ConnectionVaultError("not_found", `connection ${id} not found`);
    }
    return connection;
  }

  async #openValues(
    connection: Connection,
  ): Promise<Record<string, string>> {
    const blob = await this.#store.getSecretBlob(connection.id);
    if (!blob) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connection.id} has no secret blob`,
      );
    }
    const plaintext = await this.#crypto.open(
      base64ToBytes(blob.ciphertext),
      blob.aad.cloudPartition as CloudPartition,
    );
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") values[name] = value;
    }
    return values;
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
      return { ok: false, detail: `token verify request failed: ${errorMessage(error)}` };
    }
    if (!response.ok) {
      return { ok: false, detail: `token verify returned http ${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, detail: "token verify returned non-JSON body" };
    }
    if (isCloudflareVerifyOk(body)) return { ok: true };
    return { ok: false, detail: "token verify reported the token is not active" };
  }
}

/**
 * Local provider name used as the `<provider>` segment of the §13 per-alias
 * credential var (`TF_VAR_<provider>_<capability>_<arg>`). Mirrors rootgen's
 * `providerLocalName`: the trailing type segment of the provider rule (e.g.
 * `cloudflare/cloudflare` / `cloudflare` -> `cloudflare`; `hashicorp/aws` ->
 * `aws`). The connection's `provider` is a registered short name in practice, so
 * this is usually identity; the split handles a registry-path provider too.
 */
function providerLocalName(provider: string): string {
  const parts = provider.split("/");
  return parts[parts.length - 1] ?? provider;
}

function selectConnectionForProvider(
  connections: readonly Connection[],
  provider: string,
): Connection | undefined {
  const matches = connections.filter(
    (c) =>
      c.status !== "revoked" &&
      !isSourceGitKind(c.kind) &&
      providerMatches(c.provider, provider),
  );
  // Prefer a verified connection over a pending one; newest first within a tier.
  const verified = matches
    .filter((c) => c.status === "verified")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (verified[0]) return verified[0];
  const pending = matches
    .filter((c) => c.status === "pending")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return pending[0];
}

function providerMatches(left: string, right: string): boolean {
  if (left === right) return true;
  const lrule = providerEnvRule(left);
  const rrule = providerEnvRule(right);
  return lrule !== undefined && lrule === rrule;
}

function isCloudflareVerifyOk(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const record = body as { success?: unknown; result?: unknown };
  if (record.success !== true) return false;
  const result = record.result;
  if (result === null || typeof result !== "object") return false;
  return (result as { status?: unknown }).status === "active";
}

function normalizeScope(
  scope: ConnectionScopeHints | undefined,
): ConnectionScopeHints | undefined {
  if (!scope) return undefined;
  const out: {
    accountId?: string;
    zoneId?: string;
    username?: string;
    knownHostsEntry?: string;
  } = {};
  if (typeof scope.accountId === "string" && scope.accountId.length > 0) {
    out.accountId = scope.accountId;
  }
  if (typeof scope.zoneId === "string" && scope.zoneId.length > 0) {
    out.zoneId = scope.zoneId;
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
  return Object.keys(out).length > 0 ? out : undefined;
}

function isSourceGitKind(
  kind: Connection["kind"] | undefined,
): kind is SourceGitConnectionKind {
  return kind === "source_git_https_token" || kind === "source_git_ssh_key";
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
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
