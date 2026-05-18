/**
 * Bundled `worker@v1` KernelPlugin factory backed by the Deno Deploy
 * connector on the runtime-agent.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  createDenoDeployProvider,
  type DenoDeployLifecycleClient,
  InMemoryDenoDeployLifecycle,
} from "../shape-providers/worker/deno-deploy.ts";
import { kernelPluginFromProviderPlugin } from "./_kernel_plugin_adapter.ts";
import { KIND_URI_WORKER } from "./_kinds.ts";

export interface DenoDeployWorkerProviderOptions {
  /** Deno Deploy organization id used by the lifecycle client. */
  readonly organizationId?: string;
  readonly lifecycle?: DenoDeployLifecycleClient;
}

export function denoDeployWorkerProvider(
  opts: DenoDeployWorkerProviderOptions = {},
): KernelPlugin {
  const organizationId = opts.organizationId ?? "default";
  const lifecycle = opts.lifecycle ??
    new InMemoryDenoDeployLifecycle(organizationId);
  const provider = createDenoDeployProvider({ lifecycle, organizationId });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_WORKER,
    capabilities: ["scale-to-zero", "long-request", "geo-routing"],
  });
}
