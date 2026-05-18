/**
 * Bundled `object-store@v1` KernelPlugin factory backed by local
 * filesystem storage — primarily useful for development.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  createFilesystemObjectStoreProvider,
  type FilesystemBucketLifecycleClient,
  InMemoryFilesystemLifecycle,
} from "../shape-providers/object-store/filesystem.ts";
import { kernelPluginFromProviderPlugin } from "./_kernel_plugin_adapter.ts";
import { KIND_URI_OBJECT_STORE } from "./_kinds.ts";

export interface SelfhostFilesystemProviderOptions {
  readonly rootDir?: string;
  readonly lifecycle?: FilesystemBucketLifecycleClient;
}

export function selfhostFilesystemObjectStoreProvider(
  opts: SelfhostFilesystemProviderOptions = {},
): KernelPlugin {
  const rootDir = opts.rootDir ?? "/var/lib/takos/object-store";
  const lifecycle = opts.lifecycle ?? new InMemoryFilesystemLifecycle(rootDir);
  const provider = createFilesystemObjectStoreProvider({ lifecycle, rootDir });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_OBJECT_STORE,
    capabilities: ["presigned-urls"],
  });
}
