import assert from "node:assert/strict";
import {
  type Deployment,
  TAKOS_PAAS_INTERNAL_PATHS,
  type TakosActorContext,
} from "takosumi-contract";
import { signTakosInternalRequest } from "takosumi-contract/internal-rpc";
import {
  type DeploymentService,
  TAKOS_PAAS_PUBLIC_PATHS,
} from "./public_routes.ts";
import { TAKOS_PAAS_READINESS_PATHS } from "./readiness_routes.ts";
import { createApiApp } from "./app.ts";
import {
  createCoreDomainServices,
  createInMemoryCoreDomainDependencies,
} from "../domains/core/mod.ts";
import {
  InMemoryRuntimeNetworkPolicyStore,
  InMemoryServiceGrantStore,
  InMemoryWorkloadIdentityStore,
} from "../domains/network/mod.ts";
import { EntitlementPolicyService } from "../services/entitlements/mod.ts";
import { WorkerAuthzService } from "../services/security/mod.ts";

Deno.test("createApiApp exposes base capabilities without public routes by default", async () => {
  const app = await createApiApp({ registerInternalRoutes: false });

  const capabilities = await app.request("/capabilities");
  assert.equal(capabilities.status, 200);
  const body = await capabilities.json();
  assert.equal(body.service, "takosumi");

  const publicCapabilities = await app.request(
    TAKOS_PAAS_PUBLIC_PATHS.capabilities,
  );
  assert.equal(publicCapabilities.status, 404);
});

Deno.test("createApiApp mounts readiness routes and reports them in route inventory", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerReadinessRoutes: true,
    registerOpenApiRoute: true,
  });

  const ready = await app.request(TAKOS_PAAS_READINESS_PATHS.ready);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).ok, true);

  const capabilities = await app.request("/capabilities");
  const capabilitiesBody = await capabilities.json();
  assert.ok(
    capabilitiesBody.endpoints.some((
      endpoint: { path: string; method: string },
    ) =>
      endpoint.method === "GET" &&
      endpoint.path === TAKOS_PAAS_READINESS_PATHS.ready
    ),
  );

  const openapi = await app.request("/openapi.json");
  const openapiBody = await openapi.json();
  assert.ok(openapiBody.paths[TAKOS_PAAS_READINESS_PATHS.ready]?.get);
});

Deno.test("createApiApp optionally mounts public routes with standalone defaults", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerPublicRoutes: true,
  });

  const capabilities = await app.request(TAKOS_PAAS_PUBLIC_PATHS.capabilities);
  assert.equal(capabilities.status, 200);
  const capabilitiesBody = await capabilities.json();
  assert.equal(capabilitiesBody.capabilities.audience, "public-api");

  const createSpace = await app.request(TAKOS_PAAS_PUBLIC_PATHS.spaces, {
    method: "POST",
    body: JSON.stringify({ slug: "space_dev", name: "Standalone Dev" }),
  });
  assert.equal(createSpace.status, 201);
  const createSpaceBody = await createSpace.json();
  assert.equal(createSpaceBody.space.id, "space_dev");

  const listSpaces = await app.request(TAKOS_PAAS_PUBLIC_PATHS.spaces);
  assert.equal(listSpaces.status, 200);
  const listSpacesBody = await listSpaces.json();
  assert.ok(
    listSpacesBody.spaces.some((space: { id: string }) =>
      space.id === "space_dev"
    ),
  );
});

Deno.test("createApiApp standalone public approve persists Deployment.approval", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerPublicRoutes: true,
  });
  const manifest = {
    name: "approval-app",
    compute: {
      web: {
        type: "container",
        image:
          "registry.example.test/approval@sha256:1111111111111111111111111111111111111111111111111111111111111111",
        port: 8080,
      },
    },
  };

  const resolve = await app.request(TAKOS_PAAS_PUBLIC_PATHS.deployments, {
    method: "POST",
    body: JSON.stringify({ mode: "resolve", manifest }),
  });
  assert.equal(resolve.status, 201);
  const resolvedBody = await resolve.json();

  const approvePath = TAKOS_PAAS_PUBLIC_PATHS.deploymentApprove.replace(
    ":deploymentId",
    resolvedBody.deployment_id,
  );
  const approve = await app.request(approvePath, {
    method: "POST",
    body: JSON.stringify({ policy_decision_id: "policy_public_1" }),
  });
  assert.equal(approve.status, 200);

  const get = await app.request(
    TAKOS_PAAS_PUBLIC_PATHS.deployment.replace(
      ":deploymentId",
      resolvedBody.deployment_id,
    ),
  );
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.equal(getBody.deployment.approval.approved_by, "local-operator");
  assert.equal(
    getBody.deployment.approval.policy_decision_id,
    "policy_public_1",
  );
});

