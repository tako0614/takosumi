import type { TakosPaaSKernelPlugin } from "./types.ts";

const trustedInstalledPlugins = new WeakSet<TakosPaaSKernelPlugin>();

export function markTrustedKernelPlugin<T extends TakosPaaSKernelPlugin>(
  plugin: T,
): T {
  trustedInstalledPlugins.add(plugin);
  return plugin;
}

export function hasTrustedKernelPluginInstall(
  plugin: TakosPaaSKernelPlugin,
): boolean {
  return plugin.trustedInstall?.source === "trusted-signed-manifest" &&
    trustedInstalledPlugins.has(plugin);
}
