/** Operator-only migration from the retired Resource backing-Capsule state. */

import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureWorkspacePermission,
  nonEmptyString,
  readJsonBody,
  WORKSPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import { TAKOSUMI_WORKSPACE_RESOURCE_STATE_ADOPTION_ROUTE } from "./deploy_control_route_paths.ts";
import {
  LegacyResourceStateAdoptionError,
  type ConfirmLegacyResourceStateAdoptionInput,
} from "../domains/resource-shape/legacy_state_adoption.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/errors.ts";

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: WORKSPACE_ID_PATTERN,
} as const;

export const DEPLOY_CONTROL_RESOURCE_STATE_ADOPTION_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_RESOURCE_STATE_ADOPTION_ROUTE,
      summary: "Reports exact candidates for legacy Resource state adoption.",
      auth: "deploy-control-token",
      operationId: "reportLegacyResourceStateAdoption",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "LegacyResourceStateAdoptionReportResponse",
      },
      notImplementedMessage: "legacy Resource state adoption is not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_RESOURCE_STATE_ADOPTION_ROUTE,
      summary: "Confirms one exact reviewed Resource state adoption candidate.",
      auth: "deploy-control-token",
      operationId: "confirmLegacyResourceStateAdoption",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "ConfirmLegacyResourceStateAdoptionRequest",
        okSchema: "ConfirmLegacyResourceStateAdoptionResponse",
      },
      notImplementedMessage: "legacy Resource state adoption is not wired",
    },
  ];

export function mountDeployControlResourceStateAdoptionRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, deployControlBodyLimit } = ctx;
  const migration = dependencies.legacyResourceStateAdoptionService;

  app.get(
    TAKOSUMI_WORKSPACE_RESOURCE_STATE_ADOPTION_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.legacyResourceStateAdoptionService
          ? undefined
          : "legacy Resource state adoption is not wired",
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id: workspaceId }) => {
        ensureWorkspacePermission(principal, workspaceId);
        return c.json(await migration!.report(workspaceId), 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_RESOURCE_STATE_ADOPTION_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.legacyResourceStateAdoptionService
          ? undefined
          : "legacy Resource state adoption is not wired",
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id: workspaceId }) => {
        ensureWorkspacePermission(principal, workspaceId);
        const body = parseConfirmationBody(
          await readJsonBody<Record<string, unknown>>(
            c,
            "resourceStateAdoptionConfirm",
          ),
        );
        if (!body.resourceId.startsWith(`tkrn:${workspaceId}:`)) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "resourceId does not belong to the route Workspace",
          );
        }
        try {
          const descriptor = await migration!.confirm({
            ...body,
            confirmedBy: principal.actor ?? "deploy-control-operator",
          });
          return c.json({ descriptor }, 200);
        } catch (error) {
          if (error instanceof LegacyResourceStateAdoptionError) {
            throw new OpenTofuControllerError(
              error.code === "candidate_not_found"
                ? "not_found"
                : "failed_precondition",
              error.message,
            );
          }
          throw error;
        }
      },
    }),
  );
}

function parseConfirmationBody(
  body: Record<string, unknown>,
): Omit<ConfirmLegacyResourceStateAdoptionInput, "confirmedBy"> {
  const stringFields = [
    "resourceId",
    "resourceUpdatedAt",
    "expectedLegacyCapsuleName",
    "capsuleId",
    "stateVersionId",
    "stateRef",
    "stateDigest",
  ] as const;
  for (const field of stringFields) {
    if (!nonEmptyString(body[field])) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `${field} must be a non-empty string copied from the adoption report`,
      );
    }
  }
  if (
    !Number.isSafeInteger(body.stateGeneration) ||
    Number(body.stateGeneration) < 0
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "stateGeneration must be a non-negative safe integer copied from the adoption report",
    );
  }
  return {
    resourceId: body.resourceId as string,
    resourceUpdatedAt: body.resourceUpdatedAt as string,
    expectedLegacyCapsuleName: body.expectedLegacyCapsuleName as string,
    capsuleId: body.capsuleId as string,
    stateVersionId: body.stateVersionId as string,
    stateGeneration: body.stateGeneration as number,
    stateRef: body.stateRef as string,
    stateDigest: body.stateDigest as string,
  };
}
