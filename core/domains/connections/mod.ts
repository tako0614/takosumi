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
  canonicalRunCredentialSettings,
  isWorkspaceBindableOperatorConnection,
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
  readonly moduleLocalName?: string;
  readonly childAlias?: string;
  readonly rootAlias?: string;
  /** @deprecated Ambiguous pre-v1 alias retained for stored-row compatibility. */
  readonly alias?: string;
  readonly runCredentialSettings?: ProviderBinding["runCredentialSettings"];
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
  let alias =
    value.alias === undefined
      ? undefined
      : nonEmptyField(value.alias, `${field}.alias`);
  let moduleLocalName =
    value.moduleLocalName === undefined
      ? undefined
      : providerIdentifierField(
          value.moduleLocalName,
          `${field}.moduleLocalName`,
        );
  let childAlias =
    value.childAlias === undefined
      ? undefined
      : providerIdentifierField(value.childAlias, `${field}.childAlias`);
  let rootAlias =
    value.rootAlias === undefined
      ? undefined
      : providerIdentifierField(value.rootAlias, `${field}.rootAlias`);
  if (
    alias &&
    moduleLocalName === undefined &&
    childAlias === undefined &&
    rootAlias === undefined
  ) {
    const configurationAlias =
      /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(alias);
    if (configurationAlias) {
      moduleLocalName = configurationAlias[1]!;
      childAlias = configurationAlias[2]!;
      rootAlias = configurationAlias[2]!;
      alias = undefined;
    }
  }
  const region =
    value.region === undefined
      ? undefined
      : nonEmptyField(value.region, `${field}.region`);
  let runCredentialSettings: ProviderBinding["runCredentialSettings"];
  try {
    runCredentialSettings = canonicalRunCredentialSettings(
      value.runCredentialSettings,
      `${field}.runCredentialSettings`,
    );
  } catch (error) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      error instanceof Error
        ? error.message
        : `${field}.runCredentialSettings is invalid`,
    );
  }
  return {
    provider,
    connectionId,
    ...(moduleLocalName ? { moduleLocalName } : {}),
    ...(childAlias ? { childAlias } : {}),
    ...(rootAlias ? { rootAlias } : {}),
    ...(alias ? { alias } : {}),
    ...(region ? { region } : {}),
    ...(runCredentialSettings ? { runCredentialSettings } : {}),
  };
}

