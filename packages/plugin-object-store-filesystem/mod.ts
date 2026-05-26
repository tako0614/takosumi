/**
 * filesystem `object-store@v1` KernelPlugin package.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  createFilesystemObjectStoreProvider,
  type FilesystemBucketLifecycleClient,
  InMemoryFilesystemLifecycle,
} from "@takos/takosumi-plugins/shape-providers/object-store/filesystem";
import { TAKOSUMI_REFERENCE_KIND_URIS } from "@takos/takosumi-plugins/kinds";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";

export interface FilesystemObjectStoreProviderOptions {
  readonly rootDir?: string;
  readonly lifecycle?: FilesystemBucketLifecycleClient;
}

export function filesystemObjectStoreProvider(
  opts: FilesystemObjectStoreProviderOptions = {},
): KernelPlugin {
  const rootDir = opts.rootDir ?? "/var/lib/takos/object-store";
  const lifecycle = opts.lifecycle ?? new InMemoryFilesystemLifecycle(rootDir);
  const provider = createFilesystemObjectStoreProvider({ lifecycle, rootDir });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: TAKOSUMI_REFERENCE_KIND_URIS["object-store"],
    capabilities: ["presigned-urls"],
  });
}
