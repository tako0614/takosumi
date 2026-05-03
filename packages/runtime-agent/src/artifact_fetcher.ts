/**
 * `ArtifactFetcher` — connector-side port for retrieving artifact bytes from
 * the kernel's `/v1/artifacts` store.
 *
 * The kernel embeds an `ArtifactStoreLocator` (`baseUrl`, `token`) in every
 * `LifecycleApplyRequest`. The runtime-agent server materialises that into a
 * `HttpArtifactFetcher` and threads it through `ConnectorContext.fetcher` so
 * connectors that need to push bytes to a downstream registry / runtime can
 * stream them on demand.
 *
 * Connectors that take only pointer artifacts (`oci-image` URI, managed
 * services with no artifact at all) can ignore the fetcher entirely.
 */

import type { JsonObject } from "takosumi-contract";

export interface FetchedArtifact {
  readonly bytes: Uint8Array;
  readonly kind: string;
  readonly contentType?: string;
  readonly metadata?: JsonObject;
}

export interface ArtifactFetcher {
  fetch(hash: string): Promise<FetchedArtifact>;
  head(hash: string): Promise<{ kind: string; size: number } | undefined>;
}

export interface HttpArtifactFetcherOptions {
  /** Base URL for the artifact endpoint, including `/v1/artifacts`. */
  readonly baseUrl: string;
  /** Bearer token shared with the kernel artifact store. */
  readonly token: string;
  /** Override `globalThis.fetch` (tests, custom transport). */
  readonly fetch?: typeof fetch;
}

const HEADER_KIND = "x-takosumi-artifact-kind";
const HEADER_SIZE = "x-takosumi-artifact-size";

export class HttpArtifactFetcher implements ArtifactFetcher {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(opts: HttpArtifactFetcherOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
  }

  async fetch(hash: string): Promise<FetchedArtifact> {
    const url = `${this.#baseUrl}/${encodeURIComponent(hash)}`;
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!response.ok) {
      throw new Error(
        `artifact fetch failed: HTTP ${response.status} ${response.statusText}`,
      );
    }
    const buffer = await response.arrayBuffer();
    const kind = response.headers.get(HEADER_KIND) ?? "raw";
    const contentType = response.headers.get("content-type") ?? undefined;
    return {
      bytes: new Uint8Array(buffer),
      kind,
      contentType,
      metadata: undefined,
    };
  }

  async head(
    hash: string,
  ): Promise<{ kind: string; size: number } | undefined> {
    const url = `${this.#baseUrl}/${encodeURIComponent(hash)}`;
    const response = await this.#fetch(url, {
      method: "HEAD",
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `artifact head failed: HTTP ${response.status} ${response.statusText}`,
      );
    }
    const kind = response.headers.get(HEADER_KIND) ?? "raw";
    const sizeRaw = response.headers.get(HEADER_SIZE);
    const size = sizeRaw ? Number.parseInt(sizeRaw, 10) : 0;
    return { kind, size: Number.isFinite(size) ? size : 0 };
  }
}
