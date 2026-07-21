/**
 * Dependency routes: create / list a Capsule's DAG edges and delete a
 * single edge. Owns its handlers and its slice of the internal descriptor
 * inventory.
 */

import type { CreateDependencyRequest } from "../domains/dependencies/mod.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureOperationPermission,
  ensureWorkspacePermission,
  readJsonBody,
  DEPENDENCY_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_DEPENDENCY_ROUTE,
  TAKOSUMI_CAPSULE_DEPENDENCIES_ROUTE,
} from "./deploy_control_route_paths.ts";

export const DEPLOY_CONTROL_DEPENDENCY_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_CAPSULE_DEPENDENCIES_ROUTE,
      summary:
        "Creates a Dependency edge whose consumer is this Capsule (variable_injection, remote_state, or published_output; cycles rejected).",
      auth: "deploy-control-token",
      operationId: "createDependency",
      openapi: {
        pathParams: ["capsuleId"],
        requestSchema: "CreateDependencyRequest",
        okStatus: "201",
        okSchema: "DependencyResponse",
      },
      notImplementedMessage: "dependencies not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_CAPSULE_DEPENDENCIES_ROUTE,
      summary:
        "Lists the Dependencies of a Capsule, split into asProducer / asConsumer views.",
      auth: "deploy-control-token",
      operationId: "listCapsuleDependencies",
      openapi: {
        pathParams: ["capsuleId"],
        okSchema: "CapsuleDependenciesResponse",
      },
      notImplementedMessage: "dependencies not wired",
    },
    {
      method: "DELETE",
      path: TAKOSUMI_DEPENDENCY_ROUTE,
      summary:
        "Deletes a Dependency edge (Workspace-permission gated via its consumer).",
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
    TAKOSUMI_CAPSULE_DEPENDENCIES_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireDependencies,
      param: { id: "capsuleId" },
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        // The consumer is the path Capsule; its Workspace gates the write.
        // A Dependency edge decides which producer Output is injected into the
        // consumer's next run, so it is an update to the consumer Capsule and
        // needs write authority, not just Workspace membership.
        const consumer = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, consumer.capsule.workspaceId);
        ensureOperationPermission(principal, "update");
        const body = await readJsonBody<
          Omit<
            CreateDependencyRequest,
            "workspaceId" | "consumerCapsuleId"
          >
        >(c, "dependencyCreate");
        const dependency = await dependenciesService!.createDependency({
          ...body,
          workspaceId: consumer.capsule.workspaceId,
          consumerCapsuleId: id,
        });
        return c.json({ dependency }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_CAPSULE_DEPENDENCIES_ROUTE,
    defineRoute({
      ctx,
      requireService: requireDependencies,
      param: { id: "capsuleId" },
      handler: async ({ c, principal, id }) => {
        const capsule = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, capsule.capsule.workspaceId);
        return c.json(await dependenciesService!.listForCapsule(id), 200);
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
        // Resolve the edge first so deletion is workspace-permission gated via
        // its consumer Capsule's Workspace (the edge carries workspaceId).
        const dependency = await dependenciesService!.getDependency(id);
        if (!dependency) {
          throw new OpenTofuControllerError(
            "not_found",
            `dependency ${id} not found`,
          );
        }
        ensureWorkspacePermission(principal, dependency.workspaceId);
        ensureOperationPermission(principal, "update");
        await dependenciesService!.deleteDependency(id);
        return c.body(null, 204);
      },
    }),
  );
}
