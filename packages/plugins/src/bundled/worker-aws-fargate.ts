/**
 * Bundled `worker@v1` KernelPlugin factory backed by AWS Fargate.
 *
 * Maps the canonical `worker` kind URI to an always-on container running
 * on Fargate. The wrapper passes the AppSpec component.spec through to
 * the underlying shape-provider; operators authoring the AppSpec keep the
 * shape compatible with the underlying provider (image / port / etc.).
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  type AwsFargateLifecycleClient,
  createAwsFargateWebServiceProvider,
  InMemoryAwsFargateLifecycle,
} from "../shape-providers/web-service/aws-fargate.ts";
import { kernelPluginFromProviderPlugin } from "./_kernel_plugin_adapter.ts";
import { KIND_URI_WORKER } from "./_kinds.ts";

export interface AwsFargateWorkerProviderOptions {
  readonly clusterName?: string;
  readonly region?: string;
  readonly lifecycle?: AwsFargateLifecycleClient;
}

export function awsFargateWorkerProvider(
  opts: AwsFargateWorkerProviderOptions = {},
): KernelPlugin {
  const clusterName = opts.clusterName ?? "takos-cluster";
  const region = opts.region ?? "us-east-1";
  const lifecycle = opts.lifecycle ??
    new InMemoryAwsFargateLifecycle(clusterName, region);
  const provider = createAwsFargateWebServiceProvider({
    lifecycle,
    clusterName,
    region,
  });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_WORKER,
    capabilities: [
      "always-on",
      "websocket",
      "long-request",
      "sticky-session",
      "private-networking",
    ],
  });
}
