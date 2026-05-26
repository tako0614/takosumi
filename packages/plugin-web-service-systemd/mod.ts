/**
 * systemd `web-service@v1` KernelPlugin package.
 */

import type { KernelPlugin } from "takosumi-contract/reference/plugin";
import {
  createSystemdUnitWebServiceProvider,
  InMemorySystemdUnitLifecycle,
  type SystemdUnitLifecycleClient,
} from "@takos/takosumi-plugins/shape-providers/web-service/systemd-unit";
import { TAKOSUMI_REFERENCE_KIND_URIS } from "@takos/takosumi-plugins/kinds";
import { kernelPluginFromProviderPlugin } from "takosumi-contract/reference/kernel-plugin-adapter";

export interface SystemdWebServiceProviderOptions {
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly lifecycle?: SystemdUnitLifecycleClient;
}

export function systemdWebServiceProvider(
  opts: SystemdWebServiceProviderOptions = {},
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
    kindUri: TAKOSUMI_REFERENCE_KIND_URIS["web-service"],
    capabilities: ["always-on", "long-request"],
  });
}
