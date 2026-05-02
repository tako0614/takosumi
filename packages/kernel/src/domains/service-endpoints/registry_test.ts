import assert from "node:assert/strict";
import {
  InMemoryServiceEndpointStore,
  InMemoryServiceGrantStore,
  InMemoryServiceTrustRecordStore,
  type ServiceEndpoint,
  ServiceEndpointRegistry,
  type ServiceGrant,
  type ServiceTrustRecord,
} from "./mod.ts";

Deno.test("service endpoint registry keeps endpoint, trust, and grants separate", async () => {
  const registry = createRegistry();
  await registry.registerEndpoint(endpoint());
  await registry.recordTrust(trustRecord());
  await registry.grantAccess(grant());

  const stored = await registry.getEndpoint("endpoint_web_internal");
  assert.equal(stored?.name, "internal-http");
  assert.equal(stored?.health.status, "unknown");
  assert.equal(
    "level" in (stored as unknown as Record<string, unknown>),
    false,
  );
  assert.equal(
    "subject" in (stored as unknown as Record<string, unknown>),
    false,
  );

  const effective = await registry.listEffectiveGrantsForEndpoint(
    "endpoint_web_internal",
    "2026-04-27T00:02:00.000Z",
  );
  assert.equal(effective.length, 1);
  assert.equal(effective[0]?.subject, "workload:space_a/group_a/worker");
});

Deno.test("service endpoint health updates do not rewrite trust records or grants", async () => {
  const registry = createRegistry();
  await registry.registerEndpoint(endpoint());
  await registry.recordTrust(trustRecord());
  await registry.grantAccess(grant());

  const updated = await registry.updateHealth("endpoint_web_internal", {
    status: "degraded",
    checkedAt: "2026-04-27T00:05:00.000Z",
    message: "readiness probe failed",
  });

  assert.equal(updated?.health.status, "degraded");
  assert.equal(updated?.health.message, "readiness probe failed");
  assert.equal(updated?.updatedAt, "2026-04-27T00:05:00.000Z");

  const effective = await registry.listEffectiveGrantsForEndpoint(
    "endpoint_web_internal",
    "2026-04-27T00:05:00.000Z",
  );
  assert.equal(effective.length, 1);
  assert.equal(effective[0]?.id, "grant_worker_call_web");
});

Deno.test("trust revoke removes effective grants without deleting endpoint", async () => {
  const registry = createRegistry();
  await registry.registerEndpoint(endpoint());
  await registry.recordTrust(trustRecord());
  await registry.grantAccess(grant());

  const revoked = await registry.revokeTrust("trust_web_internal", {
    revokedAt: "2026-04-27T00:10:00.000Z",
    revokedBy: "actor_admin",
    reason: "rotated service identity",
  });

  assert.equal(revoked?.status, "revoked");
  assert.equal(revoked?.revokedBy, "actor_admin");
  assert.equal(revoked?.revokeReason, "rotated service identity");

  const endpointAfterRevoke = await registry.getEndpoint(
    "endpoint_web_internal",
  );
  assert.equal(endpointAfterRevoke?.id, "endpoint_web_internal");

  const effective = await registry.listEffectiveGrantsForEndpoint(
    "endpoint_web_internal",
    "2026-04-27T00:11:00.000Z",
  );
  assert.deepEqual(effective, []);
});

function createRegistry(): ServiceEndpointRegistry {
  return new ServiceEndpointRegistry({
    endpoints: new InMemoryServiceEndpointStore(),
    trustRecords: new InMemoryServiceTrustRecordStore(),
    grants: new InMemoryServiceGrantStore(),
  });
}

function endpoint(): ServiceEndpoint {
  return {
    id: "endpoint_web_internal",
    serviceId: "svc_web",
    spaceId: "space_a",
    groupId: "group_a",
    name: "internal-http",
    protocol: "https",
    host: "web.group-a.svc.cluster.local",
    port: 8443,
    pathPrefix: "/internal",
    health: {
      status: "unknown",
      checkedAt: "2026-04-27T00:00:00.000Z",
    },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  };
}

function trustRecord(): ServiceTrustRecord {
  return {
    id: "trust_web_internal",
    endpointId: "endpoint_web_internal",
    serviceId: "svc_web",
    spaceId: "space_a",
    groupId: "group_a",
    level: "group",
    audience: ["workload:space_a/group_a/worker"],
    issuer: "takosumi",
    status: "active",
    createdAt: "2026-04-27T00:01:00.000Z",
    updatedAt: "2026-04-27T00:01:00.000Z",
  };
}

function grant(): ServiceGrant {
  return {
    id: "grant_worker_call_web",
    trustRecordId: "trust_web_internal",
    endpointId: "endpoint_web_internal",
    subject: "workload:space_a/group_a/worker",
    action: "service.call",
    resource: "svc_web/internal-http",
    effect: "allow",
    conditions: [],
    createdAt: "2026-04-27T00:01:30.000Z",
  };
}
