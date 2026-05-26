/**
 * MinIO `object-store@v1` KernelPlugin package.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  createMinioObjectStoreProvider,
  InMemoryMinioLifecycle,
  type MinioLifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/object-store/minio";
import { TAKOSUMI_REFERENCE_KIND_URIS } from "@takos/takosumi-plugins/kinds";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";

export interface MinioObjectStoreProviderOptions {
  readonly endpoint?: string;
  readonly lifecycle?: MinioLifecycleClient;
}

export function minioObjectStoreProvider(
  opts: MinioObjectStoreProviderOptions = {},
): KernelPlugin {
  const endpoint = opts.endpoint ?? "http://minio.local:9000";
  const lifecycle = opts.lifecycle ?? new InMemoryMinioLifecycle(endpoint);
  const provider = createMinioObjectStoreProvider({ lifecycle, endpoint });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: TAKOSUMI_REFERENCE_KIND_URIS["object-store"],
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
