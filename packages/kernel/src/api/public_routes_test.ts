import assert from "node:assert/strict";
import { Hono, type Hono as HonoApp } from "hono";
import type {
  ActorContext,
  Deployment,
  DeploymentCondition,
  GroupHead,
  ProviderObservation,
} from "takosumi-contract";
import {
  type DeploymentEnvelope,
  type DeploymentMutationResponse,
  type DeploymentService,
  type PublicRouteServices,
  registerPublicRoutes,
  TAKOSUMI_PAAS_PUBLIC_PATHS,
} from "./public_routes.ts";

Deno.test("public routes list and create spaces through injected services", async () => {
  const calls: string[] = [];
  const app = createApp({
    spaces: {
      list(input) {
        calls.push(`list:${input.actor.actorAccountId}`);
        return [{ id: "space_1", name: "Demo" }];
      },
      create(input) {
        calls.push(`create:${input.name}:${input.slug}`);
        return {
          id: "space_2",
          name: input.name,
          slug: input.slug,
          metadata: input.metadata,
        };
      },
    },
  });

  const list = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.spaces);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), {
    spaces: [{ id: "space_1", name: "Demo" }],
  });

  const create = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.spaces, {
    method: "POST",
    body: JSON.stringify({
      name: "Created",
      slug: "space_public",
      metadata: { plan: "free" },
    }),
  });
  assert.equal(create.status, 201);
  assert.deepEqual(await create.json(), {
    space: {
      id: "space_2",
      name: "Created",
      slug: "space_public",
      metadata: { plan: "free" },
    },
  });
  assert.deepEqual(calls, [
    "list:acct_public",
    "create:Created:space_public",
  ]);
});

Deno.test("public routes list and create groups with space fallback", async () => {
  const calls: string[] = [];
  const app = createApp({
    groups: {
      list(input) {
        calls.push(`list:${input.spaceId}`);
        return [{ id: "group_1", spaceId: input.spaceId, name: "Prod" }];
      },
      create(input) {
        calls.push(`create:${input.spaceId}:${input.name}:${input.envName}`);
        return {
          id: "group_2",
          spaceId: input.spaceId,
          name: input.name,
          envName: input.envName,
        };
      },
    },
  });

  const list = await app.request(
    `${TAKOSUMI_PAAS_PUBLIC_PATHS.groups}?spaceId=space_public`,
  );
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), {
    groups: [{ id: "group_1", spaceId: "space_public", name: "Prod" }],
  });

  const create = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.groups, {
    method: "POST",
    body: JSON.stringify({ name: "Preview", envName: "preview" }),
  });
  assert.equal(create.status, 201);
  assert.deepEqual(await create.json(), {
    group: {
      id: "group_2",
      spaceId: "space_public",
      name: "Preview",
      envName: "preview",
    },
  });
  assert.deepEqual(calls, [
    "list:space_public",
    "create:space_public:Preview:preview",
  ]);
});

Deno.test("public routes reject group requests outside the actor space", async () => {
  const app = createApp();

  const list = await app.request(
    `${TAKOSUMI_PAAS_PUBLIC_PATHS.groups}?spaceId=space_other`,
  );
  assert.equal(list.status, 403);
  assert.deepEqual(await list.json(), {
    error: {
      code: "permission_denied",
      message: "actor cannot access requested space",
    },
  });

  const create = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.groups, {
    method: "POST",
    body: JSON.stringify({ spaceId: "space_other", name: "Other" }),
  });
  assert.equal(create.status, 403);
  assert.deepEqual(await create.json(), {
    error: {
      code: "permission_denied",
      message: "actor cannot access requested space",
    },
  });
});

