/** Public host-composition helpers for the generic OpenTofu Capsule policy. */
import type { InstallConfig } from "takosumi-contract/install-configs";

export {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleInstallConfig,
} from "../../core/domains/capsules/default_install_config.ts";

import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleInstallConfig,
} from "../../core/domains/capsules/default_install_config.ts";

/**
 * Applies explicit host credential requirements to the generic default
 * InstallConfig. The sources are already validated by the host-composition
 * contract; this helper only performs the deterministic sorted union and
 * never derives requirements from recipes, connections, or source HCL.
 */
export function applyCredentialRequiredProviderSources(
  installConfigs: readonly InstallConfig[],
  credentialRequiredProviderSources: readonly string[] | undefined,
): readonly InstallConfig[] {
  const sources = Array.from(
    new Set(credentialRequiredProviderSources ?? []),
  ).sort();
  if (sources.length === 0) return installConfigs;

  const defaultIndex = installConfigs.findIndex(
    (config) => config.id === DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  );
  const base =
    defaultIndex >= 0
      ? installConfigs[defaultIndex]!
      : defaultCapsuleInstallConfig();
  const current = base.policy.providerCredentials;
  const requiredProviders = Array.from(
    new Set([...(current?.requiredProviders ?? []), ...sources]),
  ).sort();
  const composed = Object.freeze({
    ...base,
    policy: Object.freeze({
      ...base.policy,
      providerCredentials: Object.freeze({
        ...current,
        requiredProviders: Object.freeze(requiredProviders),
      }),
    }),
  });

  if (defaultIndex >= 0) {
    return Object.freeze(
      installConfigs.map((config, index) =>
        index === defaultIndex ? composed : config,
      ),
    );
  }
  return Object.freeze([composed, ...installConfigs]);
}
