/**
 * Docker `postgres@v1` KernelPlugin package.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  createLocalDockerPostgresProvider,
  InMemoryLocalDockerPostgresLifecycle,
  type LocalDockerPostgresLifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/database-postgres/local-docker";
import { TAKOSUMI_REFERENCE_KIND_URIS } from "@takos/takosumi-plugins/kinds";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";

export interface DockerPostgresProviderOptions {
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly secretRefBase?: string;
  readonly databaseName?: string;
  readonly username?: string;
  readonly passwordGenerator?: () => string;
  readonly lifecycle?: LocalDockerPostgresLifecycleClient;
}

export function dockerPostgresProvider(
  opts: DockerPostgresProviderOptions = {},
): KernelPlugin {
  const lifecycle = opts.lifecycle ??
    new InMemoryLocalDockerPostgresLifecycle();
  const provider = createLocalDockerPostgresProvider({
    lifecycle,
    ...(opts.hostBinding ? { hostBinding: opts.hostBinding } : {}),
    ...(opts.hostPortStart !== undefined
      ? { hostPortStart: opts.hostPortStart }
      : {}),
    ...(opts.secretRefBase ? { secretRefBase: opts.secretRefBase } : {}),
    ...(opts.databaseName ? { databaseName: opts.databaseName } : {}),
    ...(opts.username ? { username: opts.username } : {}),
    ...(opts.passwordGenerator
      ? { passwordGenerator: opts.passwordGenerator }
      : {}),
  });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: TAKOSUMI_REFERENCE_KIND_URIS.postgres,
    capabilities: ["ssl-required", "extensions"],
  });
}
