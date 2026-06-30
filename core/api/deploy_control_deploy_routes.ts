/**
 * Internal upload/source-archive compatibility routes.
 *
 *   POST /internal/v1/workspaces/:spaceId/uploads   binary tar(zstd) ingest ->
 *                                        R2_SOURCE -> upload SourceSnapshot
 *   POST /internal/v1/workspaces/:spaceId/artifact-snapshots
 *                                        legacy HTTPS source archive + sha256
 *                                        ingest -> R2_SOURCE -> SourceSnapshot
 *   POST /internal/v1/deploy             resolve an existing source-less legacy
 *                                        Capsule and plan the no-git source
 *                                        snapshot for the internal path
 *
 * The descriptor inventory models the upload body as `application/octet-stream`;
 * the control surface they expose is still an internal compatibility surface;
 * the public Takosumi model remains Git-hosted OpenTofu Capsules.
 */

import type { InternalDeployRequest } from "@takosumi/internal/deploy-control-api";
import { INTERNAL_V1_PREFIX } from "takosumi-contract/api-surface";
import type {
  ArtifactSnapshotRequest,
  SourceSnapshot,
} from "takosumi-contract/sources";
import {
  artifactArchiveObjectKey,
  uploadArchiveObjectKey,
} from "../domains/sources/mod.ts";
import { deployUpload } from "../domains/deploy-control/upload_deploy.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import { evaluateSourceUrl } from "../domains/sources/url-policy.ts";
import {
  authorizeDeployControl,
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureSpacePermission,
  errorEnvelope,
  readJsonBody,
  runHandler,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";

const SPACE_UPLOADS_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:spaceId/uploads` as const;
const SPACE_ARTIFACT_SNAPSHOTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:spaceId/artifact-snapshots` as const;
const DEPLOY_ROUTE = `${INTERNAL_V1_PREFIX}/deploy` as const;

export const DEPLOY_CONTROL_DEPLOY_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: SPACE_UPLOADS_ROUTE,
      summary:
        "Ingests a local Capsule archive upload and records an upload SourceSnapshot.",
      auth: "deploy-control-token",
      operationId: "uploadSpaceSourceSnapshot",
      openapi: {
        pathParams: ["workspaceId"],
        query: ["path"],
        okStatus: "201",
        okSchema: "UploadSnapshotResponse",
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": {
              schema: {
                type: "string",
                format: "binary",
                description:
                  "tar or tar.zst archive bytes for the local OpenTofu Capsule.",
              },
            },
          },
        },
      },
      notImplementedMessage: "upload archive storage not wired",
    },
    {
      method: "POST",
      path: SPACE_ARTIFACT_SNAPSHOTS_ROUTE,
      summary:
        "Fetches a legacy digest-pinned prepared Capsule source archive and records a SourceSnapshot.",
      auth: "deploy-control-token",
      operationId: "createArtifactSourceSnapshot",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "ArtifactSnapshotRequest",
        okStatus: "201",
        okSchema: "ArtifactSnapshotResponse",
      },
      notImplementedMessage: "prepared source archive storage not wired",
    },
    {
      method: "POST",
      path: DEPLOY_ROUTE,
      summary:
        "Starts a deploy from an upload SourceSnapshot by resolving or creating the target Installation and plan Run.",
      auth: "deploy-control-token",
      operationId: "deployUploadSnapshot",
      openapi: {
        requestSchema: "DeployUploadSnapshotRequest",
        okSchema: "DeployResponse",
      },
      notImplementedMessage: "installations not wired",
    },
  ];

/** 64 MiB cap on a single upload archive. */
export const DEFAULT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
/** 64 MiB cap on a legacy prepared source archive. */
export const DEFAULT_ARTIFACT_SNAPSHOT_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES;

export interface RecordUploadArchiveInput {
  readonly controller: DeployControlRouteContext["controller"];
  readonly writeSourceArchive: NonNullable<
    DeployControlRouteContext["dependencies"]["writeSourceArchive"]
  >;
  readonly spaceId: string;
  readonly bytes: Uint8Array;
  readonly path?: string;
}

export async function recordUploadArchive(
  input: RecordUploadArchiveInput,
): Promise<SourceSnapshot> {
  const digest = await sha256Digest(input.bytes);
  const snapshotId = `snap_${randomHex()}`;
  const archiveObjectKey = uploadArchiveObjectKey(input.spaceId, snapshotId);
  await input.writeSourceArchive(archiveObjectKey, input.bytes);
  return await input.controller.recordUploadSnapshot({
    spaceId: input.spaceId,
    snapshotId,
    archiveObjectKey,
    archiveDigest: digest,
    archiveSizeBytes: input.bytes.byteLength,
    ...(input.path ? { path: input.path } : {}),
  });
}

export interface RecordArtifactSnapshotInput {
  readonly controller: DeployControlRouteContext["controller"];
  readonly writeSourceArchive: NonNullable<
    DeployControlRouteContext["dependencies"]["writeSourceArchive"]
  >;
  readonly spaceId: string;
  readonly request: ArtifactSnapshotRequest;
  readonly fetcher?: typeof fetch;
  readonly maxBytes?: number;
}

