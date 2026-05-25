/**
 * Bundled `gateway@v1` KernelPlugin factory backed by AWS Route53.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  createRoute53Provider,
  InMemoryRoute53Lifecycle,
  type Route53LifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/gateway/route53";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";
import { KIND_URI_GATEWAY } from "./_kinds.ts";

export interface AwsRoute53ProviderOptions {
  readonly hostedZoneId?: string;
  readonly lifecycle?: Route53LifecycleClient;
}

export function awsRoute53CustomDomainProvider(
  opts: AwsRoute53ProviderOptions = {},
): KernelPlugin {
  const hostedZoneId = opts.hostedZoneId ?? "Z000000000000000000000";
  const lifecycle = opts.lifecycle ??
    new InMemoryRoute53Lifecycle(hostedZoneId);
  const provider = createRoute53Provider({ lifecycle, hostedZoneId });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_GATEWAY,
    capabilities: ["wildcard", "auto-tls", "sni", "alpn-acme"],
  });
}
