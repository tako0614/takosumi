import { expect, test } from "bun:test";
import { encodeActorContext } from "takosumi-contract/internal/rpc";
import { TAKOSUMI_INTERNAL_ACTOR_HEADER } from "takosumi-contract/reference/compat";
import { createApiApp } from "../../../core/api/app.ts";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
} from "../../../core/domains/interfaces/mod.ts";

async function app() {
  let id = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => "2026-07-16T12:00:00.000Z",
    newId: (prefix) => `${prefix}_${++id}`,
  });
  const api = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      getInterfaceBearerToken: () => "interface-token",
    },
    requestCorrelation: false,
  });
  return { api, service };
}

const controlHeaders = {
  "content-type": "application/json",
  authorization: "Bearer interface-token",
};

function capsuleActorHeaders(capsuleId: string, mutable = true) {
  return {
    ...controlHeaders,
    [TAKOSUMI_INTERNAL_ACTOR_HEADER]: encodeActorContext({
      actorAccountId: `capsule:${capsuleId}`,
      workspaceId: "ws_1",
      capsuleId,
      capsuleRunMutable: mutable,
      roles: ["capsule-runtime"],
      requestId: "req_test",
      principalKind: "service",
    }),
  };
}

function specBody(name: string, ownerId: string) {
  return {
    workspaceId: "ws_1",
    name,
    ownerRef: { kind: "Capsule", id: ownerId },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: { source: "literal", value: "https://app.example.test/mcp" },
      },
      access: { visibility: "workspace" },
    },
  };
}

test("capsule actor creates its own Interface with capsule_resource ownership", async () => {
  const { api } = await app();
  const created = await api.request("/v1/interfaces", {
    method: "POST",
    headers: capsuleActorHeaders("cap_1"),
    body: JSON.stringify(specBody("mcp", "cap_1")),
  });
  expect(created.status).toBe(201);
  const record = await created.json();
  expect(record.metadata.materializedFrom).toEqual({
    source: "capsule_resource",
  });

  // The same actor may update and retire its own declaration.
  const etag = created.headers.get("etag")!;
  const patched = await api.request(`/v1/interfaces/${record.metadata.id}`, {
    method: "PATCH",
    headers: { ...capsuleActorHeaders("cap_1"), "if-match": etag },
    body: JSON.stringify({ labels: { app: "demo" } }),
  });
  expect(patched.status).toBe(200);
});

test("capsule actor cannot declare for another Capsule", async () => {
  const { api } = await app();
  const created = await api.request("/v1/interfaces", {
    method: "POST",
    headers: capsuleActorHeaders("cap_1"),
    body: JSON.stringify(specBody("mcp", "cap_other")),
  });
  expect(created.status).toBe(403);
});

test("capsule actor cannot adopt a blueprint-materialized Interface", async () => {
  const { api, service } = await app();
  const [materialized] = await service.ensureCapsuleBlueprints({
    workspaceId: "ws_1",
    capsuleId: "cap_1",
    blueprints: [
      {
        key: "launcher",
        name: "launcher",
        spec: {
          type: "interface.ui.surface",
          version: "1",
          document: { launcher: true, display: { title: "Demo" } },
          access: { visibility: "workspace" },
        },
      },
    ],
  });
  const denied = await api.request(
    `/v1/interfaces/${materialized.metadata.id}`,
    {
      method: "PATCH",
      headers: { ...capsuleActorHeaders("cap_1"), "if-match": '"if-1-1"' },
      body: JSON.stringify({ labels: { app: "demo" } }),
    },
  );
  expect(denied.status).toBe(403);
});

