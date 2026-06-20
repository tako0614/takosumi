import { RuntimeHandlerRegistry } from "/workspace/core/runtime-agent/handlers.ts";

/**
 * Local-substrate empty runtime handler registry.
 *
 * OpenTofu/provider materialization is now operator-owned. The local substrate
 * keeps the runtime-agent host available for lifecycle dispatch smoke tests,
 * but it does not import a sibling provider package or register concrete cloud
 * handlers from this ecosystem checkout.
 */
export function buildLocalSubstrateRegistry(
  _env: Record<string, string | undefined>,
): RuntimeHandlerRegistry {
  return new RuntimeHandlerRegistry();
}
