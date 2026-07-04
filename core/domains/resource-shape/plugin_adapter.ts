import type {
  AdapterApplyInput,
  AdapterApplyResult,
  AdapterDeleteInput,
  AdapterPreviewResult,
  ResourceAdapter,
} from "./adapter.ts";
import type { JsonObject, NativeResourceRef } from "takosumi-contract";

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
    return validatePreviewResult(
      await this.#callPlugin(
        plugin,
        input.implementationPlugin!,
        "preview",
        input,
      ),
      input.implementationPlugin!,
    );
  }

  async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    const plugin = this.#pluginFor(input.implementationPlugin);
    if (!plugin) return await this.#fallback.apply(input);
    return validateApplyResult(
      await this.#callPlugin(
        plugin,
        input.implementationPlugin!,
        "apply",
        input,
      ),
      input.implementationPlugin!,
    );
  }

  async delete(input: AdapterDeleteInput): Promise<void> {
    const plugin = this.#pluginFor(input.implementationPlugin);
    if (!plugin) return await this.#fallback.delete(input);
    await this.#callPlugin(
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

  async #callPlugin(
    plugin: ResourceShapePluginBinding,
    pluginId: string,
    action: PluginAction,
    input: AdapterApplyInput | AdapterDeleteInput,
  ): Promise<Record<string, unknown> | undefined> {
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
    if (action === "delete" || response.status === 204) return undefined;
    const body = (await response.json()) as unknown;
    if (!isRecord(body)) {
      throw new Error(
        `Resource Shape adapter plugin "${pluginId}" ${action} returned a non-object response`,
      );
    }
    return body;
  }
}

function validatePreviewResult(
  body: Record<string, unknown> | undefined,
  pluginId: string,
): AdapterPreviewResult {
  if (!body) {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" preview returned an empty response`,
    );
  }
  const summary = body.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" preview response must include summary`,
    );
  }
  return {
    summary,
    nativeResources: nativeResourcesFromPluginResponse(
      body.nativeResources,
      pluginId,
      "preview",
    ),
    ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
  };
}

function validateApplyResult(
  body: Record<string, unknown> | undefined,
  pluginId: string,
): AdapterApplyResult {
  if (!body) {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" apply returned an empty response`,
    );
  }
  if (!isRecord(body.outputs)) {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" apply response must include outputs`,
    );
  }
  return {
    nativeResources: nativeResourcesFromPluginResponse(
      body.nativeResources,
      pluginId,
      "apply",
    ),
    outputs: body.outputs as JsonObject,
    ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
  };
}

function nativeResourcesFromPluginResponse(
  value: unknown,
  pluginId: string,
  action: PluginAction,
): readonly NativeResourceRef[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" ${action} response must include nativeResources`,
    );
  }
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.type !== "string" ||
      item.type.trim() === "" ||
      typeof item.id !== "string" ||
      item.id.trim() === ""
    ) {
      throw new Error(
        `Resource Shape adapter plugin "${pluginId}" ${action} response nativeResources[${index}] must include type and id`,
      );
    }
    return { type: item.type, id: item.id };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
