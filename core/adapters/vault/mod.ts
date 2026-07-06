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
  type MintedFile,
  type MintResponse,
  type SourceGitConnectionKind,
} from "takosumi-contract/sources";
import {
  allowedEnvNamesForProvider,
  canonicalProviderSource,
  cloudFamilyForProvider,
  providerCredentialArgs,
  providerEnvRule,
  requiredEnvGroupsForProvider,
  requiredEnvGroupsSatisfied,
  sameProviderFamily,
} from "takosumi-contract/provider-env-rules";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import { providerForAddress } from "@takosumi/providers";
import { cloudflareCredentialDriver } from "@takosumi/providers/cloudflare/connection.ts";
import { CloudflareCredentialError } from "@takosumi/providers/cloudflare/credentials.ts";
import {
  AwsConnectionError,
  mintAwsAssumeRoleCredentials,
  verifyAwsAssumeRole,
} from "@takosumi/providers/aws/credentials.ts";
import {
  GitCredentialMintError,
  mintGitSourceCredential,
} from "@takosumi/providers/git/credentials.ts";
import {
  mintGenericEnvProviderVariables,
  GenericEnvProviderDriverError,
} from "@takosumi/providers/generic-env-provider/credentials.ts";
import {
  validateGenericEnvProviderRegistration,
  GenericEnvProviderConnectionError,
} from "@takosumi/providers/generic-env-provider/connection.ts";
import { verifyDriverForKind } from "./verify_drivers.ts";
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

export interface ManagedProviderCredentialIssueRequest {
  readonly workspaceId: string;
  readonly installationId?: string;
  readonly connection: Connection;
  readonly phase?: MintPhase;
  readonly delivery: ProviderCredentialMintEvidence["delivery"];
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
  if (
    input.workspaceId !== undefined &&
    input.spaceId !== undefined &&
    input.workspaceId !== input.spaceId
  ) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "workspaceId and spaceId must match when both are supplied",
    );
  }
  return input.workspaceId ?? input.spaceId;
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
 *   - `plan` / `apply` / `destroy` -> ONLY provider env bindings; git excluded.
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

/** One provider env binding credential mint entry. */
export interface InstallationProviderEnvBindingMintEntry {
  /** Provider rule, short (`cloudflare`) or registry form. */
  readonly provider: string;
  /** Optional OpenTofu provider alias declared by the generated root. */
  readonly alias?: string;
  /** The Connection this provider env binding resolved to. */
  readonly connectionId: string;
}

export type InstallationProviderEnvBindingDelivery =
  ProviderCredentialMintEvidence["delivery"];

export interface InstallationProviderEnvBindingMintOptions {
  readonly phase?: MintPhase;
  readonly installationId?: string;
  /**
   * `generated_root_variable` is the normal OpenTofu plan/apply path: provider
   * credentials become TF_VAR_<provider>_<alias>_<arg> so only the generated
   * root provider block sees them. `provider_env` is for flows whose generated
   * root intentionally leaves provider credentials in native env names, such as
   * runner-executed release commands or managed compatibility targets that only
   * render a provider `base_url`.
   */
  readonly delivery?: InstallationProviderEnvBindingDelivery;
}