Deno.test("public routes resolve and apply Deployment via mode dispatch", async () => {
  const calls: string[] = [];
  const manifest = { name: "demo", version: "1.0.0" };
  const app = createApp({
    deployments: stubDeploymentService({
      resolveDeployment(input) {
        calls.push(`resolve:${input.space_id}:${input.actor.actorAccountId}`);
        return envelopeFor("dep_resolved", "resolved");
      },
      applyDeployment(input) {
        calls.push(`apply:${input.space_id}:${input.actor.actorAccountId}`);
        return envelopeFor("dep_applied", "applied");
      },
    }),
  });

  const resolve = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.deployments, {
    method: "POST",
    body: JSON.stringify({
      mode: "resolve",
      manifest,
      space_id: "space_public",
    }),
  });
  assert.equal(resolve.status, 201);
  const resolveBody = await resolve.json();
  assert.equal(resolveBody.deployment_id, "dep_resolved");
  assert.equal(resolveBody.status, "resolved");

  const apply = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.deployments, {
    method: "POST",
    body: JSON.stringify({
      mode: "apply",
      manifest,
      space_id: "space_public",
    }),
  });
  assert.equal(apply.status, 201);
  const applyBody = await apply.json();
  assert.equal(applyBody.deployment_id, "dep_applied");
  assert.equal(applyBody.status, "applied");

  assert.deepEqual(calls, [
    "resolve:space_public:acct_public",
    "apply:space_public:acct_public",
  ]);
});

Deno.test("public deployments reject create requests outside the actor space", async () => {
  const app = createApp();

  const response = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.deployments, {
    method: "POST",
    body: JSON.stringify({
      mode: "resolve",
      manifest: { name: "demo" },
      space_id: "space_other",
    }),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: {
      code: "permission_denied",
      message: "actor cannot access requested space",
    },
  });
});

Deno.test("public deployments accept preview mode without persistence", async () => {
  const app = createApp({
    deployments: stubDeploymentService({
      previewDeployment(input): DeploymentMutationResponse {
        return {
          deployment_id: `preview:${input.space_id}`,
          status: "preview",
          conditions: [],
        };
      },
    }),
  });

  const preview = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.deployments, {
    method: "POST",
    body: JSON.stringify({
      mode: "preview",
      manifest: { name: "demo" },
      space_id: "space_public",
    }),
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    deployment_id: "preview:space_public",
    status: "preview",
    conditions: [],
  });
});

Deno.test("public deployments mode=rollback flips GroupHead", async () => {
  const calls: string[] = [];
  const app = createApp({
    deployments: stubDeploymentService({
      rollbackGroup(input) {
        calls.push(`rollback:${input.groupId}:${input.target_id ?? ""}`);
        return envelopeFor("dep_rb", "rolled-back");
      },
    }),
  });

  const rollback = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.deployments, {
    method: "POST",
    body: JSON.stringify({
      mode: "rollback",
      group: "demo",
      target_id: "dep_old",
      space_id: "space_public",
    }),
  });
  assert.equal(rollback.status, 201);
  assert.deepEqual(calls, ["rollback:demo:dep_old"]);
});

Deno.test("public deployment apply / approve endpoints transition status", async () => {
  const calls: string[] = [];
  const app = createApp({
    deployments: stubDeploymentService({
      applyResolved(input) {
        calls.push(`apply-by-id:${input.deploymentId}`);
        return envelopeFor(input.deploymentId, "applied");
      },
      approveDeployment(input) {
        calls.push(`approve:${input.deploymentId}`);
        return envelopeFor(input.deploymentId, "resolved");
      },
      getDeployment(input) {
        return makeDeployment(input.deploymentId, "resolved");
      },
    }),
  });

  const applyById = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApply.replace(
      ":deploymentId",
      "dep_1",
    ),
    { method: "POST" },
  );
  assert.equal(applyById.status, 201);
  const applyBody = await applyById.json();
  assert.equal(applyBody.deployment_id, "dep_1");
  assert.equal(applyBody.status, "applied");

  const approve = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApprove.replace(
      ":deploymentId",
      "dep_1",
    ),
    { method: "POST", body: JSON.stringify({ policy_decision_id: "pd_1" }) },
  );
  assert.equal(approve.status, 200);
  assert.deepEqual(calls, ["apply-by-id:dep_1", "approve:dep_1"]);
});

