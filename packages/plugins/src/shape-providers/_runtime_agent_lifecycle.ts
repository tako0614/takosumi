/**
 * Universal runtime-agent HTTP client used by every shape-provider plugin.
 *
 * Plugins post lifecycle envelopes (apply / destroy / describe) to a
 * runtime-agent service which holds the actual cloud SDK / Deno.Command
 * code. Credentials never reach the kernel — the runtime-agent is the only
 * thing that needs them.
 *
 * See `@takos/takosumi-contract` `runtime-agent-lifecycle.ts` for the wire
 * shape (`LifecycleApplyRequest`, `LIFECYCLE_APPLY_PATH`, etc.).
 */

import {
  type ArtifactStoreLocator,
  LIFECYCLE_APPLY_PATH,
  LIFECYCLE_DESCRIBE_PATH,
  LIFECYCLE_DESTROY_PATH,
  type LifecycleApplyRequest,
  type LifecycleApplyResponse,
  type LifecycleDescribeRequest,
  type LifecycleDescribeResponse,
  type LifecycleDestroyRequest,
  type LifecycleDestroyResponse,
} from "takosumi-contract";

export interface RuntimeAgentClientOptions {
  /** Base URL of the runtime-agent service (e.g. `http://127.0.0.1:8789`). */
  readonly agentUrl: string;
  /** Bearer token shared with the runtime-agent. */
  readonly token: string;
  /** Optional fetch override for testing. */
  readonly fetch?: typeof fetch;
  /** When set, every apply request carries an `artifactStore` field so
   *  connectors that need to fetch uploaded bundles by hash can do so. */
  readonly artifactStore?: ArtifactStoreLocator;
}

/**
 * Thin HTTP wrapper. Each method posts a lifecycle envelope to the agent
 * and returns the parsed JSON response. Throws on non-2xx with the agent's
 * error body included in the message.
 */
export class RuntimeAgentLifecycle {
  readonly #agentUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #artifactStore?: ArtifactStoreLocator;

  constructor(options: RuntimeAgentClientOptions) {
    this.#agentUrl = trimTrailingSlash(options.agentUrl);
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#artifactStore = options.artifactStore;
  }

  apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
    const enriched = this.#artifactStore && req.artifactStore === undefined
      ? { ...req, artifactStore: this.#artifactStore }
      : req;
    return this.#post<LifecycleApplyResponse>(LIFECYCLE_APPLY_PATH, enriched);
  }

  destroy(req: LifecycleDestroyRequest): Promise<LifecycleDestroyResponse> {
    return this.#post<LifecycleDestroyResponse>(LIFECYCLE_DESTROY_PATH, req);
  }

  describe(req: LifecycleDescribeRequest): Promise<LifecycleDescribeResponse> {
    return this.#post<LifecycleDescribeResponse>(LIFECYCLE_DESCRIBE_PATH, req);
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#agentUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${this.#token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `runtime-agent ${path} failed: ${response.status} ${response.statusText}${
          text ? ` ${text}` : ""
        }`,
      );
    }
    return await response.json() as T;
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
