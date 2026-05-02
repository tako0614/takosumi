import type { TakosPaaSKernelPlugin } from "./types.ts";
import { installTrustedKernelPlugins } from "./trusted_install.ts";
import type {
  TrustedKernelPluginInstallPolicy,
  TrustedKernelPluginManifestEnvelope,
  TrustedKernelPluginPublisherKey,
} from "./trusted_install.ts";

export interface KernelPluginModule {
  readonly default?: TakosPaaSKernelPlugin | readonly TakosPaaSKernelPlugin[];
  readonly plugin?: TakosPaaSKernelPlugin;
  readonly plugins?: readonly TakosPaaSKernelPlugin[];
}

export async function loadKernelPluginsFromModules(
  moduleSpecifiers: readonly string[],
): Promise<readonly TakosPaaSKernelPlugin[]> {
  const plugins: TakosPaaSKernelPlugin[] = [];
  for (const specifier of moduleSpecifiers) {
    if (!specifier.trim()) continue;
    const module = await import(specifier) as KernelPluginModule;
    plugins.push(...pluginsFromModule(module, specifier));
  }
  return Object.freeze(plugins);
}

export async function loadKernelPluginsFromEnv(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  options: {
    readonly availableTrustedPlugins?: readonly TakosPaaSKernelPlugin[];
  } = {},
): Promise<readonly TakosPaaSKernelPlugin[]> {
  const trustedPlugins = await loadTrustedKernelPluginsFromEnv(env, options);
  const raw = env.TAKOS_KERNEL_PLUGIN_MODULES ??
    env.TAKOS_PAAS_PLUGIN_MODULES;
  if (!raw) return trustedPlugins;
  if (!dynamicPluginModuleLoadingEnabled(env)) return trustedPlugins;
  const environment = normalizeEnvironment(
    env.TAKOS_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT,
  );
  if (environment === "production" || environment === "staging") {
    throw new Error(
      `${environment} cannot use reference dynamic kernel plugin module loading; install trusted plugins through the operator registry`,
    );
  }
  const dynamicPlugins = await loadKernelPluginsFromModules(
    raw.split(",").map((item) => item.trim()).filter(Boolean),
  );
  return Object.freeze([...trustedPlugins, ...dynamicPlugins]);
}

async function loadTrustedKernelPluginsFromEnv(
  env: Record<string, string | undefined>,
  options: {
    readonly availableTrustedPlugins?: readonly TakosPaaSKernelPlugin[];
  },
): Promise<readonly TakosPaaSKernelPlugin[]> {
  const rawManifests = env.TAKOS_TRUSTED_KERNEL_PLUGIN_MANIFESTS ??
    env.TAKOS_KERNEL_PLUGIN_REGISTRY_MANIFESTS;
  if (!rawManifests) return Object.freeze([]);
  const environment = normalizeEnvironment(
    env.TAKOS_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT,
  );
  return await installTrustedKernelPlugins({
    envelopes: parseJsonEnv<readonly TrustedKernelPluginManifestEnvelope[]>(
      rawManifests,
      "TAKOS_TRUSTED_KERNEL_PLUGIN_MANIFESTS",
    ),
    availablePlugins: options.availableTrustedPlugins ?? [],
    trustedKeys: parseJsonEnv<readonly TrustedKernelPluginPublisherKey[]>(
      env.TAKOS_KERNEL_PLUGIN_TRUST_KEYS,
      "TAKOS_KERNEL_PLUGIN_TRUST_KEYS",
    ),
    policy: parseJsonEnv<TrustedKernelPluginInstallPolicy>(
      env.TAKOS_KERNEL_PLUGIN_INSTALL_POLICY,
      "TAKOS_KERNEL_PLUGIN_INSTALL_POLICY",
    ),
    environment,
  });
}

function parseJsonEnv<T>(value: string | undefined, key: string): T {
  if (!value) {
    throw new Error(`${key} is required for trusted kernel plugin install`);
  }
  return JSON.parse(value) as T;
}

function dynamicPluginModuleLoadingEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return parseBoolean(env.TAKOS_ENABLE_DYNAMIC_KERNEL_PLUGIN_MODULES) ||
    parseBoolean(env.TAKOS_ENABLE_REFERENCE_KERNEL_PLUGIN_LOADER);
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on", "enabled"].includes(
    value.trim().toLowerCase(),
  );
}

function normalizeEnvironment(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  if (normalized === "prod") return "production";
  if (normalized === "stage") return "staging";
  return normalized;
}

function pluginsFromModule(
  module: KernelPluginModule,
  specifier: string,
): readonly TakosPaaSKernelPlugin[] {
  const candidates = [
    module.default,
    module.plugin,
    module.plugins,
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
  const plugins = candidates.flatMap((value) =>
    Array.isArray(value) ? value : [value]
  );
  if (plugins.length === 0) {
    throw new Error(`kernel plugin module exported no plugins: ${specifier}`);
  }
  return plugins;
}
