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
  LifecycleCompensateRequest,
  LifecycleCompensateResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";
import type { ArtifactFetcher } from "../artifact_fetcher.ts";

/**
 * Per-request context the dispatcher hands to a connector. Currently carries
 * an optional `ArtifactFetcher` materialised from the request's
 * `artifactStore` locator. Connectors that don't fetch bytes can ignore it.
 */
export interface ConnectorContext {
  readonly fetcher?: ArtifactFetcher;
}

/**
 * Result of a `Connector.verify(...)` smoke test against the provider's API.
 * Operators run this through `POST /v1/lifecycle/verify` (see
 * `packages/runtime-agent/src/server.ts`) before doing a real `apply`, to
 * catch missing credentials / wrong region / firewall errors early.
 */
export interface ConnectorVerifyResult {
  readonly ok: boolean;
  /** Short message — "credentials valid" / "permission denied: s3:ListBucket" */
  readonly note?: string;
  /** When ok=false, optional structured error code for tooling. */
  readonly code?: string;
}

export interface Connector {
  /** Provider id this connector implements (e.g. `aws-s3`, `filesystem`). */
  readonly provider: string;
  /** Shape this connector implements (e.g. `object-store@v1`). */
  readonly shape: string;
  /**
   * Artifact kinds this connector accepts (e.g. `["oci-image"]`,
   * `["js-bundle"]`). Empty array means the connector does not consume an
   * artifact at all (managed services, DNS, raw object-store buckets).
   *
   * The dispatcher validates `spec.artifact.kind` (or `spec.image` legacy
   * treated as `oci-image`) against this list before invoking `apply`.
   */
  readonly acceptedArtifactKinds: readonly string[];

  apply(
    req: LifecycleApplyRequest,
    ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse>;
  destroy(
    req: LifecycleDestroyRequest,
    ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse>;
  /**
   * Optional compensating hook for WAL recovery. When absent, the dispatcher
   * falls back to `destroy` because most current connectors use handle-keyed
   * deletion as their complete reverse operation.
   */
  compensate?(
    req: LifecycleCompensateRequest,
    ctx: ConnectorContext,
  ): Promise<LifecycleCompensateResponse>;
  describe(
    req: LifecycleDescribeRequest,
    ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse>;
  /**
   * Optional: read-only no-op API call to verify credentials & connectivity.
   *
   * Connectors should implement the cheapest read-only call available
   * (ListBuckets, DescribeClusters, GET /api/v1/namespaces, etc.). Return
   * `{ ok: true, note: "credentials valid" }` on success and wrap thrown
   * errors as `{ ok: false, code: "auth_failed" | "network_error" |
   * "permission_denied", note: "..." }` so the dispatcher can render a
   * consistent table.
   *
   * When unimplemented the dispatcher reports
   * `{ ok: true, note: "no verify hook" }` so the connector is treated as
   * "credentials cannot be checked" but not failed.
   */
  verify?(ctx: ConnectorContext): Promise<ConnectorVerifyResult>;
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
