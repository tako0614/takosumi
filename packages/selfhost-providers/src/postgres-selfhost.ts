/**
 * Bundled `postgres@v1` KernelPlugin factory backed by a self-hosted
 * Postgres instance run via a local Docker daemon.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  createLocalDockerPostgresProvider,
  InMemoryLocalDockerPostgresLifecycle,
  type LocalDockerPostgresLifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/database-postgres/local-docker";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/kernel-plugin-adapter";
import { KIND_URI_POSTGRES } from "./_kinds.ts";

export interface SelfhostPostgresProviderOptions {
  readonly hostBinding?: string;
  readonly lifecycle?: LocalDockerPostgresLifecycleClient;
}

export function selfhostPostgresProvider(
  opts: SelfhostPostgresProviderOptions = {},
): KernelPlugin {
  const lifecycle = opts.lifecycle ??
    new InMemoryLocalDockerPostgresLifecycle();
  const provider = createLocalDockerPostgresProvider({
    lifecycle,
    ...(opts.hostBinding ? { hostBinding: opts.hostBinding } : {}),
  });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_POSTGRES,
    capabilities: ["ssl-required", "extensions"],
  });
}
