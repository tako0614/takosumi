/**
 * Bundled `custom-domain@v1` KernelPlugin factory backed by AWS Route53.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  createRoute53Provider,
  InMemoryRoute53Lifecycle,
  type Route53LifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/custom-domain/route53";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/kernel-plugin-adapter";
import { KIND_URI_CUSTOM_DOMAIN } from "./_kinds.ts";

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
    kindUri: KIND_URI_CUSTOM_DOMAIN,
    capabilities: ["wildcard", "auto-tls", "sni", "alpn-acme"],
  });
}
