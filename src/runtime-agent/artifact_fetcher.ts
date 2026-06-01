/**
 * `ArtifactFetcher` — connector-side port for retrieving DataAsset bytes from
 * an operator-mounted `/v1/artifacts` endpoint.
 *
 * When the optional DataAsset extension is enabled, the dispatcher may include
 * an `ArtifactStoreLocator` (`baseUrl`, `token`) in `LifecycleApplyRequest`.
 * The runtime-agent server materialises that into a `HttpArtifactFetcher` and
 * threads it through `ConnectorContext.fetcher` so connectors that need to push
 * bytes to a downstream registry / runtime can stream them on demand.
 *
 * Connectors that take only pointer artifacts (`oci-image` URI, managed
 * services with no artifact at all) can ignore the fetcher entirely.
 *
 * # Request bounds
 *
 * `fetch()` / `head()` run server-side in the operator-deployed runtime-agent
 * during apply / lifecycle, against an operator-supplied artifact endpoint. To
 * keep parity with the already-hardened tenant-influenced fetch twins in this
 * package (see `prepared_source_reader.ts`), both methods apply a per-request
 * timeout so a stalled / slow endpoint cannot hang an apply indefinitely, and
 * `fetch()` enforces a byte cap instead of buffering an unbounded
 * `arrayBuffer()`: it rejects before reading when `Content-Length` (or a
 * prior `head()`-reported size) exceeds the cap, and otherwise streams the
 * body with a running byte counter that aborts once the cap is crossed. The
 * cap reuses the producing kernel artifact store's own `TAKOSUMI_ARTIFACT_MAX_BYTES`
 * (default 50 MiB) so the consumer bound matches the producer bound exactly;
 * this is symmetry / defense-in-depth, not SSRF or gzip-bomb hardening (the
 * endpoint is operator-supplied, read-only-token-scoped, and itself capped).
 */

import type { JsonObject } from "takosumi-contract/reference/types";
import { readRuntimeEnv } from "./runtime.ts";

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
  /**
   * Per-request timeout in milliseconds. Defaults to
   * {@link TAKOSUMI_ARTIFACT_FETCH_TIMEOUT_MS} from the env (default 60s) so a
   * stalled artifact endpoint cannot hang an apply indefinitely.
   */
  readonly timeoutMs?: number;
  /**
   * Maximum artifact body size in bytes for `fetch()`. Defaults to the
   * producing endpoint's `TAKOSUMI_ARTIFACT_MAX_BYTES` (default 50 MiB) so the
   * consumer cap matches the producer cap exactly.
   */
  readonly maxBytes?: number;
}

const HEADER_KIND = "x-takosumi-artifact-kind";
const HEADER_SIZE = "x-takosumi-artifact-size";

/**
 * Default per-request timeout. Operators may override via
 * `TAKOSUMI_ARTIFACT_FETCH_TIMEOUT_MS`. 60s is generous for large operator
 * artifacts while still bounding a stalled endpoint.
 */
const DEFAULT_ARTIFACT_FETCH_TIMEOUT_MS = 60_000;

/**
 * Default body cap. Reuses the producing kernel artifact store's
 * `TAKOSUMI_ARTIFACT_MAX_BYTES` (50 MiB = 52428800) so the consumer bound
 * matches the producer bound exactly, instead of inventing a new policy.
 */
const DEFAULT_ARTIFACT_MAX_BYTES = 52_428_800;

function artifactFetchTimeoutMs(): number {
  return readPositiveIntEnv(
    "TAKOSUMI_ARTIFACT_FETCH_TIMEOUT_MS",
    DEFAULT_ARTIFACT_FETCH_TIMEOUT_MS,
  );
}

function artifactMaxBytes(): number {
  return readPositiveIntEnv(
    "TAKOSUMI_ARTIFACT_MAX_BYTES",
    DEFAULT_ARTIFACT_MAX_BYTES,
  );
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = readRuntimeEnv(name);
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Read a response body into memory, aborting as soon as the accumulated byte
 * count exceeds `cap`. This bounds memory even when the server omits / lies
 * about `Content-Length` or uses chunked transfer-encoding, which a plain
 * `arrayBuffer()` would buffer in full before any size check. Mirrors the
 * capped reader in `prepared_source_reader.ts`.
 */
async function readBodyWithCap(
  response: Response,
  cap: number,
  label: string,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeds ${cap} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class HttpArtifactFetcher implements ArtifactFetcher {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  constructor(opts: HttpArtifactFetcherOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = validPositiveInt(opts.timeoutMs) ??
      artifactFetchTimeoutMs();
    this.#maxBytes = validPositiveInt(opts.maxBytes) ?? artifactMaxBytes();
  }

  async fetch(hash: string): Promise<FetchedArtifact> {
    const url = `${this.#baseUrl}/${encodeURIComponent(hash)}`;
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#token}` },
      // Cover both header arrival AND body read with one deadline so a stalled
      // endpoint cannot hang the apply after headers land.
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      throw new Error(
        `artifact fetch failed: HTTP ${response.status} ${response.statusText}`,
      );
    }
    const cap = this.#maxBytes;
    // Short-circuit oversized downloads from the declared length before we
    // buffer anything. A missing / lying / chunked length still cannot exceed
    // the cap because readBodyWithCap aborts once the running count crosses it.
    const declaredRaw = response.headers.get("content-length");
    if (declaredRaw !== null) {
      const declared = Number.parseInt(declaredRaw, 10);
      if (Number.isFinite(declared) && declared > cap) {
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        throw new Error(
          `artifact ${hash} declares ${declared} bytes, cap is ${cap}`,
        );
      }
    }
    const bytes = await readBodyWithCap(response, cap, `artifact ${hash}`);
    const kind = response.headers.get(HEADER_KIND) ?? "raw";
    const contentType = response.headers.get("content-type") ?? undefined;
    return {
      bytes,
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
      signal: AbortSignal.timeout(this.#timeoutMs),
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

function validPositiveInt(value: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return undefined;
}
