import type { Hono as HonoApp } from "hono";
import {
  ARTIFACTS_BASE_PATH,
  type ArtifactStored,
  type JsonObject,
} from "takosumi-contract";
import type {
  ObjectStorageDigest,
  ObjectStoragePort,
} from "../adapters/object-storage/types.ts";
import type { TakosumiDeploymentRecordStore } from "../domains/deploy/takosumi_deployment_record_store.ts";
import { apiError } from "./errors.ts";

/**
 * Artifact upload endpoints — the data plane for `takosumi artifact push`.
 *
 *   POST   /v1/artifacts            multipart upload (kind, metadata, body)
 *   GET    /v1/artifacts            list (cursor + limit pagination)
 *   HEAD   /v1/artifacts/:hash      existence + size + kind (header `x-takosumi-artifact-*`)
 *   GET    /v1/artifacts/:hash      bytes stream
 *   DELETE /v1/artifacts/:hash      remove
 *   POST   /v1/artifacts/gc         mark+sweep unreferenced artifacts
 *
 * Auth: write-side endpoints (POST / DELETE / gc) require the
 * `TAKOSUMI_DEPLOY_TOKEN` bearer. Read-side endpoints (GET / HEAD on a
 * single hash) ALSO accept `TAKOSUMI_ARTIFACT_FETCH_TOKEN` when set, so the
 * runtime-agent host can fetch artifact bytes without holding the full
 * deploy token. When the deploy token is unset every route 404s.
 *
 * Storage is content-addressed under `<bucket>/artifacts/<sha256-hex>` via
 * the kernel's `objectStorage` adapter; digest is computed and verified
 * server-side, regardless of any client-side `expectedDigest`.
 *
 * # Memory model — buffered upload, capped at `maxBytes`
 *
 * The current POST handler buffers the entire request body into memory
 * (Hono's `c.req.formData()` reads the whole multipart payload before
 * yielding `File` parts, and `ObjectStoragePort.putObject` requires a
 * fully-materialized `Uint8Array | string` body). To bound RAM use we
 * enforce a hard cap on a single artifact's body, configurable via:
 *
 *   - `TAKOSUMI_ARTIFACT_MAX_BYTES` env var (default 50 MiB = 52428800)
 *   - `RegisterArtifactRoutesOptions.maxBytes`
 *
 * Both `Content-Length` (cheap, pre-buffer) and the post-buffer
 * `bytes.length` are checked; oversize requests get a 413 envelope with
 * the `resource_exhausted` code instead of OOM-ing the kernel.
 *
 * For larger artifacts (>50 MiB JS bundles, big lambda zips, OCI layers)
 * operators should run an external object-storage backend (Cloudflare R2,
 * AWS S3, GCS) and configure the kernel's `objectStorage` adapter to
 * point at it. The {@link ObjectStoragePort} interface stays the same;
 * only the adapter changes. From there a future `putObjectStream(...)`
 * extension can stream multipart parts directly into the backend without
 * buffering through kernel RAM. Until that lands, raise
 * `TAKOSUMI_ARTIFACT_MAX_BYTES` deliberately and provision RAM
 * accordingly, or move to presigned-URL uploads at the storage backend.
 */
export const TAKOSUMI_ARTIFACTS_PATH = ARTIFACTS_BASE_PATH;
export const TAKOSUMI_ARTIFACTS_BUCKET = "takosumi-artifacts" as const;
const KEY_PREFIX = "artifacts/" as const;
/** Hard cap on `?limit=` for the list endpoint. */
const ARTIFACT_LIST_MAX_LIMIT = 1000;
/** Default `?limit=` when the client omits it. */
const ARTIFACT_LIST_DEFAULT_LIMIT = 100;
/**
 * Default upload-body cap (50 MiB). Operators bump this via
 * `TAKOSUMI_ARTIFACT_MAX_BYTES` or the `maxBytes` option. Chosen to
 * comfortably cover Cloudflare Workers bundles and small Lambda zips
 * without letting a single multipart request OOM the kernel process.
 */
export const TAKOSUMI_ARTIFACT_MAX_BYTES_DEFAULT = 52_428_800;

