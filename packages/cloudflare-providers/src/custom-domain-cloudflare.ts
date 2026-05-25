/**
 * Bundled `gateway@v1` KernelPlugin factory backed by Cloudflare DNS.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  type CloudflareDnsLifecycleClient,
  createCloudflareDnsProvider,
  InMemoryCloudflareDnsLifecycle,
} from "@takos/takosumi-plugins/shape-providers/gateway/cloudflare-dns";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";
import { KIND_URI_GATEWAY } from "./_kinds.ts";

export interface CloudflareCustomDomainProviderOptions {
  readonly zoneId?: string;
  readonly accountId?: string;
  readonly lifecycle?: CloudflareDnsLifecycleClient;
}

export function cloudflareCustomDomainProvider(
  opts: CloudflareCustomDomainProviderOptions = {},
): KernelPlugin {
  const zoneId = opts.zoneId ?? "default-zone";
  const accountId = opts.accountId ?? "default-account";
  const lifecycle = opts.lifecycle ??
    new InMemoryCloudflareDnsLifecycle(zoneId);
  const provider = createCloudflareDnsProvider({
    lifecycle,
    zoneId,
    accountId,
  });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_GATEWAY,
    capabilities: ["wildcard", "auto-tls", "sni", "http3"],
  });
}