export interface ConnectionVault {
  register(input: RegisterConnectionInput): Promise<Connection>;
  test(connectionId: string): Promise<TestConnectionResult>;
  revoke(id: string): Promise<boolean>;
  /**
   * Mints a {@link CredentialBundle} of env vars for the given providers within
   * a space. Only verified connections may mint. This is the default
   * provider-mint helper for plan/apply callers; it is equivalent to
   * `mintForPhase({ phase: "plan", providers })`.
   */
  mint(
    spaceId: string,
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
   * vault re-validates the id (existence + space ownership, like
   * {@link MintRequest.connectionIds}), opens the connection's sealed values, and
   * maps built-in provider credential env names to
   * `TF_VAR_<provider>_<alias>_<arg>` entries using the provider arg mapping
   * (cloudflare: `api_token`; aws: `access_key` / `secret_key` / `token`). A
   * generic-env Provider Connection maps its declared variables to process env
   * under the same names (for example `SNOWFLAKE_PASSWORD`), so arbitrary
   * providers can read their normal environment variables. A connection whose
   * provider has neither mapping contributes no env.
   * Phase rule: tofu phases only (plan / apply / destroy). The returned bundle
   * carries runner-dispatch env only and is never serialized into logs.
   */
  mintForInstallationProviderEnvBindings(
    spaceId: string,
    entries: readonly InstallationProviderEnvBindingMintEntry[],
    options?: InstallationProviderEnvBindingMintOptions,
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
}

interface ProviderSecretMaterial {
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly MintedFile[];
}

type CloudflareTokenVendingConfig = NonNullable<
  ConnectionScopeHints["cloudflareTokenVending"]
>;

/** Injected fetch implementation so `test()` is unit-testable without real network. */
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
  readonly managedProviderCredentialIssuer?: ManagedProviderCredentialIssuer;
}

export class StaticSecretConnectionVault implements ConnectionVault {
  readonly #store: OpenTofuDeploymentStore;
  readonly #crypto: SecretBoundaryCrypto;
  readonly #fetch: VaultFetch;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #managedProviderCredentialIssuer?: ManagedProviderCredentialIssuer;

  constructor(deps: StaticSecretConnectionVaultDependencies) {
    this.#store = deps.store;
    this.#crypto = deps.crypto;
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? defaultConnectionId;
    this.#managedProviderCredentialIssuer =
      deps.managedProviderCredentialIssuer;
  }

