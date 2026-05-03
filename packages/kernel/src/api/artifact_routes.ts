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
import { apiError } from "./errors.ts";

/**
 * Artifact upload endpoints — the data plane for `takosumi artifact push`.
 *
 *   POST   /v1/artifacts            multipart upload (kind, metadata, body)
 *   GET    /v1/artifacts            list (paginated by underlying object storage)
 *   HEAD   /v1/artifacts/:hash      existence + size + kind (header `x-takosumi-artifact-*`)
 *   GET    /v1/artifacts/:hash      bytes stream
 *   DELETE /v1/artifacts/:hash      remove
 *
 * Auth: same `TAKOSUMI_DEPLOY_TOKEN` bearer as `deploy_public_routes`. When
 * unset all routes 404. Storage is content-addressed under
 * `<bucket>/artifacts/<sha256-hex>` via the kernel's `objectStorage` adapter;
 * digest is computed and verified server-side, regardless of any client-side
 * `expectedDigest`.
 */
export const TAKOSUMI_ARTIFACTS_PATH = ARTIFACTS_BASE_PATH;
export const TAKOSUMI_ARTIFACTS_BUCKET = "takosumi-artifacts" as const;
const KEY_PREFIX = "artifacts/" as const;

const META_HEADER_KIND = "x-takosumi-artifact-kind";
const META_HEADER_SIZE = "x-takosumi-artifact-size";
const META_HEADER_UPLOADED_AT = "x-takosumi-artifact-uploaded-at";

export interface RegisterArtifactRoutesOptions {
  /** Shared-secret token. When undefined the routes are disabled. */
  readonly getDeployToken?: () => string | undefined;
  /** Object storage backing the artifact blobs. Required (no in-memory default
   *  to force operators to think about persistence). */
  readonly objectStorage: ObjectStoragePort;
  readonly bucket?: string;
  readonly now?: () => string;
}

export function registerArtifactRoutes(
  app: HonoApp,
  options: RegisterArtifactRoutesOptions,
): void {
  const getToken = options.getDeployToken ?? (() => undefined);
  const bucket = options.bucket ?? TAKOSUMI_ARTIFACTS_BUCKET;
  const now = options.now ?? (() => new Date().toISOString());
  const storage = options.objectStorage;

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
    const list = await storage.listObjects({ bucket, prefix: KEY_PREFIX });
    const artifacts: ArtifactStored[] = list.objects.map((o) =>
      headToStored(o.digest, o.metadata, o.contentLength)
    );
    return c.json({ artifacts }, 200);
  });

  app.get(`${TAKOSUMI_ARTIFACTS_PATH}/:hash`, async (c) => {
    const auth = checkAuth(c, getToken);
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
    const auth = checkAuth(c, getToken);
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
