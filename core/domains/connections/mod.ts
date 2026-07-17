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
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import { randomUUID } from "node:crypto";
import type {
  ProviderBinding,
  ProviderBindings,
  ProviderConnectionMaterialization,
} from "takosumi-contract/connections";
import {
  isPublicManagedProviderConnection,
  managedProviderProfile,
} from "takosumi-contract/connections";
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import {
  OpenTofuControllerError,
  PROVIDER_CONNECTION_NOT_READY_REASON,
  PROVIDER_CONNECTION_SETUP_REQUIRED_REASON,
} from "../deploy-control/errors.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";

/** One Provider Connection binding's resolution outcome. */
export interface ResolvedCapsuleProviderBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly connection: ProviderConnection;
  readonly materialization: ProviderConnectionMaterialization;
}

export function validateCapsuleProviderBindings(
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
    validateCapsuleProviderBinding(entry, `${field}[${index}]`),
  );
}

function validateCapsuleProviderBinding(
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
  const connectionId = nonEmptyField(
    value.connectionId,
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
 * Stable digest over a run's resolved Provider Connection bindings. The chosen
 * CredentialRecipe and managed-provider profile are pinned with the connection
 * id so changing a pre-run driver or token authority cannot slip between
 * reviewed plan and apply. Mutable verification status is deliberately
 * excluded; revocation still fails before minting.
 */
export async function resolvedProviderBindingsDigest(
  resolved: readonly ResolvedCapsuleProviderBinding[] | undefined,
): Promise<string> {
  const entries = (resolved ?? [])
    .map((entry) => ({
      provider: entry.provider,
      alias: entry.alias ?? null,
      materialization: entry.connection.materialization,
      credentialRecipe: entry.connection.credentialRecipe ?? null,
      connectionId: entry.connection.id,
      envNames: [...entry.connection.envNames].sort(),
      providerConfig: entry.connection.scopeHints?.providerConfig ?? null,
      managedProviderProfile:
        managedProviderProfile(entry.connection.scopeHints) ?? null,
    }))
    .sort((a, b) => {
      const providerOrder = compareText(a.provider, b.provider);
      if (providerOrder !== 0) return providerOrder;
      if (a.alias === b.alias) return 0;
      if (a.alias === null) return -1;
      if (b.alias === null) return 1;
      return compareText(a.alias, b.alias);
    });
  return await stableJsonDigest(entries);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ConnectionsServiceDependencies {
  readonly store: OpenTofuControlStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  /**
   * An operator extension may expose a Workspace-scoped Provider Connection
   * backed by an operator-scoped credential. OSS leaves this disabled so
   * operator credentials never become bindable by accident.
   */
  readonly allowOperatorScopedProviderConnections?: boolean;
}

export class ConnectionsService {
  readonly #store: OpenTofuControlStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;
  readonly #allowOperatorScopedProviderConnections: boolean;

  constructor(dependencies: ConnectionsServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId =
      dependencies.newId ??
      ((prefix) =>
        `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#allowOperatorScopedProviderConnections =
      dependencies.allowOperatorScopedProviderConnections === true;
  }

  /**
   * Lists the provider-bindable Provider Connections visible to a Workspace. Source
   * git connections are never provider connections and are excluded.
   */
  async listProviderConnections(
    workspaceId?: string,
  ): Promise<readonly ProviderConnection[]> {
    const connections = workspaceId
      ? await this.#store.listConnections(workspaceId)
      : [];
    const operatorManagedConnections =
      workspaceId && this.#allowOperatorScopedProviderConnections
        ? (await this.#store.listOperatorConnections()).filter(
            isPublicManagedProviderConnection,
          )
        : [];
    return [...connections, ...operatorManagedConnections].filter(
      (connection) => !isSourceGitKind(connection),
    );
  }

  async getProviderConnection(id: string): Promise<ProviderConnection> {
    const connection = await this.#store.getConnection(nonEmptyField(id, "id"));
    if (!connection || isSourceGitKind(connection)) {
      throw new OpenTofuControllerError(
        "not_found",
        `Provider Connection ${id} not found`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    return connection;
  }

  async resolveProviderBindings(
    capsule: Capsule,
  ): Promise<readonly ResolvedCapsuleProviderBinding[]> {
    const set = await this.#store.getProviderBindingSetByCapsule(
      capsule.id,
      capsule.environment,
    );
    const bindings = validateCapsuleProviderBindings(
      set?.bindings ?? [],
      "capsule provider binding set bindings",
    );
    return await Promise.all(
      bindings.map((binding) => this.#resolveBinding(capsule, binding)),
    );
  }

  async resolveProviderBindingsForRun(
    capsule: Capsule,
    requiredProviders: readonly string[],
  ): Promise<readonly ResolvedCapsuleProviderBinding[]> {
    const explicit = await this.resolveProviderBindings(capsule);
    if (requiredProviders.length === 0) return explicit;

    const missing = requiredProviders
      .filter(
        (required) =>
          !explicit.some((entry) =>
            sameProviderSource(required, entry.provider),
          ),
      )
      .sort();
    if (missing.length > 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `provider connection is required for providers: ${missing.join(", ")}`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    return explicit;
  }

  /** Resolve one Target-selected Provider Connection for a Resource Run. */
  async resolveResourceProviderBinding(input: {
    readonly workspaceId: string;
    readonly provider: string;
    readonly alias?: string;
    readonly connectionId?: string;
    readonly required: boolean;
  }): Promise<readonly ResolvedCapsuleProviderBinding[]> {
    if (!input.connectionId) {
      if (input.required) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `provider connection is required for provider ${input.provider}`,
          { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
        );
      }
      return [];
    }
    return [
      await this.#resolveBinding(
        { workspaceId: input.workspaceId },
        {
          provider: input.provider,
          connectionId: input.connectionId,
          ...(input.alias ? { alias: input.alias } : {}),
        },
      ),
    ];
  }

  async #resolveBinding(
    capsule: Pick<Capsule, "workspaceId">,
    binding: ProviderBinding,
  ): Promise<ResolvedCapsuleProviderBinding> {
    const connection = await this.#store.getConnection(binding.connectionId);
    if (!connection) {
      throw new OpenTofuControllerError(
        "not_found",
        `Provider Connection ${binding.connectionId} (provider ${binding.provider}) not found`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    if (isSourceGitKind(connection)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${connection.id} is a git source connection and cannot back a provider binding`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    if (
      connection.scope === "workspace" &&
      connection.workspaceId !== capsule.workspaceId
    ) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `Provider Connection ${binding.connectionId} belongs to another Workspace`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    if (
      connection.scope === "operator" &&
      !this.#allowOperatorScopedProviderConnections
    ) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `Provider Connection ${connection.id} is operator-scoped and cannot back OSS Provider Connections`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    if (!sameProviderSource(binding.provider, connection.providerSource)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${binding.connectionId} provider ${connection.provider} does not match binding provider ${binding.provider}`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    if (
      connection.scopeHints?.managedProvider === true &&
      !isPublicManagedProviderConnection(connection)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${binding.connectionId} requires an explicit managedProviderProfile and operator scope`,
        { reason: PROVIDER_CONNECTION_NOT_READY_REASON },
      );
    }
    if (!connectionUsableForProviderBinding(connection)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${binding.connectionId} status ${connection.status} is not verified`,
        { reason: PROVIDER_CONNECTION_NOT_READY_REASON },
      );
    }
    return {
      provider: binding.provider,
      ...(binding.alias ? { alias: binding.alias } : {}),
      connection,
      materialization: connection.materialization,
    };
  }
}

function isSourceGitKind(connection: ProviderConnection): boolean {
  return (
    connection.kind === "source_git_https_token" ||
    connection.kind === "source_git_ssh_key"
  );
}

function connectionUsableForProviderBinding(
  connection: ProviderConnection,
): boolean {
  if (connection.scopeHints?.managedProvider === true) {
    return (
      (connection.status === "pending" || connection.status === "verified") &&
      isPublicManagedProviderConnection(connection)
    );
  }
  if (connection.status === "verified") return true;
  return false;
}

/** Collects the connection ids a run's vault-backed credential mint may draw from. */
export function mintableConnectionIds(
  resolved: readonly ResolvedCapsuleProviderBinding[],
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