  async register(input: RegisterConnectionInput): Promise<Connection> {
    const workspaceId = workspaceIdForConnectionInput(input);
    // spaceId is absent for a global helper connection; when
    // present it must be a real id.
    if (workspaceId !== undefined || input.scope === "space") {
      requireNonEmpty(workspaceId, "spaceId");
    }
    // Privilege-escalation guard: a global helper connection has NO owning
    // Space, so a caller-supplied `scope: "operator"` must never win against a
    // present spaceId. A hybrid `{ spaceId, scope: "operator" }` row would
    // otherwise bypass the `scope === "space" && spaceId mismatch` cross-tenant
    // guard at mint time, letting any Space bind another Space's secret.
    if (workspaceId !== undefined && input.scope === "operator") {
      throw new ConnectionVaultError(
        "invalid_argument",
        "operator-scoped connections must not have an owning space (omit spaceId for scope: operator)",
      );
    }
    if (isSourceGitKind(input.kind)) {
      return await this.#registerGitConnection(input, input.kind);
    }
    requireNonEmpty(input.provider, "provider");
    const genericEnvRegistration =
      input.kind === "generic_env_provider"
        ? validateGenericEnvProviderInput(input)
        : undefined;
    if (!genericEnvRegistration && input.files && input.files.length > 0) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "provider credential files require a generic_env_provider Connection",
      );
    }
    const rule = providerEnvRule(input.provider);
    if (!rule && !genericEnvRegistration) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `provider ${input.provider} has no built-in Credential Recipe; use a generic_env_provider Connection with explicit env names`,
      );
    }
    let values = genericEnvRegistration?.values ?? input.values;
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
    if (isGcpServiceAccountJsonRegistration(input)) {
      values = normalizeGcpServiceAccountJsonValues(input, values);
    }
    const valueEnvNames = Object.keys(values);
    const envNames = genericEnvRegistration?.envNames ?? valueEnvNames;
    if (envNames.length === 0) {
      throw new ConnectionVaultError(
        "invalid_argument",
        "values must supply at least one env name",
      );
    }
    const allowed = new Set(
      genericEnvRegistration
        ? genericEnvRegistration.envNames
        : rule
          ? allowedEnvNamesForProvider(input.provider)
          : [],
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
      !genericEnvRegistration &&
      rule &&
      !requiredEnvGroupsSatisfied(input.provider, valueEnvNames)
    ) {
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
    const secretMaterial = genericEnvRegistration
      ? {
          env: values,
          files: genericEnvRegistration.files,
        }
      : values;
    const sealed = await this.#crypto.seal(
      JSON.stringify(secretMaterial),
      cloudPartition,
      secretEnvelopeAad({
        cloudPartition,
        ...(workspaceId ? { spaceId: workspaceId } : {}),
        connectionId: id,
        provider: input.provider,
      }),
    );
    const now = this.#now();
    const nowIso = now.toISOString();
    const connectionKind =
      input.kind ?? providerConnectionKindFor(input.provider);
    const blob = makeStoredSecretBlob({
      connectionId: id,
      ...(workspaceId ? { spaceId: workspaceId } : {}),
      provider: input.provider,
      connectionKind,
      sealed,
      cloudPartition,
      createdAt: nowIso,
      crypto: this.#crypto,
    });
    await this.#store.putSecretBlob(blob);

    const expiresAt = normalizeConnectionExpiresAt(input.expiresAt, now);
    const connection: Connection = {
      id,
      ...(workspaceId ? { workspaceId, spaceId: workspaceId } : {}),
      provider: input.provider,
      providerSource: canonicalProviderSource(input.provider),
      kind: connectionKind,
      scope: input.scope ?? (workspaceId ? "space" : "operator"),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "pending",
      materialization: input.materialization ?? "secret",
      ...(normalizeScope(input.scopeHints)
        ? { scopeHints: normalizeScope(input.scopeHints) }
        : {}),
      envNames: [...envNames].sort(),
      ...(genericEnvRegistration &&
      genericEnvRegistration.fileEnvNames.length > 0
        ? { fileEnvNames: genericEnvRegistration.fileEnvNames }
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
   * Git connections are sealed under the `local-adapters` partition (no provider
   * cloud family) and recorded with `kind` so the mint phase rules can exclude
   * them from the tofu phases.
   */
  async #registerGitConnection(
    input: RegisterConnectionInput,
    kind: SourceGitConnectionKind,
  ): Promise<Connection> {
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
    // A git connection stores `provider: kind`, so the AAD binds to `kind` to
    // match the open-time derivation in `connectionEnvelopeAad`.
    const sealed = await this.#crypto.seal(
      JSON.stringify(values),
      cloudPartition,
      secretEnvelopeAad({
        cloudPartition,
        ...(workspaceId ? { spaceId: workspaceId } : {}),
        connectionId: id,
        provider: kind,
      }),
    );
    const now = this.#now();
    const nowIso = now.toISOString();
    const blob = makeStoredSecretBlob({
      connectionId: id,
      ...(workspaceId ? { spaceId: workspaceId } : {}),
      provider: kind,
      connectionKind: kind,
      sealed,
      cloudPartition,
      createdAt: nowIso,
      crypto: this.#crypto,
    });
    await this.#store.putSecretBlob(blob);

    const expiresAt = normalizeConnectionExpiresAt(input.expiresAt, now);
    const connection: Connection = {
      id,
      ...(workspaceId ? { workspaceId, spaceId: workspaceId } : {}),
      provider: kind,
      providerSource: canonicalProviderSource(kind),
      kind,
      scope: input.scope ?? (workspaceId ? "space" : "operator"),
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
    const values = await this.#openValues(connection);
    let verified: { readonly ok: boolean; readonly detail?: string };
    if (connection.kind === "generic_env_provider") {
      const driver = verifyDriverForKind(connection.kind);
      if (!driver) {
        return {
          status: "pending",
          detail:
            "no verification driver is configured for generic-env provider connections",
        };
      }
      verified = await driver({ connection, values, fetch: this.#fetch });
    } else if (isReservedGcpConnection(connection)) {
      return {
        status: "pending",
        detail:
          "reserved (gcp live verification and credential mint drivers pending)",
      };
    } else if (isCloudflareProvider(connection.provider)) {
      const token = values.CLOUDFLARE_API_TOKEN ?? values.CF_API_TOKEN;
      const accountId =
        values.CLOUDFLARE_ACCOUNT_ID?.trim() ||
        values.CF_ACCOUNT_ID?.trim() ||
        connection.scopeHints?.accountId?.trim();
      if (!token) {
        return {
          status: "pending",
          detail:
            "no cloudflare api token to verify (CLOUDFLARE_API_TOKEN / CF_API_TOKEN)",
        };
      }
      verified = await cloudflareCredentialDriver.verify({
        token,
        ...(accountId ? { accountId } : {}),
        fetch: this.#fetch,
      });
    } else if (isAwsProvider(connection.provider)) {
      verified = await verifyAwsAssumeRole(connection, values, {
        fetch: this.#fetch,
        now: this.#now,
      });
    } else {
      // Per-ConnectionKind verify driver (git_https smart-HTTP probe,
      // generic_env_provider structural, git_ssh reserved-structural, GCP
      // reserved-pending). Git / generic-env can reach `verified`; GCP stays
      // pending until a real verify + mint driver is wired.
      const driver = verifyDriverForKind(connection.kind);
      if (!driver) {
        return {
          status: "pending",
          detail: `no verification driver is configured for connection kind ${connection.kind ?? "(unknown)"} (provider ${connection.provider})`,
        };
      }
      verified = await driver({ connection, values, fetch: this.#fetch });
    }
    if (!verified.ok) {
      return { status: "pending", detail: verified.detail };
    }
    const verifiedAtIso = this.#now().toISOString();
    const verifiedConnection: Connection = {
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
      assertConnectionVerifiedUnlessManagedProvider(match);
      const minted =
        (await this.#mintManagedProviderValues(spaceId, match, {
          delivery: "provider_env",
        })) ?? (await this.#mintProviderValues(match, "provider_env"));
      evidence.push(minted.evidence);
      for (const [name, value] of Object.entries(minted.values)) {
        env[name] = value;
      }
    }
    return new CredentialBundle(env, [], evidence);
  }

  /**
   * Per-connection credential mint. See {@link ConnectionVault.mintForInstallationProviderEnvBindings}.
   * Re-validates each connection id (existence + space ownership) before opening
   * any value, so a caller can never mint a connection from another space. Maps
   * each built-in provider connection's credential env to
   * `TF_VAR_<provider>_<alias>_<arg>` using the provider arg mapping. Generic
   * provider connections may also return runner-only credential files whose
   * paths are exposed through declared env names.
   */
  async mintForInstallationProviderEnvBindings(
    spaceId: string,
    entries: readonly InstallationProviderEnvBindingMintEntry[],
    options?: InstallationProviderEnvBindingMintOptions,
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
        `mintForInstallationProviderEnvBindings is tofu-phase only; ${phase} phase must not request provider credentials`,
      );
    }
    const env: Record<string, string> = {};
    const files: MintedFileInternal[] = [];
    const evidence: ProviderCredentialMintEvidence[] = [];
    const delivery = options?.delivery ?? "generated_root_variable";
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
          `connection ${entry.connectionId} is a git source connection and cannot back a provider env binding`,
        );
      }
      if (!sameProviderFamily(entry.provider, connection.provider)) {
        throw new ConnectionVaultError(
          "failed_precondition",
          `connection ${entry.connectionId} provider ${connection.provider} does not match InstallationProviderEnvBinding provider ${entry.provider}`,
        );
      }
      assertConnectionVerifiedUnlessManagedProvider(connection);
      assertProviderMintDriverAvailable(connection);
      const customBundle = await this.#mintCustomProviderVariables(
        connection,
        entry.alias,
      );
      if (customBundle) {
        mergeCredentialEnv(env, customBundle.env, entry);
        files.push(...customBundle.files);
        evidence.push(customBundle.evidence);
        continue;
      }
      if (delivery === "provider_env") {
        const minted =
          (await this.#mintManagedProviderValues(spaceId, connection, {
            phase,
            delivery,
            ...(options?.installationId
              ? { installationId: options.installationId }
              : {}),
          })) ?? (await this.#mintProviderValues(connection, delivery));
        evidence.push(minted.evidence);
        mergeCredentialEnv(env, minted.values, entry);
        continue;
      }
      const argMap = providerCredentialArgs(connection.provider);
      if (argMap.length === 0) {
        // No per-alias split for this provider: rootgen emits a credential-free
        // alias and no shared provider env is admitted by the runner unless the
        // connection was the generic-env carrier handled above.
        continue;
      }
      const minted =
        (await this.#mintManagedProviderValues(spaceId, connection, {
          phase,
          delivery: "generated_root_variable",
          ...(options?.installationId
            ? { installationId: options.installationId }
            : {}),
        })) ??
        (await this.#mintProviderValues(connection, "generated_root_variable"));
      evidence.push(minted.evidence);
      const localProvider = providerLocalName(connection.provider);
      for (const { envName, arg } of argMap) {
        const value = minted.values[envName];
        if (typeof value !== "string") continue;
        mergeCredentialEnv(
          env,
          {
            [`TF_VAR_${providerCredentialVarName(localProvider, entry.alias, arg)}`]:
              value,
          },
          entry,
        );
      }
    }
    return new PhaseMintBundle(
      { env, ...(files.length > 0 ? { files } : {}) },
      [],
      evidence,
    );
  }

  async #mintCustomProviderVariables(
    connection: Connection,
    alias: string | undefined,
  ): Promise<
    | {
        readonly env: Readonly<Record<string, string>>;
        readonly files: readonly MintedFileInternal[];
        readonly evidence: ProviderCredentialMintEvidence;
      }
    | undefined
  > {
    // A non-generic-env connection contributes nothing and never needs its blob
    // opened (the driver's own `undefined` branch is structural-only). Gate the
    // crypto here so the open happens only for the generic-env provider kind.
    if (connection.kind !== "generic_env_provider") return undefined;
    const material = await this.#openProviderSecretMaterial(connection);
    // The generic-env provider driver maps the opened values to process env
    // entries under the declared names, plus non-secret mint evidence.
    // Its scope-precondition error is re-wrapped to the vault's surface so the
    // message text stays byte-identical for callers/tests.
    try {
      return mintGenericEnvProviderVariables(
        connection,
        material.env,
        material.files,
        alias,
      );
    } catch (error) {
      throw wrapDriverError(error);
    }
  }

  async #mintManagedProviderValues(
    workspaceId: string,
    connection: Connection,
    options: {
      readonly installationId?: string;
      readonly phase?: MintPhase;
      readonly delivery: ProviderCredentialMintEvidence["delivery"];
    },
  ): Promise<MintedProviderValues | undefined> {
    if (connection.scopeHints?.managedProvider !== true) return undefined;
    const issuer = this.#managedProviderCredentialIssuer;
    if (!issuer) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `managed provider connection ${connection.id} requires a managed provider credential issuer`,
      );
    }
    const issued = await issuer({
      workspaceId,
      ...(options.installationId ? { installationId: options.installationId } : {}),
      connection,
      delivery: options.delivery,
      ...(options.phase ? { phase: options.phase } : {}),
    });
    if (!issued) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `managed provider connection ${connection.id} could not mint a run-scoped provider token`,
      );
    }
    return {
      values: issued.values,
      evidence: {
        providerEnvId: connection.id,
        connectionId: connection.id,
        provider: connection.provider,
        delivery: options.delivery,
        rootOnly: options.delivery === "generated_root_variable",
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
   * A git connection is NEVER minted for a tofu phase, and a provider env binding
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

    // The git source driver (`@takosumi/providers/git`) turns the opened secret
    // values + the connection context into the runner-facing askpass / ssh key
    // files. Crypto / connection-state validation stayed in core above; the
    // driver's typed error is re-wrapped so its byte-identical message text keeps
    // the same `failed_precondition` surface for callers/tests.
    try {
      const response = mintGitSourceCredential(values, {
        connectionId,
        kind: connection.kind,
        ...(connection.scopeHints?.username
          ? { username: connection.scopeHints.username }
          : {}),
        ...(connection.scopeHints?.knownHostsEntry
          ? { knownHostsEntry: connection.scopeHints.knownHostsEntry }
          : {}),
      });
      return new PhaseMintBundle(response, []);
    } catch (error) {
      throw wrapDriverError(error);
    }
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
    const expiredConnection: Connection = {
      ...connection,
      status: "expired",
      updatedAt: nowIso,
    };
    await this.#store.putConnection(expiredConnection);
  }

  async #openProviderSecretMaterial(
    connection: Connection,
  ): Promise<ProviderSecretMaterial> {
    const blob = await this.#store.getSecretBlob(connection.id);
    if (!blob) {
      throw new ConnectionVaultError(
        "failed_precondition",
        `connection ${connection.id} has no secret blob`,
      );
    }
    // Partition and AAD are derived from the CONNECTION ROW — never from the
    // blob's self-described `aad.cloudPartition` — so a swapped or tampered blob
    // cannot select its provider env/AAD and fails the AES-GCM auth tag.
    const plaintext = await this.#crypto.open(
      base64ToBytes(blob.ciphertext),
      cloudFamilyForProvider(connection.provider) as CloudPartition,
      connectionEnvelopeAad(connection),
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

  async #openValues(connection: Connection): Promise<Record<string, string>> {
    return { ...(await this.#openProviderSecretMaterial(connection)).env };
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
        providerEnvId: connection.id,
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
    if (isReservedGcpConnection(connection)) {
      throw reservedProviderMintDriverError("gcp");
    }
    // Cloudflare token-vending: the driver mints a short-lived scoped token from
    // the opened bootstrap token (`@takosumi/providers/cloudflare`). Crypto /
    // opening stayed in core above; the driver only talks to the CF API. Its
    // typed error is re-wrapped into the vault's `failed_precondition` surface
    // so the message text stays byte-identical for callers/tests.
    if (
      cloudflareCredentialDriver.isProvider(connection.provider) &&
      cloudflareCredentialDriver.isTokenVending(connection)
    ) {
      try {
        return await cloudflareCredentialDriver.mint({
          connection,
          values,
          delivery,
          fetch: this.#fetch,
          now: this.#now,
        });
      } catch (error) {
        throw wrapDriverError(error);
      }
    }
    // AWS AssumeRole: the driver mints temporary STS credentials from the opened
    // source credentials + the connection's AWS scope hints
    // (`@takosumi/providers/aws`). It returns `undefined` when AssumeRole does
    // not apply (non-AWS provider or no `awsRoleArn`), so the vault falls through
    // to the static-secret path unchanged.
    let awsMinted: MintedProviderValues | undefined;
    try {
      awsMinted = await mintAwsAssumeRoleCredentials(
        connection,
        values,
        delivery,
        staticEvidence,
        { fetch: this.#fetch, now: this.#now },
      );
    } catch (error) {
      throw wrapDriverError(error);
    }
    if (awsMinted) return awsMinted;
    return { values, evidence: staticEvidence() };
  }
}

/**
 * Local provider name used as the `<provider>` segment of the per-connection
 * credential var (`TF_VAR_<provider>_<alias>_<arg>`). Mirrors rootgen's
 * `providerLocalName`: the trailing type segment of the provider rule (e.g.
 * `cloudflare/cloudflare` / `cloudflare` -> `cloudflare`; `hashicorp/aws` ->
 * `aws`). The connection's `provider` is a registered short name in practice, so
 * this is usually identity; the split handles a registry-path provider too.
 */
function providerLocalName(provider: string): string {
  const rule = providerEnvRule(provider);
  if (rule) return rule.shortName;
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

function mergeCredentialEnv(
  target: Record<string, string>,
  source: Readonly<Record<string, string>>,
  entry: InstallationProviderEnvBindingMintEntry,
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
      sameProviderFamily(c.provider, provider),
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

function assertConnectionVerifiedUnlessManagedProvider(
  connection: Connection,
): void {
  if (connection.scopeHints?.managedProvider === true) return;
  assertConnectionVerified(connection);
}

function assertProviderMintDriverAvailable(connection: Connection): void {
  if (isReservedGcpConnection(connection)) {
    throw reservedProviderMintDriverError("gcp");
  }
}

function isReservedGcpConnection(connection: Connection): boolean {
  if (
    connection.kind === "gcp_oauth_bootstrap" ||
    connection.kind === "gcp_service_account_impersonation"
  ) {
    return true;
  }
  // Folded from the former `gcp_oauth_bootstrap` credentialDriver: an
  // OAuth-minted google credential (registered with kind generic_env_provider)
  // is still a reserved gcp mint until the gcp mint driver is wired. Cloudflare
  // OAuth (materialization oauth, provider cloudflare) is NOT reserved.
  return (
    connection.materialization === "oauth" &&
    sameProviderFamily(connection.provider, "google")
  );
}

function reservedProviderMintDriverError(
  provider: string,
): ConnectionVaultError {
  return new ConnectionVaultError(
    "not_implemented",
    `${provider} credential mint driver is not wired`,
  );
}

function isAwsProvider(provider: string): boolean {
  return providerForAddress(provider)?.id === "aws";
}

function isCloudflareProvider(provider: string): boolean {
  return providerForAddress(provider)?.id === "cloudflare";
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
    workersSubdomain?: string;
    managedProvider?: boolean;
    providerBaseUrl?: string;
    managedProviderProfile?: string;
    cloudflareTokenVending?: ConnectionScopeHints["cloudflareTokenVending"];
    username?: string;
    knownHostsEntry?: string;
    awsRoleArn?: string;
    awsExternalId?: string;
    awsRegion?: string;
    gcpServiceAccountEmail?: string;
    gcpProjectId?: string;
    templateId?: string;
  } = {};
  if (typeof scope.accountId === "string" && scope.accountId.length > 0) {
    out.accountId = scope.accountId;
  }
  if (typeof scope.zoneId === "string" && scope.zoneId.length > 0) {
    out.zoneId = scope.zoneId;
  }
  if (
    typeof scope.workersSubdomain === "string" &&
    scope.workersSubdomain.length > 0
  ) {
    out.workersSubdomain = scope.workersSubdomain;
  }
  if (scope.managedProvider === true) {
    out.managedProvider = true;
  }
  if (
    typeof scope.providerBaseUrl === "string" &&
    scope.providerBaseUrl.length > 0
  ) {
    out.providerBaseUrl = scope.providerBaseUrl;
  }
  if (
    typeof scope.managedProviderProfile === "string" &&
    scope.managedProviderProfile.length > 0
  ) {
    out.managedProviderProfile = scope.managedProviderProfile;
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
  if (typeof scope.templateId === "string" && scope.templateId.length > 0) {
    out.templateId = scope.templateId;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
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

function defaultConnectionId(): string {
  return `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function validateGenericEnvProviderInput(
  input: RegisterConnectionInput,
): ReturnType<typeof validateGenericEnvProviderRegistration> {
  try {
    return validateGenericEnvProviderRegistration(input);
  } catch (error) {
    if (error instanceof GenericEnvProviderConnectionError) {
      throw new ConnectionVaultError(error.code, error.message);
    }
    throw error;
  }
}

function isGcpServiceAccountJsonRegistration(
  input: RegisterConnectionInput,
): boolean {
  return input.kind === "gcp_service_account_json";
}

function normalizeGcpServiceAccountJsonValues(
  input: RegisterConnectionInput,
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!sameProviderFamily(input.provider, "google")) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "gcp_service_account_json requires provider google",
    );
  }
  const raw = values.GOOGLE_CREDENTIALS;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "gcp_service_account_json requires GOOGLE_CREDENTIALS",
    );
  }
  const parsed = parseGcpServiceAccountJson(raw);
  if (parsed.type !== "service_account") {
    throw new ConnectionVaultError(
      "invalid_argument",
      "gcp_service_account_json requires a service_account credential JSON",
    );
  }
  for (const field of ["client_email", "private_key"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field].length === 0) {
      throw new ConnectionVaultError(
        "invalid_argument",
        `gcp_service_account_json credential JSON is missing ${field}`,
      );
    }
  }
  const project =
    nonEmpty(values.GOOGLE_CLOUD_PROJECT) ??
    nonEmpty(values.GOOGLE_PROJECT) ??
    nonEmpty(parsed.project_id);
  if (!project) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "gcp_service_account_json requires GOOGLE_CLOUD_PROJECT or credential JSON project_id",
    );
  }
  return {
    ...values,
    GOOGLE_CLOUD_PROJECT: project,
  };
}

function parseGcpServiceAccountJson(
  value: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ConnectionVaultError(
      "invalid_argument",
      "gcp_service_account_json GOOGLE_CREDENTIALS must be valid JSON",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectionVaultError(
      "invalid_argument",
      "gcp_service_account_json GOOGLE_CREDENTIALS must be a JSON object",
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Re-wraps a per-provider credential driver error into the vault's own
 * {@link ConnectionVaultError} surface. Each driver
 * (`@takosumi/providers/{cloudflare,aws,git,generic-env-provider}`) raises its own
 * typed error whose `message` text is byte-identical to the formerly-inline
 * vault message; all of them map to `failed_precondition` (the same code the
 * inline paths threw). Any other error is rethrown unchanged so unexpected
 * failures are not masked.
 */
function wrapDriverError(error: unknown): unknown {
  if (
    error instanceof CloudflareCredentialError ||
    error instanceof AwsConnectionError ||
    error instanceof GitCredentialMintError ||
    error instanceof GenericEnvProviderDriverError
  ) {
    return new ConnectionVaultError("failed_precondition", error.message);
  }
  return error;
}

/**
 * Identity fields bound into the at-rest secret envelope's canonical AAD. The
 * AAD ties a sealed blob to the CONNECTION ROW it belongs to so that opening it
 * under a different connection / space / provider / partition fails the AES-GCM
 * auth tag (a swapped or tampered blob never decrypts). `spaceId` falls back to
 * {@link OPERATOR_SCOPE_AAD} for operator-scoped rows that have no owning Space.
 */
interface SecretEnvelopeIdentity {
  readonly cloudPartition: CloudPartition;
  readonly spaceId?: string;
  readonly connectionId: string;
  readonly provider: string;
}

/**
 * Derives the canonical AES-GCM AAD bytes from a connection row's identity. The
 * same identity MUST be reconstructed at seal and open time; at open we derive
 * `cloudPartition` from the connection row's provider (never from the blob's
 * self-described partition) so a tampered/swapped blob cannot pick its provider env.
 */
function secretEnvelopeAad(identity: SecretEnvelopeIdentity): Uint8Array {
  const canonical = JSON.stringify({
    v: 1,
    cloudPartition: identity.cloudPartition,
    spaceId: identity.spaceId ?? OPERATOR_SCOPE_AAD,
    connectionId: identity.connectionId,
    provider: identity.provider,
  });
  return new TextEncoder().encode(canonical);
}

/**
 * Reconstructs the at-rest AAD identity from a stored connection row. The
 * partition is recomputed from the provider (mirroring the register path), so
 * the blob's own `aad` partition field is never trusted at open time.
 */
function connectionEnvelopeAad(connection: Connection): Uint8Array {
  return secretEnvelopeAad({
    cloudPartition: cloudFamilyForProvider(
      connection.provider,
    ) as CloudPartition,
    ...(connection.spaceId ? { spaceId: connection.spaceId } : {}),
    connectionId: connection.id,
    provider: connection.provider,
  });
}

function makeStoredSecretBlob(input: {
  readonly connectionId: string;
  readonly spaceId?: string;
  readonly provider: string;
  readonly connectionKind?: ConnectionKind;
  readonly sealed: Uint8Array;
  readonly cloudPartition: CloudPartition;
  readonly createdAt: string;
  readonly crypto: SecretBoundaryCrypto;
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
    // The IV is the ciphertext prefix; `nonce` is a non-load-bearing mirror of
    // it kept for the persisted `NOT NULL` column (never read for decryption).
    nonce: bytesToBase64(input.sealed.slice(0, 12)),
    aad: JSON.stringify(aad),
    // Real key-version fingerprint of the active passphrase (rotation-detectable)
    // when the crypto exposes one; falls back to the legacy `1` for keyless
    // (placeholder / dev) crypto so existing dev blobs keep a stable version.
    keyVersion: input.crypto.keyVersion?.(input.cloudPartition) ?? 1,
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
    return "gcp_service_account_json";
  }
  return "static_secret";
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
