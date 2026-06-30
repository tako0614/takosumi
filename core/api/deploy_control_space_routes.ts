/**
 * Workspace CRUD routes. Owns
 * its handlers and its slice of the {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS}
 * descriptor inventory.
 */

import type { CreateWorkspaceRequest } from "../domains/workspaces/mod.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureSpaceCreatePermission,
  ensureSpacePermission,
  nonEmptyString,
  readJsonBody,
  scopeAllows,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_WORKSPACE_ROUTE,
  TAKOSUMI_WORKSPACES_ROUTE,
} from "./deploy_control_route_paths.ts";
import { stableJsonDigest } from "../adapters/source/digest.ts";

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: SPACE_ID_PATTERN,
} as const;

export const DEPLOY_CONTROL_SPACE_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACES_ROUTE,
      summary:
        "Creates a Workspace (owner namespace `@handle`) Capsules live directly under.",
      auth: "deploy-control-token",
      operationId: "createWorkspace",
      openapi: {
        requestSchema: "CreateWorkspaceRequest",
        okStatus: "201",
        okSchema: "SpaceResponse",
      },
      notImplementedMessage: "spaces not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACES_ROUTE,
      summary: "Lists Workspaces visible to the principal.",
      auth: "deploy-control-token",
      operationId: "listWorkspaces",
      openapi: { okSchema: "ListSpacesResponse" },
      notImplementedMessage: "spaces not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_ROUTE,
      summary: "Reads a Workspace record.",
      auth: "deploy-control-token",
      operationId: "getWorkspace",
      openapi: { pathParams: ["workspaceId"], okSchema: "SpaceResponse" },
      notImplementedMessage: "spaces not wired",
    },
    {
      method: "PATCH",
      path: TAKOSUMI_WORKSPACE_ROUTE,
      summary:
        "Updates mutable Workspace settings such as displayName or archive state.",
      auth: "deploy-control-token",
      operationId: "patchWorkspace",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "PatchSpaceRequest",
        okSchema: "SpaceResponse",
      },
      notImplementedMessage: "spaces not wired",
    },
  ];

export function mountDeployControlSpaceRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, deployControlBodyLimit } = ctx;
  const spaces = dependencies.spacesService;
  const activity = dependencies.activityService;

  app.post(
    TAKOSUMI_WORKSPACES_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.spacesService ? undefined : "spaces not wired",
      enforceBody: true,
      handler: async ({ c, principal }) => {
        // Workspace creation is not scoped by an existing workspace id, so only
        // an unrestricted principal (`spaceIds: "*"`) may mint new Workspaces.
        ensureSpaceCreatePermission(principal);
        const body = await readJsonBody<CreateWorkspaceRequest>(c, "spaceCreate");
        return c.json({ space: await spaces!.createWorkspace(body) }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_WORKSPACES_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.spacesService ? undefined : "spaces not wired",
      handler: async ({ c, principal }) => {
        const all = await spaces!.listWorkspaces();
        // A scoped principal only sees the Workspaces it may access.
        const visible =
          principal.spaceIds === "*"
            ? all
            : all.filter((space) => scopeAllows(principal.spaceIds, space.id));
        return c.json({ spaces: visible }, 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_WORKSPACE_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.spacesService ? undefined : "spaces not wired",
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        return c.json({ space: await spaces!.getWorkspace(id) }, 200);
      },
    }),
  );

  // Mutable Workspace settings.
  app.patch(
    TAKOSUMI_WORKSPACE_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.spacesService ? undefined : "spaces not wired",
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const body = await readJsonBody<{
          readonly displayName?: string;
          readonly policy?: unknown;
          readonly archived?: boolean;
        }>(c, "spacePatch");
        const patch: {
          displayName?: string;
          policy?: Readonly<Record<string, unknown>>;
          archived?: boolean;
        } = {};
        if (body.displayName !== undefined) {
          if (!nonEmptyString(body.displayName)) {
            throw new OpenTofuControllerError(
              "invalid_argument",
              "displayName is required",
            );
          }
          patch.displayName = body.displayName;
        }
        if (body.policy !== undefined) {
          if (
            typeof body.policy !== "object" ||
            body.policy === null ||
            Array.isArray(body.policy)
          ) {
            throw new OpenTofuControllerError(
              "invalid_argument",
              "policy must be an object",
            );
          }
          patch.policy = body.policy as Readonly<Record<string, unknown>>;
        }
        if (body.archived !== undefined) {
          if (typeof body.archived !== "boolean") {
            throw new OpenTofuControllerError(
              "invalid_argument",
              "archived must be boolean",
            );
          }
          patch.archived = body.archived;
        }
        if (
          patch.displayName === undefined &&
          patch.policy === undefined &&
          patch.archived === undefined
        ) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "displayName, policy, or archived is required",
          );
        }
        const space = await spaces!.updateWorkspace(id, patch);
        await activity?.record({
          workspaceId: id,
          spaceId: id,
          actorId: principal.actor,
          action: "space.updated",
          targetType: "space",
          targetId: id,
          metadata: {
            fields: Object.keys(patch).sort(),
            ...(patch.policy !== undefined
              ? { policyDigest: await stableJsonDigest(patch.policy) }
              : {}),
            ...(patch.archived !== undefined
              ? { archived: patch.archived }
              : {}),
          },
        });
        return c.json({ space }, 200);
      },
    }),
  );
}
