/**
 * Bundled `object-store@v1` KernelPlugin factory backed by self-hosted
 * MinIO.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  createMinioObjectStoreProvider,
  InMemoryMinioLifecycle,
  type MinioLifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/object-store/minio";
import { kernelPluginFromProviderPlugin } from "./_kernel_plugin_adapter.ts";
import { KIND_URI_OBJECT_STORE } from "./_kinds.ts";

export interface SelfhostMinioProviderOptions {
  readonly endpoint?: string;
  readonly lifecycle?: MinioLifecycleClient;
}

export function selfhostMinioObjectStoreProvider(
  opts: SelfhostMinioProviderOptions = {},
): KernelPlugin {
  const endpoint = opts.endpoint ?? "http://minio.local:9000";
  const lifecycle = opts.lifecycle ?? new InMemoryMinioLifecycle(endpoint);
  const provider = createMinioObjectStoreProvider({ lifecycle, endpoint });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_OBJECT_STORE,
    capabilities: [
      "versioning",
      "presigned-urls",
      "server-side-encryption",
      "public-access",
      "lifecycle-rules",
      "multipart-upload",
    ],
  });
}
