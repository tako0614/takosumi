import assert from "node:assert/strict";
import type {
  ActorContext,
  Deployment,
  DeploymentStatus,
  GroupHead,
  ProviderObservation,
} from "takosumi-contract";
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
  TAKOS_PAAS_PUBLIC_PATHS,
} from "./public_routes.ts";
import { createApiApp } from "./app.ts";

Deno.test("public API fetch-level lifecycle creates space/group then drives Deployment surface", async () => {
  const restoreCryptoRandomUUID = installUnboundSafeRandomUUID();
  try {
    const deployments = createInMemoryDeploymentService();
    const customApp = await createApiApp({
      registerPublicRoutes: true,
      publicRouteServices: await createCustomPublicRouteServices(deployments),
    });

    const capabilitiesResponse = await customApp.request(
      TAKOS_PAAS_PUBLIC_PATHS.capabilities,
    );
    assert.equal(capabilitiesResponse.status, 200);
    const capabilitiesBody = await capabilitiesResponse.json();
    assert.equal(capabilitiesBody.capabilities.service, "takosumi");
    assert.equal(capabilitiesBody.capabilities.audience, "public-api");
    assertEndpoint(capabilitiesBody, "POST", TAKOS_PAAS_PUBLIC_PATHS.spaces);
    assertEndpoint(capabilitiesBody, "POST", TAKOS_PAAS_PUBLIC_PATHS.groups);
    assertEndpoint(
      capabilitiesBody,
      "POST",
      TAKOS_PAAS_PUBLIC_PATHS.deployments,
    );
    assertEndpoint(
      capabilitiesBody,
      "POST",
      TAKOS_PAAS_PUBLIC_PATHS.groupRollback,
    );

    const manifest = {
      name: "e2e-public-app",
      version: "1.0.0",
      env: { APP_ENV: "test" },
      compute: {
        web: {
          type: "container",
          image:
            "registry.example.test/e2e-public-app@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          port: 8080,
          env: { PORT: "8080" },
        },
      },
    };

    const resolveResponse = await customApp.request(
      TAKOS_PAAS_PUBLIC_PATHS.deployments,
      {
        method: "POST",
        body: JSON.stringify({
          mode: "resolve",
          manifest,
          space_id: "space_e2e_public",
          group: "e2e-public-app",
        }),
      },
    );
    assert.equal(resolveResponse.status, 201);
    const resolveBody = await resolveResponse.json();
    assert.equal(resolveBody.status, "resolved");
    const deploymentId: string = resolveBody.deployment_id;

    const applyResponse = await customApp.request(
      TAKOS_PAAS_PUBLIC_PATHS.deploymentApply.replace(
        ":deploymentId",
        deploymentId,
      ),
      { method: "POST" },
    );
    assert.equal(applyResponse.status, 201);
    const applyBody = await applyResponse.json();
    assert.equal(applyBody.status, "applied");
    assert.equal(applyBody.deployment_id, deploymentId);

    const headResponse = await customApp.request(
      TAKOS_PAAS_PUBLIC_PATHS.groupHead.replace(":groupId", "e2e-public-app"),
    );
    assert.equal(headResponse.status, 200);
    const headBody = await headResponse.json();
    assert.equal(headBody.head.current_deployment_id, deploymentId);

    const listResponse = await customApp.request(
      `${TAKOS_PAAS_PUBLIC_PATHS.deployments}?group=e2e-public-app`,
    );
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.deployments.length, 1);
  } finally {
    restoreCryptoRandomUUID();
  }
});

function installUnboundSafeRandomUUID(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  const original = crypto.randomUUID.bind(crypto);
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => original(),
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(crypto, "randomUUID", descriptor);
    }
  };
}

function assertEndpoint(
  body: {
    capabilities: {
      endpoints: readonly { method: string; path: string }[];
    };
  },
  method: string,
  path: string,
): void {
  assert.ok(
    body.capabilities.endpoints.some((endpoint) =>
      endpoint.method === method && endpoint.path === path
    ),
    `expected public capabilities to include ${method} ${path}`,
  );
}

async function createCustomPublicRouteServices(
  deployments: DeploymentService,
) {
  const { LocalActorAdapter } = await import("../adapters/auth/local.ts");
  const auth = new LocalActorAdapter({
    actor: {
      actorAccountId: "local-operator",
      roles: ["owner"],
      requestId: "request_e2e_public",
      spaceId: "space_e2e_public",
    },
  });
  return {
    authenticate: (request: Request) => auth.authenticate(request),
    spaces: {
      list: () => [],
      create: (
        input: { actor: ActorContext; name?: string; slug?: string },
      ) => ({
        id: input.slug ?? "space_stub",
        name: input.name ?? "Stub",
      }),
    },
    groups: {
      list: () => [],
      create: (input: {
        actor: ActorContext;
        spaceId: string;
        name?: string;
        envName?: string;
      }) => ({
        id: input.envName ?? input.name ?? "default",
        spaceId: input.spaceId,
      }),
    },
    deployments,
  } as const;
}

