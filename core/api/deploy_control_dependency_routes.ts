/**
 * Dependency routes: create / list an Installation's DAG edges and delete a
 * single edge. Owns its handlers and its slice of the internal descriptor
 * inventory.
 */

import type { CreateDependencyRequest } from "../domains/dependencies/mod.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureSpacePermission,
  readJsonBody,
  DEPENDENCY_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_DEPENDENCY_ROUTE,
  TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
} from "./deploy_control_route_paths.ts";

export const DEPLOY_CONTROL_DEPENDENCY_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
      summary:
        "Creates a Dependency edge whose consumer is this Installation (variable_injection, remote_state, or published_output; cycles rejected).",
      auth: "deploy-control-token",
      operationId: "createDependency",
      openapi: {
        pathParams: ["installationId"],
        requestSchema: "CreateDependencyRequest",
        okStatus: "201",
        okSchema: "DependencyResponse",
      },
      notImplementedMessage: "dependencies not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
      summary:
        "Lists the Dependencies of an Installation, split into asProducer / asConsumer views.",
      auth: "deploy-control-token",
      operationId: "listInstallationDependencies",
      openapi: {
        pathParams: ["installationId"],
        okSchema: "InstallationDependenciesResponse",
      },
      notImplementedMessage: "dependencies not wired",
    },
    {
      method: "DELETE",
      path: TAKOSUMI_DEPENDENCY_ROUTE,
      summary:
        "Deletes a Dependency edge (space-permission gated via its consumer).",
      auth: "deploy-control-token",
      operationId: "deleteDependency",
      openapi: {
        pathParams: ["dependencyId"],
        okStatus: "204",
        okSchema: "EmptyResponse",
      },
      notImplementedMessage: "dependencies not wired",
    },
  ];

export function mountDeployControlDependencyRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, controller, deployControlBodyLimit } = ctx;
  const dependenciesService = dependencies.dependenciesService;
  const requireDependencies = (
    deps: typeof dependencies,
  ): string | undefined =>
    deps.dependenciesService ? undefined : "dependencies not wired";

  app.post(
    TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireDependencies,
      param: { id: "installationId" },
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        // The consumer is the path Installation; its Space gates the write.
        const consumer = await controller.getInstallation(id);
        ensureSpacePermission(principal, consumer.installation.spaceId);
        const body = await readJsonBody<
          Omit<CreateDependencyRequest, "spaceId" | "consumerInstallationId">
        >(c, "dependencyCreate");
        const dependency = await dependenciesService!.createDependency({
          ...body,
          spaceId: consumer.installation.spaceId,
          consumerInstallationId: id,
        });
        return c.json({ dependency }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
    defineRoute({
      ctx,
      requireService: requireDependencies,
      param: { id: "installationId" },
      handler: async ({ c, principal, id }) => {
        const installation = await controller.getInstallation(id);
        ensureSpacePermission(principal, installation.installation.spaceId);
        return c.json(await dependenciesService!.listForInstallation(id), 200);
      },
    }),
  );

  app.delete(
    TAKOSUMI_DEPENDENCY_ROUTE,
    defineRoute({
      ctx,
      requireService: requireDependencies,
      param: { param: "dependencyId", pattern: DEPENDENCY_ID_PATTERN },
      handler: async ({ principal, id, c }) => {
        // Resolve the edge first so deletion is space-permission gated via its
        // consumer Installation's Space (the edge carries spaceId directly).
        const dependency = await dependenciesService!.getDependency(id);
        if (!dependency) {
          throw new OpenTofuControllerError(
            "not_found",
            `dependency ${id} not found`,
          );
        }
        ensureSpacePermission(principal, dependency.spaceId);
        await dependenciesService!.deleteDependency(id);
        return c.body(null, 204);
      },
    }),
  );
}
