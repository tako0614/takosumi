/**
 * Docker Compose `web-service@v1` KernelPlugin package.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  createDockerComposeWebServiceProvider,
  type DockerComposeServiceLifecycleClient,
  InMemoryDockerComposeLifecycle,
} from "@takos/takosumi-plugins/shape-providers/web-service/docker-compose";
import { TAKOSUMI_REFERENCE_KIND_URIS } from "@takos/takosumi-plugins/kinds";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";

export interface DockerComposeWebServiceProviderOptions {
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly lifecycle?: DockerComposeServiceLifecycleClient;
}

export function dockerComposeWebServiceProvider(
  opts: DockerComposeWebServiceProviderOptions = {},
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
    kindUri: TAKOSUMI_REFERENCE_KIND_URIS["web-service"],
    capabilities: ["always-on", "websocket", "long-request", "sticky-session"],
  });
}
