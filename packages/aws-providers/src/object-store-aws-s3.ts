/**
 * Bundled `object-store@v1` KernelPlugin factory backed by AWS S3 via the
 * runtime-agent connector. In-memory lifecycle is used by default so the
 * factory is safe to call in tests.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  type AwsS3ObjectStoreProviderOptions,
  createAwsS3ObjectStoreProvider,
  InMemoryAwsS3Lifecycle,
} from "@takos/takosumi-plugins/shape-providers/object-store/aws-s3";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/kernel-plugin-adapter";
import { KIND_URI_OBJECT_STORE } from "./_kinds.ts";

export interface AwsS3ProviderOptions {
  readonly region?: string;
  readonly lifecycle?: AwsS3ObjectStoreProviderOptions["lifecycle"];
}

export function awsS3ObjectStoreProvider(
  opts: AwsS3ProviderOptions = {},
): KernelPlugin {
  const lifecycle = opts.lifecycle ?? new InMemoryAwsS3Lifecycle();
  const provider = createAwsS3ObjectStoreProvider({
    lifecycle,
    ...(opts.region ? { defaultRegion: opts.region } : {}),
  });
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