export async function recordArtifactSnapshotFromUrl(
  input: RecordArtifactSnapshotInput,
): Promise<SourceSnapshot> {
  const sourceArchiveUrl = validateArtifactUrl(input.request.url);
  const expectedDigest = normalizeSha256Digest(input.request.digest);
  const format = input.request.format ?? "tar.zst";
  if (format !== "tar.zst") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "prepared source archive format must be tar.zst",
    );
  }
  const maxBytes = input.maxBytes ?? DEFAULT_ARTIFACT_SNAPSHOT_MAX_BYTES;
  const response = await (input.fetcher ?? fetch)(sourceArchiveUrl.toString(), {
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "prepared source archive url redirects are not allowed",
    );
  }
  if (!response.ok) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `prepared source archive fetch failed (${response.status})`,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new OpenTofuControllerError(
        "resource_exhausted",
        "prepared source archive too large",
      );
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "prepared source archive body is empty",
    );
  }
  if (bytes.byteLength > maxBytes) {
    throw new OpenTofuControllerError(
      "resource_exhausted",
      "prepared source archive too large",
    );
  }
  const actualDigest = await sha256Digest(bytes);
  if (actualDigest !== expectedDigest) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "prepared source archive digest mismatch",
    );
  }
  const snapshotId = `snap_${randomHex()}`;
  const archiveObjectKey = artifactArchiveObjectKey(input.spaceId, snapshotId);
  await input.writeSourceArchive(archiveObjectKey, bytes);
  return await input.controller.recordArtifactSnapshot({
    spaceId: input.spaceId,
    url: sourceArchiveUrl.toString(),
    snapshotId,
    archiveObjectKey,
    archiveDigest: actualDigest,
    archiveSizeBytes: bytes.byteLength,
    ...(input.request.path ? { path: input.request.path } : {}),
  });
}

export function mountDeployControlDeployRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, controller } = ctx;

  app.post(SPACE_UPLOADS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const writeSourceArchive = dependencies.writeSourceArchive;
    if (!writeSourceArchive) {
      return c.json(
        errorEnvelope(
          c,
          "not_implemented",
          "upload archive storage (R2_SOURCE) is not configured",
        ),
        501,
      );
    }
    const spaceId = c.req.param("spaceId");
    if (!SPACE_ID_PATTERN.test(spaceId)) {
      return c.json(
        errorEnvelope(c, "invalid_argument", "invalid spaceId"),
        400,
      );
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) {
      return c.json(
        errorEnvelope(c, "invalid_argument", "upload body is empty"),
        400,
      );
    }
    if (bytes.byteLength > DEFAULT_UPLOAD_MAX_BYTES) {
      return c.json(
        errorEnvelope(c, "resource_exhausted", "upload archive too large"),
        413,
      );
    }
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, spaceId);
      const path = c.req.query("path");
      const snapshot = await recordUploadArchive({
        controller,
        writeSourceArchive,
        spaceId,
        bytes,
        ...(path ? { path } : {}),
      });
      return c.json({ snapshot }, 201);
    });
  });

  app.post(
    SPACE_ARTIFACT_SNAPSHOTS_ROUTE,
    ctx.deployControlBodyLimit,
    defineRoute({
      ctx,
      param: { param: "workspaceId", pattern: SPACE_ID_PATTERN },
      enforceBody: true,
      handler: async ({ c, principal, id: spaceId }) => {
        const writeSourceArchive = dependencies.writeSourceArchive;
        if (!writeSourceArchive) {
          return c.json(
            errorEnvelope(
              c,
              "not_implemented",
              "prepared source archive storage (R2_SOURCE) is not configured",
            ),
            501,
          );
        }
        ensureSpacePermission(principal, spaceId);
        const body = await readJsonBody<ArtifactSnapshotRequest>(
          c,
          "artifactSnapshot",
        );
        const snapshot = await recordArtifactSnapshotFromUrl({
          controller,
          writeSourceArchive,
          spaceId,
          request: body,
        });
        return c.json({ snapshot }, 201);
      },
    }),
  );

  app.post(
    DEPLOY_ROUTE,
    ctx.deployControlBodyLimit,
    defineRoute({
      ctx,
      enforceBody: true,
      handler: async ({ c, principal }) => {
        const installations = dependencies.installationsService;
        if (!installations) {
          return c.json(
            errorEnvelope(c, "not_implemented", "installations not wired"),
            501,
          );
        }
        const body = await readJsonBody<InternalDeployRequest>(c, "deploy");
        ensureSpacePermission(principal, body.workspaceId ?? body.spaceId);
        const response = await deployUpload(
          { controller, installations },
          body,
        );
        return c.json(response, 200);
      },
    }),
  );
}

async function sha256Digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view.buffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function validateArtifactUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "prepared source archive url is required",
    );
  }
  const policy = evaluateSourceUrl(raw);
  if (!policy.ok || policy.scheme !== "https") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `prepared source archive url is not allowed (${policy.ok ? "non_https" : policy.reason})`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "prepared source archive url is malformed",
    );
  }
  if (url.username || url.password) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "prepared source archive url must not contain embedded credentials",
    );
  }
  return url;
}

function normalizeSha256Digest(raw: string): `sha256:${string}` {
  if (typeof raw !== "string") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "prepared source archive digest is required",
    );
  }
  const value = raw.trim().toLowerCase();
  const hex = value.startsWith("sha256:")
    ? value.slice("sha256:".length)
    : value;
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "prepared source archive digest must be sha256:<64 hex>",
    );
  }
  return `sha256:${hex}`;
}

function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