function createInMemoryDeploymentService(): DeploymentService {
  const store = new Map<string, Deployment>();
  const heads = new Map<string, GroupHead>();

  const make = (
    id: string,
    group: string,
    space: string,
    status: DeploymentStatus,
  ): Deployment => ({
    id,
    group_id: group,
    space_id: space,
    input: { manifest_snapshot: "{}", source_kind: "inline" },
    resolution: {
      descriptor_closure: {
        resolutions: [],
        closureDigest: "sha256:closure",
        createdAt: new Date().toISOString(),
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
    conditions: [],
    created_at: new Date().toISOString(),
  });

  let counter = 0;
  const nextId = () => `dep_${++counter}`;

  const envelopeOf = (deployment: Deployment): DeploymentEnvelope => ({
    deployment,
    expansion_summary: {},
  });

  return {
    resolveDeployment(input: PublicDeploymentCreateInput) {
      const id = nextId();
      const dep = make(
        id,
        input.group ?? "default",
        input.space_id ?? input.actor.spaceId ?? "space",
        "resolved",
      );
      store.set(id, dep);
      return envelopeOf(dep);
    },
    applyDeployment(input: PublicDeploymentCreateInput) {
      const id = nextId();
      const dep = make(
        id,
        input.group ?? "default",
        input.space_id ?? input.actor.spaceId ?? "space",
        "applied",
      );
      store.set(id, dep);
      heads.set(headKey(dep.space_id, dep.group_id), {
        space_id: dep.space_id,
        group_id: dep.group_id,
        current_deployment_id: id,
        previous_deployment_id: null,
        generation: 1,
        advanced_at: new Date().toISOString(),
      });
      return envelopeOf(dep);
    },
    previewDeployment(
      input: PublicDeploymentCreateInput,
    ): DeploymentMutationResponse {
      return {
        deployment_id: `preview:${input.group ?? "default"}`,
        status: "preview",
        conditions: [],
      };
    },
    applyResolved(input: PublicDeploymentGetInput) {
      const existing = store.get(input.deploymentId);
      if (!existing) {
        throw new Error(`unknown deployment ${input.deploymentId}`);
      }
      const applied: Deployment = {
        ...existing,
        status: "applied",
        applied_at: new Date().toISOString(),
      };
      store.set(applied.id, applied);
      const previousHead = heads.get(
        headKey(applied.space_id, applied.group_id),
      );
      heads.set(headKey(applied.space_id, applied.group_id), {
        space_id: applied.space_id,
        group_id: applied.group_id,
        current_deployment_id: applied.id,
        previous_deployment_id: previousHead?.current_deployment_id ?? null,
        generation: (previousHead?.generation ?? 0) + 1,
        advanced_at: new Date().toISOString(),
      });
      return envelopeOf(applied);
    },
    approveDeployment(input: PublicDeploymentApproveInput) {
      const existing = store.get(input.deploymentId);
      if (!existing) {
        throw new Error(`unknown deployment ${input.deploymentId}`);
      }
      return envelopeOf(existing);
    },
    rollbackGroup(input: PublicGroupRollbackInput) {
      const spaceId = input.space_id ?? input.actor.spaceId ?? "space";
      const head = heads.get(headKey(spaceId, input.groupId));
      if (!head) throw new Error(`unknown group ${input.groupId}`);
      const targetId = input.target_id ?? head.previous_deployment_id;
      if (!targetId) throw new Error(`no rollback target for ${input.groupId}`);
      const target = store.get(targetId);
      if (!target) throw new Error(`unknown deployment ${targetId}`);
      const flipped: Deployment = { ...target, status: "rolled-back" };
      heads.set(headKey(spaceId, input.groupId), {
        space_id: target.space_id,
        group_id: input.groupId,
        current_deployment_id: target.id,
        previous_deployment_id: head.current_deployment_id,
        generation: head.generation + 1,
        advanced_at: new Date().toISOString(),
      });
      return envelopeOf(flipped);
    },
    getDeployment(input: PublicDeploymentGetInput) {
      return store.get(input.deploymentId) ?? null;
    },
    listDeployments(input: PublicDeploymentListInput) {
      return Array.from(store.values()).filter((dep) =>
        (!input.group || dep.group_id === input.group) &&
        (!input.status || dep.status === input.status)
      );
    },
    getGroupHead(input: PublicGroupRefInput) {
      return heads.get(
        headKey(
          input.space_id ?? input.actor.spaceId ?? "space",
          input.groupId,
        ),
      ) ??
        null;
    },
    listObservations(_input: PublicDeploymentGetInput) {
      const empty: readonly ProviderObservation[] = [];
      return empty;
    },
  };
}

function headKey(spaceId: string, groupId: string): string {
  return `${spaceId}\u0000${groupId}`;
}
