/**
 * Bundled `postgres@v1` KernelPlugin factory backed by GCP Cloud SQL.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  type CloudSqlLifecycleClient,
  createCloudSqlProvider,
  InMemoryCloudSqlLifecycle,
} from "@takos/takosumi-plugins/shape-providers/database-postgres/cloud-sql";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/kernel-plugin-adapter";
import { KIND_URI_POSTGRES } from "./_kinds.ts";

export interface GcpCloudSqlProviderOptions {
  readonly project?: string;
  readonly region?: string;
  readonly lifecycle?: CloudSqlLifecycleClient;
}

export function gcpCloudSqlPostgresProvider(
  opts: GcpCloudSqlProviderOptions = {},
): KernelPlugin {
  const project = opts.project ?? "default";
  const region = opts.region ?? "us-central1";
  const lifecycle = opts.lifecycle ??
    new InMemoryCloudSqlLifecycle(project, region);
  const provider = createCloudSqlProvider({ lifecycle, project, region });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_POSTGRES,
    capabilities: [
      "pitr",
      "read-replicas",
      "high-availability",
      "backups",
      "ssl-required",
      "extensions",
    ],
  });
}
