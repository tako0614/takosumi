/**
 * Bundled `object-store@v1` KernelPlugin factory backed by Cloudflare R2.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  type CloudflareR2BucketLifecycleClient,
  createCloudflareR2ObjectStoreProvider,
  InMemoryCloudflareR2Lifecycle,
} from "@takos/takosumi-plugins/shape-providers/object-store/cloudflare-r2";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";
import { KIND_URI_OBJECT_STORE } from "./_kinds.ts";

export interface CloudflareR2ProviderOptions {
  readonly accountId?: string;
  readonly lifecycle?: CloudflareR2BucketLifecycleClient;
}

export function cloudflareR2ObjectStoreProvider(
  opts: CloudflareR2ProviderOptions = {},
): KernelPlugin {
  const accountId = opts.accountId ?? "default";
  const lifecycle = opts.lifecycle ??
    new InMemoryCloudflareR2Lifecycle(accountId);
  const provider = createCloudflareR2ObjectStoreProvider({
    lifecycle,
    accountId,
  });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_OBJECT_STORE,
    capabilities: ["presigned-urls", "public-access", "multipart-upload"],
  });
}
