/**
 * Connector interface — implemented per-provider inside the runtime-agent.
 * Connectors hold the actual SDK call code (cloud REST APIs, Deno.Command, etc.).
 *
 * Plugins NEVER instantiate connectors. They post lifecycle envelopes to the
 * agent's HTTP server, which routes to the registered connector.
 */

import type {
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";

export interface Connector {
  /** Provider id this connector implements (e.g. `aws-s3`, `filesystem`). */
  readonly provider: string;
  /** Shape this connector implements (e.g. `object-store@v1`). */
  readonly shape: string;

  apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse>;
  destroy(req: LifecycleDestroyRequest): Promise<LifecycleDestroyResponse>;
  describe(req: LifecycleDescribeRequest): Promise<LifecycleDescribeResponse>;
}

/**
 * In-memory registry. The agent's HTTP server consults this when dispatching
 * lifecycle requests. Connectors register at startup based on env credentials.
 */
export class ConnectorRegistry {
  readonly #connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    const key = registryKey(connector.shape, connector.provider);
    this.#connectors.set(key, connector);
  }

  get(shape: string, provider: string): Connector | undefined {
    return this.#connectors.get(registryKey(shape, provider));
  }

  list(): readonly Connector[] {
    return Array.from(this.#connectors.values());
  }

  size(): number {
    return this.#connectors.size;
  }
}

function registryKey(shape: string, provider: string): string {
  return `${shape}::${provider}`;
}