Deno.test("public group head and rollback endpoints expose GroupHead semantics", async () => {
  const calls: string[] = [];
  const head: GroupHead = {
    space_id: "space_public",
    group_id: "demo",
    current_deployment_id: "dep_current",
    previous_deployment_id: "dep_previous",
    generation: 4,
    advanced_at: "2026-04-29T00:00:00.000Z",
  };
  const app = createApp({
    deployments: stubDeploymentService({
      getGroupHead(input) {
        calls.push(`head:${input.space_id}:${input.groupId}`);
        return head;
      },
      rollbackGroup(input) {
        calls.push(`rollback:${input.space_id}:${input.groupId}`);
        return envelopeFor("dep_rb", "rolled-back");
      },
    }),
  });

  const headResponse = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.groupHead.replace(":groupId", "demo"),
  );
  assert.equal(headResponse.status, 200);
  assert.deepEqual(await headResponse.json(), { head });

  const rollback = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.groupRollback.replace(":groupId", "demo"),
    { method: "POST", body: JSON.stringify({}) },
  );
  assert.equal(rollback.status, 201);
  assert.deepEqual(calls, [
    "head:space_public:demo",
    "rollback:space_public:demo",
  ]);
});

Deno.test("public group head and rollback endpoints enforce space boundaries", async () => {
  const app = createApp({
    deployments: stubDeploymentService({
      getGroupHead() {
        return {
          space_id: "space_other",
          group_id: "demo",
          current_deployment_id: "dep_current",
          previous_deployment_id: null,
          generation: 1,
          advanced_at: "2026-04-29T00:00:00.000Z",
        };
      },
      rollbackGroup() {
        throw new Error("cross-space rollback should not run");
      },
    }),
  });

  const queryDenied = await app.request(
    `${
      TAKOSUMI_PAAS_PUBLIC_PATHS.groupHead.replace(":groupId", "demo")
    }?spaceId=space_other`,
  );
  assert.equal(queryDenied.status, 403);

  const hiddenHead = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.groupHead.replace(":groupId", "demo"),
  );
  assert.equal(hiddenHead.status, 404);

  const rollbackDenied = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.groupRollback.replace(":groupId", "demo"),
    { method: "POST", body: JSON.stringify({ space_id: "space_other" }) },
  );
  assert.equal(rollbackDenied.status, 403);
});

Deno.test("public deployment list / get / observations endpoints", async () => {
  const observations: readonly ProviderObservation[] = [{
    id: "obs_1",
    deployment_id: "dep_1",
    provider_id: "provider_demo",
    object_address: "demo:component",
    observed_state: "present",
    observed_at: "2026-04-29T00:00:00.000Z",
  }];
  const deployment = makeDeployment("dep_1", "applied");
  const app = createApp({
    deployments: stubDeploymentService({
      getDeployment() {
        return deployment;
      },
      listDeployments() {
        return [deployment];
      },
      listObservations() {
        return observations;
      },
    }),
  });

  const get = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.deployment.replace(":deploymentId", "dep_1"),
  );
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.equal(getBody.deployment.id, "dep_1");

  const list = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.deployments);
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.deployments.length, 1);

  const obs = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentObservations.replace(
      ":deploymentId",
      "dep_1",
    ),
  );
  assert.equal(obs.status, 200);
  assert.deepEqual(await obs.json(), { observations });
});

Deno.test("public deployment id endpoints hide cross-space deployments", async () => {
  const deployment = {
    ...makeDeployment("dep_other", "resolved"),
    space_id: "space_other",
  };
  const app = createApp({
    deployments: stubDeploymentService({
      getDeployment() {
        return deployment;
      },
      applyResolved() {
        throw new Error("cross-space apply should not run");
      },
      approveDeployment() {
        throw new Error("cross-space approve should not run");
      },
      listObservations() {
        throw new Error("cross-space observations should not run");
      },
    }),
  });

  const get = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.deployment.replace(":deploymentId", "dep_other"),
  );
  assert.equal(get.status, 404);

  const apply = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApply.replace(
      ":deploymentId",
      "dep_other",
    ),
    { method: "POST" },
  );
  assert.equal(apply.status, 404);

  const approve = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApprove.replace(
      ":deploymentId",
      "dep_other",
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
  assert.equal(approve.status, 404);

  const obs = await app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentObservations.replace(
      ":deploymentId",
      "dep_other",
    ),
  );
  assert.equal(obs.status, 404);
});

