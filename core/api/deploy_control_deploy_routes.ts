/**
 * `takosumi deploy` routes: upload ingest + deploy.
 *
 *   POST /internal/v1/spaces/:spaceId/uploads   binary tar(zstd) ingest ->
 *                                        R2_SOURCE -> upload SourceSnapshot
 *   POST /internal/v1/deploy             resolve/create Installation + plan the
 *                                        upload snapshot (the `wrangler deploy`
 *                                        equivalent)
 *
 * The descriptor inventory models the upload body as `application/octet-stream`;
 * the control surface they expose is still the canonical Space / Installation /
 * Run vocabulary.
 */

import type { InternalDeployRequest } from "takosumi-contract/deploy";
import { INTERNAL_V1_PREFIX } from "takosumi-contract/api-surface";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { uploadArchiveObjectKey } from "../domains/sources/mod.ts";
import { deployUpload } from "../domains/deploy-control/upload_deploy.ts";
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
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/uploads` as const;
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
        pathParams: ["spaceId"],
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

/** 64 MiB cap on a single upload archive (mirrors the artifact-route posture). */
export const DEFAULT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

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
        ensureSpacePermission(principal, body.spaceId);
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

function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
