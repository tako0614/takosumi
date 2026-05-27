/**
 * Kernel plugin registry — owns the set of operator-supplied
 * `KernelPlugin` instances and resolves component kind URIs to the plugin
 * that materializes them.
 */
import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import { isKindUri } from "takosumi-contract/app-spec";
import type { KernelPluginRegistry, KindAliasMap } from "./types.ts";

export interface KernelPluginRegistryOptions {
  readonly kindAliases?: KindAliasMap;
}

export class InMemoryKernelPluginRegistry implements KernelPluginRegistry {
  readonly #plugins: KernelPlugin[] = [];
  readonly #byKindUri = new Map<string, KernelPlugin>();
  readonly #byName = new Map<string, KernelPlugin>();
  readonly #kindAliases: KindAliasMap;

  constructor(
    plugins: readonly KernelPlugin[] = [],
    options: KernelPluginRegistryOptions = {},
  ) {
    this.#kindAliases = validateKindAliases(options.kindAliases ?? {});
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: KernelPlugin): void {
    assertValidPlugin(plugin);
    if (this.#byName.has(plugin.name)) {
      throw new Error(`kernel plugin already registered: ${plugin.name}`);
    }
    for (const kindUri of plugin.provides) {
      const existing = this.#byKindUri.get(kindUri);
      if (existing) {
        throw new Error(
          `kernel plugin ${plugin.name} conflicts on kind ${kindUri}; ${existing.name} already provides it`,
        );
      }
    }
    this.#plugins.push(plugin);
    this.#byName.set(plugin.name, plugin);
    for (const kindUri of plugin.provides) {
      this.#byKindUri.set(kindUri, plugin);
    }
  }

  list(): readonly KernelPlugin[] {
    return Object.freeze([...this.#plugins]);
  }

  findByKindUri(kindUri: string): KernelPlugin | undefined {
    return this.#byKindUri.get(kindUri);
  }

  findByKindRef(kind: string): KernelPlugin | undefined {
    return this.findByKindUri(normalizeKindToUri(kind, this.#kindAliases));
  }

  getByName(name: string): KernelPlugin | undefined {
    return this.#byName.get(name);
  }
}

export function createKernelPluginRegistry(
  plugins: readonly KernelPlugin[] = [],
  options: KernelPluginRegistryOptions = {},
): KernelPluginRegistry {
  return new InMemoryKernelPluginRegistry(plugins, options);
}

/**
 * Normalize a `Component.kind` value (short name or canonical URI) to the
 * URI used for plugin lookup. Full `http(s)` URIs pass through unchanged.
 * Bare aliases resolve only when the operator supplied a matching alias.
 */
export function normalizeKindToUri(
  kind: string,
  aliases: KindAliasMap = {},
): string {
  if (isKindUri(kind)) return kind;
  const aliased = aliases[kind];
  if (aliased) return aliased;
  // Unknown bare token — return as-is so the lookup miss surfaces a clean
  // "no plugin provides kind X" error downstream.
  return kind;
}

/**
 * Find the plugin that should materialize a given component kind. Accepts
 * either an operator alias or a full kind URI on the AppSpec side.
 */
export function findPluginForKind(
  registry: KernelPluginRegistry,
  kind: string,
): KernelPlugin | undefined {
  return registry.findByKindRef(kind);
}

function validateKindAliases(aliases: KindAliasMap): KindAliasMap {
  for (const [alias, uri] of Object.entries(aliases)) {
    if (alias.length === 0) {
      throw new Error("kind alias name must be non-empty");
    }
    if (typeof uri !== "string" || !isKindUri(uri)) {
      throw new Error(`kind alias ${alias} must resolve to an http(s) URI`);
    }
  }
  return Object.freeze({ ...aliases });
}

function assertValidPlugin(plugin: KernelPlugin): void {
  if (!plugin.name?.trim()) {
    throw new Error("kernel plugin name is required");
  }
  if (!plugin.version?.trim()) {
    throw new Error(`kernel plugin version is required: ${plugin.name}`);
  }
  if (!Array.isArray(plugin.provides) || plugin.provides.length === 0) {
    throw new Error(
      `kernel plugin ${plugin.name} must advertise at least one kind URI in provides[]`,
    );
  }
  for (const kindUri of plugin.provides) {
    if (typeof kindUri !== "string" || kindUri.length === 0) {
      throw new Error(
        `kernel plugin ${plugin.name} has invalid provides[] entry`,
      );
    }
  }
  if (typeof plugin.apply !== "function") {
    throw new Error(`kernel plugin ${plugin.name} must define apply()`);
  }
}
