import { Hono, type Hono as HonoApp } from "hono";
import type { ActorContext, Deployment } from "takosumi-contract";
import type { AppContext } from "../app_context.ts";
import type { AuthPort } from "../adapters/auth/mod.ts";
import { LocalActorAdapter } from "../adapters/auth/local.ts";
import type { SourcePort, SourceSnapshot } from "../adapters/source/mod.ts";
import { InMemoryRuntimeAgentRegistry } from "../agents/registry.ts";
import { createCoreDomainServices } from "../domains/core/mod.ts";
import type { PublicDeployManifest } from "../domains/deploy/mod.ts";
import { assertRoleCapability, type PaaSProcessRole } from "../process/mod.ts";
import { createApiCapabilitiesDescription } from "./capabilities.ts";
import {
  registerAgentControlRoutes,
  type RegisterAgentControlRoutesOptions,
} from "./agent_control_routes.ts";
import { registerApiErrorHandler } from "./errors.ts";
import { createPaaSOpenApiDocument, type OpenApiDocument } from "./openapi.ts";
import {
  type InternalRouteServices,
  registerInternalRoutes,
} from "./internal_routes.ts";
import {
  type DeploymentEnvelope,
  type DeploymentMutationResponse,
  type DeploymentService,
  type PublicDeploymentApproveInput,
  type PublicDeploymentCreateInput,
  type PublicDeploymentGetInput,
  type PublicDeploymentListInput,
  type PublicGroupRefInput,
  type PublicGroupRollbackInput,
  type PublicRouteServices,
  registerPublicRoutes,
} from "./public_routes.ts";
import {
  type ReadinessRouteProbes,
  registerReadinessRoutes,
} from "./readiness_routes.ts";
import {
  registerRuntimeAgentRoutes,
  type RegisterRuntimeAgentRoutesOptions,
} from "./runtime_agent_routes.ts";
import { DefaultGroupSummaryStatusProjector } from "../services/status/mod.ts";
import { permissionDenied } from "../shared/errors.ts";

export interface CreateApiAppOptions {
  readonly role?: PaaSProcessRole;
  readonly context?: AppContext;
  readonly internalRouteServices?: InternalRouteServices;
  readonly publicRouteServices?: PublicRouteServices;
  readonly getInternalServiceSecret?: () => string | undefined;
  readonly registerInternalRoutes?: boolean;
  readonly registerAgentControlRoutes?: boolean;
  readonly agentControlRouteOptions?: RegisterAgentControlRoutesOptions;
  readonly registerPublicRoutes?: boolean;
  readonly registerOpenApiRoute?: boolean;
  readonly registerReadinessRoutes?: boolean;
  readonly readinessRouteProbes?: ReadinessRouteProbes;
  readonly createOpenApiDocument?: () =>
    | OpenApiDocument
    | Promise<OpenApiDocument>;
  readonly registerRuntimeAgentRoutes?: boolean;
  readonly runtimeAgentRouteOptions?: RegisterRuntimeAgentRoutesOptions;
  readonly sourceAdapters?: PublicDeploySourceAdapters;
  /** Optional extension point for mounting current/future route modules. */
  readonly configure?: (app: HonoApp) => void | Promise<void>;
}