const META_HEADER_KIND = "x-takosumi-artifact-kind";
const META_HEADER_SIZE = "x-takosumi-artifact-size";
const META_HEADER_UPLOADED_AT = "x-takosumi-artifact-uploaded-at";

export interface RegisterArtifactRoutesOptions {
  /** Shared-secret token. When undefined the routes are disabled. */
  readonly getDeployToken?: () => string | undefined;
  /**
   * Optional read-only token. When set, GET / HEAD on
   * `/v1/artifacts/:hash` accept EITHER this token OR the deploy token.
   * POST / DELETE / GC continue to require the deploy token. Operators
   * deploy this on the runtime-agent host so the agent can fetch artifact
   * bytes without holding the full deploy token; if the agent host is
   * compromised, the attacker has read-only artifact access rather than
   * apply / destroy / upload power.
   */
  readonly getArtifactFetchToken?: () => string | undefined;
  /** Object storage backing the artifact blobs. Required (no in-memory default
   *  to force operators to think about persistence). */
  readonly objectStorage: ObjectStoragePort;
  /**
   * Optional source of truth for which artifacts are still referenced by
   * a persisted deployment record. Required for the GC endpoint to delete
   * anything; if absent the GC route falls back to retaining everything
   * (the safe direction).
   */
  readonly recordStore?: TakosumiDeploymentRecordStore;
  readonly bucket?: string;
  readonly now?: () => string;
  /**
   * Max bytes accepted for a single multipart upload body. Defaults to
   * {@link TAKOSUMI_ARTIFACT_MAX_BYTES_DEFAULT} (50 MiB). Operators
   * typically wire this from `TAKOSUMI_ARTIFACT_MAX_BYTES`. Both the
   * declared `Content-Length` header and the actual buffered size are
   * compared against this value; either exceeding it returns a 413
   * `resource_exhausted` envelope.
   */
  readonly maxBytes?: number;
}