function providerIdentifierField(value: unknown, field: string): string {
  const normalized = nonEmptyField(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be a valid OpenTofu identifier`,
    );
  }
  return normalized;
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
 * CredentialRecipe, including its resolved run-issuance descriptor, is pinned
 * with the connection id so changing a pre-run driver or issuance authority cannot slip between
 * reviewed plan and apply. Mutable verification status is deliberately
 * excluded; revocation still fails before minting.
 */
export async function resolvedProviderBindingsDigest(
  resolved: readonly ResolvedCapsuleProviderBinding[] | undefined,
): Promise<string> {
  const entries = (resolved ?? [])
    .map((entry) => ({
      provider: entry.provider,
      moduleLocalName: entry.moduleLocalName ?? null,
      childAlias: entry.childAlias ?? null,
      rootAlias: entry.rootAlias ?? null,
      alias: entry.alias ?? null,
      materialization: entry.connection.materialization,
      credentialRecipe: entry.connection.credentialRecipe ?? null,
      connectionId: entry.connection.id,
      envNames: [...entry.connection.envNames].sort(),
      providerConfig: entry.connection.scopeHints?.providerConfig ?? null,
      runCredentialSettings: entry.runCredentialSettings ?? null,
    }))
    .sort((a, b) => {
      const providerOrder = compareText(a.provider, b.provider);
      if (providerOrder !== 0) return providerOrder;
      return compareText(
        JSON.stringify([a.moduleLocalName, a.childAlias, a.rootAlias, a.alias]),
        JSON.stringify([b.moduleLocalName, b.childAlias, b.rootAlias, b.alias]),
      );
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
   * Host-owned, credentialless Provider Connections projected directly from
   * the running release. They are not runtime database rows: release tooling
   * may reconcile durable copies for audit/migration purposes, but ordinary
   * reads and Run binding resolution use this immutable code authority.
   */
  readonly operatorProviderConnections?: readonly ProviderConnection[];
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
  readonly #operatorProviderConnections: ReadonlyMap<
    string,
    ProviderConnection
  >;

  constructor(dependencies: ConnectionsServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId =
      dependencies.newId ??
      ((prefix) =>
        `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#allowOperatorScopedProviderConnections =
      dependencies.allowOperatorScopedProviderConnections === true;
    this.#operatorProviderConnections = operatorConnectionMap(
      dependencies.operatorProviderConnections ?? [],
    );
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
      await this.listReleaseOwnedProviderConnections(workspaceId);
    return [...connections, ...operatorManagedConnections].filter(
      (connection) => !isSourceGitKind(connection),
    );
  }

  /**
   * Lists only immutable release-owned Provider Connections. This projection
   * deliberately performs no durable store read so a slow Control database
   * cannot hide a built-in deployment destination from install discovery.
   */
  async listReleaseOwnedProviderConnections(
    workspaceId?: string,
  ): Promise<readonly ProviderConnection[]> {
    return workspaceId && this.#allowOperatorScopedProviderConnections
      ? [...this.#operatorProviderConnections.values()].filter(
          isWorkspaceBindableOperatorConnection,
        )
      : [];
  }

  async getProviderConnection(id: string): Promise<ProviderConnection> {
    const connectionId = nonEmptyField(id, "id");
    const connection =
      this.#operatorProviderConnections.get(connectionId) ??
      (await this.#store.getConnection(connectionId));
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
    const resolved = await this.#resolveBinding(
      { workspaceId: input.workspaceId },
      {
        provider: input.provider,
        connectionId: input.connectionId,
        ...(input.alias ? { alias: input.alias } : {}),
      },
    );
    if (resolved.connection.scope === "operator") {
      throw new OpenTofuControllerError(
        "permission_denied",
        `Provider Connection ${resolved.connection.id} is operator-scoped and cannot back a user-managed Resource Target`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    return [resolved];
  }

  async #resolveBinding(
    capsule: Pick<Capsule, "workspaceId">,
    binding: ProviderBinding,
  ): Promise<ResolvedCapsuleProviderBinding> {
    const connection =
      this.#operatorProviderConnections.get(binding.connectionId) ??
      (await this.#store.getConnection(binding.connectionId));
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
    if (connection.scope === "operator") {
      if (
        !this.#allowOperatorScopedProviderConnections ||
        !isWorkspaceBindableOperatorConnection(connection)
      ) {
        throw new OpenTofuControllerError(
          "permission_denied",
          `Provider Connection ${connection.id} is operator-scoped and cannot back a generic provider binding`,
          { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
        );
      }
    }
    if (!sameProviderSource(binding.provider, connection.providerSource)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${binding.connectionId} provider ${connection.provider} does not match binding provider ${binding.provider}`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    if (!connectionUsableForProviderBinding(connection)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${binding.connectionId} status ${connection.status} is not verified`,
        { reason: PROVIDER_CONNECTION_NOT_READY_REASON },
      );
    }
    if (
      binding.runCredentialSettings !== undefined &&
      !isWorkspaceBindableOperatorConnection(connection)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Connection ${binding.connectionId} does not accept run credential settings`,
        { reason: PROVIDER_CONNECTION_SETUP_REQUIRED_REASON },
      );
    }
    // A release-owned run-issued connection is the current policy authority.
    // Stored Capsule bindings may predate a newly required non-secret policy
    // field, so resolving a Run must project the current declaration instead
    // of replaying a stale copy. The resolved value is included in the Plan
    // digest, preserving the Plan/Apply fence across release changes.
    const runCredentialSettings =
      isWorkspaceBindableOperatorConnection(connection) &&
      connection.runCredentialSettings !== undefined
        ? connection.runCredentialSettings
        : binding.runCredentialSettings;
    return {
      provider: binding.provider,
      ...(binding.moduleLocalName
        ? { moduleLocalName: binding.moduleLocalName }
        : {}),
      ...(binding.childAlias ? { childAlias: binding.childAlias } : {}),
      ...(binding.rootAlias ? { rootAlias: binding.rootAlias } : {}),
      ...(binding.alias ? { alias: binding.alias } : {}),
      ...(runCredentialSettings
        ? { runCredentialSettings }
        : {}),
      connection,
      materialization: connection.materialization,
    };
  }
}

function operatorConnectionMap(
  connections: readonly ProviderConnection[],
): ReadonlyMap<string, ProviderConnection> {
  const result = new Map<string, ProviderConnection>();
  for (const connection of connections) {
    if (!isWorkspaceBindableOperatorConnection(connection)) {
      throw new TypeError(
        `operator Provider Connection ${connection.id} must be a verified workspace-bindable run-issued connection`,
      );
    }
    if (result.has(connection.id)) {
      throw new TypeError(
        `operator Provider Connection id ${connection.id} must be unique`,
      );
    }
    result.set(connection.id, Object.freeze({ ...connection }));
  }
  return result;
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
  return connection.status === "verified";
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