Deno.test("public group routes reject non-catalog condition reasons", async () => {
  const app = createApp({
    groups: {
      list() {
        return [{
          id: "group_invalid",
          conditions: [{ type: "Ready", status: "false", reason: "bad" }],
        }];
      },
      create(input) {
        return {
          id: "group_invalid",
          spaceId: input.spaceId,
          conditions: [{
            type: "Ready",
            status: "false",
            reason: "not-catalog",
          }],
        };
      },
    },
  });

  const list = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.groups);
  assert.equal(list.status, 500);
  assert.deepEqual(await list.json(), {
    error: { code: "internal_error", message: "Internal server error" },
  });

  const create = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.groups, {
    method: "POST",
    body: JSON.stringify({ name: "Preview" }),
  });
  assert.equal(create.status, 500);
  assert.deepEqual(await create.json(), {
    error: { code: "internal_error", message: "Internal server error" },
  });
});

Deno.test("public routes expose capabilities reference and auth failures", async () => {
  const app = createApp({
    authenticate: () => ({ ok: false, status: 403, error: "forbidden" }),
  });

  const denied = await app.request(TAKOSUMI_PAAS_PUBLIC_PATHS.capabilities);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    error: {
      code: "permission_denied",
      message: "forbidden",
    },
  });

  const allowed = createApp();
  const response = await allowed.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.capabilities,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.capabilities.service, "takosumi");
  assert.equal(body.capabilities.audience, "public-api");
  assert.ok(
    body.capabilities.endpoints.some((endpoint: { path: string }) =>
      endpoint.path === TAKOSUMI_PAAS_PUBLIC_PATHS.deployments
    ),
  );
});

function createApp(overrides: Partial<PublicRouteServices> = {}): HonoApp {
  const app: HonoApp = new Hono();
  registerPublicRoutes(app, { services: stubServices(overrides) });
  return app;
}

function stubServices(
  overrides: Partial<PublicRouteServices>,
): PublicRouteServices {
  return {
    authenticate: () => ({ ok: true, actor }),
    spaces: {
      list: () => [],
      create: (input) => ({ id: "space_stub", name: input.name }),
    },
    groups: {
      list: () => [],
      create: (input) => ({ id: "group_stub", spaceId: input.spaceId }),
    },
    deployments: stubDeploymentService(),
    ...overrides,
  };
}

function stubDeploymentService(
  overrides: Partial<DeploymentService> = {},
): DeploymentService {
  const fallback = (): never => {
    throw new Error("DeploymentService method not stubbed");
  };
  const summary = (): DeploymentMutationResponse => ({
    deployment_id: "dep_stub",
    status: "preview",
    conditions: [],
  });
  return {
    resolveDeployment: () => envelopeFor("dep_resolved", "resolved"),
    applyDeployment: () => envelopeFor("dep_applied", "applied"),
    previewDeployment: () => summary(),
    applyResolved: () => envelopeFor("dep_applied", "applied"),
    approveDeployment: () => envelopeFor("dep_resolved", "resolved"),
    rollbackGroup: () => envelopeFor("dep_rb", "rolled-back"),
    getDeployment: () => fallback(),
    listDeployments: () => [],
    getGroupHead: () => null,
    listObservations: () => [],
    ...overrides,
  };
}

function envelopeFor(
  id: string,
  status: Deployment["status"],
): DeploymentEnvelope {
  return { deployment: makeDeployment(id, status) };
}

function makeDeployment(id: string, status: Deployment["status"]): Deployment {
  const conditions: readonly DeploymentCondition[] = [];
  return {
    id,
    group_id: "demo",
    space_id: "space_public",
    input: {
      manifest_snapshot: "{}",
      source_kind: "inline",
    },
    resolution: {
      descriptor_closure: {
        resolutions: [],
        closureDigest: "sha256:closure",
        createdAt: "2026-04-29T00:00:00.000Z",
      },
      resolved_graph: {
        digest: "sha256:graph",
        components: [],
        projections: [],
      },
    },
    desired: {
      routes: [],
      bindings: [],
      resources: [],
      runtime_network_policy: {
        policyDigest: "sha256:policy",
        defaultEgress: "deny",
      },
      activation_envelope: {
        primary_assignment: { componentAddress: "component:web", weight: 1 },
        envelopeDigest: "sha256:env",
      },
    },
    status,
    conditions,
    created_at: "2026-04-29T00:00:00.000Z",
  };
}

const actor: ActorContext = {
  actorAccountId: "acct_public",
  spaceId: "space_public",
  roles: ["owner"],
  requestId: "req_public",
  principalKind: "account",
};
