import { Hono, type Hono as HonoApp } from "hono";
import type {
  ActorContext,
  Deployment,
} from "takosumi-contract/reference/compat";
import type { AppContext } from "../app_context.ts";
import type { SourcePort, SourceSnapshot } from "../adapters/source/mod.ts";
import { InMemoryRuntimeAgentRegistry } from "../agents/registry.ts";
import { createSpaceDomainServices } from "../domains/space/mod.ts";
import type { ReferenceDeploySourcePayload } from "../domains/deploy/mod.ts";
import { assertRoleCapability, type TakosumiProcessRole } from "../process/mod.ts";
import { currentRuntime } from "../shared/runtime/index.ts";
import { createApiCapabilitiesDescription } from "./capabilities.ts";
import { registerApiErrorHandler } from "./errors.ts";
import {
  createTakosumiOpenApiDocument,
  type OpenApiDocument,
} from "./openapi.ts";
import {
  type InternalRouteServices,
  registerInternalRoutes,
} from "./internal_routes.ts";
import type {
  DeploymentEnvelope,
  DeploymentRouteApproveInput,
  DeploymentRouteCreateInput,
  DeploymentRouteGetInput,
  DeploymentRouteListInput,
  DeploymentRouteService,
  GroupRouteRefInput,
  GroupRouteRollbackInput,
} from "./deployment_route_types.ts";
import {
  type ReadinessRouteProbes,
  registerReadinessRoutes,
} from "./readiness_routes.ts";
import {
  registerRuntimeAgentRoutes,
  type RegisterRuntimeAgentRoutesOptions,
} from "./runtime_agent_routes.ts";
import {
  registerArtifactRoutes,
  type RegisterArtifactRoutesOptions,
} from "./artifact_routes.ts";
import {
  type InstallerPublicRouteDependencies,
  mountInstallerPublicRoutes,
} from "./installer_public_routes.ts";
import {
  registerMetricsRoutes,
  type RegisterMetricsRoutesOptions,
} from "./metrics_routes.ts";
import {
  registerRequestCorrelation,
  type RegisterRequestCorrelationOptions,
} from "./request_correlation.ts";
import { DefaultGroupSummaryStatusProjector } from "../services/status/mod.ts";

export interface CreateApiAppOptions {
  readonly role?: TakosumiProcessRole;
  readonly context?: AppContext;
  readonly internalRouteServices?: InternalRouteServices;
  readonly getInternalServiceSecret?: () => string | undefined;
  readonly registerInternalRoutes?: boolean;
  readonly registerOpenApiRoute?: boolean;
  readonly registerReadinessRoutes?: boolean;
  readonly readinessRouteProbes?: ReadinessRouteProbes;
  readonly createOpenApiDocument?: () =>
    | OpenApiDocument
    | Promise<OpenApiDocument>;
  readonly registerRuntimeAgentRoutes?: boolean;
  readonly runtimeAgentRouteOptions?: RegisterRuntimeAgentRoutesOptions;
  readonly registerArtifactRoutes?: boolean;
  readonly artifactRouteOptions?: RegisterArtifactRoutesOptions;
  /**
   * When set, mounts the v1 installer public surface (5 endpoints:
   * /v1/installations[/dry-run] + /v1/installations/{id}/deployments[/dry-run]
   * + /v1/installations/{id}/rollback).
   */
  readonly registerInstallerPublicRoutes?: boolean;
  readonly installerPublicRouteOptions?: InstallerPublicRouteDependencies;
  readonly registerMetricsRoutes?: boolean;
  readonly metricsRouteOptions?: RegisterMetricsRoutesOptions;
  /**
   * HTTP request/correlation id propagation is mounted by default. Pass
   * `false` only for low-level route tests that need to exercise raw Hono
   * behavior without service middleware.
   */
  readonly requestCorrelation?: RegisterRequestCorrelationOptions | false;
  readonly sourceAdapters?: DeploymentSourceAdapters;
  /** Optional extension point for mounting current/future route modules. */
  readonly configure?: (app: HonoApp) => void | Promise<void>;
}

export interface DeploymentSourceAdapters {
  readonly snapshot?: SourcePort<unknown>;
}

type InternalRouteServiceBase = Omit<InternalRouteServices, "deployments">;

