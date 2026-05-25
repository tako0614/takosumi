/**
 * Bundled `web-service@v1` KernelPlugin factory backed by GCP Cloud Run.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  type CloudRunLifecycleClient,
  createCloudRunWebServiceProvider,
  InMemoryCloudRunLifecycle,
} from "@takos/takosumi-plugins/shape-providers/web-service/cloud-run";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";
import { KIND_URI_WEB_SERVICE } from "./_kinds.ts";

export interface GcpCloudRunWorkerProviderOptions {
  readonly project?: string;
  readonly region?: string;
  readonly lifecycle?: CloudRunLifecycleClient;
}

export type GcpCloudRunWebServiceProviderOptions =
  GcpCloudRunWorkerProviderOptions;

export function gcpCloudRunWebServiceProvider(
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
    kindUri: KIND_URI_WEB_SERVICE,
    capabilities: ["always-on", "scale-to-zero", "websocket", "long-request"],
  });
}

/** @deprecated Use `gcpCloudRunWebServiceProvider`; this provides web-service. */
export const gcpCloudRunWorkerProvider = gcpCloudRunWebServiceProvider;
