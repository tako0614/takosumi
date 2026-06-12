/**
 * Connection-management facade (provider credential registration; Phase 1A).
 *
 * A thin collaborator pulled out of `OpenTofuDeploymentController`: the write +
 * test + mint methods delegate to the injected {@link ConnectionVault} (guarded
 * by a single `not_implemented` check when no Vault is wired), and the read
 * methods project the {@link OpenTofuDeploymentStore} Connection rows (never
 * secret values). The controller holds one instance and re-exposes these on its
 * public API unchanged, so the `/api` connection route layer keeps calling the
 * controller surface. The run-execution path keeps its own direct Vault handle
 * for per-phase credential mint; this facade only owns the Connection lifecycle.
 */

import type {
  Connection,
  ConnectionResponse,
  CreateConnectionRequest,
  ListConnectionsResponse,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type { PageParams } from "takosumi-contract/pagination";
import type { ConnectionVault } from "../../adapters/vault/mod.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import {
  mapVaultError,
  OpenTofuControllerError,
  requireNonEmptyString,
} from "./errors.ts";

/**
 * Collaborator owning the Connection lifecycle. When `vault` is absent the
 * write / test / mint methods throw `not_implemented`, matching the prior inline
 * `#requireVault()` behavior; the read methods stay available (they only touch
 * the store).
 */
export class ConnectionManagement {
  readonly #store: OpenTofuDeploymentStore;
  readonly #vault?: ConnectionVault;

  constructor(store: OpenTofuDeploymentStore, vault?: ConnectionVault) {
    this.#store = store;
    this.#vault = vault;
  }

  async createConnection(
    request: CreateConnectionRequest,
  ): Promise<ConnectionResponse> {
    const vault = this.#requireVault();
    try {
      const connection = await vault.register(request);
      return { connection };
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  async listConnections(
    spaceId: string,
    params?: PageParams,
  ): Promise<ListConnectionsResponse> {
    requireNonEmptyString(spaceId, "spaceId");
    const { items, nextCursor } = await this.#store.listConnectionsPage(
      spaceId,
      params ?? {},
    );
    return {
      connections: items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  /**
   * Lists instance-wide `operator`-scoped Connections (spec §30 `GET
   * /api/connections` with `?spaceId` omitted). Never includes secret values.
   */
  async listOperatorConnections(): Promise<ListConnectionsResponse> {
    return { connections: await this.#store.listOperatorConnections() };
  }

  async getConnection(connectionId: string): Promise<Connection> {
    requireNonEmptyString(connectionId, "connectionId");
    const connection = await this.#store.getConnection(connectionId);
    if (!connection) {
      throw new OpenTofuControllerError(
        "not_found",
        `connection ${connectionId} not found`,
      );
    }
    return connection;
  }

  async testConnection(
    connectionId: string,
  ): Promise<TestConnectionResponse> {
    const vault = this.#requireVault();
    requireNonEmptyString(connectionId, "connectionId");
    try {
      return await vault.test(connectionId);
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  async deleteConnection(connectionId: string): Promise<boolean> {
    const vault = this.#requireVault();
    requireNonEmptyString(connectionId, "connectionId");
    try {
      return await vault.revoke(connectionId);
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  #requireVault(): ConnectionVault {
    if (!this.#vault) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "connection vault is not configured",
      );
    }
    return this.#vault;
  }
}
