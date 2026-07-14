import type {
  AdapterApplyInput,
  AdapterApplyResult,
  AdapterDeleteInput,
  AdapterImportInput,
  AdapterImportResult,
  AdapterObserveResult,
  AdapterPreviewResult,
  AdapterRefreshResult,
  ResourceAdapter,
} from "./adapter.ts";
import type { JsonObject, NativeResourceRef } from "takosumi-contract";

export interface ResourceShapePluginBinding {
  fetch(request: Request): Promise<Response> | Response;
}

export type ResourceShapePluginBindings = Readonly<
  Record<string, ResourceShapePluginBinding>
>;

type PluginAction =
  "preview" | "apply" | "import" | "observe" | "refresh" | "delete";

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
    const plugin = this.#pluginFor(input.implementation.plugin);
    if (!plugin) {
      assertExplicitModuleExecution(input);
      return await this.#fallback.preview(input);
    }
    return validatePreviewResult(
      await this.#callPlugin(
        plugin,
        input.implementation.plugin!,
        "preview",
        input,
      ),
      input.implementation.plugin!,
    );
  }

  async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    const plugin = this.#pluginFor(input.implementation.plugin);
    if (!plugin) {
      assertExplicitModuleExecution(input);
      return await this.#fallback.apply(input);
    }
    return validateApplyResult(
      await this.#callPlugin(
        plugin,
        input.implementation.plugin!,
        "apply",
        input,
      ),
      input.implementation.plugin!,
    );
  }

  async importResource(
    input: AdapterImportInput,
  ): Promise<AdapterImportResult> {
    const plugin = this.#pluginFor(input.implementation.plugin);
    if (!plugin) {
      assertExplicitModuleExecution(input);
      return await this.#fallback.importResource(input);
    }
    return validateImportResult(
      await this.#callPlugin(
        plugin,
        input.implementation.plugin!,
        "import",
        input,
      ),
      input.implementation.plugin!,
    );
  }

  async observe(input: AdapterApplyInput): Promise<AdapterObserveResult> {
    const plugin = this.#pluginFor(input.implementation.plugin);
    if (!plugin) {
      assertExplicitModuleExecution(input);
      return await this.#fallback.observe(input);
    }
    return validateObserveResult(
      await this.#callPlugin(
        plugin,
        input.implementation.plugin!,
        "observe",
        input,
      ),
      input.implementation.plugin!,
    );
  }

  async refresh(input: AdapterApplyInput): Promise<AdapterRefreshResult> {
    const plugin = this.#pluginFor(input.implementation.plugin);
    if (!plugin) {
      assertExplicitModuleExecution(input);
      return await this.#fallback.refresh(input);
    }
    return validateRefreshResult(
      await this.#callPlugin(
        plugin,
        input.implementation.plugin!,
        "refresh",
        input,
      ),
      input.implementation.plugin!,
    );
  }

  async delete(input: AdapterDeleteInput): Promise<void> {
    const plugin = this.#pluginFor(input.implementation.plugin);
    if (!plugin) {
      assertExplicitModuleExecution(input);
      return await this.#fallback.delete(input);
    }
    await this.#callPlugin(
      plugin,
      input.implementation.plugin!,
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
    input: AdapterApplyInput | AdapterImportInput | AdapterDeleteInput,
  ): Promise<Record<string, unknown> | undefined> {
    const resource = input.plan
      ? {
          kind: input.plan.shape,
          spec: input.plan.validatedSpec,
        }
      : undefined;
    const response = await plugin.fetch(
      new Request(
        `https://takosumi-resource-shape-plugin.local/${encodeURIComponent(
          pluginId,
        )}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            input,
            ...(resource ? { resource } : {}),
          }),
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

function assertExplicitModuleExecution(
  input: AdapterApplyInput | AdapterDeleteInput,
): void {
  if (
    input.implementation.providerSource &&
    input.implementation.moduleTemplate
  ) {
    return;
  }
  throw new Error(
    `Resource Shape implementation "${input.implementation.implementation}" must declare either an installed plugin or providerSource + moduleTemplate`,
  );
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

function validateImportResult(
  body: Record<string, unknown> | undefined,
  pluginId: string,
): AdapterImportResult {
  if (!body) {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" import returned an empty response`,
    );
  }
  const summary = body.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" import response must include summary`,
    );
  }
  if (!isRecord(body.outputs)) {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" import response must include outputs`,
    );
  }
  return {
    summary,
    nativeResources: nativeResourcesFromPluginResponse(
      body.nativeResources,
      pluginId,
      "import",
    ),
    outputs: body.outputs as JsonObject,
    ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
  };
}

function validateRefreshResult(
  body: Record<string, unknown> | undefined,
  pluginId: string,
): AdapterRefreshResult {
  if (!body) {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" refresh returned an empty response`,
    );
  }
  const summary = body.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" refresh response must include summary`,
    );
  }
  if (!isRecord(body.outputs)) {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" refresh response must include outputs`,
    );
  }
  return {
    summary,
    nativeResources: nativeResourcesFromPluginResponse(
      body.nativeResources,
      pluginId,
      "refresh",
    ),
    outputs: body.outputs as JsonObject,
    ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
  };
}

function validateObserveResult(
  body: Record<string, unknown> | undefined,
  pluginId: string,
): AdapterObserveResult {
  if (!body) {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" observe returned an empty response`,
    );
  }
  const status = body.status;
  if (status !== "current" && status !== "drifted" && status !== "missing") {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" observe response status must be current, drifted, or missing`,
    );
  }
  const summary = body.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new Error(
      `Resource Shape adapter plugin "${pluginId}" observe response must include summary`,
    );
  }
  return {
    status,
    summary,
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
