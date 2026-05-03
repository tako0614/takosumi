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
import type { Connector, ConnectorContext } from "./connectors/connector.ts";
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

/**
 * Thrown when a request's `spec.artifact.kind` (or `spec.image` legacy =>
 * `oci-image`) is not in the connector's `acceptedArtifactKinds` list.
 */
export class ArtifactKindMismatchError extends Error {
  readonly shape: string;
  readonly provider: string;
  readonly expected: readonly string[];
  readonly got: string;
  constructor(
    shape: string,
    provider: string,
    expected: readonly string[],
    got: string,
  ) {
    super(
      `connector ${provider} for shape=${shape} does not accept artifact kind ${got}; ` +
        `accepted=[${expected.join(", ")}]`,
    );
    this.shape = shape;
    this.provider = provider;
    this.expected = expected;
    this.got = got;
    this.name = "ArtifactKindMismatchError";
  }
}

export class LifecycleDispatcher {
  readonly #registry: ConnectorRegistry;

  constructor(registry: ConnectorRegistry) {
    this.#registry = registry;
  }

  apply(
    req: LifecycleApplyRequest,
    ctx: ConnectorContext = {},
  ): Promise<LifecycleApplyResponse> {
    const connector = this.#registry.get(req.shape, req.provider);
    if (!connector) throw new ConnectorNotFoundError(req.shape, req.provider);
    validateArtifactKind(connector, req);
    return connector.apply(req, ctx);
  }

  destroy(
    req: LifecycleDestroyRequest,
    ctx: ConnectorContext = {},
  ): Promise<LifecycleDestroyResponse> {
    const connector = this.#registry.get(req.shape, req.provider);
    if (!connector) throw new ConnectorNotFoundError(req.shape, req.provider);
    return connector.destroy(req, ctx);
  }

  describe(
    req: LifecycleDescribeRequest,
    ctx: ConnectorContext = {},
  ): Promise<LifecycleDescribeResponse> {
    const connector = this.#registry.get(req.shape, req.provider);
    if (!connector) throw new ConnectorNotFoundError(req.shape, req.provider);
    return connector.describe(req, ctx);
  }
}

function validateArtifactKind(
  connector: Connector,
  req: LifecycleApplyRequest,
): void {
  const accepted = connector.acceptedArtifactKinds;
  const declared = inferArtifactKind(req.spec);
  if (declared === undefined) return;
  if (!accepted.includes(declared)) {
    throw new ArtifactKindMismatchError(
      req.shape,
      req.provider,
      accepted,
      declared,
    );
  }
}

function inferArtifactKind(spec: unknown): string | undefined {
  if (!spec || typeof spec !== "object") return undefined;
  const obj = spec as Record<string, unknown>;
  const artifact = obj.artifact;
  if (artifact && typeof artifact === "object") {
    const k = (artifact as Record<string, unknown>).kind;
    if (typeof k === "string" && k.length > 0) return k;
  }
  if (typeof obj.image === "string" && obj.image.length > 0) {
    return "oci-image";
  }
  return undefined;
}