test("capsule actor reads are confined to its own Capsule", async () => {
  const { api, service } = await app();
  // A foreign Capsule owns a private Interface with a resolved endpoint.
  await service.create({
    workspaceId: "ws_1",
    name: "foreign",
    ownerRef: { kind: "Capsule", id: "cap_other" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://foreign.example.test/mcp",
        },
      },
      access: { visibility: "private" },
    },
  });
  const own = await api.request("/v1/interfaces", {
    method: "POST",
    headers: capsuleActorHeaders("cap_1"),
    body: JSON.stringify(specBody("mine", "cap_1")),
  });
  const ownRecord = await own.json();

  // List returns only the caller's own Capsule Interfaces even without an
  // owner filter (the foreign private record must not appear).
  const listed = await api.request("/v1/interfaces?workspaceId=ws_1", {
    headers: capsuleActorHeaders("cap_1"),
  });
  const body = await listed.json();
  expect(
    body.interfaces.every(
      (item: { metadata: { ownerRef: { id: string } } }) =>
        item.metadata.ownerRef.id === "cap_1",
    ),
  ).toBe(true);
  expect(body.interfaces).toHaveLength(1);

  // A forced owner filter cannot widen the read: querying cap_other still
  // returns only the caller's own records (the override wins over the query).
  const forced = await api.request(
    "/v1/interfaces?workspaceId=ws_1&ownerKind=Capsule&ownerId=cap_other",
    { headers: capsuleActorHeaders("cap_1") },
  );
  const forcedBody = await forced.json();
  expect(
    forcedBody.interfaces.every(
      (item: { metadata: { ownerRef: { id: string } } }) =>
        item.metadata.ownerRef.id === "cap_1",
    ),
  ).toBe(true);
  expect(
    forcedBody.interfaces.some(
      (item: { metadata: { ownerRef: { id: string } } }) =>
        item.metadata.ownerRef.id === "cap_other",
    ),
  ).toBe(false);

  // Direct GET of the foreign record is not found, not forbidden.
  const foreignId = (
    await service.list({ workspaceId: "ws_1", ownerId: "cap_other" })
  )[0].metadata.id;
  const direct = await api.request(`/v1/interfaces/${foreignId}`, {
    headers: capsuleActorHeaders("cap_1"),
  });
  expect(direct.status).toBe(404);

  // The caller's own record is readable.
  const self = await api.request(`/v1/interfaces/${ownRecord.metadata.id}`, {
    headers: capsuleActorHeaders("cap_1"),
  });
  expect(self.status).toBe(200);
});

test("capsule actor never carries binding authority", async () => {
  const { api } = await app();
  const created = await api.request("/v1/interfaces", {
    method: "POST",
    headers: capsuleActorHeaders("cap_1"),
    body: JSON.stringify(specBody("mcp", "cap_1")),
  });
  const record = await created.json();
  const binding = await api.request(
    `/v1/interfaces/${record.metadata.id}/bindings`,
    {
      method: "POST",
      headers: capsuleActorHeaders("cap_1"),
      body: JSON.stringify({
        subjectRef: { kind: "Principal", id: "acct_1" },
        permissions: ["mcp.invoke"],
        delivery: { type: "none" },
      }),
    },
  );
  expect(binding.status).toBe(403);
});

test("a read-only run credential cannot mutate but can read and self-report", async () => {
  const { api } = await app();
  // Seed with a mutable (apply-run) credential.
  const created = await api.request("/v1/interfaces", {
    method: "POST",
    headers: capsuleActorHeaders("cap_1", true),
    body: JSON.stringify(specBody("mcp", "cap_1")),
  });
  const record = await created.json();
  const readOnly = capsuleActorHeaders("cap_1", false);

  // Create / update / delete are all denied for the read-only credential.
  const createDenied = await api.request("/v1/interfaces", {
    method: "POST",
    headers: readOnly,
    body: JSON.stringify(specBody("mcp2", "cap_1")),
  });
  expect(createDenied.status).toBe(403);

  const updateDenied = await api.request(
    `/v1/interfaces/${record.metadata.id}`,
    {
      method: "PATCH",
      headers: { ...readOnly, "if-match": created.headers.get("etag")! },
      body: JSON.stringify({ labels: { app: "x" } }),
    },
  );
  expect(updateDenied.status).toBe(403);

  const deleteDenied = await api.request(
    `/v1/interfaces/${record.metadata.id}`,
    {
      method: "DELETE",
      headers: { ...readOnly, "if-match": created.headers.get("etag")! },
    },
  );
  expect(deleteDenied.status).toBe(403);

  // Read and status self-report are allowed for the read-only credential.
  const read = await api.request(`/v1/interfaces/${record.metadata.id}`, {
    headers: readOnly,
  });
  expect(read.status).toBe(200);

  const status = await api.request(
    `/v1/interfaces/${record.metadata.id}/status`,
    {
      method: "POST",
      headers: readOnly,
      body: JSON.stringify({
        conditions: [{ type: "Healthy", status: "true" }],
      }),
    },
  );
  expect(status.status).toBe(200);
});

