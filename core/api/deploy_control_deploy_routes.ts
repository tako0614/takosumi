/**
 * `takosumi deploy` routes: upload ingest + deploy.
 *
 *   POST /api/spaces/:spaceId/uploads   binary tar(zstd) ingest -> R2_SOURCE ->
 *                                        upload SourceSnapshot
 *   POST /api/deploy                     resolve/create Installation + plan the
 *                                        upload snapshot (the `wrangler deploy`
 *                                        equivalent)
 *
 * These are mounted OUTSIDE the public descriptor inventory (like the ledger
 * routes) because the upload route carries a binary body that the JSON-schema
 * OpenAPI inventory does not model; the control surface they expose is still the
 * canonical Space / Installation / Run vocabulary.
 */

import type { DeployRequest } from "takosumi-contract/deploy";
import { uploadArchiveObjectKey } from "../domains/sources/mod.ts";
import { deployUpload } from "../domains/deploy-control/upload_deploy.ts";
import {
  authorizeDeployControl,
  defineRoute,
  type DeployControlRouteContext,
  ensureSpacePermission,
  errorEnvelope,
  readJsonBody,
  runHandler,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";

const SPACE_UPLOADS_ROUTE = "/api/spaces/:spaceId/uploads" as const;
const DEPLOY_ROUTE = "/api/deploy" as const;

/** 64 MiB cap on a single upload archive (mirrors the artifact-route posture). */
const DEFAULT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

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
        errorEnvelope(c, "invalid_argument", "upload archive too large"),
        413,
      );
    }
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, spaceId);
      const digest = await sha256Digest(bytes);
      const snapshotId = `snap_${randomHex()}`;
      const archiveObjectKey = uploadArchiveObjectKey(spaceId, snapshotId);
      await writeSourceArchive(archiveObjectKey, bytes);
      const path = c.req.query("path");
      const snapshot = await controller.recordUploadSnapshot({
        spaceId,
        snapshotId,
        archiveObjectKey,
        archiveDigest: digest,
        archiveSizeBytes: bytes.byteLength,
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
        const body = await readJsonBody<DeployRequest>(c, "deploy");
        ensureSpacePermission(principal, body.spaceId);
        const response = await deployUpload({ controller, installations }, body);
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
