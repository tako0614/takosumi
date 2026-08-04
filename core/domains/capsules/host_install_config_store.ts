import type { InstallConfig } from "takosumi-contract/install-configs";
import {
  pageSorted,
} from "takosumi-contract/pagination";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";

const MAX_HOST_INSTALL_CONFIGS = 100;

function compareInstallConfigs(a: InstallConfig, b: InstallConfig): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function validateHostInstallConfigs(
  configs: readonly InstallConfig[],
): ReadonlyMap<string, InstallConfig> {
  if (configs.length > MAX_HOST_INSTALL_CONFIGS) {
    throw new TypeError(
      `host InstallConfig composition exceeds ${MAX_HOST_INSTALL_CONFIGS} entries`,
    );
  }
  const result = new Map<string, InstallConfig>();
  for (const config of configs) {
    if (config.workspaceId !== undefined) {
      throw new TypeError(
        `host InstallConfig ${config.id} must be Workspace-neutral`,
      );
    }
    if (config.internal !== undefined) {
      throw new TypeError(
        `host InstallConfig ${config.id} must not be an internal per-install clone`,
      );
    }
    if (result.has(config.id)) {
      throw new TypeError(`duplicate host InstallConfig id: ${config.id}`);
    }
    result.set(config.id, config);
  }
  return result;
}

/**
 * Adds immutable host-owned InstallConfigs to the durable ledger's read model.
 *
 * Host composition is process configuration, not database state. In
 * particular, creating a service must never write these rows or pay D1
 * maintenance admission once per config on a cold request. Workspace-derived
 * configs remain ordinary durable records. Persisted historical shared rows
 * stay readable by id for installed Capsules and backups, but shared discovery
 * comes only from this explicit host composition.
 */
export function withHostInstallConfigs(
  durable: OpenTofuControlStore,
  configs: readonly InstallConfig[],
): OpenTofuControlStore {
  const hostById = validateHostInstallConfigs(configs);
  const hosts = [...hostById.values()].sort(compareInstallConfigs);

  const overrides: Partial<OpenTofuControlStore> = {
    async putInstallConfig(config) {
      if (hostById.has(config.id)) {
        throw new OpenTofuControllerError(
          "permission_denied",
          `host InstallConfig ${config.id} is immutable`,
        );
      }
      return await durable.putInstallConfig(config);
    },
    async getInstallConfig(id) {
      return hostById.get(id) ?? (await durable.getInstallConfig(id));
    },
    async getInstallConfigsByIds(ids) {
      const missing = ids.filter((id) => !hostById.has(id));
      const durableRows = await durable.getInstallConfigsByIds(missing);
      const durableById = new Map(durableRows.map((row) => [row.id, row]));
      return ids
        .map((id) => hostById.get(id) ?? durableById.get(id))
        .filter((row): row is InstallConfig => row !== undefined);
    },
    async listInstallConfigs(workspaceId) {
      const rows = await durable.listInstallConfigs(workspaceId);
      if (workspaceId !== undefined) return rows;
      const durableById = new Map(rows.map((row) => [row.id, row]));
      for (const host of hosts) durableById.set(host.id, host);
      return [...durableById.values()].sort(compareInstallConfigs);
    },
    async listSharedInstallConfigs() {
      return hosts;
    },
    async listSharedInstallConfigsPage(params) {
      return pageSorted(hosts, params);
    },
  };

  return new Proxy(durable, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property);
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
