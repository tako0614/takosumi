/**
 * Lifecycle dispatcher — routes apply/destroy/describe requests to the
 * handler registered for `(shape, provider)`. Returns a typed response or
 * a structured error.
 */

import type {
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleCompensateRequest,
  LifecycleCompensateResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract/reference/runtime-agent-lifecycle";
import type { RuntimeHandler, RuntimeHandlerContext } from "./handlers.ts";
import type { RuntimeHandlerRegistry } from "./handlers.ts";
import { isRecord } from "./value.ts";

export class RuntimeHandlerNotFoundError extends Error {
  readonly shape: string;
  readonly provider: string;
  constructor(shape: string, provider: string) {
    super(`no handler registered for shape=${shape} provider=${provider}`);
    this.shape = shape;
    this.provider = provider;
    this.name = "RuntimeHandlerNotFoundError";
  }
}

/**
 * Thrown when an artifact-backed request's kind is not in the handler's
 * `acceptedArtifactKinds` list.
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
      `handler ${provider} for shape=${shape} does not accept artifact kind ${got}; ` +
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
  readonly #registry: RuntimeHandlerRegistry;

  constructor(registry: RuntimeHandlerRegistry) {
    this.#registry = registry;
  }

  apply(
    req: LifecycleApplyRequest,
    ctx: RuntimeHandlerContext = {},
  ): Promise<LifecycleApplyResponse> {
    const handler = this.#registry.get(req.shape, req.provider);
    if (!handler) throw new RuntimeHandlerNotFoundError(req.shape, req.provider);
    validateArtifactKind(handler, req);
    return handler.apply(req, ctx);
  }

  destroy(
    req: LifecycleDestroyRequest,
    ctx: RuntimeHandlerContext = {},
  ): Promise<LifecycleDestroyResponse> {
    const handler = this.#registry.get(req.shape, req.provider);
    if (!handler) throw new RuntimeHandlerNotFoundError(req.shape, req.provider);
    return handler.destroy(req, ctx);
  }

  async compensate(
    req: LifecycleCompensateRequest,
    ctx: RuntimeHandlerContext = {},
  ): Promise<LifecycleCompensateResponse> {
    const handler = this.#registry.get(req.shape, req.provider);
    if (!handler) throw new RuntimeHandlerNotFoundError(req.shape, req.provider);
    if (handler.compensate) return await handler.compensate(req, ctx);
    const result = await handler.destroy(req, ctx);
    return { ok: result.ok, ...(result.note ? { note: result.note } : {}) };
  }

  describe(
    req: LifecycleDescribeRequest,
    ctx: RuntimeHandlerContext = {},
  ): Promise<LifecycleDescribeResponse> {
    const handler = this.#registry.get(req.shape, req.provider);
    if (!handler) throw new RuntimeHandlerNotFoundError(req.shape, req.provider);
    return handler.describe(req, ctx);
  }
}

function validateArtifactKind(
  handler: RuntimeHandler,
  req: LifecycleApplyRequest,
): void {
  const accepted = handler.acceptedArtifactKinds;
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
  if (!isRecord(spec)) return undefined;
  const artifact = spec.artifact;
  if (isRecord(artifact)) {
    const k = artifact.kind;
    if (typeof k === "string" && k.length > 0) return k;
  }
  if (typeof spec.image === "string" && spec.image.length > 0) {
    return "oci-image";
  }
  return undefined;
}
