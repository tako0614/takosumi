/**
 * §4 Space CRUD routes plus the §9 operator-connection-default routes (mounted
 * consecutively in the original). Owns its handlers and its slice of the
 * {@link DEPLOY_CONTROL_PUBLIC_ENDPOINTS} descriptor inventory.
 *
 * NOTE: the §30 descriptor inventory enumerates the Space routes; it does NOT
 * list the operator-connection-default routes (they are mounted only when a
 * controller is present and are not part of the controller-absent 501 fallback),
 * so those two routes have no descriptor entry here.
 */

import type {
  PutOperatorConnectionDefaultRequest,
} from "../domains/connections/mod.ts";
import type { CreateSpaceRequest } from "../domains/spaces/mod.ts";
import {
  OpenTofuControllerError,
} from "../domains/deploy-control/mod.ts";
import {
  authorizeDeployControl,
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureConnectionPermission,
  ensureSpaceCreatePermission,
  ensureSpacePermission,
  enforceBodyLimit,
  notImplemented,
  nonEmptyString,
  readJsonBody,
  runHandler,
  scopeAllows,
  SPACE_ID_PATTERN,
  DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_OPERATOR_CONNECTION_DEFAULTS_ROUTE,
  TAKOSUMI_SPACE_ROUTE,
  TAKOSUMI_SPACES_ROUTE,
} from "./deploy_control_route_paths.ts";

const SPACE_ID_PARAM = { param: "spaceId", pattern: SPACE_ID_PATTERN } as const;

export const DEPLOY_CONTROL_SPACE_ENDPOINTS: readonly DeployControlEndpoint[] = [
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
    summary: "Updates a Space (displayName only for MVP).",
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
  const connectionsService = dependencies.connectionsService;

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
        const visible = principal.spaceIds === "*"
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

  // §30 `PATCH /api/spaces/:spaceId` — mutable Space settings.
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
        }>(
          c,
          "spacePatch",
        );
        const patch: {
          displayName?: string;
          policy?: Readonly<Record<string, unknown>>;
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
        if (patch.displayName === undefined && patch.policy === undefined) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "displayName or policy is required",
          );
        }
        const space = await spaces!.updateSpace(id, patch);
        return c.json({ space }, 200);
      },
    }),
  );

  // --- Operator default connections (Core Specification §9) ------------------
  // Not part of the §30 descriptor inventory; mounted only with a controller and
  // absent from the controller-absent 501 fallback.

  app.put(
    TAKOSUMI_OPERATOR_CONNECTION_DEFAULTS_ROUTE,
    deployControlBodyLimit,
    async (c) => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      if (!connectionsService) {
        return c.json(notImplemented(c, "connections not wired"), 501);
      }
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
      return await runHandler(c, async () => {
        // Instance-wide defaults: only the unrestricted bearer may set them.
        ensureConnectionPermission(auth.principal, undefined);
        const body = await readJsonBody<PutOperatorConnectionDefaultRequest>(
          c,
          "operatorConnectionDefault",
        );
        const record = await connectionsService.putOperatorConnectionDefault(
          body,
        );
        return c.json({ operatorConnectionDefault: record }, 200);
      });
    },
  );

  app.get(TAKOSUMI_OPERATOR_CONNECTION_DEFAULTS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!connectionsService) {
      return c.json(notImplemented(c, "connections not wired"), 501);
    }
    return await runHandler(c, async () => {
      ensureConnectionPermission(auth.principal, undefined);
      return c.json({
        operatorConnectionDefaults: await connectionsService
          .listOperatorConnectionDefaults(),
      }, 200);
    });
  });
}
