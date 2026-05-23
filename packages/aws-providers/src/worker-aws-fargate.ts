/**
 * Reference `web-service` KernelPlugin factory backed by AWS Fargate.
 *
 * The historical `awsFargateWorkerProvider` export is retained as a
 * compatibility alias, but it now provides the `web-service` kind URI because
 * the underlying shape is an OCI container service rather than a JS worker.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  type AwsFargateLifecycleClient,
  createAwsFargateWebServiceProvider,
  InMemoryAwsFargateLifecycle,
} from "@takos/takosumi-plugins/shape-providers/web-service/aws-fargate";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/kernel-plugin-adapter";
import { KIND_URI_WEB_SERVICE } from "./_kinds.ts";

export interface AwsFargateWorkerProviderOptions {
  readonly clusterName?: string;
  readonly region?: string;
  readonly lifecycle?: AwsFargateLifecycleClient;
}

export type AwsFargateWebServiceProviderOptions =
  AwsFargateWorkerProviderOptions;

export function awsFargateWebServiceProvider(
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
    kindUri: KIND_URI_WEB_SERVICE,
    capabilities: [
      "always-on",
      "websocket",
      "long-request",
      "sticky-session",
      "private-networking",
    ],
  });
}

/** @deprecated Use `awsFargateWebServiceProvider`; this provides web-service. */
export const awsFargateWorkerProvider = awsFargateWebServiceProvider;