test("status self-report merges conditions without touching the revision", async () => {
  const { api } = await app();
  const created = await api.request("/v1/interfaces", {
    method: "POST",
    headers: capsuleActorHeaders("cap_1"),
    body: JSON.stringify(specBody("mcp", "cap_1")),
  });
  const record = await created.json();

  const reported = await api.request(
    `/v1/interfaces/${record.metadata.id}/status`,
    {
      method: "POST",
      headers: capsuleActorHeaders("cap_1"),
      body: JSON.stringify({
        conditions: [{ type: "Healthy", status: "true", reason: "Heartbeat" }],
      }),
    },
  );
  expect(reported.status).toBe(200);
  const updated = await reported.json();
  expect(updated.status.resolvedRevision).toBe(record.status.resolvedRevision);
  expect(
    updated.status.conditions.some(
      (item: { type: string }) => item.type === "Healthy",
    ),
  ).toBe(true);

  // Observer-owned lifecycle conditions are not self-reportable.
  const reserved = await api.request(
    `/v1/interfaces/${record.metadata.id}/status`,
    {
      method: "POST",
      headers: capsuleActorHeaders("cap_1"),
      body: JSON.stringify({
        conditions: [{ type: "Drifted", status: "true" }],
      }),
    },
  );
  expect(reserved.status).toBe(400);

  // A foreign Capsule's credential cannot report for this Interface.
  const foreign = await api.request(
    `/v1/interfaces/${record.metadata.id}/status`,
    {
      method: "POST",
      headers: capsuleActorHeaders("cap_2"),
      body: JSON.stringify({
        conditions: [{ type: "Healthy", status: "false" }],
      }),
    },
  );
  expect(foreign.status).toBe(403);
});

test("blueprint composes bindings onto a capsule_resource Interface without rewriting it", async () => {
  const { api, service } = await app();
  const created = await api.request("/v1/interfaces", {
    method: "POST",
    headers: capsuleActorHeaders("cap_1"),
    body: JSON.stringify(specBody("mcp", "cap_1")),
  });
  expect(created.status).toBe(201);
  const declared = await created.json();

  const materialized = await service.ensureCapsuleBlueprints({
    workspaceId: "ws_1",
    capsuleId: "cap_1",
    blueprints: [
      {
        key: "mcp",
        name: "mcp",
        spec: {
          type: "mcp.server",
          version: "2025-11-25",
          document: { transport: "http", display: { title: "Rewritten" } },
          access: { visibility: "workspace" },
        },
        bindings: [
          {
            key: "mcp.installer",
            subjectRef: { kind: "Principal", id: "acct_1" },
            permissions: ["mcp.invoke"],
            delivery: { type: "none" },
          },
        ],
      },
    ],
  });
  // The module-declared Interface owns name + spec; the blueprint's spec is
  // ignored while its binding proposals still compose onto the record.
  expect(materialized).toHaveLength(1);
  expect(materialized[0].metadata.id).toBe(declared.metadata.id);
  expect(materialized[0].metadata.materializedFrom).toEqual({
    source: "capsule_resource",
  });
  expect(materialized[0].spec.document).toEqual({
    transport: "streamable-http",
  });
  const bindings = await service.listBindings(declared.metadata.id);
  expect(bindings).toHaveLength(1);
  expect(bindings[0].spec.subjectRef).toEqual({
    kind: "Principal",
    id: "acct_1",
  });
});
