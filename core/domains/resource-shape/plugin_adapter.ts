import type {
  AdapterApplyInput,
  AdapterApplyResult,
  AdapterDeleteInput,
  AdapterPreviewResult,
  ResourceAdapter,
} from "./adapter.ts";

export interface ResourceShapePluginBinding {
  fetch(request: Request): Promise<Response> | Response;
}

export type ResourceShapePluginBindings = Readonly<
  Record<string, ResourceShapePluginBinding>
>;

type PluginAction = "preview" | "apply" | "delete";

/**
 * Adapter multiplexer for operator-installed Resource Shape plugins.
 *
 * OSS core owns only the stable adapter contract and dispatch mechanism.
 * Concrete Cloud/Operator backends are injected as fetch-compatible bindings by
 * the host worker and selected through TargetPool implementation.plugin.
 */
export class PluginResourceShapeAdapter implements ResourceAdapter {
  readonly id: string;
  readonly #fallback: ResourceAdapter;
  readonly #plugins: ResourceShapePluginBindings;

  constructor(fallback: ResourceAdapter, plugins: ResourceShapePluginBindings) {
    this.#fallback = fallback;
    this.#plugins = plugins;
    this.id = `${fallback.id}+plugins`;
  }

  async preview(input: AdapterApplyInput): Promise<AdapterPreviewResult> {
    const plugin = this.#pluginFor(input.implementationPlugin);
    if (!plugin) return await this.#fallback.preview(input);
    return await this.#callPlugin<AdapterPreviewResult>(
      plugin,
      input.implementationPlugin!,
      "preview",
      input,
    );
  }

  async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    const plugin = this.#pluginFor(input.implementationPlugin);
    if (!plugin) return await this.#fallback.apply(input);
    return await this.#callPlugin<AdapterApplyResult>(
      plugin,
      input.implementationPlugin!,
      "apply",
      input,
    );
  }

  async delete(input: AdapterDeleteInput): Promise<void> {
    const plugin = this.#pluginFor(input.implementationPlugin);
    if (!plugin) return await this.#fallback.delete(input);
    await this.#callPlugin<unknown>(
      plugin,
      input.implementationPlugin!,
      "delete",
      input,
    );
  }

  #pluginFor(
    pluginId: string | undefined,
  ): ResourceShapePluginBinding | undefined {
    if (!pluginId) return undefined;
    const plugin = this.#plugins[pluginId];
    if (!plugin) {
      throw new Error(
        `Resource Shape adapter plugin "${pluginId}" is not installed`,
      );
    }
    return plugin;
  }

  async #callPlugin<T>(
    plugin: ResourceShapePluginBinding,
    pluginId: string,
    action: PluginAction,
    input: AdapterApplyInput | AdapterDeleteInput,
  ): Promise<T> {
    const response = await plugin.fetch(
      new Request(
        `https://takosumi-resource-shape-plugin.local/${encodeURIComponent(
          pluginId,
        )}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, input }),
        },
      ),
    );
    if (!response.ok) {
      throw new Error(
        `Resource Shape adapter plugin "${pluginId}" ${action} failed with ${response.status}: ${await response.text()}`,
      );
    }
    if (action === "delete" || response.status === 204) return undefined as T;
    const body = (await response.json()) as unknown;
    if (!isRecord(body)) {
      throw new Error(
        `Resource Shape adapter plugin "${pluginId}" ${action} returned a non-object response`,
      );
    }
    return body as T;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