export async function createApiApp(
  options: CreateApiAppOptions = {},
): Promise<HonoApp> {
  const role = options.role ?? "takosumi-api";
  assertRoleCapability(role, "api.health.read");
  assertRoleCapability(role, "api.capabilities.read");

  const app: HonoApp = new Hono();
  registerApiErrorHandler(app);
  if (options.requestCorrelation !== false) {
    registerRequestCorrelation(app, options.requestCorrelation ?? {});
  }
  const defaultRouteServices = createDefaultRouteServices(options);

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "takosumi",
      domains: ["space", "deploy"],
    });
  });

  const internalRoutesMounted = options.registerInternalRoutes ??
    role === "takosumi-api";
  const runtimeAgentRoutesMounted = options.registerRuntimeAgentRoutes ??
    role === "takosumi-runtime-agent";
  const openApiRouteMounted = options.registerOpenApiRoute ??
    role === "takosumi-api";
  const readinessRoutesMounted = options.registerReadinessRoutes ?? false;
  const artifactRoutesMounted = options.registerArtifactRoutes ??
    (role === "takosumi-api" && options.artifactRouteOptions !== undefined);
  const installerPublicRoutesMounted = options.registerInstallerPublicRoutes ??
    (role === "takosumi-api");
  const metricsRoutesMounted = options.registerMetricsRoutes ??
    (role === "takosumi-api" && options.metricsRouteOptions !== undefined);

  if (internalRoutesMounted) assertRoleCapability(role, "api.internal.host");
  if (runtimeAgentRoutesMounted) {
    assertRoleCapability(role, "runtime.agent.lease");
    assertRoleCapability(role, "runtime.agent.observe");
  }

  app.get("/capabilities", (c) => {
    return c.json(createApiCapabilitiesDescription(role, {
      internalRoutesMounted,
      installerPublicRoutesMounted,
      artifactRoutesMounted,
      runtimeAgentRoutesMounted,
      openApiRouteMounted,
      readinessRoutesMounted,
      metricsRoutesMounted,
    }));
  });

  if (internalRoutesMounted) {
    registerInternalRoutes(app, {
      services: options.internalRouteServices ??
        (await defaultRouteServices).internal,
      getInternalServiceSecret: options.getInternalServiceSecret,
    });
  }

  if (runtimeAgentRoutesMounted) {
    registerRuntimeAgentRoutes(app, createRuntimeAgentRouteOptions(options));
  }

  if (artifactRoutesMounted) {
    if (!options.artifactRouteOptions) {
      throw new Error(
        "registerArtifactRoutes was requested but artifactRouteOptions " +
          "(with objectStorage) was not supplied",
      );
    }
    registerArtifactRoutes(app, options.artifactRouteOptions);
  }

  if (installerPublicRoutesMounted) {
    mountInstallerPublicRoutes(
      app,
      options.installerPublicRouteOptions ?? {},
    );
  }

  if (metricsRoutesMounted) {
    if (!options.metricsRouteOptions) {
      throw new Error(
        "registerMetricsRoutes was requested but metricsRouteOptions " +
          "(with observability) was not supplied",
      );
    }
    registerMetricsRoutes(app, options.metricsRouteOptions);
  }

  if (readinessRoutesMounted) {
    registerReadinessRoutes(app, {
      probes: options.readinessRouteProbes ?? createDefaultReadinessProbes(),
    });
  }

  if (openApiRouteMounted) {
    const createOpenApiDocument = options.createOpenApiDocument ??
      (() =>
        createTakosumiOpenApiDocument({
          internalRoutesMounted,
          installerPublicRoutesMounted,
          artifactRoutesMounted,
          runtimeAgentRoutesMounted,
          readinessRoutesMounted,
          metricsRoutesMounted,
          openApiRouteMounted,
        }));
    app.get(
      "/openapi.json",
      async (c) => c.json(await createOpenApiDocument()),
    );
  }

  await options.configure?.(app);

  return app;
}

async function createDefaultRouteServices(
  options: CreateApiAppOptions,
): Promise<{
  readonly internal: InternalRouteServices;
}> {
  const context = options.context;
  if (context) {
    const internal: InternalRouteServiceBase = {
      space: context.services.space,
      planService: {
        createPlan: (input) =>
          context.services.deploy.plans.createPlan({
            spaceId: input.spaceId,
            manifest: input.manifest as ReferenceDeploySourcePayload,
            input: input.input,
          }),
      },
      applyService: {
        applySourcePayload: (input) =>
          context.services.deploy.apply.applySourcePayload({
            spaceId: input.spaceId,
            manifest: input.manifest as ReferenceDeploySourcePayload,
            input: input.input,
            createdBy: input.createdBy,
            actor: input.actor as ActorContext,
          }),
      },
      entitlements: context.services.entitlements.policy,
    };
    const sourceAdapters = options.sourceAdapters ??
      createDefaultSourceAdapters(options);
    const internalWithDeployments: InternalRouteServices = {
      ...internal,
      deployments: createDefaultDeploymentService(
        internal,
        context.stores.deploy.deploys,
        sourceAdapters,
      ),
    };
    return {
      internal: internalWithDeployments,
    };
  }
  const space = createSpaceDomainServices();
  const deployModule = await import("../domains/deploy/" + "mod.ts");
  const deployStore = new deployModule.InMemoryDeploymentStore();
  const planService = new deployModule.PlanService({ store: deployStore });
  const applyService = new deployModule.ApplyService({ store: deployStore });
  const internal: InternalRouteServiceBase = {
    space,
    planService,
    applyService,
  };
  const sourceAdapters = options.sourceAdapters ??
    createDefaultSourceAdapters(options);
  const internalWithDeployments: InternalRouteServices = {
    ...internal,
    deployments: createDefaultDeploymentService(
      internal,
      deployStore,
      sourceAdapters,
    ),
  };
  return {
    internal: internalWithDeployments,
  };
}

