/**
 * §4 Space CRUD routes. Owns
 * its handlers and its slice of the {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS}
 * descriptor inventory.
 */

import type { CreateSpaceRequest } from "../domains/spaces/mod.ts";
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
  TAKOSUMI_SPACE_ROUTE,
  TAKOSUMI_SPACES_ROUTE,
} from "./deploy_control_route_paths.ts";
import { stableJsonDigest } from "../adapters/source/digest.ts";

const SPACE_ID_PARAM = { param: "spaceId", pattern: SPACE_ID_PATTERN } as const;

export const DEPLOY_CONTROL_SPACE_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_SPACES_ROUTE,
      summary:
        "Creates a Space (owner namespace `@handle`) Installations live directly under.",
      auth: "deploy-control-token",
      operationId: "createSpace",
      openapi: {
        requestSchema: "CreateSpaceRequest",
        okStatus: "201",
        okSchema: "SpaceResponse",
      },
      notImplementedMessage: "spaces not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SPACES_ROUTE,
      summary: "Lists Spaces visible to the principal.",
      auth: "deploy-control-token",
      operationId: "listSpaces",
      openapi: { okSchema: "ListSpacesResponse" },
      notImplementedMessage: "spaces not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SPACE_ROUTE,
      summary: "Reads a Space record.",
      auth: "deploy-control-token",
      operationId: "getSpace",
      openapi: { pathParams: ["spaceId"], okSchema: "SpaceResponse" },
      notImplementedMessage: "spaces not wired",
    },
    {
      method: "PATCH",
      path: TAKOSUMI_SPACE_ROUTE,
      summary:
        "Updates mutable Space settings such as displayName or archive state.",
      auth: "deploy-control-token",
      operationId: "patchSpace",
      openapi: {
        pathParams: ["spaceId"],
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
    TAKOSUMI_SPACES_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.spacesService ? undefined : "spaces not wired",
      enforceBody: true,
      handler: async ({ c, principal }) => {
        // Space creation is not scoped by an existing space id, so only an
        // unrestricted principal (`spaceIds: "*"`) may mint new Spaces.
        ensureSpaceCreatePermission(principal);
        const body = await readJsonBody<CreateSpaceRequest>(c, "spaceCreate");
        return c.json({ space: await spaces!.createSpace(body) }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_SPACES_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.spacesService ? undefined : "spaces not wired",
      handler: async ({ c, principal }) => {
        const all = await spaces!.listSpaces();
        // A scoped principal only sees the Spaces it may access.
        const visible =
          principal.spaceIds === "*"
            ? all
            : all.filter((space) => scopeAllows(principal.spaceIds, space.id));
        return c.json({ spaces: visible }, 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_SPACE_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.spacesService ? undefined : "spaces not wired",
      param: SPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        return c.json({ space: await spaces!.getSpace(id) }, 200);
      },
    }),
  );

  // §30 `PATCH /internal/v1/spaces/:spaceId` — mutable Space settings.
  app.patch(
    TAKOSUMI_SPACE_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.spacesService ? undefined : "spaces not wired",
      param: SPACE_ID_PARAM,
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
        const space = await spaces!.updateSpace(id, patch);
        await activity?.record({
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
