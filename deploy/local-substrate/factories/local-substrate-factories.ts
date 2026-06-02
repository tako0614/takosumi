import { ConnectorRegistry } from "/workspace/src/runtime-agent/connectors/connector.ts";

/**
 * Local-substrate empty connector registry.
 *
 * OpenTofu/provider materialization is now operator-owned. The local substrate
 * keeps the runtime-agent host available for lifecycle dispatch smoke tests,
 * but it does not import a sibling provider package or register concrete cloud
 * connectors from this ecosystem checkout.
 */
export function buildLocalSubstrateRegistry(
  _env: Record<string, string | undefined>,
): ConnectorRegistry {
  return new ConnectorRegistry();
}
