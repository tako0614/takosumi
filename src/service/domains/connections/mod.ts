/**
 * Connections domain: operator default connections + capability binding
 * resolution (core-spec.md §8 / §9).
 *
 * An Installation binds each capability (source / compute / dns / storage /
 * database / secrets) through its DeploymentProfile:
 *
 *   - `default`    -> the instance-wide operator default connection
 *   - `connection` -> an explicit Connection (space-scoped to the
 *                     installation's Space, or operator-scoped)
 *   - `manual`     -> operator/user-provided values (no connection; the values
 *                     become module inputs, never credentials)
 *   - `disabled`   -> the capability is unavailable
 *
 * An UNBOUND capability resolves as `default` (spec §9: the operator defaults
 * are the baseline; bindings are per-capability overrides).
 *
 * Resolution is pure lookup — the vault still decides per-phase what a
 * resolved connection may mint (invariants 3-5), and never trusts the caller.
 */
import type {
  Connection,
  InstallConfig,
  Installation,
} from "takosumi-contract/deploy-control-api";
import type {
  Capability,
  CapabilityBinding,
  OperatorConnectionDefault,
} from "takosumi-contract/capability-bindings";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";

export const CAPABILITIES: readonly Capability[] = [
  "source",
  "compute",
  "dns",
  "storage",
  "database",
  "secrets",
] as const;

/** One capability's resolution outcome. */
export interface ResolvedCapability {
  readonly capability: Capability;
  readonly mode: CapabilityBinding["mode"];
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
  readonly capability: Capability;
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
   * Sets the instance-wide default connection for one capability (spec §9).
   * The connection must exist and be operator-scoped: a space connection is
   * one Space's credential and must never become an instance-wide default.
   */
  async putOperatorConnectionDefault(
    request: PutOperatorConnectionDefaultRequest,
  ): Promise<OperatorConnectionDefault> {
    if (!CAPABILITIES.includes(request.capability)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `unknown capability ${String(request.capability)}`,
      );
    }
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
      capability: request.capability,
      provider: connection.provider,
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
   * Resolves every capability for an Installation (spec §9). Unbound
   * capabilities resolve as `default`. `default` with no operator default for
   * the capability resolves to mode `default` with NO connection — whether
   * that is an error depends on what the run actually needs (the install-type
   * wiring decides; conformance M5).
   */
  async resolveCapabilities(
    installation: Installation,
  ): Promise<readonly ResolvedCapability[]> {
    const profile = await this.#store.getDeploymentProfileByInstallation(
      installation.id,
      installation.environment,
    );
    const resolved: ResolvedCapability[] = [];
    for (const capability of CAPABILITIES) {
      const binding = profile?.bindings[capability] ?? { mode: "default" };
      resolved.push(await this.#resolveBinding(installation, capability, binding));
    }
    return resolved;
  }

  async #resolveBinding(
    installation: Installation,
    capability: Capability,
    binding: CapabilityBinding,
  ): Promise<ResolvedCapability> {
    switch (binding.mode) {
      case "disabled":
        return { capability, mode: "disabled" };
      case "manual":
        return { capability, mode: "manual", values: binding.values ?? {} };
      case "connection": {
        if (!binding.connectionId) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `capability ${capability} binds mode "connection" without a connectionId`,
          );
        }
        const connection = await this.#store.getConnection(binding.connectionId);
        if (!connection) {
          throw new OpenTofuControllerError(
            "not_found",
            `connection ${binding.connectionId} (capability ${capability}) not found`,
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
        return { capability, mode: "connection", connection };
      }
      case "default": {
        const fallback = await this.#store.getOperatorConnectionDefault(
          capability,
        );
        if (!fallback) return { capability, mode: "default" };
        const connection = await this.#store.getConnection(fallback.connectionId);
        return {
          capability,
          mode: "default",
          ...(connection ? { connection } : {}),
        };
      }
    }
  }
}

/**
 * Collects the connection ids a run's credential mint may draw from: the
 * resolved `connection` / `default` capabilities. `manual` contributes module
 * values (not credentials) and `disabled` contributes nothing.
 */
export function mintableConnectionIds(
  resolved: readonly ResolvedCapability[],
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
export type { Capability, CapabilityBinding, InstallConfig };
