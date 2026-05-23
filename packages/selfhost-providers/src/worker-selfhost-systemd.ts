/**
 * Bundled `web-service@v1` KernelPlugin factory backed by a self-hosted
 * systemd unit.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  createSystemdUnitWebServiceProvider,
  InMemorySystemdUnitLifecycle,
  type SystemdUnitLifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/web-service/systemd-unit";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/kernel-plugin-adapter";
import { KIND_URI_WEB_SERVICE } from "./_kinds.ts";

export interface SelfhostSystemdWorkerProviderOptions {
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly lifecycle?: SystemdUnitLifecycleClient;
}

export type SelfhostSystemdWebServiceProviderOptions =
  SelfhostSystemdWorkerProviderOptions;

export function selfhostSystemdWebServiceProvider(
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
    kindUri: KIND_URI_WEB_SERVICE,
    capabilities: ["always-on", "long-request"],
  });
}

/** @deprecated Use `selfhostSystemdWebServiceProvider`; this provides web-service. */
export const selfhostSystemdWorkerProvider = selfhostSystemdWebServiceProvider;
