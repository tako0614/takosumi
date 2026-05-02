import assert from "node:assert/strict";
import {
  CORE_CONDITION_REASONS,
  TAKOSUMI_INTERNAL_PATHS,
} from "takosumi-contract";
import { createPaaSOpenApiDocument } from "./openapi.ts";
import { TAKOS_PAAS_PUBLIC_PATHS } from "./public_routes.ts";
import { TAKOS_PAAS_READINESS_PATHS } from "./readiness_routes.ts";
import { TAKOS_PAAS_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";

Deno.test("createPaaSOpenApiDocument emits process and Deployment-centric public API paths", () => {
  const doc = allRoutesDoc();

  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.paths["/health"]?.get);
  assert.equal(doc.paths["/health"]?.get?.["x-takos-auth"], "none");
  assert.ok(doc.paths["/capabilities"]?.get);

  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.capabilities]?.get);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.spaces]?.get);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.spaces]?.post);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.groups]?.get);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.groups]?.post);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.deployments]?.post);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.deployments]?.get);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.deployment]?.get);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.deploymentApply]?.post);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.deploymentApprove]?.post);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.deploymentObservations]?.get);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.groupHead]?.get);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.groupRollback]?.post);

  assert.equal(
    doc.paths[TAKOS_PAAS_PUBLIC_PATHS.spaces]?.get?.security?.[0]
      .actorBearer.length,
    0,
  );
  assert.equal(
    doc.paths[TAKOS_PAAS_PUBLIC_PATHS.deployments]?.post?.responses["201"]
      ?.description,
    "JSON response",
  );
});

Deno.test("createPaaSOpenApiDocument omits removed plan / apply / snapshot paths", () => {
  const doc = allRoutesDoc();
  for (
    const removedPath of [
      "/api/public/v1/deploy/plans",
      "/api/public/v1/deploy/applies",
      "/api/public/v1/spaces/:spaceId/group-deployment-snapshots",
      "/api/public/v1/spaces/:spaceId/group-deployment-snapshots/plan",
      "/api/public/v1/spaces/:spaceId/group-deployment-snapshots/:groupDeploymentSnapshotId",
      "/api/public/v1/spaces/:spaceId/group-deployment-snapshots/:groupDeploymentSnapshotId/rollback",
      "/api/deploy/plans",
      "/api/deploy/apply-runs",
      "/api/deploy/groups",
    ]
  ) {
    assert.equal(
      doc.paths[removedPath],
      undefined,
      `expected ${removedPath} removed`,
    );
  }
});

Deno.test("createPaaSOpenApiDocument emits all internal route skeleton paths", () => {
  const doc = allRoutesDoc();

  assert.equal(doc.paths["/internal/spaces"], undefined);
  assert.equal(doc.paths["/internal/groups"], undefined);
  assert.equal(doc.paths["/internal/deploy/plans"], undefined);
  assert.equal(doc.paths["/internal/deploy/applies"], undefined);
  assert.equal(doc.paths["/api/internal/v1/deploy/plans"], undefined);
  assert.equal(doc.paths["/api/internal/v1/deploy/applies"], undefined);
  assert.ok(doc.paths[TAKOSUMI_INTERNAL_PATHS.spaces]?.get);
  assert.ok(doc.paths[TAKOSUMI_INTERNAL_PATHS.spaces]?.post);
  assert.ok(doc.paths[TAKOSUMI_INTERNAL_PATHS.groups]?.get);
  assert.ok(doc.paths[TAKOSUMI_INTERNAL_PATHS.groups]?.post);
  assert.ok(doc.paths[TAKOSUMI_INTERNAL_PATHS.deployments]?.post);
  assert.ok(doc.paths[TAKOSUMI_INTERNAL_PATHS.deploymentApply]?.post);

  for (const path of Object.values(TAKOSUMI_INTERNAL_PATHS)) {
    const methods = doc.paths[path];
    assert.ok(methods, `missing ${path}`);
    for (const operation of Object.values(methods)) {
      assert.equal(operation?.["x-takos-auth"], "internal-service");
      assert.equal(
        operation?.security?.[0].internalService.length,
        0,
        `${path} should require internal service auth`,
      );
    }
  }
});

