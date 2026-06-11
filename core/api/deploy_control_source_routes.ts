/**
 * §6 Source routes: create / list / read / patch / sync / snapshots. Owns its
 * handlers and its slice of the {@link DEPLOY_CONTROL_PUBLIC_ENDPOINTS}
 * descriptor inventory.
 */

import type {
  CreateSourceRequest,
  PatchSourceRequest,
} from "takosumi-contract/sources";
import type { CreateSourceCompatibilityCheckRequest } from "takosumi-contract/capsules";
import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import {
  authorizeDeployControl,
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  COMPATIBILITY_REPORT_ID_PATTERN,
  ensureSpacePermission,
  errorEnvelope,
  readOptionalJsonBody,
  readJsonBody,
  runHandler,
  SOURCE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_COMPATIBILITY_REPORT_ROUTE,
  TAKOSUMI_SOURCE_COMPATIBILITY_CHECK_ROUTE,
  TAKOSUMI_SOURCE_ROUTE,
  TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE,
  TAKOSUMI_SOURCE_SYNC_ROUTE,
  TAKOSUMI_SOURCES_ROUTE,
} from "./deploy_control_route_paths.ts";

const SOURCE_ID_PARAM = {
  param: "sourceId",
  pattern: SOURCE_ID_PATTERN,
} as const;

export const DEPLOY_CONTROL_SOURCE_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_SOURCES_ROUTE,
      summary:
        "Registers a git Source (URL-policy checked; ls-remote verification is a queued source_sync). Returns the hook secret once.",
      auth: "deploy-control-token",
      operationId: "createSource",
      openapi: {
        requestSchema: "CreateSourceRequest",
        okStatus: "201",
        okSchema: "CreateSourceResponse",
      },
      notImplementedMessage: "sources not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SOURCES_ROUTE,
      summary: "Lists Sources for a Space (never includes the hook secret).",
      auth: "deploy-control-token",
      operationId: "listSources",
      openapi: { query: ["spaceId"], okSchema: "ListSourcesResponse" },
      notImplementedMessage: "sources not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SOURCE_ROUTE,
      summary: "Reads a Source record.",
      auth: "deploy-control-token",
      operationId: "getSource",
      openapi: { pathParams: ["sourceId"], okSchema: "SourceResponse" },
      notImplementedMessage: "sources not wired",
    },
    {
      method: "PATCH",
      path: TAKOSUMI_SOURCE_ROUTE,
      summary:
        "Updates a Source (name / defaultRef / defaultPath / auth / status).",
      auth: "deploy-control-token",
      operationId: "patchSource",
      openapi: {
        pathParams: ["sourceId"],
        requestSchema: "PatchSourceRequest",
        okSchema: "SourceResponse",
      },
      notImplementedMessage: "sources not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_SOURCE_COMPATIBILITY_CHECK_ROUTE,
      summary:
        "Creates a compatibility_check Run for a Source and records a Capsule compatibility report.",
      auth: "deploy-control-token",
      operationId: "createSourceCompatibilityCheck",
      openapi: {
        pathParams: ["sourceId"],
        requestSchema: "CreateSourceCompatibilityCheckRequest",
        okStatus: "201",
        okSchema: "CapsuleCompatibilityReportResponse",
      },
      notImplementedMessage: "capsule compatibility service not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_COMPATIBILITY_REPORT_ROUTE,
      summary: "Reads a Capsule compatibility report.",
      auth: "deploy-control-token",
      operationId: "getCapsuleCompatibilityReport",
      openapi: {
        pathParams: ["reportId"],
        okSchema: "CapsuleCompatibilityReportResponse",
      },
      notImplementedMessage: "capsule compatibility service not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_SOURCE_SYNC_ROUTE,
      summary:
        "Creates a source_sync run that resolves the source's default ref to an archive snapshot in the runner.",
      auth: "deploy-control-token",
      operationId: "createSourceSync",
      openapi: {
        pathParams: ["sourceId"],
        okStatus: "201",
        okSchema: "CreateSourceSyncResponse",
      },
      notImplementedMessage: "sources not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE,
      summary: "Lists archive snapshots resolved for a Source.",
      auth: "deploy-control-token",
      operationId: "listSourceSnapshots",
      openapi: {
        pathParams: ["sourceId"],
        okSchema: "ListSourceSnapshotsResponse",
      },
      notImplementedMessage: "sources not wired",
    },
  ];

