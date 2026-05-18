/**
 * Bundled `worker@v1` KernelPlugin factory backed by GCP Cloud Run.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  type CloudRunLifecycleClient,
  createCloudRunWebServiceProvider,
  InMemoryCloudRunLifecycle,
} from "../shape-providers/web-service/cloud-run.ts";
import { kernelPluginFromProviderPlugin } from "./_kernel_plugin_adapter.ts";
import { KIND_URI_WORKER } from "./_kinds.ts";

export interface GcpCloudRunWorkerProviderOptions {
  readonly project?: string;
  readonly region?: string;
  readonly lifecycle?: CloudRunLifecycleClient;
}

export function gcpCloudRunWorkerProvider(
  opts: GcpCloudRunWorkerProviderOptions = {},
): KernelPlugin {
  const project = opts.project ?? "default";
  const region = opts.region ?? "us-central1";
  const lifecycle = opts.lifecycle ??
    new InMemoryCloudRunLifecycle(project, region);
  const provider = createCloudRunWebServiceProvider({
    lifecycle,
    project,
    region,
  });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_WORKER,
    capabilities: ["always-on", "scale-to-zero", "websocket", "long-request"],
  });
}