Deno.test("createApiApp mounts signed internal routes and leaves old aliases unmounted", async () => {
  const secret = "route-secret";
  const app = await createApiApp({
    getInternalServiceSecret: () => secret,
  });
  const body = JSON.stringify({
    spaceId: "space_internal_v1",
    name: "Internal V1",
  });

  const created = await app.request(TAKOS_PAAS_INTERNAL_PATHS.spaces, {
    method: "POST",
    headers: await signedHeaders({
      secret,
      method: "POST",
      path: TAKOS_PAAS_INTERNAL_PATHS.spaces,
      body,
      actor: {
        actorAccountId: "acct_owner",
        roles: ["owner"],
        requestId: "req_internal_v1",
        principalKind: "service",
        serviceId: "svc_internal",
      },
    }),
    body,
  });

  assert.equal(created.status, 201);
  assert.equal((await created.json()).space.id, "space_internal_v1");

  const removedInternalSpaces = await app.request("/internal/spaces", {
    method: "POST",
    headers: await signedHeaders({
      secret,
      method: "POST",
      path: "/internal/spaces",
      body,
      actor: {
        actorAccountId: "acct_owner",
        roles: ["owner"],
        requestId: "req_internal_removed",
        principalKind: "service",
        serviceId: "svc_internal",
      },
    }),
    body,
  });
  assert.equal(removedInternalSpaces.status, 404);

  const internalDeployments = await app.request(
    TAKOS_PAAS_INTERNAL_PATHS.deployments,
    { method: "POST" },
  );
  assert.equal(internalDeployments.status, 401);

  const internalDeploymentApply = await app.request(
    TAKOS_PAAS_INTERNAL_PATHS.deploymentApply.replace(
      ":deploymentId",
      "dep_route",
    ),
    { method: "POST" },
  );
  assert.equal(internalDeploymentApply.status, 401);

  const removedDeploymentPlanningRoute = await app.request(
    "/api/internal/v1/deploy/plans",
    { method: "POST" },
  );
  assert.equal(removedDeploymentPlanningRoute.status, 404);

  const removedDeployApply = await app.request(
    "/api/internal/v1/deploy/applies",
    { method: "POST" },
  );
  assert.equal(removedDeployApply.status, 404);
});

Deno.test("createApiApp does not mount internal routes for non-api roles by default", async () => {
  const app = await createApiApp({ role: "takosumi-worker" });

  const internal = await app.request(TAKOS_PAAS_INTERNAL_PATHS.spaces);
  assert.equal(internal.status, 404);

  const capabilities = await app.request("/capabilities");
  const body = await capabilities.json();
  assert.equal(
    body.endpoints.some((
      endpoint: { path: string },
    ) => endpoint.path === TAKOS_PAAS_INTERNAL_PATHS.spaces),
    false,
  );
});

Deno.test("createApiApp rejects internal route mounting for non-api roles", async () => {
  await assert.rejects(
    () =>
      createApiApp({
        role: "takosumi-worker",
        registerInternalRoutes: true,
      }),
    /PaaS process role takosumi-worker does not provide api\.internal\.host/,
  );
});


