/**
 * Bundled `worker@v1` KernelPlugin factory backed by the Cloudflare Workers
 * connector on the runtime-agent.
 *
 * Operators register this plugin by spreading it into the plain-array
 * `plugins` option of `createPaaSApp({ plugins: [cloudflareWorkerProvider(...)] })`.
 * The underlying lifecycle / connector wiring is unchanged; this file is a
 * thin KernelPlugin adapter around the existing
 * `createCloudflareWorkersProvider()` factory.
 */

import type { KernelPlugin } from "takosumi-contract/plugin";
import {
  type CloudflareWorkersLifecycleClient,
  createCloudflareWorkersProvider,
  InMemoryCloudflareWorkersLifecycle,
} from "@takos/takosumi-plugins/shape-providers/worker/cloudflare-workers";
import { kernelPluginFromProviderPlugin } from "./_kernel_plugin_adapter.ts";
import { KIND_URI_WORKER } from "./_kinds.ts";

export interface CloudflareWorkerProviderOptions {
  /** Cloudflare account ID — used by the lifecycle client to scope scripts. */
  readonly accountId?: string;
  /**
   * Optional lifecycle client override. Defaults to an in-memory client so
   * `cloudflareWorkerProvider()` is usable in tests without further setup.
   * In production, operators inject a runtime-agent-backed client.
   */
  readonly lifecycle?: CloudflareWorkersLifecycleClient;
}

export function cloudflareWorkerProvider(
  opts: CloudflareWorkerProviderOptions = {},
): KernelPlugin {
  const accountId = opts.accountId ?? "default";
  const lifecycle = opts.lifecycle ??
    new InMemoryCloudflareWorkersLifecycle(accountId);
  const provider = createCloudflareWorkersProvider({ lifecycle, accountId });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_WORKER,
    capabilities: [
      "scale-to-zero",
      "websocket",
      "long-request",
      "geo-routing",
      "crons",
    ],
  });
}