export interface PublicDeploySourceAdapters {
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
  const defaultRouteServices = createDefaultRouteServices(options);

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "takosumi",
      domains: ["core", "deploy"],
    });
  });

  const internalRoutesMounted = options.registerInternalRoutes ??
    role === "takosumi-api";
  const agentControlRoutesMounted = options.registerAgentControlRoutes ??
    internalRoutesMounted;
  const publicRoutesMounted = options.registerPublicRoutes ?? false;
  const runtimeAgentRoutesMounted = options.registerRuntimeAgentRoutes ??
    role === "takosumi-runtime-agent";
  const openApiRouteMounted = options.registerOpenApiRoute ??
    role === "takosumi-api";
  const readinessRoutesMounted = options.registerReadinessRoutes ?? false;

  if (internalRoutesMounted) assertRoleCapability(role, "api.internal.host");
  if (agentControlRoutesMounted) {
    assertRoleCapability(role, "api.internal.host");
  }
  if (publicRoutesMounted) assertRoleCapability(role, "api.public.host");
  if (runtimeAgentRoutesMounted) {
    assertRoleCapability(role, "runtime.agent.lease");
    assertRoleCapability(role, "runtime.agent.observe");
  }

  app.get("/capabilities", (c) => {
    return c.json(createApiCapabilitiesDescription(role, {
      internalRoutesMounted,
      agentControlRoutesMounted,
      publicRoutesMounted,
      runtimeAgentRoutesMounted,
      openApiRouteMounted,
      readinessRoutesMounted,
    }));
  });

  if (internalRoutesMounted) {
    registerInternalRoutes(app, {
      services: options.internalRouteServices ??
        (await defaultRouteServices).internal,
      getInternalServiceSecret: options.getInternalServiceSecret,
    });
  }

  if (agentControlRoutesMounted) {
    registerAgentControlRoutes(app, {
      getInternalServiceSecret: options.getInternalServiceSecret,
      ...options.agentControlRouteOptions,
    });
  }

  if (publicRoutesMounted) {
    registerPublicRoutes(app, {
      services: options.publicRouteServices ??
        (await defaultRouteServices).public,
    });
  }

  if (runtimeAgentRoutesMounted) {
    registerRuntimeAgentRoutes(app, createRuntimeAgentRouteOptions(options));
  }

  if (readinessRoutesMounted) {
    registerReadinessRoutes(app, {
      probes: options.readinessRouteProbes ?? createDefaultReadinessProbes(),
    });
  }

  if (openApiRouteMounted) {
    const createOpenApiDocument = options.createOpenApiDocument ??
      (() =>
        createPaaSOpenApiDocument({
          internalRoutesMounted,
          agentControlRoutesMounted,
          publicRoutesMounted,
          runtimeAgentRoutesMounted,
          readinessRoutesMounted,
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
  readonly public: PublicRouteServices;
}> {
  const context = options.context;
  if (context) {
    const internal: InternalRouteServiceBase = {
      core: context.services.core,
      planService: {
        createPlan: (input) =>
          context.services.deploy.plans.createPlan({
            spaceId: input.spaceId,
            manifest: input.manifest as PublicDeployManifest,
            input: input.input,
          }),
      },
      applyService: {
        applyManifest: (input) =>
          context.services.deploy.apply.applyManifest({
            spaceId: input.spaceId,
            manifest: input.manifest as PublicDeployManifest,
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
      public: createDefaultPublicRouteServices(
        internalWithDeployments,
        context.adapters.auth,
        context.stores.deploy.deploys,
        sourceAdapters,
      ),
    };
  }
  const core = createCoreDomainServices();
  const deployModule = await import("../domains/deploy/" + "mod.ts");
  const deployStore = new deployModule.InMemoryDeploymentStore();
  const planService = new deployModule.PlanService({ store: deployStore });
  const applyService = new deployModule.ApplyService({ store: deployStore });
  const internal: InternalRouteServiceBase = {
    core,
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
    public: createDefaultPublicRouteServices(
      internalWithDeployments,
      undefined,
      deployStore,
      sourceAdapters,
    ),
  };
}

function createDefaultPublicRouteServices(
  services: InternalRouteServices,
  auth: AuthPort = new LocalActorAdapter(),
  deployStore?: import("../domains/deploy/mod.ts").DeploymentStore,
  sourceAdapters: PublicDeploySourceAdapters = {},
): PublicRouteServices {
  return {
    authenticate: (request) => auth.authenticate(request),
    spaces: {
      async list(input) {
        const spaces = await services.core.spaceQueries.listSpaces(input);
        const visible = [];
        for (const space of spaces) {
          if (await actorCanAccessSpace(services, input.actor, space.id)) {
            visible.push(space);
          }
        }
        return visible;
      },
      async create(input) {
        const requestedSpaceId = input.slug ?? input.actor.spaceId;
        if (
          input.actor.spaceId && requestedSpaceId &&
          input.actor.spaceId !== requestedSpaceId
        ) {
          throw permissionDenied("actor cannot access requested space");
        }
        const result = await services.core.spaces.createSpace({
          actor: input.actor,
          spaceId: requestedSpaceId,
          name: input.name,
          metadata: input.metadata,
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      },
    },
    groups: {
      async list(input) {
        if (!input.spaceId) return [];
        if (!await actorCanAccessSpace(services, input.actor, input.spaceId)) {
          return [];
        }
        return services.core.groupQueries.listGroups({
          actor: input.actor,
          spaceId: input.spaceId,
        });
      },
      async create(input) {
        if (!await actorCanAccessSpace(services, input.actor, input.spaceId)) {
          throw permissionDenied("actor cannot access requested space");
        }
        const result = await services.core.groups.createGroup({
          actor: input.actor,
          spaceId: input.spaceId,
          slug: input.envName ?? input.name ?? "default",
          displayName: input.name ?? input.envName,
          metadata: input.metadata,
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      },
    },
    deployments: createDefaultDeploymentService(
      services,
      deployStore,
      sourceAdapters,
    ),
  };
}

function createDefaultDeploymentService(
  services: Pick<InternalRouteServices, "applyService" | "planService">,
  deployStore?: import("../domains/deploy/mod.ts").DeploymentStore,
  sourceAdapters: PublicDeploySourceAdapters = {},
): DeploymentService {
  const manifestFrom = (
    input: PublicDeploymentCreateInput,
  ): PublicDeployManifest => {
    if (isPublicDeployManifest(input.manifest)) return input.manifest;
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

  const getDeployment = async (input: PublicDeploymentGetInput) => {
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
    async resolveDeployment(input: PublicDeploymentCreateInput) {
      const source = await snapshotPublicDeploySource(input, sourceAdapters);
      const manifest = source?.manifest ?? manifestFrom(input);
      const deployment = await services.planService.createPlan({
        spaceId: input.space_id ?? input.actor.spaceId ?? "default",
        manifest,
        env: input.env,
        input: undefined,
      });
      return envelopeOf(asDeployment(deployment));
    },
    async applyDeployment(input: PublicDeploymentCreateInput) {
      const source = await snapshotPublicDeploySource(input, sourceAdapters);
      const manifest = source?.manifest ?? manifestFrom(input);
      const result = await services.applyService.applyManifest({
        spaceId: input.space_id ?? input.actor.spaceId ?? "default",
        manifest,
        input: undefined,
        createdBy: input.actor.actorAccountId,
        actor: input.actor,
      });
      return envelopeOf(asApplyResult(result).deployment);
    },
    previewDeployment(
      input: PublicDeploymentCreateInput,
    ): DeploymentMutationResponse {
      return {
        deployment_id: `preview:${input.group ?? "default"}`,
        status: "preview",
        conditions: [],
        expansion_summary: {
          components:
            isRecord(input.manifest) && isRecord(input.manifest.compute)
              ? Object.keys(input.manifest.compute).length
              : undefined,
          resources:
            isRecord(input.manifest) && isRecord(input.manifest.resources)
              ? Object.keys(input.manifest.resources).length
              : undefined,
        },
      };
    },
    async applyResolved(input: PublicDeploymentGetInput) {
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
    async approveDeployment(input: PublicDeploymentApproveInput) {
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
          "public-api",
      };
      const approved: Deployment = { ...deployment, approval };
      return envelopeOf(await deployStore?.putDeployment(approved) ?? approved);
    },
    async rollbackGroup(input: PublicGroupRollbackInput) {
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
        reason: "public API rollback",
      });
      return envelopeOf(asApplyResult(result).deployment);
    },
    getDeployment,
    listDeployments(input: PublicDeploymentListInput) {
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
    async getGroupHead(input: PublicGroupRefInput) {
      return await deployStore?.getGroupHead({
        spaceId: input.space_id ?? input.actor.spaceId ?? "default",
        groupId: input.groupId,
      }) ?? null;
    },
    listObservations(input: PublicDeploymentGetInput) {
      return deployStore?.listObservations?.({
        deploymentId: input.deploymentId,
      }) ?? [];
    },
  };
}

async function snapshotPublicDeploySource(
  input: PublicDeploymentCreateInput,
  adapters: PublicDeploySourceAdapters,
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

async function actorCanAccessSpace(
  services: InternalRouteServices,
  actor: ActorContext,
  spaceId: string,
): Promise<boolean> {
  if (actor.spaceId && actor.spaceId !== spaceId) return false;
  const memberships = await services.core.memberships.listSpaceMemberships(
    spaceId,
  );
  return memberships.some((membership) =>
    membership.accountId === actor.actorAccountId &&
    membership.status === "active"
  );
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

function isPublicDeployManifest(value: unknown): value is PublicDeployManifest {
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

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`source.${field} is required`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function createDefaultSourceAdapters(
  _options: CreateApiAppOptions,
): PublicDeploySourceAdapters {
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
  return Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
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