function createDefaultDeploymentService(
  services: Pick<InternalRouteServices, "applyService" | "planService">,
  deployStore?: import("../domains/deploy/mod.ts").DeploymentStore,
  sourceAdapters: DeploymentSourceAdapters = {},
): DeploymentRouteService {
  const sourcePayloadFrom = (
    input: DeploymentRouteCreateInput,
  ): ReferenceDeploySourcePayload => {
    if (isReferenceDeploySourcePayload(input.manifest)) return input.manifest;
    return {
      name: input.group ?? "default",
      version: "0.0.0",
    };
  };

  const envelopeOf = (deployment: Deployment): DeploymentEnvelope => ({
    deployment,
    expansion_summary: {
      components: deployment.desired.activation_envelope ? 1 : 0,
      bindings: deployment.desired.bindings.length,
      routes: deployment.desired.routes.length,
      resources: deployment.desired.resources.length,
    },
  });

  const getDeployment = async (input: DeploymentRouteGetInput) => {
    if (services.planService.getDeployment) {
      return deploymentVisibleToActor(
        await services.planService.getDeployment(input.deploymentId),
        input.actor,
      );
    }
    const deployments = (await services.planService.listDeployments?.({}) ?? [])
      .map(asDeploymentOrNull)
      .filter((deployment): deployment is Deployment => Boolean(deployment));
    return deploymentVisibleToActor(
      deployments.find((deployment) => deployment.id === input.deploymentId),
      input.actor,
    );
  };

  return {
    async resolveDeployment(input: DeploymentRouteCreateInput) {
      const source = await snapshotPublicDeploySource(input, sourceAdapters);
      const sourcePayload = source?.source ?? sourcePayloadFrom(input);
      const deployment = await services.planService.createPlan({
        spaceId: input.space_id ?? input.actor.spaceId ?? "default",
        manifest: sourcePayload,
        env: input.env,
        input: undefined,
      });
      return envelopeOf(asDeployment(deployment));
    },
    async applyDeployment(input: DeploymentRouteCreateInput) {
      const source = await snapshotPublicDeploySource(input, sourceAdapters);
      const sourcePayload = source?.source ?? sourcePayloadFrom(input);
      const result = await services.applyService.applySourcePayload({
        spaceId: input.space_id ?? input.actor.spaceId ?? "default",
        manifest: sourcePayload,
        input: undefined,
        createdBy: input.actor.actorAccountId,
        actor: input.actor,
      });
      return envelopeOf(asApplyResult(result).deployment);
    },
    async applyResolved(input: DeploymentRouteGetInput) {
      if (!services.applyService.applyDeployment) {
        throw new Error("applyDeployment is not wired");
      }
      const deployment = await getDeployment(input);
      if (!deployment) {
        throw new Error(`unknown deployment: ${input.deploymentId}`);
      }
      const result = await services.applyService.applyDeployment({
        deploymentId: input.deploymentId,
      });
      return envelopeOf(asApplyResult(result).deployment);
    },
    async approveDeployment(input: DeploymentRouteApproveInput) {
      const deployment = await getDeployment(input);
      if (!deployment) {
        throw new Error(`unknown deployment: ${input.deploymentId}`);
      }
      const approval = {
        approved_by: input.actor.actorAccountId,
        approved_at: new Date().toISOString(),
        policy_decision_id: input.policy_decision_id ??
          deployment.policy_decisions?.find((decision) =>
            decision.decision === "require-approval"
          )?.id ??
          "internal-api",
      };
      const approved: Deployment = { ...deployment, approval };
      return envelopeOf(await deployStore?.putDeployment(approved) ?? approved);
    },
    async rollbackGroup(input: GroupRouteRollbackInput) {
      const targetDeploymentId = input.target_id;
      if (!targetDeploymentId) {
        throw new Error("target_id is required for rollback");
      }
      if (!services.applyService.rollbackToDeployment) {
        throw new Error("rollbackToDeployment is not wired");
      }
      const result = await services.applyService.rollbackToDeployment({
        spaceId: input.space_id ?? input.actor.spaceId ?? "default",
        groupId: input.groupId,
        targetDeploymentId,
        reason: "internal API rollback",
      });
      return envelopeOf(asApplyResult(result).deployment);
    },
    getDeployment,
    listDeployments(input: DeploymentRouteListInput) {
      const listed = services.planService.listDeployments?.({
        spaceId: input.space_id ?? input.actor.spaceId,
        groupId: input.group,
        status: input.status,
      }) ?? [];
      return Promise.resolve(listed).then((deployments) =>
        deployments
          .map(asDeploymentOrNull)
          .filter((deployment): deployment is Deployment => Boolean(deployment))
      );
    },
    async getGroupHead(input: GroupRouteRefInput) {
      return await deployStore?.getGroupHead({
        spaceId: input.space_id ?? input.actor.spaceId ?? "default",
        groupId: input.groupId,
      }) ?? null;
    },
    listObservations(input: DeploymentRouteGetInput) {
      return deployStore?.listObservations?.({
        deploymentId: input.deploymentId,
      }) ?? [];
    },
  };
}

