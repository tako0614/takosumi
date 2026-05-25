/**
 * Bundled `object-store@v1` KernelPlugin factory backed by GCP GCS.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  createGcsObjectStoreProvider,
  type GcsLifecycleClient,
  InMemoryGcsLifecycle,
} from "@takos/takosumi-plugins/shape-providers/object-store/gcp-gcs";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";
import { KIND_URI_OBJECT_STORE } from "./_kinds.ts";

export interface GcpGcsProviderOptions {
  readonly project?: string;
  readonly lifecycle?: GcsLifecycleClient;
}

export function gcpGcsObjectStoreProvider(
  opts: GcpGcsProviderOptions = {},
): KernelPlugin {
  const project = opts.project ?? "default";
  const lifecycle = opts.lifecycle ?? new InMemoryGcsLifecycle(project);
  const provider = createGcsObjectStoreProvider({ lifecycle, project });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_OBJECT_STORE,
    capabilities: [
      "versioning",
      "presigned-urls",
      "server-side-encryption",
      "public-access",
      "event-notifications",
      "lifecycle-rules",
      "multipart-upload",
    ],
  });
}
