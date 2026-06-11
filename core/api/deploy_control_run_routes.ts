/**
 * §6.8 unified Run facade routes: read / logs / events / approve / cancel over
 * the SourceSync / Plan / Apply ledgers. Owns its handlers and its slice of the
 * {@link DEPLOY_CONTROL_PUBLIC_ENDPOINTS} descriptor inventory.
 */

import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureSpacePermission,
  readOptionalJsonBody,
  RUN_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_RUN_APPROVE_ROUTE,
  TAKOSUMI_RUN_CANCEL_ROUTE,
  TAKOSUMI_RUN_EVENTS_ROUTE,
  TAKOSUMI_RUN_LOGS_ROUTE,
  TAKOSUMI_RUN_ROUTE,
} from "./deploy_control_route_paths.ts";

const RUN_ID_PARAM = { param: "runId", pattern: RUN_ID_PATTERN } as const;

export const DEPLOY_CONTROL_RUN_ENDPOINTS: readonly DeployControlEndpoint[] = [
  {
    method: "GET",
    path: TAKOSUMI_RUN_ROUTE,
    summary:
      "Reads the unified Run projection (over the SourceSync / Plan / Apply ledgers).",
    auth: "deploy-control-token",
    operationId: "getRun",
    openapi: { pathParams: ["runId"], okSchema: "RunResponse" },
    notImplementedMessage: "runs not wired",
  },
  {
    method: "GET",
    path: TAKOSUMI_RUN_LOGS_ROUTE,
    summary:
      "Reads a Run's structured diagnostics + run-level audit trail (redacted).",
    auth: "deploy-control-token",
    operationId: "getRunLogs",
    openapi: { pathParams: ["runId"], okSchema: "RunLogsResponse" },
    notImplementedMessage: "runs not wired",
  },
  {
    method: "GET",
    path: TAKOSUMI_RUN_EVENTS_ROUTE,
    summary: "Reads a Run's run-level audit-event trail.",
    auth: "deploy-control-token",
    operationId: "getRunEvents",
    openapi: { pathParams: ["runId"], okSchema: "RunEventsResponse" },
    notImplementedMessage: "runs not wired",
  },
  {
    method: "POST",
    path: TAKOSUMI_RUN_APPROVE_ROUTE,
    summary:
      "Approves a waiting-approval run (destroy plan or destructive change), clearing the apply gate.",
    auth: "deploy-control-token",
    operationId: "approveRun",
    openapi: {
      pathParams: ["runId"],
      requestSchema: "ApproveRunRequest",
      okSchema: "RunResponse",
    },
    notImplementedMessage: "runs not wired",
  },
  {
    method: "POST",
    path: TAKOSUMI_RUN_CANCEL_ROUTE,
    summary: "Cancels a queued or waiting-approval run.",
    auth: "deploy-control-token",
    operationId: "cancelRun",
    openapi: { pathParams: ["runId"], okSchema: "RunResponse" },
    notImplementedMessage: "runs not wired",
  },
];

export function mountDeployControlRunRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, controller } = ctx;

  app.get(
    TAKOSUMI_RUN_ROUTE,
    defineRoute({
      ctx,
      param: RUN_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const run = await controller.getRun(id);
        ensureSpacePermission(principal, run.spaceId);
        return c.json({ run }, 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_RUN_LOGS_ROUTE,
    defineRoute({
      ctx,
      param: RUN_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        // Resolve the run's space first so logs are space-permission gated.
        const run = await controller.getRun(id);
        ensureSpacePermission(principal, run.spaceId);
        return c.json(await controller.getRunLogs(id), 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_RUN_EVENTS_ROUTE,
    defineRoute({
      ctx,
      param: RUN_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const run = await controller.getRun(id);
        ensureSpacePermission(principal, run.spaceId);
        return c.json(await controller.getRunEvents(id), 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_RUN_APPROVE_ROUTE,
    defineRoute({
      ctx,
      param: RUN_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const existing = await controller.getRun(id);
        ensureSpacePermission(principal, existing.spaceId);
        const body = await readOptionalJsonBody<{
          readonly reason?: string;
        }>(c, "runApprove");
        return c.json(
          {
            run: await controller.approveRun(id, {
              approvedBy: principal.actor,
              ...(body.reason ? { reason: body.reason } : {}),
            }),
          },
          200,
        );
      },
    }),
  );

  app.post(
    TAKOSUMI_RUN_CANCEL_ROUTE,
    defineRoute({
      ctx,
      param: RUN_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        // Resolve the run's space first so cancel is space-permission gated.
        const existing = await controller.getRun(id);
        ensureSpacePermission(principal, existing.spaceId);
        return c.json({ run: await controller.cancelRun(id) }, 200);
      },
    }),
  );
}