async function snapshotPublicDeploySource(
  input: DeploymentRouteCreateInput,
  adapters: DeploymentSourceAdapters,
): Promise<SourceSnapshot | undefined> {
  if (input.source === undefined || input.source === null) return undefined;
  if (!isRecord(input.source)) {
    throw new Error("source must be an object");
  }
  if (!adapters.snapshot) {
    throw new Error(
      `no source adapter configured for kind: ${
        String((input.source as { kind?: unknown }).kind ?? "unknown")
      }`,
    );
  }
  return await adapters.snapshot.snapshot({
    actor: input.actor,
    ...(input.source as Record<string, unknown>),
  });
}

function deploymentVisibleToActor(
  value: unknown,
  actor: ActorContext,
): Deployment | null {
  const deployment = asDeploymentOrNull(value);
  if (!deployment) return null;
  if (actor.spaceId && deployment.space_id !== actor.spaceId) return null;
  return deployment;
}

function isReferenceDeploySourcePayload(value: unknown): value is ReferenceDeploySourcePayload {
  return isRecord(value) && typeof value.name === "string" &&
    value.name.trim().length > 0;
}

function asDeployment(value: unknown): Deployment {
  const deployment = asDeploymentOrNull(value);
  if (!deployment) {
    throw new Error("deployment service returned invalid deployment");
  }
  return deployment;
}

function asDeploymentOrNull(value: unknown): Deployment | null {
  if (!isDeployment(value)) return null;
  return value;
}

function isDeployment(value: unknown): value is Deployment {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (
    typeof value.group_id !== "string" || typeof value.space_id !== "string"
  ) {
    return false;
  }
  return isRecord(value.input) && isRecord(value.resolution) &&
    isRecord(value.desired) && typeof value.status === "string" &&
    Array.isArray(value.conditions) && typeof value.created_at === "string";
}

function asApplyResult(
  value: unknown,
): { readonly deployment: Deployment } {
  if (isRecord(value) && isRecord(value.deployment)) {
    return { deployment: asDeployment(value.deployment) };
  }
  return { deployment: asDeployment(value) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDefaultSourceAdapters(
  _options: CreateApiAppOptions,
): DeploymentSourceAdapters {
  return {};
}

function createRuntimeAgentRouteOptions(
  options: CreateApiAppOptions,
): RegisterRuntimeAgentRoutesOptions {
  if (options.runtimeAgentRouteOptions) {
    return {
      getInternalServiceSecret: options.getInternalServiceSecret ??
        defaultInternalServiceSecret,
      ...options.runtimeAgentRouteOptions,
    };
  }
  return {
    registry: options.context?.adapters.runtimeAgent ??
      new InMemoryRuntimeAgentRegistry(),
    getInternalServiceSecret: options.getInternalServiceSecret ??
      defaultInternalServiceSecret,
  };
}

function defaultInternalServiceSecret(): string | undefined {
  return currentRuntime().env.get("TAKOSUMI_INTERNAL_API_SECRET");
}

function createDefaultReadinessProbes(): ReadinessRouteProbes {
  const projector = new DefaultGroupSummaryStatusProjector();
  return {
    ready: () => ({
      ok: true,
      service: "takosumi",
      checkedAt: new Date().toISOString(),
    }),
    live: () => ({
      ok: true,
      service: "takosumi",
      checkedAt: new Date().toISOString(),
    }),
    statusSummary: () =>
      projector.project({
        spaceId: "system",
        groupId: "takosumi",
      }),
  };
}
