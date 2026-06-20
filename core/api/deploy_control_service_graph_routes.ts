/**
 * Service Graph v1 routes. These are supporting deploy-control internal seam
 * routes: runtime services are projected from Capsule Outputs and bound through
 * this record contract. Some route path parameters still use Installation names
 * while the deploy-control implementation migrates to Capsule terminology.
 */

import type {
  IssueServiceGrantInput,
  RecordServiceExportInput,
  RequestServiceBindingInput,
} from "../domains/service-graph/mod.ts";
import type {
  PublicServiceGrant,
  ServiceGrant,
} from "takosumi-contract/service-graph";
import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureSpacePermission,
  readJsonBody,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_INSTALLATION_SERVICE_BINDINGS_ROUTE,
  TAKOSUMI_SERVICE_BINDING_GRANTS_ROUTE,
  TAKOSUMI_SERVICE_BINDING_RESOLVE_ROUTE,
  TAKOSUMI_SPACE_SERVICE_EXPORTS_ROUTE,
} from "./deploy_control_route_paths.ts";

const SERVICE_BINDING_ID_PATTERN = /^sbind_[0-9a-zA-Z_:-]{4,128}$/;

type CreateServiceExportBody = Omit<RecordServiceExportInput, "workspaceId">;
type CreateServiceBindingBody = Omit<
  RequestServiceBindingInput,
  "workspaceId" | "consumerCapsuleId"
>;
type CreateServiceGrantBody = Omit<
  IssueServiceGrantInput,
  "bindingId" | "secretRef"
>;

export const DEPLOY_CONTROL_SERVICE_GRAPH_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_SPACE_SERVICE_EXPORTS_ROUTE,
      summary: "Records a ServiceExport for a producer Capsule.",
      auth: "deploy-control-token",
      operationId: "createServiceExport",
      openapi: {
        pathParams: ["spaceId"],
        requestSchema: "CreateServiceExportRequest",
        okStatus: "201",
        okSchema: "ServiceExportResponse",
      },
      notImplementedMessage: "service graph not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SPACE_SERVICE_EXPORTS_ROUTE,
      summary: "Lists ServiceExports in a Space.",
      auth: "deploy-control-token",
      operationId: "listServiceExports",
      openapi: {
        pathParams: ["spaceId"],
        okSchema: "ServiceExportsResponse",
      },
      notImplementedMessage: "service graph not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_INSTALLATION_SERVICE_BINDINGS_ROUTE,
      summary: "Creates a ServiceBinding request for the consumer Capsule.",
      auth: "deploy-control-token",
      operationId: "createServiceBinding",
      openapi: {
        pathParams: ["installationId"],
        requestSchema: "CreateServiceBindingRequest",
        okStatus: "201",
        okSchema: "ServiceBindingResponse",
      },
      notImplementedMessage: "service graph not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_INSTALLATION_SERVICE_BINDINGS_ROUTE,
      summary: "Lists ServiceBindings for a consumer Installation.",
      auth: "deploy-control-token",
      operationId: "listServiceBindings",
      openapi: {
        pathParams: ["installationId"],
        okSchema: "ServiceBindingsResponse",
      },
      notImplementedMessage: "service graph not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_SERVICE_BINDING_RESOLVE_ROUTE,
      summary: "Resolves a ServiceBinding to exactly one ready ServiceExport.",
      auth: "deploy-control-token",
      operationId: "resolveServiceBinding",
      openapi: {
        pathParams: ["serviceBindingId"],
        okSchema: "ServiceBindingResponse",
      },
      notImplementedMessage: "service graph not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_SERVICE_BINDING_GRANTS_ROUTE,
      summary: "Issues a ServiceGrant for a bound ServiceBinding.",
      auth: "deploy-control-token",
      operationId: "issueServiceGrant",
      openapi: {
        pathParams: ["serviceBindingId"],
        requestSchema: "CreateServiceGrantRequest",
        okStatus: "201",
        okSchema: "ServiceGrantResponse",
      },
      notImplementedMessage: "service graph not wired",
    },
  ];

export function mountDeployControlServiceGraphRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, controller, deployControlBodyLimit } = ctx;
  const serviceGraph = dependencies.serviceGraphService;
  const requireService = (deps: typeof dependencies): string | undefined =>
    deps.serviceGraphService ? undefined : "service graph not wired";

  app.post(
    TAKOSUMI_SPACE_SERVICE_EXPORTS_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService,
      param: { param: "spaceId", pattern: SPACE_ID_PATTERN },
      enforceBody: true,
      handler: async ({ c, principal, id: spaceId }) => {
        ensureSpacePermission(principal, spaceId);
        const body = await readJsonBody<CreateServiceExportBody>(
          c,
          "serviceExportCreate",
        );
        const producer = await controller.getInstallation(
          body.producerCapsuleId,
        );
        if (producer.installation.spaceId !== spaceId) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "producerCapsuleId must belong to the route Workspace",
          );
        }
        const serviceExport = await serviceGraph!.recordExport({
          ...body,
          workspaceId: spaceId,
        });
        return c.json({ serviceExport }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_SPACE_SERVICE_EXPORTS_ROUTE,
    defineRoute({
      ctx,
      requireService,
      param: { param: "spaceId", pattern: SPACE_ID_PATTERN },
      handler: async ({ c, principal, id: spaceId }) => {
        ensureSpacePermission(principal, spaceId);
        const serviceExports =
          await serviceGraph!.listExportsByWorkspace(spaceId);
        return c.json({ serviceExports }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_INSTALLATION_SERVICE_BINDINGS_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService,
      param: { id: "installationId" },
      enforceBody: true,
      handler: async ({ c, principal, id: installationId }) => {
        const consumer = await controller.getInstallation(installationId);
        ensureSpacePermission(principal, consumer.installation.spaceId);
        const body = await readJsonBody<CreateServiceBindingBody>(
          c,
          "serviceBindingCreate",
        );
        const serviceBinding = await serviceGraph!.requestBinding({
          ...body,
          workspaceId: consumer.installation.spaceId,
          consumerCapsuleId: installationId,
        });
        return c.json({ serviceBinding }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_INSTALLATION_SERVICE_BINDINGS_ROUTE,
    defineRoute({
      ctx,
      requireService,
      param: { id: "installationId" },
      handler: async ({ c, principal, id: installationId }) => {
        const consumer = await controller.getInstallation(installationId);
        ensureSpacePermission(principal, consumer.installation.spaceId);
        const serviceBindings =
          await serviceGraph!.listBindingsByConsumerCapsule(installationId);
        return c.json({ serviceBindings }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_SERVICE_BINDING_RESOLVE_ROUTE,
    defineRoute({
      ctx,
      requireService,
      param: { param: "serviceBindingId", pattern: SERVICE_BINDING_ID_PATTERN },
      handler: async ({ c, principal, id: serviceBindingId }) => {
        const binding = await loadBindingForSpaceCheck(ctx, serviceBindingId);
        ensureSpacePermission(principal, binding.workspaceId);
        const serviceBinding =
          await serviceGraph!.resolveBinding(serviceBindingId);
        return c.json({ serviceBinding }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_SERVICE_BINDING_GRANTS_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService,
      param: { param: "serviceBindingId", pattern: SERVICE_BINDING_ID_PATTERN },
      enforceBody: true,
      handler: async ({ c, principal, id: serviceBindingId }) => {
        const binding = await loadBindingForSpaceCheck(ctx, serviceBindingId);
        ensureSpacePermission(principal, binding.workspaceId);
        const body = await readJsonBody<CreateServiceGrantBody>(
          c,
          "serviceGrantCreate",
        );
        const serviceGrant = await serviceGraph!.issueGrant({
          ...body,
          bindingId: serviceBindingId,
        });
        return c.json({ serviceGrant: publicServiceGrant(serviceGrant) }, 201);
      },
    }),
  );
}

function publicServiceGrant(grant: ServiceGrant): PublicServiceGrant {
  const { secretRef: _secretRef, ...publicGrant } = grant;
  void _secretRef;
  return publicGrant;
}

async function loadBindingForSpaceCheck(
  ctx: DeployControlRouteContext,
  serviceBindingId: string,
) {
  const binding =
    await ctx.dependencies.serviceGraphService!.getBinding(serviceBindingId);
  if (!binding) {
    throw new OpenTofuControllerError(
      "not_found",
      `ServiceBinding ${serviceBindingId} not found`,
    );
  }
  return binding;
}
