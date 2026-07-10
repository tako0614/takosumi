/**
 * Connections domain: Provider Connection binding resolution.
 *
 * After the credential-model collapse a Provider Connection IS the stored
 * credential record (the former `Connection` substrate + `ProviderEnv` resolver
 * projection folded onto one row). OpenTofu provider execution is bound through
 * these rows; the vault opens the sealed material at run time. Official hosted
 * provider compatibility profile handlers and managed-resource backends are
 * Operator/Cloud extensions, not OSS resolver materializations.
 */
import type {
  Connection,
  Installation,
} from "@takosumi/internal/deploy-control-api";
import { randomUUID } from "node:crypto";
import type {
  ProviderBinding,
  ProviderBindings,
  ProviderConnectionMaterialization,
} from "takosumi-contract/connections";
import { sameProviderFamily } from "takosumi-contract/provider-env-rules";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";

/** One Provider Connection binding's resolution outcome. */
export interface ResolvedInstallationProviderEnvBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly connection: Connection;
  readonly materialization: ProviderConnectionMaterialization;
}

export function validateInstallationProviderEnvBindings(
  value: unknown,
  field = "providerBindings",
): ProviderBindings {
  if (!Array.isArray(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be an array`,
    );
  }
  return value.map((entry, index) =>
    validateInstallationProviderEnvBinding(entry, `${field}[${index}]`),
  );
}

function validateInstallationProviderEnvBinding(
  value: unknown,
  field: string,
): ProviderBinding {
  if (!isRecord(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be an object`,
    );
  }
  const provider = nonEmptyField(value.provider, `${field}.provider`);
  // Accept the legacy `envId` field name (provider env id == connection id) so
  // binding sets serialized before the credential-model collapse keep resolving.
  const connectionId = nonEmptyField(
    value.connectionId ?? value.envId,
    `${field}.connectionId`,
  );
  const alias =
    value.alias === undefined
      ? undefined
      : nonEmptyField(value.alias, `${field}.alias`);
  const region =
    value.region === undefined
      ? undefined
      : nonEmptyField(value.region, `${field}.region`);
  return {
    provider,
    connectionId,
    ...(alias ? { alias } : {}),
    ...(region ? { region } : {}),
  };
}

function nonEmptyField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stable digest over a run's resolved Provider Connection bindings. The field
 * projection is kept byte-identical to the pre-collapse `ProviderEnv` projection
 * (`envId`/`connectionId` are the connection id). Mutable verification status
 * is deliberately excluded: a pending-to-verified transition does not change
 * which credential binding the plan reviewed, while revocation still fails in
 * binding resolution before credential minting.
 */
export async function resolvedProviderEnvBindingsDigest(
  resolved: readonly ResolvedInstallationProviderEnvBinding[] | undefined,
): Promise<string> {
  const entries = (resolved ?? [])
    .map((entry) => ({
      provider: entry.provider,
      alias: entry.alias ?? null,
      envId: entry.connection.id,
      materialization: entry.connection.materialization,
      connectionId: entry.connection.id,
      envNames: [...entry.connection.envNames].sort(),
    }))
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        String(a.alias).localeCompare(String(b.alias)),
    );
  return await stableJsonDigest(entries);
}

export interface ConnectionsServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  /**
   * Takosumi Cloud may expose a Space-scoped Provider Connection that is backed
   * by an operator-scoped credential. OSS leaves this disabled so self-hosted
   * operator credentials never become bindable by accident.
   */
  readonly allowOperatorBackedProviderEnvs?: boolean;
}