Deno.test("internal deploy routes enforce workload service grants when security is wired", async () => {
  const secret = "route-secret";
  const dependencies = createInMemoryCoreDomainDependencies();
  const securityStores = {
    workloadIdentities: new InMemoryWorkloadIdentityStore(),
    serviceGrants: new InMemoryServiceGrantStore(),
    runtimeNetworkPolicies: new InMemoryRuntimeNetworkPolicyStore(),
  };
  await securityStores.workloadIdentities.put({
    id: "wi_deployer",
    spaceId: "space_route",
    groupId: "app",
    componentName: "deployer",
    subject: "service:deployer",
    claims: { aud: "takosumi" },
    issuedAt: "2026-04-27T00:00:00.000Z",
  });
  const app = await createApiApp({
    getInternalServiceSecret: () => secret,
    internalRouteServices: {
      core: createCoreDomainServices(dependencies),
      deployments: stubDeploymentService({
        resolveDeployment: () => {
          throw new Error("unexpected deployment resolve");
        },
      }),
      planService: { createPlan: () => Promise.resolve({ id: "plan_1" }) },
      applyService: {
        applyManifest: () => Promise.resolve({ id: "apply_1" }),
      },
      security: new WorkerAuthzService({
        stores: securityStores,
        clock: () => new Date("2026-04-27T00:00:00.000Z"),
      }),
    },
  });
  const body = JSON.stringify({
    spaceId: "space_route",
    manifest: { name: "app" },
  });

  const response = await app.request(TAKOS_PAAS_INTERNAL_PATHS.deployments, {
    method: "POST",
    headers: await signedHeaders({
      secret,
      method: "POST",
      path: TAKOS_PAAS_INTERNAL_PATHS.deployments,
      body,
      actor: {
        actorAccountId: "acct_owner",
        roles: ["owner"],
        requestId: "req_deploy_plan",
        principalKind: "service",
        serviceId: "wi_deployer",
        spaceId: "space_route",
      },
    }),
    body,
  });

  assert.equal(response.status, 403);
  assert.equal(
    (await response.json()).error.message,
    "Service grant is required",
  );
});

Deno.test("internal list routes enforce workload read grants when security is wired", async () => {
  const secret = "route-secret";
  const dependencies = createInMemoryCoreDomainDependencies();
  const securityStores = {
    workloadIdentities: new InMemoryWorkloadIdentityStore(),
    serviceGrants: new InMemoryServiceGrantStore(),
    runtimeNetworkPolicies: new InMemoryRuntimeNetworkPolicyStore(),
  };
  await securityStores.workloadIdentities.put({
    id: "wi_reader",
    spaceId: "space_route",
    groupId: "app",
    componentName: "reader",
    subject: "service:reader",
    claims: { aud: "takosumi" },
    issuedAt: "2026-04-27T00:00:00.000Z",
  });
  const app = await createApiApp({
    getInternalServiceSecret: () => secret,
    internalRouteServices: {
      core: createCoreDomainServices(dependencies),
      deployments: stubDeploymentService(),
      planService: { createPlan: () => Promise.resolve({ id: "plan_1" }) },
      applyService: {
        applyManifest: () => Promise.resolve({ id: "apply_1" }),
      },
      security: new WorkerAuthzService({
        stores: securityStores,
        clock: () => new Date("2026-04-27T00:00:00.000Z"),
      }),
    },
  });
  const actor: TakosActorContext = {
    actorAccountId: "acct_owner",
    roles: ["owner"],
    requestId: "req_list_spaces_denied",
    principalKind: "service",
    serviceId: "wi_reader",
    spaceId: "space_route",
  };

  const spaces = await app.request(TAKOS_PAAS_INTERNAL_PATHS.spaces, {
    method: "GET",
    headers: await signedHeaders({
      secret,
      method: "GET",
      path: TAKOS_PAAS_INTERNAL_PATHS.spaces,
      body: "",
      actor,
    }),
  });
  assert.equal(spaces.status, 403);
  assert.equal(
    (await spaces.json()).error.message,
    "Service grant is required",
  );

  const groupsPath = `${TAKOS_PAAS_INTERNAL_PATHS.groups}?spaceId=space_route`;
  const groups = await app.request(groupsPath, {
    method: "GET",
    headers: await signedHeaders({
      secret,
      method: "GET",
      path: TAKOS_PAAS_INTERNAL_PATHS.groups,
      query: "?spaceId=space_route",
      body: "",
      actor: { ...actor, requestId: "req_list_groups_denied" },
    }),
  });
  assert.equal(groups.status, 403);
  assert.equal(
    (await groups.json()).error.message,
    "Service grant is required",
  );
});

