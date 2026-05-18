/**
 * Bundled `worker@v1` KernelPlugin factory backed by a self-hosted
 * systemd unit.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  createSystemdUnitWebServiceProvider,
  InMemorySystemdUnitLifecycle,
  type SystemdUnitLifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/web-service/systemd-unit";
import { kernelPluginFromProviderPlugin } from "./_kernel_plugin_adapter.ts";
import { KIND_URI_WORKER } from "./_kinds.ts";

export interface SelfhostSystemdWorkerProviderOptions {
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly lifecycle?: SystemdUnitLifecycleClient;
}

export function selfhostSystemdWorkerProvider(
  opts: SelfhostSystemdWorkerProviderOptions = {},
): KernelPlugin {
  const lifecycle = opts.lifecycle ?? new InMemorySystemdUnitLifecycle();
  const provider = createSystemdUnitWebServiceProvider({
    lifecycle,
    ...(opts.hostBinding ? { hostBinding: opts.hostBinding } : {}),
    ...(opts.hostPortStart !== undefined
      ? { hostPortStart: opts.hostPortStart }
      : {}),
  });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_WORKER,
    capabilities: ["always-on", "long-request"],
  });
}
