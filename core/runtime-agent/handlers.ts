/**
 * RuntimeHandler interface — implemented per-provider inside the runtime-agent.
 * RuntimeHandlers hold the actual backend call code: cloud REST APIs,
 * host subprocess calls, local sockets, or equivalent operator-owned execution.
 *
 * Implementations NEVER instantiate handlers. They post lifecycle envelopes to the
 * agent's HTTP server, which routes to the registered handler.
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
import type { ArtifactFetcher } from "./artifact_fetcher.ts";
import type { PreparedSourceReader } from "./prepared_source_reader.ts";

/**
 * Per-request context the dispatcher hands to a handler. Currently carries
 * optional readers materialised from request locators. RuntimeHandlers that don't
 * fetch bytes can ignore them.
 */
export interface RuntimeHandlerContext {
  readonly fetcher?: ArtifactFetcher;
  readonly source?: PreparedSourceReader;
}

/**
 * Result of a `RuntimeHandler.verify(...)` smoke test against the provider's API.
 * Operators run this through `POST /v1/lifecycle/verify` (see
 * `packages/runtime-agent/src/server.ts`) before doing a real `apply`, to
 * catch missing credentials / wrong region / firewall errors early.
 */
export interface RuntimeHandlerVerifyResult {
  readonly ok: boolean;
  /** Short message — "credentials valid" / "permission denied: s3:ListBucket" */
  readonly note?: string;
  /** When ok=false, optional structured error code for tooling. */
  readonly code?: string;
}

export interface RuntimeHandler {
  /** Provider id this handler implements (e.g. `aws-s3`, `filesystem`). */
  readonly provider: string;
  /** Shape this handler implements (e.g. `object-store@v1`). */
  readonly shape: string;
  /**
   * Artifact kinds this handler accepts (e.g. `["oci-image"]`). Empty array
   * means the handler does not consume a resolved artifact descriptor.
   *
   * The dispatcher validates artifact-backed specs against this list before
   * invoking `apply`.
   */
  readonly acceptedArtifactKinds: readonly string[];

  apply(
    req: LifecycleApplyRequest,
    ctx: RuntimeHandlerContext,
  ): Promise<LifecycleApplyResponse>;
  destroy(
    req: LifecycleDestroyRequest,
    ctx: RuntimeHandlerContext,
  ): Promise<LifecycleDestroyResponse>;
  /**
   * Optional compensating hook for WAL recovery. When absent, the dispatcher
   * falls back to `destroy` because most current handlers use handle-keyed
   * deletion as their complete reverse operation.
   */
  compensate?(
    req: LifecycleCompensateRequest,
    ctx: RuntimeHandlerContext,
  ): Promise<LifecycleCompensateResponse>;
  describe(
    req: LifecycleDescribeRequest,
    ctx: RuntimeHandlerContext,
  ): Promise<LifecycleDescribeResponse>;
  /**
   * Optional: read-only no-op API call to verify credentials & connectivity.
   *
   * RuntimeHandlers should implement the cheapest read-only call available
   * (ListBuckets, DescribeClusters, GET /api/v1/namespaces, etc.). Return
   * `{ ok: true, note: "credentials valid" }` on success and wrap thrown
   * errors as `{ ok: false, code: "auth_failed" | "network_error" |
   * "permission_denied", note: "..." }` so the dispatcher can render a
   * consistent table.
   *
   * When unimplemented the dispatcher reports
   * `{ ok: true, note: "no verify hook" }` so the handler is treated as
   * "credentials cannot be checked" but not failed.
   */
  verify?(ctx: RuntimeHandlerContext): Promise<RuntimeHandlerVerifyResult>;
}

/**
 * In-memory registry. The agent's HTTP server consults this when dispatching
 * lifecycle requests. RuntimeHandlers register at startup based on env credentials.
 */
export class RuntimeHandlerRegistry {
  readonly #handlers = new Map<string, RuntimeHandler>();

  register(handler: RuntimeHandler): void {
    const key = registryKey(handler.shape, handler.provider);
    this.#handlers.set(key, handler);
  }

  get(shape: string, provider: string): RuntimeHandler | undefined {
    return this.#handlers.get(registryKey(shape, provider));
  }

  list(): readonly RuntimeHandler[] {
    return Array.from(this.#handlers.values());
  }

  size(): number {
    return this.#handlers.size;
  }
}

function registryKey(shape: string, provider: string): string {
  return `${shape}::${provider}`;
}