export function registerArtifactRoutes(
  app: HonoApp,
  options: RegisterArtifactRoutesOptions,
): void {
  const getToken = options.getDeployToken ?? (() => undefined);
  const getFetchToken = options.getArtifactFetchToken ?? (() => undefined);
  const bucket = options.bucket ?? TAKOSUMI_ARTIFACTS_BUCKET;
  const now = options.now ?? (() => new Date().toISOString());
  const storage = options.objectStorage;
  const recordStore = options.recordStore;
  const maxBytes = resolveMaxBytes(options.maxBytes);

  const initialToken = getToken();
  if (!initialToken) {
    console.warn(
      `[takosumi-artifacts] TAKOSUMI_DEPLOY_TOKEN unset; ` +
        `${TAKOSUMI_ARTIFACTS_PATH} will return 404 until configured.`,
    );
  }

  app.post(TAKOSUMI_ARTIFACTS_PATH, async (c) => {
    const auth = checkAuth(c, getToken);
    if (auth.kind === "fail") return auth.response;

    // Cheap pre-check: reject hostile / oversize uploads before we
    // buffer anything. The wire framing carries the multipart envelope
    // overhead too, so a Content-Length over `maxBytes` is already
    // grounds for refusal — the body cannot fit even with zero overhead.
    const contentLengthHeader = c.req.header("content-length");
    if (contentLengthHeader) {
      const declared = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        return c.json(
          apiError(
            "resource_exhausted",
            tooLargeMessage(declared, maxBytes, "content-length"),
          ),
          413,
        );
      }
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(
        apiError(
          "invalid_argument",
          "request body must be multipart/form-data",
        ),
        400,
      );
    }

    const kindValue = form.get("kind");
    if (typeof kindValue !== "string" || kindValue.trim() === "") {
      return c.json(
        apiError("invalid_argument", "form field `kind` is required"),
        400,
      );
    }
    const kind = kindValue.trim();

    const fileValue = form.get("body");
    if (!(fileValue instanceof File)) {
      return c.json(
        apiError("invalid_argument", "form field `body` must be a file"),
        400,
      );
    }
    const bytes = new Uint8Array(await fileValue.arrayBuffer());
    if (bytes.length > maxBytes) {
      return c.json(
        apiError(
          "resource_exhausted",
          tooLargeMessage(bytes.length, maxBytes, "artifact bytes"),
        ),
        413,
      );
    }

    let userMetadata: JsonObject | undefined;
    const metaValue = form.get("metadata");
    if (typeof metaValue === "string" && metaValue.trim() !== "") {
      try {
        const parsed = JSON.parse(metaValue);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          userMetadata = parsed as JsonObject;
        } else {
          return c.json(
            apiError(
              "invalid_argument",
              "form field `metadata` must be a JSON object",
            ),
            400,
          );
        }
      } catch {
        return c.json(
          apiError(
            "invalid_argument",
            "form field `metadata` is not valid JSON",
          ),
          400,
        );
      }
    }

    const digest = await sha256Digest(bytes);
    const expectedDigestField = form.get("expectedDigest");
    if (
      typeof expectedDigestField === "string" &&
      expectedDigestField.trim() !== "" &&
      expectedDigestField.trim() !== digest
    ) {
      return c.json(
        apiError(
          "invalid_argument",
          `digest mismatch: expected ${expectedDigestField}, computed ${digest}`,
        ),
        400,
      );
    }

    const objectMeta: Record<string, string> = {
      kind,
      uploadedAt: now(),
    };
    if (userMetadata) {
      objectMeta.userMetadata = JSON.stringify(userMetadata);
    }

    const head = await storage.putObject({
      bucket,
      key: keyFor(digest),
      body: bytes,
      contentType: fileValue.type || "application/octet-stream",
      metadata: objectMeta,
      expectedDigest: digest as ObjectStorageDigest,
    });

    const stored: ArtifactStored = {
      hash: digest,
      kind,
      size: head.contentLength,
      uploadedAt: head.metadata.uploadedAt ?? objectMeta.uploadedAt,
      ...(userMetadata ? { metadata: userMetadata } : {}),
    };
    return c.json(stored, 200);
  });

  app.get(TAKOSUMI_ARTIFACTS_PATH, async (c) => {
    const auth = checkAuth(c, getToken);
    if (auth.kind === "fail") return auth.response;
    const limit = parseLimitParam(c.req.query("limit"));
    if (limit.kind === "fail") {
      return c.json(apiError("invalid_argument", limit.error), 400);
    }
    const cursor = c.req.query("cursor");
    const list = await storage.listObjects({
      bucket,
      prefix: KEY_PREFIX,
      limit: limit.value,
      ...(cursor ? { cursor } : {}),
    });
    const artifacts: ArtifactStored[] = list.objects.map((o) =>
      headToStored(o.digest, o.metadata, o.contentLength)
    );
    return c.json(
      list.nextCursor
        ? { artifacts, nextCursor: list.nextCursor }
        : { artifacts },
      200,
    );
  });

  /**
   * Mark+sweep GC. Lists every artifact in object storage, asks the
   * record store for the union of `sha256:...` hashes referenced by ANY
   * persisted record (including destroyed ones, for race-protection),
   * and deletes every blob whose hash is not in the referenced set.
   *
   * Idempotent: a second call with no new uploads / records returns
   * `{ deleted: [], retained: <total> }`.
   *
   * `?dryRun=1` reports what would be deleted but does not actually
   * delete anything.
   */
  app.post(`${TAKOSUMI_ARTIFACTS_PATH}/gc`, async (c) => {
    const auth = checkAuth(c, getToken);
    if (auth.kind === "fail") return auth.response;
    const dryRun = isTruthyQuery(c.req.query("dryRun")) ||
      isTruthyQuery(c.req.query("dry_run"));
    if (!recordStore) {
      const all = await listAllArtifacts(storage, bucket);
      return c.json(
        {
          deleted: [] as string[],
          retained: all.length,
          dryRun,
          warning: "recordStore not wired; GC retained all artifacts",
        },
        200,
      );
    }
    const referenced = await recordStore.listReferencedArtifactHashes();
    const all = await listAllArtifacts(storage, bucket);
    const deleted: string[] = [];
    let retained = 0;
    for (const head of all) {
      if (referenced.has(head.digest)) {
        retained += 1;
        continue;
      }
      if (!dryRun) {
        const removed = await storage.deleteObject({
          bucket: head.bucket,
          key: head.key,
        });
        if (!removed) continue;
      }
      deleted.push(head.digest);
    }
    return c.json({ deleted, retained, dryRun }, 200);
  });

  app.get(`${TAKOSUMI_ARTIFACTS_PATH}/:hash`, async (c) => {
    const auth = checkReadAuth(c, getToken, getFetchToken);
    if (auth.kind === "fail") return auth.response;
    const hash = c.req.param("hash");
    const obj = await storage.getObject({
      bucket,
      key: keyFor(hash),
    });
    if (!obj) {
      return c.json(apiError("not_found", "artifact not found"), 404);
    }
    return new Response(obj.body as BodyInit, {
      status: 200,
      headers: {
        "content-type": obj.contentType ?? "application/octet-stream",
        "content-length": String(obj.contentLength),
        [META_HEADER_KIND]: obj.metadata.kind ?? "",
        [META_HEADER_SIZE]: String(obj.contentLength),
        [META_HEADER_UPLOADED_AT]: obj.metadata.uploadedAt ?? "",
      },
    });
  });

  app.on(["HEAD"], `${TAKOSUMI_ARTIFACTS_PATH}/:hash`, async (c) => {
    const auth = checkReadAuth(c, getToken, getFetchToken);
    if (auth.kind === "fail") return auth.response;
    const hash = c.req.param("hash");
    const head = await storage.headObject({
      bucket,
      key: keyFor(hash),
    });
    if (!head) {
      return c.body(null, 404);
    }
    return c.body(null, 200, {
      [META_HEADER_KIND]: head.metadata.kind ?? "",
      [META_HEADER_SIZE]: String(head.contentLength),
      [META_HEADER_UPLOADED_AT]: head.metadata.uploadedAt ?? "",
    });
  });

  app.delete(`${TAKOSUMI_ARTIFACTS_PATH}/:hash`, async (c) => {
    const auth = checkAuth(c, getToken);
    if (auth.kind === "fail") return auth.response;
    const hash = c.req.param("hash");
    const removed = await storage.deleteObject({
      bucket,
      key: keyFor(hash),
    });
    if (!removed) {
      return c.json(apiError("not_found", "artifact not found"), 404);
    }
    return c.body(null, 204);
  });
}