export function mountDeployControlSourceRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, controller, deployControlBodyLimit } = ctx;

  app.post(
    TAKOSUMI_SOURCES_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      enforceBody: true,
      handler: async ({ c, principal }) => {
        const body = await readJsonBody<CreateSourceRequest>(c, "sourceCreate");
        ensureSpacePermission(principal, body.spaceId);
        const response = await controller.createSource(body);
        return c.json(response, 201);
      },
    }),
  );

  app.get(TAKOSUMI_SOURCES_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const spaceId = c.req.query("spaceId") ?? "";
    if (spaceId.trim().length === 0) {
      return c.json(
        errorEnvelope(c, "invalid_argument", "spaceId query is required"),
        400,
      );
    }
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, spaceId);
      return c.json(await controller.listSources(spaceId), 200);
    });
  });

  app.get(
    TAKOSUMI_SOURCE_ROUTE,
    defineRoute({
      ctx,
      param: SOURCE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const response = await controller.getSource(id);
        ensureSpacePermission(principal, response.source.spaceId);
        return c.json(response, 200);
      },
    }),
  );

  app.patch(
    TAKOSUMI_SOURCE_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      param: SOURCE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        const existing = await controller.getSource(id);
        ensureSpacePermission(principal, existing.source.spaceId);
        const body = await readJsonBody<PatchSourceRequest>(c, "sourcePatch");
        return c.json(await controller.patchSource(id, body), 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_SOURCE_COMPATIBILITY_CHECK_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      param: SOURCE_ID_PARAM,
      enforceBody: false,
      handler: async ({ c, principal, id }) => {
        const existing = await controller.getSource(id);
        ensureSpacePermission(principal, existing.source.spaceId);
        const body =
          await readOptionalJsonBody<CreateSourceCompatibilityCheckRequest>(
            c,
            "sourceCompatibilityCheck",
          );
        return c.json(
          await controller.createSourceCompatibilityCheck(id, body),
          201,
        );
      },
    }),
  );

  app.get(
    TAKOSUMI_COMPATIBILITY_REPORT_ROUTE,
    defineRoute({
      ctx,
      param: {
        param: "reportId",
        pattern: COMPATIBILITY_REPORT_ID_PATTERN,
      },
      handler: async ({ c, principal, id }) => {
        const response = await controller.getCompatibilityReport(id);
        let spaceId: string | undefined;
        if (response.report.sourceId) {
          const existing = await controller.getSource(response.report.sourceId);
          spaceId = existing.source.spaceId;
        } else if (response.report.installationId) {
          const existing = await controller.getInstallation(
            response.report.installationId,
          );
          spaceId = existing.installation.spaceId;
        } else if (response.report.sourceSnapshotId) {
          const snapshot = await controller.getSourceSnapshot(
            response.report.sourceSnapshotId,
          );
          // The snapshot carries its owning Space directly (origin-agnostic),
          // so upload-origin snapshots resolve without a git Source.
          spaceId = snapshot.spaceId;
        }
        if (!spaceId) {
          throw new OpenTofuControllerError(
            "not_found",
            `compatibility report ${id} has no resolvable owner`,
          );
        }
        ensureSpacePermission(principal, spaceId);
        return c.json(response, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_SOURCE_SYNC_ROUTE,
    defineRoute({
      ctx,
      param: SOURCE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const existing = await controller.getSource(id);
        ensureSpacePermission(principal, existing.source.spaceId);
        return c.json(await controller.createSourceSync(id), 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE,
    defineRoute({
      ctx,
      param: SOURCE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const existing = await controller.getSource(id);
        ensureSpacePermission(principal, existing.source.spaceId);
        return c.json(await controller.listSourceSnapshots(id), 200);
      },
    }),
  );
}
