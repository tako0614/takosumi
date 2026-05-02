import { TAKOSUMI_KERNEL_PLUGIN_API_VERSION } from "takosumi-contract";
import type {
  KernelPluginPortKind,
  TakosumiKernelPluginManifest,
} from "takosumi-contract";
import type {
  KernelPluginAdapterOverrides,
  KernelPluginCreateAdaptersContext,
  KernelPluginRegistry,
  TakosPaaSKernelPlugin,
} from "./types.ts";
import { hasTrustedKernelPluginInstall } from "./trust_marker.ts";

export class InMemoryKernelPluginRegistry implements KernelPluginRegistry {
  readonly #plugins = new Map<string, TakosPaaSKernelPlugin>();

  constructor(plugins: readonly TakosPaaSKernelPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: TakosPaaSKernelPlugin): void {
    assertValidPluginManifest(plugin.manifest);
    const existing = this.#plugins.get(plugin.manifest.id);
    if (existing) {
      throw new Error(
        `kernel plugin already registered: ${plugin.manifest.id}`,
      );
    }
    this.#plugins.set(plugin.manifest.id, plugin);
  }

  list(): readonly TakosPaaSKernelPlugin[] {
    return Object.freeze([...this.#plugins.values()]);
  }

  get(id: string): TakosPaaSKernelPlugin | undefined {
    return this.#plugins.get(id);
  }
}

export function createKernelPluginRegistry(
  plugins: readonly TakosPaaSKernelPlugin[] = [],
): KernelPluginRegistry {
  return new InMemoryKernelPluginRegistry(plugins);
}

export function createPluginAdapterOverrides(input: {
  readonly registry: KernelPluginRegistry;
  readonly selectedPluginIds: Partial<Record<KernelPluginPortKind, string>>;
  readonly context: KernelPluginCreateAdaptersContext;
}): KernelPluginAdapterOverrides {
  const overrides: KernelPluginAdapterOverrides = {};
  const initialized = new Set<string>();
  const selectedPortsByPlugin = selectedPortsByPluginId(
    input.selectedPluginIds,
  );
  for (const pluginId of Object.values(input.selectedPluginIds)) {
    if (!pluginId || initialized.has(pluginId)) continue;
    const plugin = input.registry.get(pluginId);
    if (!plugin) {
      throw new Error(`kernel plugin is not registered: ${pluginId}`);
    }
    const selectedPorts = selectedPortsByPlugin.get(pluginId) ?? [];
    assertPluginSupportsSelectedPorts(plugin.manifest, selectedPorts);
    assertPluginAllowedForEnvironment(
      plugin.manifest,
      selectedPorts,
      input.context.environment,
    );
    assertPluginTrustedForEnvironment(plugin, input.context.environment);
    const pluginOverrides = plugin.createAdapters(input.context);
    assertPluginProvidesSelectedAdapters(
      plugin.manifest,
      pluginOverrides,
      selectedPorts,
    );
    const selectedPluginOverrides = selectedAdapterOverrides(
      plugin.manifest,
      pluginOverrides,
      selectedPorts,
      overrides,
    );
    assertPluginDoesNotOverrideExistingAdapters(
      plugin.manifest,
      overrides,
      selectedPluginOverrides,
    );
    assignPluginOverrides(
      overrides,
      plugin.manifest.id,
      selectedPluginOverrides,
    );
    initialized.add(pluginId);
  }
  return overrides;
}

export function assertPluginTrustedForEnvironment(
  plugin: TakosPaaSKernelPlugin,
  environment: string,
): void {
  if (environment !== "production" && environment !== "staging") return;
  if (hasTrustedKernelPluginInstall(plugin)) return;
  throw new Error(
    `${environment} requires trusted install metadata for kernel plugin ${plugin.manifest.id}`,
  );
}

export function assertPluginAllowedForEnvironment(
  manifest: TakosumiKernelPluginManifest,
  ports: readonly KernelPluginPortKind[],
  environment: string,
): void {
  if (environment !== "production" && environment !== "staging") return;
  const normalizedId = manifest.id.toLowerCase();
  if (
    normalizedId === "takos.kernel.reference" ||
    /(^|[._-])noop([._-]|$)/.test(normalizedId) ||
    /(^|[._-])reference([._-]|$)/.test(normalizedId)
  ) {
    throw new Error(
      `${environment} cannot select reference/noop kernel plugin ${manifest.id}`,
    );
  }
  for (const port of ports) {
    const capabilities = manifest.capabilities.filter((capability) =>
      capability.port === port
    );
    if (
      capabilities.length > 0 &&
      capabilities.every((capability) =>
        capability.externalIo.length === 0 ||
        capability.externalIo.every((boundary) => boundary === "none")
      )
    ) {
      throw new Error(
        `${environment} plugin ${manifest.id} declares no external I/O for selected port ${port}`,
      );
    }
  }
}

export function assertValidPluginManifest(
  manifest: TakosumiKernelPluginManifest,
): void {
  if (!manifest.id.trim()) throw new Error("kernel plugin id is required");
  if (!manifest.version.trim()) {
    throw new Error(`kernel plugin version is required: ${manifest.id}`);
  }
  if (!manifest.kernelApiVersion.trim()) {
    throw new Error(
      `kernel plugin kernelApiVersion is required: ${manifest.id}`,
    );
  }
  if (manifest.kernelApiVersion !== TAKOSUMI_KERNEL_PLUGIN_API_VERSION) {
    throw new Error(
      `kernel plugin ${manifest.id} targets unsupported kernel API ${manifest.kernelApiVersion}; expected ${TAKOSUMI_KERNEL_PLUGIN_API_VERSION}`,
    );
  }
}

function selectedPortsByPluginId(
  selectedPluginIds: Partial<Record<KernelPluginPortKind, string>>,
): Map<string, KernelPluginPortKind[]> {
  const portsByPlugin = new Map<string, KernelPluginPortKind[]>();
  for (const [rawPort, pluginId] of Object.entries(selectedPluginIds)) {
    if (!pluginId) continue;
    const port = rawPort as KernelPluginPortKind;
    portsByPlugin.set(pluginId, [...(portsByPlugin.get(pluginId) ?? []), port]);
  }
  return portsByPlugin;
}

function assertPluginSupportsSelectedPorts(
  manifest: TakosumiKernelPluginManifest,
  ports: readonly KernelPluginPortKind[],
): void {
  const supportedPorts = new Set(
    manifest.capabilities.map((capability) => capability.port),
  );
  for (const port of ports) {
    if (supportedPorts.has(port)) continue;
    throw new Error(
      `kernel plugin ${manifest.id} does not declare capability for selected port ${port}`,
    );
  }
}

function assertPluginProvidesSelectedAdapters(
  manifest: TakosumiKernelPluginManifest,
  overrides: KernelPluginAdapterOverrides,
  ports: readonly KernelPluginPortKind[],
): void {
  for (const port of ports) {
    const adapterKey = adapterKeyForPort(port);
    if (!adapterKey) continue;
    if (overrides[adapterKey]) continue;
    throw new Error(
      `kernel plugin ${manifest.id} did not provide adapter ${adapterKey} for selected port ${port}`,
    );
  }
}

function selectedAdapterOverrides(
  manifest: TakosumiKernelPluginManifest,
  overrides: KernelPluginAdapterOverrides,
  ports: readonly KernelPluginPortKind[],
  existing: KernelPluginAdapterOverrides,
): KernelPluginAdapterOverrides {
  const selectedOverrides: KernelPluginAdapterOverrides = {};
  const mutableSelected =
    selectedOverrides as MutableKernelPluginAdapterOverrides;
  const selectedAdapterKeys = new Set(
    ports.map(adapterKeyForPort).filter((key): key is AdapterOverrideKey =>
      key !== undefined
    ),
  );
  const supportedAdapterKeys = new Set(
    manifest.capabilities
      .map((capability) => adapterKeyForPort(capability.port))
      .filter((key): key is AdapterOverrideKey => key !== undefined),
  );
  for (const adapterKey of Object.keys(overrides) as AdapterOverrideKey[]) {
    const adapter = overrides[adapterKey];
    if (adapter === undefined) continue;
    if (selectedAdapterKeys.has(adapterKey)) {
      mutableSelected[adapterKey] = adapter as never;
      continue;
    }
    if (existing[adapterKey] !== undefined) {
      throw new Error(
        `kernel plugin ${manifest.id} attempted duplicate ownership of adapter ${adapterKey}`,
      );
    }
    if (supportedAdapterKeys.has(adapterKey)) continue;
    throw new Error(
      `kernel plugin ${manifest.id} provided unselected adapter ${adapterKey}`,
    );
  }
  return selectedOverrides;
}

function assertPluginDoesNotOverrideExistingAdapters(
  manifest: TakosumiKernelPluginManifest,
  existing: KernelPluginAdapterOverrides,
  overrides: KernelPluginAdapterOverrides,
): void {
  for (const adapterKey of Object.keys(overrides) as AdapterOverrideKey[]) {
    if (overrides[adapterKey] === undefined) continue;
    if (existing[adapterKey] === undefined) continue;
    throw new Error(
      `kernel plugin ${manifest.id} attempted duplicate ownership of adapter ${adapterKey}`,
    );
  }
}

function assignPluginOverrides(
  target: KernelPluginAdapterOverrides,
  pluginId: string,
  overrides: KernelPluginAdapterOverrides,
): void {
  const mutableTarget = target as MutableKernelPluginAdapterOverrides;
  for (const adapterKey of Object.keys(overrides) as AdapterOverrideKey[]) {
    const adapter = overrides[adapterKey];
    if (adapter === undefined) continue;
    if (target[adapterKey] !== undefined) {
      throw new Error(
        `kernel plugin ${pluginId} attempted duplicate ownership of adapter ${adapterKey}`,
      );
    }
    mutableTarget[adapterKey] = adapter as never;
  }
}

type AdapterOverrideKey = keyof KernelPluginAdapterOverrides;
type MutableKernelPluginAdapterOverrides = {
  -readonly [K in keyof KernelPluginAdapterOverrides]:
    KernelPluginAdapterOverrides[K];
};

function adapterKeyForPort(
  port: KernelPluginPortKind,
): keyof KernelPluginAdapterOverrides | undefined {
  switch (port) {
    case "auth":
      return "auth";
    case "coordination":
      return "coordination";
    case "kms":
      return "kms";
    case "notification":
      return "notifications";
    case "object-storage":
      return "objectStorage";
    case "operator-config":
      return "operatorConfig";
    case "provider":
      return "provider";
    case "queue":
      return "queue";
    case "router-config":
      return "routerConfig";
    case "secret-store":
      return "secrets";
    case "source":
      return "source";
    case "storage":
      return "storage";
    case "observability":
      return "observability";
    case "runtime-agent":
      return "runtimeAgent";
  }
}