function keyFor(hash: string): string {
  return `${KEY_PREFIX}${hash}`;
}

function headToStored(
  digest: ObjectStorageDigest,
  metadata: Record<string, string>,
  size: number,
): ArtifactStored {
  let userMetadata: JsonObject | undefined;
  if (metadata.userMetadata) {
    try {
      const parsed = JSON.parse(metadata.userMetadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        userMetadata = parsed as JsonObject;
      }
    } catch {
      // ignore malformed metadata
    }
  }
  return {
    hash: digest,
    kind: metadata.kind ?? "unknown",
    size,
    uploadedAt: metadata.uploadedAt ?? "",
    ...(userMetadata ? { metadata: userMetadata } : {}),
  };
}

async function sha256Digest(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hex = Array.from(
    new Uint8Array(buf),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

/**
 * Walk the underlying object storage list pagination to surface every
 * artifact in the bucket. Used by GC; bounded at 100k iterations to
 * avoid runaway storage adapters.
 */
async function listAllArtifacts(
  storage: ObjectStoragePort,
  bucket: string,
): Promise<
  ReadonlyArray<{
    readonly bucket: string;
    readonly key: string;
    readonly digest: string;
    readonly contentLength: number;
  }>
> {
  const all: Array<{
    bucket: string;
    key: string;
    digest: string;
    contentLength: number;
  }> = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100_000; i++) {
    const page = await storage.listObjects({
      bucket,
      prefix: KEY_PREFIX,
      limit: ARTIFACT_LIST_MAX_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of page.objects) {
      all.push({
        bucket: o.bucket,
        key: o.key,
        digest: o.digest,
        contentLength: o.contentLength,
      });
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

function parseLimitParam(
  raw: string | undefined,
): { kind: "ok"; value: number } | { kind: "fail"; error: string } {
  if (raw === undefined || raw === "") {
    return { kind: "ok", value: ARTIFACT_LIST_DEFAULT_LIMIT };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      kind: "fail",
      error: "limit must be a positive integer",
    };
  }
  if (parsed > ARTIFACT_LIST_MAX_LIMIT) {
    return {
      kind: "fail",
      error: `limit must be <= ${ARTIFACT_LIST_MAX_LIMIT}`,
    };
  }
  return { kind: "ok", value: parsed };
}

function isTruthyQuery(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function resolveMaxBytes(option: number | undefined): number {
  if (
    typeof option === "number" && Number.isInteger(option) && option > 0
  ) {
    return option;
  }
  return TAKOSUMI_ARTIFACT_MAX_BYTES_DEFAULT;
}

/**
 * Build a 413 message with the actual / max sizes plus operator
 * remediation hints. Same shape regardless of whether the cap fires on
 * the declared `Content-Length` (cheap reject) or the buffered body
 * length (post-form-parse reject).
 */
function tooLargeMessage(
  actual: number,
  max: number,
  source: "content-length" | "artifact bytes",
): string {
  return (
    `${source} exceed maxBytes (${actual} > ${max}); ` +
    `raise TAKOSUMI_ARTIFACT_MAX_BYTES (current default is ` +
    `${TAKOSUMI_ARTIFACT_MAX_BYTES_DEFAULT}) or configure an external ` +
    `object-storage backend (R2 / S3 / GCS) that supports presigned ` +
    `uploads — the kernel buffers the whole multipart body before ` +
    `handing it to ObjectStoragePort.putObject`
  );
}

// deno-lint-ignore no-explicit-any
type AuthOk = { kind: "ok" };
// deno-lint-ignore no-explicit-any
type AuthFail = { kind: "fail"; response: any };

function checkAuth(
  // deno-lint-ignore no-explicit-any
  c: any,
  getToken: () => string | undefined,
): AuthOk | AuthFail {
  const expected = getToken();
  if (!expected) {
    return {
      kind: "fail",
      response: c.json(
        apiError("not_found", "artifact endpoint disabled"),
        404,
      ),
    };
  }
  const presented = readBearer(c.req.header("authorization"));
  if (!presented) {
    return {
      kind: "fail",
      response: c.json(
        apiError("unauthenticated", "missing bearer token"),
        401,
      ),
    };
  }
  if (!constantTimeEquals(presented, expected)) {
    return {
      kind: "fail",
      response: c.json(apiError("unauthenticated", "invalid token"), 401),
    };
  }
  return { kind: "ok" };
}

/**
 * Same shape as `checkAuth` but accepts EITHER the deploy token OR the
 * read-only fetch token (when configured). Used for GET / HEAD where the
 * runtime-agent host needs to fetch artifact bytes without holding the
 * full deploy token. POST / DELETE / GC keep `checkAuth` so write power
 * remains scoped to the deploy token.
 *
 * Note: still 404s when the deploy token is unset. That preserves the
 * "the artifact endpoint is opt-in" UX — setting only the fetch token
 * is not enough to enable the endpoint, the operator must still
 * configure the deploy token.
 */
function checkReadAuth(
  // deno-lint-ignore no-explicit-any
  c: any,
  getToken: () => string | undefined,
  getFetchToken: () => string | undefined,
): AuthOk | AuthFail {
  const deployToken = getToken();
  if (!deployToken) {
    return {
      kind: "fail",
      response: c.json(
        apiError("not_found", "artifact endpoint disabled"),
        404,
      ),
    };
  }
  const presented = readBearer(c.req.header("authorization"));
  if (!presented) {
    return {
      kind: "fail",
      response: c.json(
        apiError("unauthenticated", "missing bearer token"),
        401,
      ),
    };
  }
  const fetchToken = getFetchToken();
  if (
    constantTimeEquals(presented, deployToken) ||
    (fetchToken && constantTimeEquals(presented, fetchToken))
  ) {
    return { kind: "ok" };
  }
  return {
    kind: "fail",
    response: c.json(apiError("unauthenticated", "invalid token"), 401),
  };
}

function readBearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^bearer\s+(.+)$/i.exec(value);
  return m?.[1]?.trim() || undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
