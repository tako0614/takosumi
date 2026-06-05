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
  ConnectionScope,
  CreateConnectionRequest,
} from "takosumi-contract/deploy-control-api";
import {
  allowedEnvNamesForProvider,
  cloudFamilyForProvider,
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

export interface RegisterConnectionInput extends CreateConnectionRequest {
  /** Defaults to `"customer"` when omitted. */
  readonly owner?: Connection["owner"];
}

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

export interface ConnectionVault {
  register(input: RegisterConnectionInput): Promise<Connection>;
  test(connectionId: string): Promise<TestConnectionResult>;
  revoke(id: string): Promise<boolean>;
  /**
   * Mints a {@link CredentialBundle} of env vars for the given providers within
   * a space. Phase 1: static pass-through of decrypted values for matching
   * verified connections (falls back to pending with a flagged warning).
   */
  mint(spaceId: string, providers: readonly string[]): Promise<CredentialBundle>;
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
    requireNonEmpty(input.spaceId, "spaceId");
    requireNonEmpty(input.provider, "provider");
    if (input.authMethod !== "static_secret") {
      // Phase 1 implements static_secret only; other methods are reserved.
      throw new ConnectionVaultError(
        "not_implemented",
        `authMethod ${String(input.authMethod)} is not implemented (Phase 1 supports static_secret)`,
      );
    }
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
        spaceId: input.spaceId,
        provider: input.provider,
      },
    };
    await this.#store.putSecretBlob(blob);

    const nowIso = this.#now().toISOString();
    const connection: Connection = {
      id,
      spaceId: input.spaceId,
      provider: input.provider,
      owner: input.owner ?? "customer",
      authMethod: "static_secret",
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "pending",
      ...(normalizeScope(input.scope) ? { scope: normalizeScope(input.scope) } : {}),
      envNames: [...envNames].sort(),
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
  ): Promise<CredentialBundle> {
    requireNonEmpty(spaceId, "spaceId");
    const connections = await this.#store.listConnections(spaceId);
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

function selectConnectionForProvider(
  connections: readonly Connection[],
  provider: string,
): Connection | undefined {
  const matches = connections.filter(
    (c) => c.status !== "revoked" && providerMatches(c.provider, provider),
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
  scope: ConnectionScope | undefined,
): ConnectionScope | undefined {
  if (!scope) return undefined;
  const out: { accountId?: string; zoneId?: string } = {};
  if (typeof scope.accountId === "string" && scope.accountId.length > 0) {
    out.accountId = scope.accountId;
  }
  if (typeof scope.zoneId === "string" && scope.zoneId.length > 0) {
    out.zoneId = scope.zoneId;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