Deno.test("internal deploy routes enforce entitlement mutation boundaries when wired", async () => {
  const secret = "route-secret";
  const dependencies = createInMemoryCoreDomainDependencies();
  await dependencies.memberships.upsert({
    id: "membership_member",
    spaceId: "space_route",
    accountId: "acct_member",
    roles: ["member"],
    status: "active",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  });
  const app = await createApiApp({
    getInternalServiceSecret: () => secret,
    internalRouteServices: {
      core: createCoreDomainServices(dependencies),
      deployments: stubDeploymentService({
        getDeployment: () =>
          deploymentFixture({
            id: "dep_apply",
            space_id: "space_route",
            group_id: "app",
          }),
      }),
      planService: { createPlan: () => Promise.resolve({ id: "plan_1" }) },
      applyService: {
        applyManifest: () => Promise.resolve({ id: "apply_1" }),
      },
      entitlements: new EntitlementPolicyService({
        memberships: dependencies.memberships,
      }),
    },
  });
  const body = JSON.stringify({
    spaceId: "space_route",
    manifest: { name: "app" },
  });

  const applyPath = TAKOS_PAAS_INTERNAL_PATHS.deploymentApply.replace(
    ":deploymentId",
    "dep_apply",
  );
  const response = await app.request(
    applyPath,
    {
      method: "POST",
      headers: await signedHeaders({
        secret,
        method: "POST",
        path: applyPath,
        body,
        actor: {
          actorAccountId: "acct_member",
          roles: ["member"],
          requestId: "req_deploy_apply",
          principalKind: "account",
          spaceId: "space_route",
        },
      }),
      body,
    },
  );

  assert.equal(response.status, 403);
  assert.equal(
    (await response.json()).error.message,
    "missing capability: deploy.apply",
  );
});

Deno.test("API routes return common envelopes for malformed JSON", async () => {
  const secret = "route-secret";
  const app = await createApiApp({
    registerPublicRoutes: true,
    registerRuntimeAgentRoutes: false,
    getInternalServiceSecret: () => secret,
  });
  const runtimeAgentApp = await createApiApp({
    role: "takosumi-runtime-agent",
    getInternalServiceSecret: () => secret,
  });
  const malformedBody = "{";
  const actor: TakosActorContext = {
    actorAccountId: "acct_owner",
    roles: ["owner"],
    requestId: "req_malformed",
    principalKind: "service",
    serviceId: "svc_internal",
  };

  const publicResponse = await app.request(TAKOS_PAAS_PUBLIC_PATHS.spaces, {
    method: "POST",
    body: malformedBody,
  });
  assert.equal(publicResponse.status, 400);
  assert.deepEqual(await publicResponse.json(), {
    error: {
      code: "invalid_json",
      message: "Malformed JSON request body",
    },
  });

  const internalResponse = await app.request(TAKOS_PAAS_INTERNAL_PATHS.spaces, {
    method: "POST",
    headers: await signedHeaders({
      secret,
      method: "POST",
      path: TAKOS_PAAS_INTERNAL_PATHS.spaces,
      body: malformedBody,
      actor,
    }),
    body: malformedBody,
  });
  assert.equal(internalResponse.status, 400);
  assert.deepEqual(await internalResponse.json(), {
    error: {
      code: "invalid_json",
      message: "Malformed JSON request body",
    },
  });

  const runtimeResponse = await runtimeAgentApp.request(
    "/api/internal/v1/runtime/agents/enroll",
    {
      method: "POST",
      headers: await signedHeaders({
        secret,
        method: "POST",
        path: "/api/internal/v1/runtime/agents/enroll",
        body: malformedBody,
        actor: { ...actor, requestId: "req_runtime_malformed" },
      }),
      body: malformedBody,
    },
  );
  assert.equal(runtimeResponse.status, 400);
  assert.deepEqual(await runtimeResponse.json(), {
    error: {
      code: "invalid_json",
      message: "Malformed JSON request body",
    },
  });
});