Deno.test("createPaaSOpenApiDocument covers current route inventory", () => {
  const doc = allRoutesDoc();
  const expected: Array<readonly ["delete" | "get" | "post", string]> = [
    ["get", "/health"],
    ["get", "/capabilities"],
    ["get", TAKOS_PAAS_PUBLIC_PATHS.capabilities],
    ["get", TAKOS_PAAS_PUBLIC_PATHS.spaces],
    ["post", TAKOS_PAAS_PUBLIC_PATHS.spaces],
    ["get", TAKOS_PAAS_PUBLIC_PATHS.groups],
    ["post", TAKOS_PAAS_PUBLIC_PATHS.groups],
    ["post", TAKOS_PAAS_PUBLIC_PATHS.deployments],
    ["get", TAKOS_PAAS_PUBLIC_PATHS.deployments],
    ["get", TAKOS_PAAS_PUBLIC_PATHS.deployment],
    ["post", TAKOS_PAAS_PUBLIC_PATHS.deploymentApply],
    ["post", TAKOS_PAAS_PUBLIC_PATHS.deploymentApprove],
    ["get", TAKOS_PAAS_PUBLIC_PATHS.deploymentObservations],
    ["get", TAKOS_PAAS_PUBLIC_PATHS.groupHead],
    ["post", TAKOS_PAAS_PUBLIC_PATHS.groupRollback],
    ["get", TAKOSUMI_INTERNAL_PATHS.spaces],
    ["post", TAKOSUMI_INTERNAL_PATHS.spaces],
    ["get", TAKOSUMI_INTERNAL_PATHS.groups],
    ["post", TAKOSUMI_INTERNAL_PATHS.groups],
    ["post", TAKOSUMI_INTERNAL_PATHS.deployments],
    ["post", TAKOSUMI_INTERNAL_PATHS.deploymentApply],
    ["post", TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll],
    ["post", TAKOS_PAAS_RUNTIME_AGENT_PATHS.heartbeat],
    ["post", TAKOS_PAAS_RUNTIME_AGENT_PATHS.lease],
    ["post", TAKOS_PAAS_RUNTIME_AGENT_PATHS.report],
    ["post", TAKOS_PAAS_RUNTIME_AGENT_PATHS.drain],
    ["post", TAKOS_PAAS_RUNTIME_AGENT_PATHS.gatewayManifest],
    ["get", TAKOS_PAAS_READINESS_PATHS.ready],
    ["get", TAKOS_PAAS_READINESS_PATHS.live],
    ["get", TAKOS_PAAS_READINESS_PATHS.statusSummary],
  ];

  for (const [method, path] of expected) {
    assert.ok(
      doc.paths[path]?.[method],
      `missing ${method.toUpperCase()} ${path}`,
    );
  }
});

Deno.test("createPaaSOpenApiDocument only emits mounted route families", () => {
  const doc = createPaaSOpenApiDocument({
    publicRoutesMounted: true,
  });

  assert.ok(doc.paths["/health"]?.get);
  assert.ok(doc.paths[TAKOS_PAAS_PUBLIC_PATHS.spaces]?.get);
  assert.equal(doc.paths[TAKOSUMI_INTERNAL_PATHS.spaces], undefined);
  assert.equal(doc.paths[TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll], undefined);
  assert.equal(doc.paths[TAKOS_PAAS_READINESS_PATHS.ready], undefined);
});

Deno.test("createPaaSOpenApiDocument describes runtime-agent and readiness auth", () => {
  const doc = allRoutesDoc();

  for (const path of Object.values(TAKOS_PAAS_RUNTIME_AGENT_PATHS)) {
    assert.equal(doc.paths[path]?.post?.["x-takos-auth"], "internal-service");
  }
  assert.deepEqual(
    doc.paths[TAKOS_PAAS_RUNTIME_AGENT_PATHS.heartbeat]?.post?.parameters,
    [{
      name: "agentId",
      in: "path",
      required: true,
      schema: { type: "string" },
    }],
  );
  for (const path of Object.values(TAKOS_PAAS_READINESS_PATHS)) {
    assert.equal(doc.paths[path]?.get?.["x-takos-auth"], "none");
  }
});

Deno.test("createPaaSOpenApiDocument documents space-scoped group head and rollback APIs", () => {
  const doc = allRoutesDoc();

  assert.deepEqual(
    doc.paths[TAKOS_PAAS_PUBLIC_PATHS.groupHead]?.get?.parameters,
    [
      {
        name: "groupId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "spaceId",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
    ],
  );
  assert.deepEqual(
    doc.components.schemas.GroupRollbackRequest.properties,
    {
      space_id: { type: "string" },
      spaceId: { type: "string" },
      target_id: { type: "string" },
    },
  );
});

Deno.test("createPaaSOpenApiDocument exposes the canonical condition reason catalog", () => {
  const doc = allRoutesDoc();

  assert.deepEqual(
    doc.components.schemas.CoreConditionReason.enum,
    [...CORE_CONDITION_REASONS],
  );
  assert.deepEqual(
    doc.components.schemas.Condition.properties,
    {
      type: { type: "string" },
      status: { enum: ["true", "false", "unknown"] },
      reason: { "$ref": "#/components/schemas/CoreConditionReason" },
      message: { type: "string" },
      observedGeneration: { type: "number" },
      lastTransitionAt: { type: "string", format: "date-time" },
    },
  );
});

Deno.test("createPaaSOpenApiDocument exposes Deployment / GroupHead / ProviderObservation schemas", () => {
  const doc = allRoutesDoc();
  assert.ok(doc.components.schemas.Deployment);
  assert.ok(doc.components.schemas.GroupHead);
  assert.ok(doc.components.schemas.ProviderObservation);
  assert.ok(doc.components.schemas.DeploymentMutationResponse);
});

function allRoutesDoc() {
  return createPaaSOpenApiDocument({
    publicRoutesMounted: true,
    internalRoutesMounted: true,
    runtimeAgentRoutesMounted: true,
    readinessRoutesMounted: true,
  });
}