export class ConnectionsService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;
  readonly #allowOperatorBackedProviderEnvs: boolean;

  constructor(dependencies: ConnectionsServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId =
      dependencies.newId ??
      ((prefix) =>
        `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#allowOperatorBackedProviderEnvs =
      dependencies.allowOperatorBackedProviderEnvs === true;
  }

  /**
   * Lists the provider-bindable Provider Connections visible to a Space. Source
   * git connections are never provider connections and are excluded.
   */
  async listProviderConnections(
    spaceId?: string,
  ): Promise<readonly Connection[]> {
    const connections = spaceId
      ? await this.#store.listConnections(spaceId)
      : [];
    const operatorManagedConnections =
      spaceId && this.#allowOperatorBackedProviderEnvs
        ? (await this.#store.listOperatorConnections()).filter(
            isPublicManagedProviderConnection,
          )
        : [];
    return [...connections, ...operatorManagedConnections].filter(
      (connection) => !isSourceGitKind(connection),
    );
  }

  async getProviderConnection(id: string): Promise<Connection> {
    const connection = await this.#store.getConnection(nonEmptyField(id, "id"));
    if (!connection || isSourceGitKind(connection)) {
      throw new OpenTofuControllerError(
        "not_found",
        `Provider Connection ${id} not found`,
      );
    }
    return connection;
  }

  async resolveProviderEnvBindings(
    installation: Installation,
  ): Promise<readonly ResolvedInstallationProviderEnvBinding[]> {
    const set =
      await this.#store.getInstallationProviderEnvBindingSetByInstallation(
        installation.id,
        installation.environment,
      );
    const bindings = validateInstallationProviderEnvBindings(
      set?.bindings ?? [],
      "installation provider binding set bindings",
    );
    return await Promise.all(
      bindings.map((binding) => this.#resolveBinding(installation, binding)),
    );
  }

  async resolveProviderEnvBindingsForRun(
    installation: Installation,
    requiredProviders: readonly string[],
  ): Promise<readonly ResolvedInstallationProviderEnvBinding[]> {
    const explicit = await this.resolveProviderEnvBindings(installation);
    if (requiredProviders.length === 0) return explicit;

    let missing = requiredProviders
      .filter(
        (required) =>
          !explicit.some((entry) =>
            sameProviderFamily(required, entry.provider),
          ),
      )
      .sort();
    const managedFallbacks =
      missing.length > 0
        ? await this.#managedProviderFallbacks(installation, missing)
        : [];
    if (managedFallbacks.length > 0) {
      missing = missing.filter(
        (required) =>
          !managedFallbacks.some((entry) =>
            sameProviderFamily(required, entry.provider),
          ),
      );
    }
    if (missing.length > 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `provider connection is required for providers: ${missing.join(", ")}`,
      );
    }
    return [...explicit, ...managedFallbacks];
  }

  async #resolveBinding(
    installation: Installation,
    binding: ProviderBinding,
  ): Promise<ResolvedInstallationProviderEnvBinding> {
    const connection = await this.#store.getConnection(binding.connectionId);
    if (!connection) {
      throw new OpenTofuControllerError(
        "not_found",
        `Provider Connection ${binding.connectionId} (provider ${binding.provider}) not found`,
      );
    }
    if (isSourceGitKind(connection)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${connection.id} is a git source connection and cannot back a provider binding`,
      );
    }
    if (
      connection.scope === "space" &&
      connection.spaceId !== installation.spaceId
    ) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `Provider Connection ${binding.connectionId} belongs to another Space`,
      );
    }
    if (
      connection.scope === "operator" &&
      !this.#allowOperatorBackedProviderEnvs
    ) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `Provider Connection ${connection.id} is operator-scoped and cannot back OSS Provider Connections`,
      );
    }
    if (!sameProviderFamily(binding.provider, connection.provider)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${binding.connectionId} provider ${connection.provider} does not match binding provider ${binding.provider}`,
      );
    }
    if (!connectionUsableForProviderBinding(connection)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${binding.connectionId} status ${connection.status} is not verified`,
      );
    }
    return {
      provider: binding.provider,
      ...(binding.alias ? { alias: binding.alias } : {}),
      connection,
      materialization: connection.materialization,
    };
  }

  async #managedProviderFallbacks(
    installation: Installation,
    requiredProviders: readonly string[],
  ): Promise<readonly ResolvedInstallationProviderEnvBinding[]> {
    if (!this.#allowOperatorBackedProviderEnvs) return [];
    const installConfig = await this.#store.getInstallConfig(
      installation.installConfigId,
    );
    const storeProvider = installConfig?.store?.provider;
    if (typeof storeProvider !== "string" || !storeProvider.trim()) {
      return [];
    }
    const candidates = (await this.#store.listOperatorConnections()).filter(
      (connection) =>
        isPublicManagedProviderConnection(connection) &&
        connectionUsableForProviderBinding(connection) &&
        !isSourceGitKind(connection),
    );
    const resolved: ResolvedInstallationProviderEnvBinding[] = [];
    for (const provider of requiredProviders) {
      if (!sameProviderFamily(provider, storeProvider)) continue;
      const matches = candidates.filter((connection) =>
        sameProviderFamily(provider, connection.provider),
      );
      if (matches.length !== 1) continue;
      resolved.push({
        provider,
        connection: matches[0]!,
        materialization: matches[0]!.materialization,
      });
    }
    return resolved;
  }
}

function isSourceGitKind(connection: Connection): boolean {
  return (
    connection.kind === "source_git_https_token" ||
    connection.kind === "source_git_ssh_key"
  );
}

function isPublicManagedProviderConnection(connection: Connection): boolean {
  return (
    connection.scope === "operator" &&
    connection.spaceId === undefined &&
    connection.scopeHints?.managedProvider === true &&
    typeof connection.scopeHints.providerBaseUrl === "string" &&
    connection.scopeHints.providerBaseUrl.trim().length > 0
  );
}

function connectionUsableForProviderBinding(connection: Connection): boolean {
  if (connection.status === "verified") return true;
  return (
    connection.status === "pending" &&
    isPublicManagedProviderConnection(connection)
  );
}

/** Collects the connection ids a run's vault-backed credential mint may draw from. */
export function mintableConnectionIds(
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): readonly string[] {
  const ids = new Set<string>();
  for (const entry of resolved) {
    ids.add(entry.connection.id);
  }
  return [...ids];
}

export function createConnectionsService(
  dependencies: ConnectionsServiceDependencies,
): ConnectionsService {
  return new ConnectionsService(dependencies);
}

export type { ProviderBinding as InstallationProviderEnvBinding };
