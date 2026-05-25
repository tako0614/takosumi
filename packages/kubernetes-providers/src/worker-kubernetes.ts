/**
 * Bundled `web-service@v1` KernelPlugin factory backed by a Kubernetes /
 * k3s deployment.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  createK3sDeploymentWebServiceProvider,
  InMemoryK3sDeploymentLifecycle,
  type K3sDeploymentLifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/web-service/k3s-deployment";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";
import { KIND_URI_WEB_SERVICE } from "./_kinds.ts";

export interface KubernetesWorkerProviderOptions {
  readonly namespace?: string;
  readonly clusterDomain?: string;
  readonly lifecycle?: K3sDeploymentLifecycleClient;
}

export type KubernetesWebServiceProviderOptions =
  KubernetesWorkerProviderOptions;

export function kubernetesWebServiceProvider(
  opts: KubernetesWorkerProviderOptions = {},
): KernelPlugin {
  const namespace = opts.namespace ?? "takos";
  const lifecycle = opts.lifecycle ?? new InMemoryK3sDeploymentLifecycle();
  const provider = createK3sDeploymentWebServiceProvider({
    lifecycle,
    namespace,
    ...(opts.clusterDomain ? { clusterDomain: opts.clusterDomain } : {}),
  });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_WEB_SERVICE,
    capabilities: [
      "always-on",
      "websocket",
      "long-request",
      "private-networking",
    ],
  });
}

/** @deprecated Use `kubernetesWebServiceProvider`; this provides web-service. */
export const kubernetesWorkerProvider = kubernetesWebServiceProvider;
