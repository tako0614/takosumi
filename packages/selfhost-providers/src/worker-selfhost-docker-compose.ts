/**
 * Bundled `worker@v1` KernelPlugin factory backed by a self-hosted Docker
 * Compose stack.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  createDockerComposeWebServiceProvider,
  type DockerComposeServiceLifecycleClient,
  InMemoryDockerComposeLifecycle,
} from "@takos/takosumi-plugins/shape-providers/web-service/docker-compose";
import { kernelPluginFromProviderPlugin } from "./_kernel_plugin_adapter.ts";
import { KIND_URI_WORKER } from "./_kinds.ts";

export interface SelfhostDockerComposeWorkerProviderOptions {
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly lifecycle?: DockerComposeServiceLifecycleClient;
}

export function selfhostDockerComposeWorkerProvider(
  opts: SelfhostDockerComposeWorkerProviderOptions = {},
): KernelPlugin {
  const lifecycle = opts.lifecycle ?? new InMemoryDockerComposeLifecycle();
  const provider = createDockerComposeWebServiceProvider({
    lifecycle,
    ...(opts.hostBinding ? { hostBinding: opts.hostBinding } : {}),
    ...(opts.hostPortStart !== undefined
      ? { hostPortStart: opts.hostPortStart }
      : {}),
  });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_WORKER,
    capabilities: ["always-on", "websocket", "long-request", "sticky-session"],
  });
}
