/**
 * Bundled `postgres@v1` KernelPlugin factory backed by AWS RDS.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  type AwsRdsLifecycleClient,
  createAwsRdsProvider,
  InMemoryAwsRdsLifecycle,
} from "@takos/takosumi-plugins/shape-providers/database-postgres/aws-rds";
import { kernelPluginFromProviderPlugin } from "./_kernel_plugin_adapter.ts";
import { KIND_URI_POSTGRES } from "./_kinds.ts";

export interface AwsRdsPostgresProviderOptions {
  readonly region?: string;
  readonly lifecycle?: AwsRdsLifecycleClient;
}

export function awsRdsPostgresProvider(
  opts: AwsRdsPostgresProviderOptions = {},
): KernelPlugin {
  const region = opts.region ?? "us-east-1";
  const lifecycle = opts.lifecycle ?? new InMemoryAwsRdsLifecycle(region);
  const provider = createAwsRdsProvider({ lifecycle });
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