Deno.test("API routes return common envelopes for uncaught public and internal errors", async () => {
  const secret = "route-secret";
  const app = await createApiApp({
    registerPublicRoutes: true,
    getInternalServiceSecret: () => secret,
    publicRouteServices: {
      authenticate: () => ({
        ok: true,
        actor: {
          actorAccountId: "acct_public",
          roles: ["owner"],
          requestId: "req_public",
          principalKind: "account",
        },
      }),
      spaces: {
        list: () => {
          throw new Error("public store failed");
        },
        create: () => ({ id: "unused" }),
      },
      groups: {
        list: () => [],
        create: () => ({ id: "unused" }),
      },
      deployments: {
        resolveDeployment: () => {
          throw new Error("not used");
        },
        applyDeployment: () => {
          throw new Error("not used");
        },
        previewDeployment: () => {
          throw new Error("not used");
        },
        applyResolved: () => {
          throw new Error("not used");
        },
        approveDeployment: () => {
          throw new Error("not used");
        },
        rollbackGroup: () => {
          throw new Error("not used");
        },
        getDeployment: () => null,
        listDeployments: () => [],
        getGroupHead: () => null,
        listObservations: () => [],
      },
    },
    internalRouteServices: {
      core: createCoreDomainServices(createInMemoryCoreDomainDependencies()),
      deployments: stubDeploymentService({
        resolveDeployment: () => {
          throw new Error("internal deployment failed");
        },
      }),
      planService: {
        createPlan: () => {
          throw new Error("internal planner failed");
        },
      },
      applyService: {
        applyManifest: () => Promise.resolve({ id: "unused" }),
      },
    },
  });

  const publicResponse = await app.request(TAKOS_PAAS_PUBLIC_PATHS.spaces);
  assert.equal(publicResponse.status, 500);
  assert.deepEqual(await publicResponse.json(), {
    error: {
      code: "internal_error",
      message: "Internal server error",
    },
  });

  const body = JSON.stringify({
    spaceId: "space_route",
    manifest: { name: "app" },
  });
  const internalResponse = await app.request(
    TAKOS_PAAS_INTERNAL_PATHS.deployments,
    {
      method: "POST",
      headers: await signedHeaders({
        secret,
        method: "POST",
        path: TAKOS_PAAS_INTERNAL_PATHS.deployments,
        body,
        actor: {
          actorAccountId: "acct_owner",
          roles: ["owner"],
          requestId: "req_internal_error",
          principalKind: "service",
          serviceId: "svc_internal",
          spaceId: "space_route",
        },
      }),
      body,
    },
  );
  assert.equal(internalResponse.status, 500);
  assert.deepEqual(await internalResponse.json(), {
    error: {
      code: "internal_error",
      message: "Internal server error",
    },
  });
});

function stubDeploymentService(
  overrides: Partial<DeploymentService> = {},
): DeploymentService {
  const notStubbed = () => {
    throw new Error("DeploymentService method not stubbed");
  };
  const deployment = deploymentFixture();
  return {
    resolveDeployment: () => ({ deployment }),
    applyDeployment: () => ({ deployment }),
    previewDeployment: () => ({
      deployment_id: "preview:app",
      status: "preview",
      conditions: [],
    }),
    applyResolved: () => ({
      deployment: deploymentFixture({ status: "applied" }),
    }),
    approveDeployment: notStubbed,
    rollbackGroup: notStubbed,
    getDeployment: () => null,
    listDeployments: () => [],
    getGroupHead: () => null,
    listObservations: () => [],
    ...overrides,
  };
}

function deploymentFixture(
  overrides: Partial<Deployment> = {},
): Deployment {
  return {
    id: "dep_route",
    group_id: "app",
    space_id: "space_route",
    input: {
      manifest_snapshot:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      source_kind: "inline",
      group: "app",
    },
    resolution: {
      descriptor_closure: {
        resolutions: [],
        closureDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        createdAt: "2026-04-27T00:00:00.000Z",
      },
      resolved_graph: {
        digest:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        components: [],
        projections: [],
      },
    },
    desired: {
      routes: [],
      bindings: [],
      resources: [],
      runtime_network_policy: {
        policyDigest:
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        defaultEgress: "deny-by-default",
      },
      activation_envelope: {
        primary_assignment: {
          componentAddress: "component:app/web",
          weight: 1,
        },
        envelopeDigest:
          "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      },
    },
    status: "resolved",
    conditions: [],
    policy_decisions: [],
    approval: null,
    rollback_target: null,
    created_at: "2026-04-27T00:00:00.000Z",
    applied_at: null,
    finalized_at: null,
    ...overrides,
  };
}

async function signedHeaders(input: {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  readonly body: string;
  readonly actor: TakosActorContext;
}): Promise<Headers> {
  const signed = await signTakosInternalRequest({
    ...input,
    timestamp: new Date().toISOString(),
    caller: input.actor.serviceId ?? input.actor.agentId ?? "takos-test",
    audience: "takosumi",
  });
  return new Headers({
    ...signed.headers,
    "content-type": "application/json",
  });
}
