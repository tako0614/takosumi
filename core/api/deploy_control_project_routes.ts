/**
 * Workspace-scoped Project CRUD routes.
 *
 * Projects are part of the canonical Workspace -> Project -> Capsule ledger.
 * They are persisted by the same control-plane store and carry no execution or
 * repository metadata.
 */

import type { CreateProjectRequest } from "../domains/projects/mod.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/errors.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureWorkspacePermission,
  nonEmptyString,
  readJsonBody,
  WORKSPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_PROJECT_ROUTE,
  TAKOSUMI_PROJECTS_ROUTE,
} from "./deploy_control_route_paths.ts";

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: WORKSPACE_ID_PATTERN,
} as const;

const PROJECT_ID_PARAM = {
  param: "projectId",
  pattern: /^prj_[0-9a-zA-Z_-]{3,160}$/,
} as const;

export const DEPLOY_CONTROL_PROJECT_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_PROJECTS_ROUTE,
      summary: "Creates a Project in a Workspace.",
      auth: "deploy-control-token",
      operationId: "createProject",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "CreateProjectRequest",
        okStatus: "201",
        okSchema: "ProjectResponse",
      },
      notImplementedMessage: "projects not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PROJECTS_ROUTE,
      summary: "Lists Projects in a Workspace.",
      auth: "deploy-control-token",
      operationId: "listProjects",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "ListProjectsResponse",
      },
      notImplementedMessage: "projects not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PROJECT_ROUTE,
      summary: "Reads a Project record.",
      auth: "deploy-control-token",
      operationId: "getProject",
      openapi: {
        pathParams: ["projectId"],
        okSchema: "ProjectResponse",
      },
      notImplementedMessage: "projects not wired",
    },
  ];

export function mountDeployControlProjectRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, deployControlBodyLimit } = ctx;
  const projects = dependencies.projectsService;
  const workspaces = dependencies.workspacesService;

  app.post(
    TAKOSUMI_PROJECTS_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.projectsService && deps.workspacesService
          ? undefined
          : "projects not wired",
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id: workspaceId }) => {
        ensureWorkspacePermission(principal, workspaceId);
        await workspaces!.getWorkspace(workspaceId);
        const body = await readJsonBody<{
          readonly name?: unknown;
          readonly slug?: unknown;
          readonly projectJson?: unknown;
        }>(c, "projectCreate");
        if (!nonEmptyString(body.name)) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "name is required",
          );
        }
        if (!nonEmptyString(body.slug)) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "slug is required",
          );
        }
        if (
          body.projectJson !== undefined &&
          (typeof body.projectJson !== "object" ||
            body.projectJson === null ||
            Array.isArray(body.projectJson))
        ) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "projectJson must be an object",
          );
        }
        const request: CreateProjectRequest = {
          workspaceId,
          name: body.name.trim(),
          slug: body.slug.trim(),
          ...(body.projectJson !== undefined
            ? {
                projectJson: body.projectJson as Readonly<
                  Record<string, unknown>
                >,
              }
            : {}),
        };
        return c.json({ project: await projects!.createProject(request) }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_PROJECTS_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.projectsService && deps.workspacesService
          ? undefined
          : "projects not wired",
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id: workspaceId }) => {
        ensureWorkspacePermission(principal, workspaceId);
        await workspaces!.getWorkspace(workspaceId);
        return c.json(
          { projects: await projects!.listProjects(workspaceId) },
          200,
        );
      },
    }),
  );

  app.get(
    TAKOSUMI_PROJECT_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.projectsService ? undefined : "projects not wired",
      param: PROJECT_ID_PARAM,
      handler: async ({ c, principal, id: projectId }) => {
        const project = await projects!.getProject(projectId);
        ensureWorkspacePermission(principal, project.workspaceId);
        return c.json({ project }, 200);
      },
    }),
  );
}
