/**
 * Connections domain: Takosumi-provided defaults + provider binding
 * resolution.
 *
 * An Installation binds each required OpenTofu provider through its internal
 * provider-binding record:
 *
 *   - `default`    -> the instance-wide operator default connection
 *   - `connection` -> an explicit Connection (space-scoped to the
 *                     installation's Space, or operator-scoped)
 *   - `manual`     -> operator/user-provided values (no connection; the values
 *                     become module inputs, never credentials)
 *   - `disabled`   -> the provider is unavailable
 *
 * Resolution is pure lookup — the vault still decides per-phase what a
 * resolved connection may mint (invariants 3-5), and never trusts the caller.
 */
import type {
  Connection,
  InstallConfig,
  Installation,
} from "@takosumi/internal/deploy-control-api";
import type {
  ProviderBinding,
  OperatorConnectionDefault,
} from "takosumi-contract/provider-bindings";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";

/** One provider binding's resolution outcome. */
export interface ResolvedProviderBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly mode: ProviderBinding["mode"];
  /** Present for `connection` mode and for `default` with an operator default. */
  readonly connection?: Connection;
  /** Present for `manual` mode. */
  readonly values?: Readonly<Record<string, unknown>>;
}

export interface ConnectionsServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
}

export interface PutOperatorConnectionDefaultRequest {
  readonly provider?: string;
  readonly connectionId: string;
}

export class ConnectionsService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;

  constructor(dependencies: ConnectionsServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId ??
      ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  /**
   * Sets the instance-wide Takosumi-provided default connection for one provider.
   * The connection must exist and be operator-scoped: a space connection is
   * one Space's credential and must never become an instance-wide default.
   */
  async putOperatorConnectionDefault(
    request: PutOperatorConnectionDefaultRequest,
  ): Promise<OperatorConnectionDefault> {
    const connection = await this.#store.getConnection(request.connectionId);
    if (!connection) {
      throw new OpenTofuControllerError(
        "not_found",
        `connection ${request.connectionId} not found`,
      );
    }
    if (connection.scope !== "operator") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `connection ${request.connectionId} is space-scoped; operator defaults ` +
          `require an operator-scoped connection`,
      );
    }
    const now = this.#now();
    return await this.#store.putOperatorConnectionDefault({
      id: this.#newId("ocd"),
      provider: request.provider ?? connection.provider,
      connectionId: connection.id,
      createdAt: now,
      updatedAt: now,
    });
  }

  async listOperatorConnectionDefaults(): Promise<
    readonly OperatorConnectionDefault[]
  > {
    return await this.#store.listOperatorConnectionDefaults();
  }

  /**
   * Resolves provider bindings for an Installation. Unbound providers are not
   * synthesized here; plan creation derives provider needs from templates and
   * OpenTofu metadata.
   */
  async resolveProviderBindings(
    installation: Installation,
  ): Promise<readonly ResolvedProviderBinding[]> {
    const profile = await this.#store.getDeploymentProfileByInstallation(
      installation.id,
      installation.environment,
    );
    return await Promise.all(
      (profile?.bindings ?? []).map((binding) =>
        this.#resolveBinding(installation, binding)
      ),
    );
  }

  async #resolveBinding(
    installation: Installation,
    binding: ProviderBinding,
  ): Promise<ResolvedProviderBinding> {
    switch (binding.mode) {
      case "disabled":
        return {
          provider: binding.provider,
          ...(binding.alias ? { alias: binding.alias } : {}),
          mode: "disabled",
        };
      case "manual":
        return {
          provider: binding.provider,
          ...(binding.alias ? { alias: binding.alias } : {}),
          mode: "manual",
          values: binding.values ?? {},
        };
      case "connection": {
        if (!binding.connectionId) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `provider ${binding.provider} binds mode "connection" without a connectionId`,
          );
        }
        const connection = await this.#store.getConnection(binding.connectionId);
        if (!connection) {
          throw new OpenTofuControllerError(
            "not_found",
            `connection ${binding.connectionId} (provider ${binding.provider}) not found`,
          );
        }
        // A space connection must belong to the installation's Space; an
        // operator connection is usable from any Space.
        if (
          connection.scope === "space" &&
          connection.spaceId !== installation.spaceId
        ) {
          throw new OpenTofuControllerError(
            "permission_denied",
            `connection ${binding.connectionId} belongs to another space`,
          );
        }
        return {
          provider: binding.provider,
          ...(binding.alias ? { alias: binding.alias } : {}),
          mode: "connection",
          connection,
        };
      }
      case "default": {
        const fallback = await this.#store.getOperatorConnectionDefault(
          binding.provider,
        );
        if (!fallback) {
          return {
            provider: binding.provider,
            ...(binding.alias ? { alias: binding.alias } : {}),
            mode: "default",
          };
        }
        const connection = await this.#store.getConnection(fallback.connectionId);
        return {
          provider: binding.provider,
          ...(binding.alias ? { alias: binding.alias } : {}),
          mode: "default",
          ...(connection ? { connection } : {}),
        };
      }
    }
    throw new OpenTofuControllerError(
      "invalid_argument",
      `unknown provider binding mode ${(binding as { mode?: string }).mode}`,
    );
  }
}

/**
 * Collects the connection ids a run's credential mint may draw from: the
 * resolved `connection` / `default` provider bindings. `manual` contributes module
 * values (not credentials) and `disabled` contributes nothing.
 */
export function mintableConnectionIds(
  resolved: readonly ResolvedProviderBinding[],
): readonly string[] {
  const ids = new Set<string>();
  for (const entry of resolved) {
    if (entry.connection) ids.add(entry.connection.id);
  }
  return [...ids];
}

export function createConnectionsService(
  dependencies: ConnectionsServiceDependencies,
): ConnectionsService {
  return new ConnectionsService(dependencies);
}

// Re-exported so route/service composition can validate InstallConfig usage
// alongside capability resolution without importing the store types directly.
export type { ProviderBinding, InstallConfig };
