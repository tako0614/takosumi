/**
 * Service plugin registry — owns the set of operator-supplied
 * `TakosumiPlugin` instances and resolves exact kind references to the plugin
 * that materializes them.
 */
import type { TakosumiPlugin } from "takosumi-contract/reference/plugin";
import type { TakosumiPluginRegistry } from "./types.ts";

export class InMemoryTakosumiPluginRegistry implements TakosumiPluginRegistry {
  readonly #plugins: TakosumiPlugin[] = [];
  readonly #byKindUri = new Map<string, TakosumiPlugin>();
  readonly #byName = new Map<string, TakosumiPlugin>();

  constructor(
    plugins: readonly TakosumiPlugin[] = [],
  ) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: TakosumiPlugin): void {
    assertValidPlugin(plugin);
    if (this.#byName.has(plugin.name)) {
      throw new Error(`service plugin already registered: ${plugin.name}`);
    }
    for (const kindUri of plugin.provides) {
      const existing = this.#byKindUri.get(kindUri);
      if (existing) {
        throw new Error(
          `service plugin ${plugin.name} conflicts on kind ${kindUri}; ${existing.name} already provides it`,
        );
      }
    }
    this.#plugins.push(plugin);
    this.#byName.set(plugin.name, plugin);
    for (const kindUri of plugin.provides) {
      this.#byKindUri.set(kindUri, plugin);
    }
  }

  list(): readonly TakosumiPlugin[] {
    return Object.freeze([...this.#plugins]);
  }

  findByKindUri(kindUri: string): TakosumiPlugin | undefined {
    return this.#byKindUri.get(kindUri);
  }

  findByKindRef(kind: string): TakosumiPlugin | undefined {
    return this.findByKindUri(normalizeKindToUri(kind));
  }

  getByName(name: string): TakosumiPlugin | undefined {
    return this.#byName.get(name);
  }
}

export function createTakosumiPluginRegistry(
  plugins: readonly TakosumiPlugin[] = [],
): TakosumiPluginRegistry {
  return new InMemoryTakosumiPluginRegistry(plugins);
}

/**
 * Normalize a kind reference for plugin lookup. Full `http(s)` URIs pass
 * through unchanged. Bare tokens are returned as-is; the manifestless v1 space
 * does not expand authoring aliases.
 */
export function normalizeKindToUri(kind: string): string {
  if (isKindUri(kind)) return kind;
  // Unknown bare token - return as-is so the lookup miss surfaces a clean
  // "no plugin provides kind X" error downstream.
  return kind;
}

/**
 * Find the plugin that should materialize a given kind reference.
 */
export function findPluginForKind(
  registry: TakosumiPluginRegistry,
  kind: string,
): TakosumiPlugin | undefined {
  return registry.findByKindRef(kind);
}

function isKindUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function assertValidPlugin(plugin: TakosumiPlugin): void {
  if (!plugin.name?.trim()) {
    throw new Error("service plugin name is required");
  }
  if (!plugin.version?.trim()) {
    throw new Error(`service plugin version is required: ${plugin.name}`);
  }
  if (!Array.isArray(plugin.provides) || plugin.provides.length === 0) {
    throw new Error(
      `service plugin ${plugin.name} must advertise at least one kind URI in provides[]`,
    );
  }
  for (const kindUri of plugin.provides) {
    if (typeof kindUri !== "string" || kindUri.length === 0) {
      throw new Error(
        `service plugin ${plugin.name} has invalid provides[] entry`,
      );
    }
  }
  if (typeof plugin.apply !== "function") {
    throw new Error(`service plugin ${plugin.name} must define apply()`);
  }
}
