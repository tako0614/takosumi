/**
 * Bundled `web-service@v1` KernelPlugin factory backed by a self-hosted Docker
 * Compose stack.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  createDockerComposeWebServiceProvider,
  type DockerComposeServiceLifecycleClient,
  InMemoryDockerComposeLifecycle,
} from "@takos/takosumi-plugins/shape-providers/web-service/docker-compose";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";
import { KIND_URI_WEB_SERVICE } from "./_kinds.ts";

export interface SelfhostDockerComposeWorkerProviderOptions {
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly lifecycle?: DockerComposeServiceLifecycleClient;
}

export type SelfhostDockerComposeWebServiceProviderOptions =
  SelfhostDockerComposeWorkerProviderOptions;

export function selfhostDockerComposeWebServiceProvider(
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
    kindUri: KIND_URI_WEB_SERVICE,
    capabilities: ["always-on", "websocket", "long-request", "sticky-session"],
  });
}

/** @deprecated Use `selfhostDockerComposeWebServiceProvider`; this provides web-service. */
export const selfhostDockerComposeWorkerProvider =
  selfhostDockerComposeWebServiceProvider;
