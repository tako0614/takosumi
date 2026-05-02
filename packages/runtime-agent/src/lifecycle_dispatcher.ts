/**
 * Lifecycle dispatcher — routes apply/destroy/describe requests to the
 * connector registered for `(shape, provider)`. Returns a typed response or
 * a structured error.
 */

import type {
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";
import type { ConnectorRegistry } from "./connectors/mod.ts";

export class ConnectorNotFoundError extends Error {
  readonly shape: string;
  readonly provider: string;
  constructor(shape: string, provider: string) {
    super(`no connector registered for shape=${shape} provider=${provider}`);
    this.shape = shape;
    this.provider = provider;
    this.name = "ConnectorNotFoundError";
  }
}

export class LifecycleDispatcher {
  readonly #registry: ConnectorRegistry;

  constructor(registry: ConnectorRegistry) {
    this.#registry = registry;
  }

  apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
    const connector = this.#registry.get(req.shape, req.provider);
    if (!connector) throw new ConnectorNotFoundError(req.shape, req.provider);
    return connector.apply(req);
  }

  destroy(req: LifecycleDestroyRequest): Promise<LifecycleDestroyResponse> {
    const connector = this.#registry.get(req.shape, req.provider);
    if (!connector) throw new ConnectorNotFoundError(req.shape, req.provider);
    return connector.destroy(req);
  }

  describe(
    req: LifecycleDescribeRequest,
  ): Promise<LifecycleDescribeResponse> {
    const connector = this.#registry.get(req.shape, req.provider);
    if (!connector) throw new ConnectorNotFoundError(req.shape, req.provider);
    return connector.describe(req);
  }
}
