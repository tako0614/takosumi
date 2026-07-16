import { expect, test } from "bun:test";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
  OutputBackedInterfaceInputResolver,
  validateCapsuleInterfaceBlueprints,
} from "../../../../core/domains/interfaces/mod.ts";
import { createInMemoryResourceShapeStores } from "../../../../core/domains/resource-shape/mod.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const NOW = "2026-07-13T12:00:00.000Z";

async function outputBackedService() {
  const opentofu = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(opentofu, {
    workspaceId: "workspace_1",
    capsuleId: "capsule_mcp",
    name: "mcp-app",
  });
  await opentofu.putOutput({
    id: "out_mcp_1",
    workspaceId: "workspace_1",
    capsuleId: seeded.capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "sealed/out_mcp_1",
    publicOutputs: { endpoint: "https://mcp.example.test/mcp" },
    workspaceOutputs: {
      endpoint: "https://mcp.example.test/mcp",
      nested: {
        urls: ["https://one.example.test", "https://two.example.test"],
      },
      protocol_metadata: {
        token: "oauth2",
        credential: { mode: "invocation" },
        password: false,
      },
    },
    outputDigest: "sha256:" + "a".repeat(64),
    createdAt: NOW,
  });
  await opentofu.putStateVersion({
    id: "state_mcp_1",
    workspaceId: "workspace_1",
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 1,
    stateRef: "sealed/state_mcp_1",
    digest: "sha256:" + "b".repeat(64),
    createdByRunId: "apply_mcp_1",
    createdAt: NOW,
  });
  await opentofu.patchCapsule(seeded.capsule.id, {
    currentOutputId: "out_mcp_1",
    currentStateGeneration: 1,
    status: "active",
  });
  let id = 0;
  return new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    resolver: new OutputBackedInterfaceInputResolver({ opentofu }),
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++id}`,
  });
}

test("Interface keeps arbitrary JSON separate from resolved ordinary Outputs", async () => {
  const service = await outputBackedService();
  const record = await service.create({
    workspaceId: "workspace_1",
    name: "main-mcp",
    ownerRef: { kind: "Capsule", id: "capsule_mcp" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: {
        transport: "streamable-http",
        display: { title: "Example MCP" },
        extension: { arbitrary: [true, 42, "kept"] },
      },
      inputs: {
        endpoint: {
          source: "capsule_output",
          capsuleId: "capsule_mcp",
          outputName: "endpoint",
        },
        secondary: {
          source: "capsule_output",
          capsuleId: "capsule_mcp",
          outputName: "nested",
          pointer: "/urls/1",
        },
        protocolMetadata: {
          source: "capsule_output",
          capsuleId: "capsule_mcp",
          outputName: "protocol_metadata",
        },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  });

  expect(record.status.phase).toBe("Resolved");
  expect(record.status.resolvedRevision).toBe(1);
  expect(record.spec.document).toEqual({
    transport: "streamable-http",
    display: { title: "Example MCP" },
    extension: { arbitrary: [true, 42, "kept"] },
  });
  expect(record.status.resolvedInputs).toEqual({
    endpoint: "https://mcp.example.test/mcp",
    secondary: "https://two.example.test",
    protocolMetadata: {
      token: "oauth2",
      credential: { mode: "invocation" },
      password: false,
    },
  });
  expect(record.status.provenance?.endpoint).toMatchObject({
    source: "capsule_output",
    outputId: "out_mcp_1",
    outputName: "endpoint",
  });
});

test("missing or sensitive Outputs fail closed without exposing a stale value", async () => {
  const service = await outputBackedService();
  const record = await service.create({
    workspaceId: "workspace_1",
    name: "missing-secret",
    ownerRef: { kind: "Capsule", id: "capsule_mcp" },
    spec: {
      type: "custom.protocol",
      version: "v1",
      document: { enabled: true },
      inputs: {
        token: {
          source: "capsule_output",
          capsuleId: "capsule_mcp",
          outputName: "admin_token",
        },
      },
      access: { visibility: "private" },
    },
  });

  expect(record.status.phase).toBe("NotReady");
  expect(record.status.resolvedInputs).toBeUndefined();
  expect(record.status.conditions?.[0]?.message).toContain(
    "missing, sensitive, or excluded",
  );
});

test("unsupported binding delivery is persisted as a reference and stays NotReady", async () => {
  const service = await outputBackedService();
  const iface = await service.create({
    workspaceId: "workspace_1",
    name: "literal-service",
    ownerRef: { kind: "Workspace", id: "workspace_1" },
    spec: {
      type: "example.service",
      version: "v1",
      document: { protocol: "example" },
      inputs: {
        endpoint: { source: "literal", value: "https://example.test" },
      },
      access: { visibility: "workspace" },
    },
  });
  const binding = await service.createBinding(iface.metadata.id, {
    subjectRef: { kind: "ServiceAccount", id: "takos-runtime" },
    permissions: ["invoke"],
    delivery: {
      type: "future-workload-token",
      credentialRef: "credential/runtime-example",
    },
  });

  expect(binding.status.phase).toBe("NotReady");
  expect(binding.spec.delivery).toEqual({
    type: "future-workload-token",
    credentialRef: "credential/runtime-example",
  });
  expect(JSON.stringify(binding)).not.toContain("secretValue");
});

test("Principal oauth2 delivery requires the host issuer and mints only from an exact Ready binding", async () => {
  const stores = createInMemoryInterfaceStores();
  const issued: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  let id = 0;
  const service = new InterfaceService({
    stores,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++id}`,
    oauth2ResourceAuthorizer: () => true,
    credentialIssuer: {
      issuePrincipalOAuth2Token: (input) => {
        issued.push(input as unknown as Record<string, unknown>);
        return Promise.resolve({
          accessToken: "taksrv_runtime_only_value",
          expiresAt: "2026-07-13T12:01:00.000Z",
        });
      },
    },
    activity: {
      record: (event) => {
        activities.push(event as unknown as Record<string, unknown>);
        return Promise.resolve();
      },
    },
  });
  const iface = await service.create({
    workspaceId: "workspace_1",
    name: "oauth-mcp",
    ownerRef: { kind: "Capsule", id: "capsule_mcp" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://mcp.example.test/mcp?view=tools#catalog",
        },
      },
      access: { visibility: "private", resourceUriInput: "endpoint" },
    },
  });
  const binding = await service.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "principal_1" },
    permissions: ["mcp.invoke"],
    delivery: { type: "oauth2" },
  });
  expect(binding.status.phase).toBe("Ready");

  const workload = await service.createBinding(iface.metadata.id, {
    subjectRef: { kind: "ServiceAccount", id: "service_account_1" },
    permissions: ["mcp.invoke"],
    delivery: { type: "workload_token" },
  });
  expect(workload.status).toMatchObject({
    phase: "NotReady",
    conditions: [{ reason: "UnsupportedDelivery" }],
  });

  const token = await service.issueToken(
    iface.metadata.id,
    { permission: "mcp.invoke" },
    { workspaceId: "workspace_1", subjectId: "principal_1" },
    {
      actorAccountId: "principal_1",
      roles: ["runtime-principal"],
      requestId: "request_token_1",
      workspaceId: "workspace_1",
    },
  );
  expect(token).toEqual({
    access_token: "taksrv_runtime_only_value",
    token_type: "Bearer",
    expires_in: 60,
    expires_at: "2026-07-13T12:01:00.000Z",
    scope: "mcp.invoke",
    resource: "https://mcp.example.test/mcp",
  });
  expect(issued).toEqual([
    expect.objectContaining({
      issuedAt: NOW,
      workspaceId: "workspace_1",
      interfaceId: iface.metadata.id,
      interfaceGeneration: 1,
      interfaceResolvedRevision: 1,
      bindingId: binding.metadata.id,
      bindingGeneration: 1,
      subjectId: "principal_1",
      permission: "mcp.invoke",
      resource: "https://mcp.example.test/mcp",
    }),
  ]);
  expect(
    JSON.stringify(await stores.interfaces.get(iface.metadata.id)),
  ).not.toContain("taksrv_runtime_only_value");
  expect(
    JSON.stringify(await stores.bindings.listByInterface(iface.metadata.id)),
  ).not.toContain("taksrv_runtime_only_value");
  expect(JSON.stringify(activities)).not.toContain("taksrv_runtime_only_value");
  expect(activities.at(-1)).toMatchObject({
    action: "interface_token.issued",
    targetId: binding.metadata.id,
  });

  await expect(
    service.issueToken(
      iface.metadata.id,
      { permission: "mcp.admin" },
      { workspaceId: "workspace_1", subjectId: "principal_1" },
    ),
  ).rejects.toThrow("Interface token grant not found");
  await expect(
    service.issueToken(
      iface.metadata.id,
      { permission: "mcp.invoke" },
      { workspaceId: "workspace_2", subjectId: "principal_1" },
    ),
  ).rejects.toThrow("Interface not found");

  await service.revokeBinding(iface.metadata.id, binding.metadata.id);
  await expect(
    service.issueToken(
      iface.metadata.id,
      { permission: "mcp.invoke" },
      { workspaceId: "workspace_1", subjectId: "principal_1" },
    ),
  ).rejects.toThrow("Interface token grant not found");
  expect(issued).toHaveLength(1);

  const withoutIssuer = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
  });
  const unissuedInterface = await withoutIssuer.create({
    workspaceId: "workspace_1",
    name: "issuer-required",
    ownerRef: { kind: "Workspace", id: "workspace_1" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      inputs: {
        endpoint: { source: "literal", value: "https://mcp.example.test/mcp" },
      },
      access: { visibility: "private", resourceUriInput: "endpoint" },
    },
  });
  expect(
    (
      await withoutIssuer.createBinding(unissuedInterface.metadata.id, {
        subjectRef: { kind: "Principal", id: "principal_1" },
        permissions: ["mcp.invoke"],
        delivery: { type: "oauth2" },
      })
    ).status.phase,
  ).toBe("NotReady");
});

test("oauth2 delivery never treats an arbitrary resolved URL as resource authority", async () => {
  let issuerCalls = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
    oauth2ResourceAuthorizer: () => false,
    credentialIssuer: {
      issuePrincipalOAuth2Token: () => {
        issuerCalls += 1;
        return Promise.resolve({
          accessToken: "taksrv_must_not_issue",
          expiresAt: "2026-07-13T12:01:00.000Z",
        });
      },
    },
  });
  const iface = await service.create({
    workspaceId: "workspace_victim_guard",
    name: "unowned-resource",
    ownerRef: { kind: "Capsule", id: "capsule_attacker" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://victim.example.test/mcp",
        },
      },
      access: { visibility: "private", resourceUriInput: "endpoint" },
    },
  });
  const binding = await service.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "principal_attacker" },
    permissions: ["mcp.invoke"],
    delivery: { type: "oauth2" },
  });
  expect(binding.status.phase).toBe("NotReady");
  expect(binding.status.conditions[0]?.reason).toBe(
    "OAuthResourceUnauthorized",
  );
  await expect(
    service.issueToken(
      iface.metadata.id,
      { permission: "mcp.invoke" },
      {
        workspaceId: "workspace_victim_guard",
        subjectId: "principal_attacker",
      },
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(issuerCalls).toBe(0);
});

test("Interface token issuance rechecks the lifecycle fence before calling the host issuer", async () => {
  let unsafe = false;
  let issuerCalls = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
    lifecycleGuard: () =>
      Promise.resolve(
        unsafe
          ? {
              ok: false as const,
              phase: "Unknown" as const,
              reason: "RunLedgerUnsafe",
              message: "Capsule mutation requires recovery",
            }
          : undefined,
      ),
    oauth2ResourceAuthorizer: () => true,
    credentialIssuer: {
      issuePrincipalOAuth2Token: () => {
        issuerCalls += 1;
        return Promise.resolve({
          accessToken: "taksrv_never_returned",
          expiresAt: "2026-07-13T12:01:00.000Z",
        });
      },
    },
  });
  const iface = await service.create({
    workspaceId: "workspace_1",
    name: "guarded-oauth",
    ownerRef: { kind: "Workspace", id: "workspace_1" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      inputs: {
        endpoint: { source: "literal", value: "https://mcp.example.test/mcp" },
      },
      access: { visibility: "private", resourceUriInput: "endpoint" },
    },
  });
  const binding = await service.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "principal_1" },
    permissions: ["mcp.invoke"],
    delivery: { type: "oauth2" },
  });
  expect(binding.status.phase).toBe("Ready");

  unsafe = true;
  await expect(
    service.issueToken(
      iface.metadata.id,
      { permission: "mcp.invoke" },
      { workspaceId: "workspace_1", subjectId: "principal_1" },
    ),
  ).rejects.toThrow("Interface token grant not found");
  expect(issuerCalls).toBe(0);
  expect((await service.get(iface.metadata.id)).status.phase).toBe("Unknown");
  expect(
    (await service.getBinding(iface.metadata.id, binding.metadata.id)).status,
  ).toMatchObject({ phase: "NotReady", observedInterfaceRevision: 2 });
});

test("Interface token issuance does not return a token when lifecycle changes inside the issuer boundary", async () => {
  let unsafe = false;
  let issuerCalls = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
    lifecycleGuard: () =>
      Promise.resolve(
        unsafe
          ? {
              ok: false as const,
              phase: "Unknown" as const,
              reason: "RunLedgerUnsafe",
              message: "Capsule mutation requires recovery",
            }
          : undefined,
      ),
    oauth2ResourceAuthorizer: () => true,
    credentialIssuer: {
      issuePrincipalOAuth2Token: () => {
        issuerCalls += 1;
        unsafe = true;
        return Promise.resolve({
          accessToken: "taksrv_losing_lifecycle_race",
          expiresAt: "2026-07-13T12:01:00.000Z",
        });
      },
    },
  });
  const iface = await service.create({
    workspaceId: "workspace_1",
    name: "issuer-race-oauth",
    ownerRef: { kind: "Workspace", id: "workspace_1" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      inputs: {
        endpoint: { source: "literal", value: "https://mcp.example.test/mcp" },
      },
      access: { visibility: "private", resourceUriInput: "endpoint" },
    },
  });
  const binding = await service.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "principal_1" },
    permissions: ["mcp.invoke"],
    delivery: { type: "oauth2" },
  });

  await expect(
    service.issueToken(
      iface.metadata.id,
      { permission: "mcp.invoke" },
      { workspaceId: "workspace_1", subjectId: "principal_1" },
    ),
  ).rejects.toThrow(
    "Interface authorization changed during credential issuance",
  );
  expect(issuerCalls).toBe(1);
  expect((await service.get(iface.metadata.id)).status.phase).toBe("Unknown");
  expect(
    (await service.getBinding(iface.metadata.id, binding.metadata.id)).status
      .phase,
  ).toBe("NotReady");
});

test("Binding creation rechecks the lifecycle fence before becoming Ready", async () => {
  let unsafe = false;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
    lifecycleGuard: () =>
      Promise.resolve(
        unsafe
          ? {
              ok: false as const,
              phase: "Unknown" as const,
              reason: "RunLedgerUnsafe",
              message: "Capsule mutation requires recovery",
            }
          : undefined,
      ),
  });
  const iface = await service.create({
    workspaceId: "workspace_1",
    name: "guarded-service",
    ownerRef: { kind: "Workspace", id: "workspace_1" },
    spec: {
      type: "example.service",
      version: "v1",
      document: { protocol: "example" },
      inputs: {
        endpoint: { source: "literal", value: "https://example.test" },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  });
  expect(iface.status.phase).toBe("Resolved");

  // Model a durable ledger change whose best-effort observer was lost. The
  // stored Interface is still Resolved, but Binding issuance must repair it.
  unsafe = true;
  const binding = await service.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "principal_1" },
    permissions: ["invoke"],
    delivery: { type: "none" },
  });
  expect(binding.status.phase).toBe("NotReady");
  expect((await service.get(iface.metadata.id)).status.phase).toBe("Unknown");
});

test("service-side Capsule blueprints materialize once and never overwrite the accepted Interface", async () => {
  const service = await outputBackedService();
  const blueprint = {
    key: "catalog-mcp-v1",
    name: "catalog-mcp",
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http", display: { title: "Catalog" } },
      inputs: {
        endpoint: { source: "capsule_output" as const, outputName: "endpoint" },
      },
      access: {
        visibility: "workspace" as const,
        resourceUriInput: "endpoint",
      },
    },
  };
  const [created] = await service.ensureCapsuleBlueprints({
    workspaceId: "workspace_1",
    capsuleId: "capsule_mcp",
    blueprints: [blueprint],
  });
  expect(created?.status.phase).toBe("Resolved");
  expect(created?.spec.inputs?.endpoint).toMatchObject({
    source: "capsule_output",
    capsuleId: "capsule_mcp",
    outputName: "endpoint",
  });

  const changed = await service.update(
    created!.metadata.id,
    {
      name: "renamed-by-operator",
      spec: {
        ...created!.spec,
        document: {
          transport: "streamable-http",
          display: { title: "User edit" },
        },
      },
    },
    created!.metadata.generation,
  );
  const [ensuredAgain] = await service.ensureCapsuleBlueprints({
    workspaceId: "workspace_1",
    capsuleId: "capsule_mcp",
    blueprints: [blueprint],
  });
  expect(ensuredAgain?.metadata.id).toBe(changed.metadata.id);
  expect(ensuredAgain?.metadata.name).toBe("renamed-by-operator");
  expect(ensuredAgain?.spec.document).toEqual({
    transport: "streamable-http",
    display: { title: "User edit" },
  });

  const retired = await service.retire(
    changed.metadata.id,
    changed.metadata.generation,
  );
  const [afterRetirement] = await service.ensureCapsuleBlueprints({
    workspaceId: "workspace_1",
    capsuleId: "capsule_mcp",
    blueprints: [blueprint],
  });
  expect(afterRetirement?.metadata.id).toBe(retired.metadata.id);
  expect(afterRetirement?.status.phase).toBe("Retired");
});

test("Capsule blueprint bindings repair a crash gap once and preserve revocation", async () => {
  let id = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++id}`,
    oauth2ResourceAuthorizer: () => true,
    credentialIssuer: {
      issuePrincipalOAuth2Token: () =>
        Promise.resolve({
          accessToken: "taksrv_blueprint",
          expiresAt: "2026-07-13T12:01:00.000Z",
        }),
    },
  });
  const blueprint = {
    key: "catalog-mcp-v2",
    name: "catalog-mcp-binding",
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "literal" as const,
          value: "https://mcp.example.test/mcp",
        },
      },
      access: {
        visibility: "workspace" as const,
        resourceUriInput: "endpoint",
      },
    },
    bindings: [
      {
        key: "takos-principal",
        subjectRef: { kind: "Principal" as const, id: "principal_1" },
        permissions: ["mcp.invoke"],
        delivery: { type: "oauth2" },
      },
    ],
  };

  // Model a crash after the Interface row committed but before its proposal
  // binding was materialized. Hydration must fill only that missing record.
  const iface = await service.create(
    {
      workspaceId: "workspace_1",
      name: blueprint.name,
      ownerRef: { kind: "Capsule", id: "capsule_mcp" },
      spec: blueprint.spec,
    },
    undefined,
    { capsuleBlueprintKey: blueprint.key },
  );
  expect(await service.listBindings(iface.metadata.id)).toHaveLength(0);

  await service.ensureCapsuleBlueprints({
    workspaceId: "workspace_1",
    capsuleId: "capsule_mcp",
    blueprints: [blueprint],
  });
  const [binding] = await service.listBindings(iface.metadata.id);
  expect(binding).toMatchObject({
    metadata: {
      materializedFrom: {
        source: "capsule_blueprint",
        interfaceKey: "catalog-mcp-v2",
        key: "takos-principal",
      },
    },
    spec: {
      subjectRef: { kind: "Principal", id: "principal_1" },
      permissions: ["mcp.invoke"],
      delivery: { type: "oauth2" },
    },
    status: { phase: "Ready" },
  });

  await service.ensureCapsuleBlueprints({
    workspaceId: "workspace_1",
    capsuleId: "capsule_mcp",
    blueprints: [blueprint],
  });
  expect(await service.listBindings(iface.metadata.id)).toHaveLength(1);

  await service.revokeBinding(iface.metadata.id, binding!.metadata.id);
  await service.ensureCapsuleBlueprints({
    workspaceId: "workspace_1",
    capsuleId: "capsule_mcp",
    blueprints: [blueprint],
  });
  const afterRevocation = await service.listBindings(iface.metadata.id);
  expect(afterRevocation).toHaveLength(1);
  expect(afterRevocation[0]?.status.phase).toBe("Revoked");
});

test("fail-closed lifecycle and binding refresh converge after CAS races", async () => {
  const base = createInMemoryInterfaceStores();
  let failInterfaceCas = 0;
  let failBindingCas = 0;
  const service = new InterfaceService({
    stores: {
      interfaces: {
        ...base.interfaces,
        create: (record) => base.interfaces.create(record),
        get: (id) => base.interfaces.get(id),
        getByName: (input) => base.interfaces.getByName(input),
        list: (filter) => base.interfaces.list(filter),
        compareAndSet: (record, expected) => {
          if (failInterfaceCas > 0) {
            failInterfaceCas -= 1;
            return Promise.resolve(false);
          }
          return base.interfaces.compareAndSet(record, expected);
        },
      },
      bindings: {
        ...base.bindings,
        create: (record) => base.bindings.create(record),
        get: (id) => base.bindings.get(id),
        listByInterface: (id) => base.bindings.listByInterface(id),
        compareAndSet: (record, expected) => {
          if (failBindingCas > 0) {
            failBindingCas -= 1;
            return Promise.resolve(false);
          }
          return base.bindings.compareAndSet(record, expected);
        },
      },
    },
    now: () => NOW,
  });
  const iface = await service.create({
    workspaceId: "workspace_1",
    name: "racy-mcp",
    ownerRef: { kind: "Capsule", id: "capsule_mcp" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: { source: "literal", value: "https://mcp.example.test" },
      },
      access: { visibility: "workspace" },
    },
  });
  const binding = await service.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "principal_1" },
    permissions: ["mcp.invoke"],
    delivery: { type: "none" },
  });
  expect(binding.status.phase).toBe("Ready");

  failInterfaceCas = 1;
  failBindingCas = 1;
  await service.markCapsuleUnknown(
    "workspace_1",
    "capsule_mcp",
    "apply failed after dispatch",
  );

  expect((await service.get(iface.metadata.id)).status.phase).toBe("Unknown");
  expect(
    (await service.getBinding(iface.metadata.id, binding.metadata.id)).status,
  ).toMatchObject({
    phase: "NotReady",
    observedInterfaceRevision: 2,
  });
});

test("Resource lifecycle reconciles owners and resource_output dependants fail closed", async () => {
  const opentofu = new InMemoryOpenTofuControlStore();
  const resources = createInMemoryResourceShapeStores();
  const resourceId = "tkrn:workspace_1:ObjectBucket:assets";
  await resources.resources.upsert({
    id: resourceId,
    spaceId: "resource_space_1",
    kind: "ObjectBucket",
    name: "assets",
    managedBy: "opentofu",
    spec: { name: "assets" },
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    outputs: { endpoint: "https://objects.example.test" },
    createdAt: NOW,
    updatedAt: NOW,
  });
  let id = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    resolver: new OutputBackedInterfaceInputResolver({
      opentofu,
      resources: resources.resources,
      resolveResourceWorkspace: async ({ resourceSpaceId, resourceId: id }) =>
        resourceSpaceId === "resource_space_1" && id === resourceId
          ? "workspace_1"
          : undefined,
    }),
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++id}`,
  });
  const owner = await service.create({
    workspaceId: "workspace_1",
    name: "bucket-runtime",
    ownerRef: { kind: "Resource", id: resourceId },
    spec: {
      type: "storage.object",
      version: "v1",
      document: { protocol: "https" },
      inputs: {
        endpoint: {
          source: "resource_output",
          resourceId,
          outputName: "endpoint",
        },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  });
  const dependant = await service.create({
    workspaceId: "workspace_1",
    name: "workspace-storage",
    ownerRef: { kind: "Workspace", id: "workspace_1" },
    spec: {
      type: "storage.object.consumer",
      version: "v1",
      document: { protocol: "https" },
      inputs: {
        endpoint: {
          source: "resource_output",
          resourceId,
          outputName: "endpoint",
        },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  });
  const binding = await service.createBinding(owner.metadata.id, {
    subjectRef: { kind: "Principal", id: "storage-consumer" },
    permissions: ["storage.read"],
    delivery: { type: "none" },
  });
  expect(owner.status.phase).toBe("Resolved");
  expect(dependant.status.phase).toBe("Resolved");
  expect(binding.status.phase).toBe("Ready");

  await service.repairResourceLifecycles("workspace_1", [
    {
      resourceId,
      phase: "unknown",
      message: "Resource apply failed after backend dispatch",
    },
  ]);
  expect((await service.get(owner.metadata.id)).status.phase).toBe("Unknown");
  expect((await service.get(dependant.metadata.id)).status.phase).toBe(
    "Unknown",
  );
  expect(
    (await service.getBinding(owner.metadata.id, binding.metadata.id)).status
      .phase,
  ).toBe("NotReady");

  await service.repairResourceLifecycles("workspace_1", [
    { resourceId, phase: "ready" },
  ]);
  expect((await service.get(owner.metadata.id)).status.phase).toBe("Resolved");
  expect((await service.get(dependant.metadata.id)).status.phase).toBe(
    "Resolved",
  );

  const readyResource = await resources.resources.get(resourceId);
  expect(readyResource).toBeDefined();
  await resources.resources.upsert({
    ...readyResource!,
    phase: "Deleting",
    updatedAt: NOW,
  });
  await service.repairResourceLifecycles("workspace_1", [
    { resourceId, phase: "terminating" },
  ]);
  expect((await service.get(owner.metadata.id)).status.phase).toBe(
    "Terminating",
  );
  expect((await service.get(dependant.metadata.id)).status.phase).toBe(
    "NotReady",
  );

  await resources.resources.delete(resourceId);
  await service.repairResourceLifecycles("workspace_1", [
    { resourceId, phase: "retired" },
  ]);
  expect((await service.get(owner.metadata.id)).status.phase).toBe("Retired");
  expect((await service.get(dependant.metadata.id)).status.phase).toBe(
    "NotReady",
  );
  expect(
    (await service.getBinding(owner.metadata.id, binding.metadata.id)).status
      .phase,
  ).toBe("Revoked");
});

test("reconcile is a semantic no-op and keeps the same representation", async () => {
  const stores = createInMemoryInterfaceStores();
  let writes = 0;
  let now = "2026-07-13T12:00:00.000Z";
  const service = new InterfaceService({
    stores: {
      interfaces: {
        create: (record) => stores.interfaces.create(record),
        get: (id) => stores.interfaces.get(id),
        getByName: (input) => stores.interfaces.getByName(input),
        list: (filter) => stores.interfaces.list(filter),
        compareAndSet: (record, expected) => {
          writes += 1;
          return stores.interfaces.compareAndSet(record, expected);
        },
      },
      bindings: stores.bindings,
    },
    now: () => now,
  });
  const created = await service.create({
    workspaceId: "workspace_1",
    name: "stable-runtime",
    ownerRef: { kind: "Workspace", id: "workspace_1" },
    spec: {
      type: "example.runtime",
      version: "v1",
      document: { protocol: "https" },
      inputs: {
        endpoint: { source: "literal", value: "https://example.test" },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  });
  writes = 0;
  now = "2026-07-13T13:00:00.000Z";
  const reconciled = await service.reconcile(created.metadata.id);
  expect(writes).toBe(0);
  expect(reconciled).toEqual(created);
  expect(reconciled.metadata.updatedAt).toBe(created.metadata.updatedAt);
});

test("Interface validation keeps opaque JSON and rejects invalid OAuth resource URIs", async () => {
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
  });
  const base = {
    workspaceId: "workspace_1",
    name: "validated-runtime",
    ownerRef: { kind: "Workspace" as const, id: "workspace_1" },
    spec: {
      type: "example.runtime",
      version: "v1",
      document: { protocol: "https" },
      inputs: {
        endpoint: { source: "literal" as const, value: "https://example.test" },
      },
      access: {
        visibility: "workspace" as const,
        resourceUriInput: "endpoint",
      },
    },
  };
  const created = await service.create(base);

  await expect(
    service.update(
      created.metadata.id,
      {} as never,
      created.metadata.generation,
    ),
  ).rejects.toThrow("must change");
  await expect(
    service.update(
      created.metadata.id,
      { specc: created.spec } as never,
      created.metadata.generation,
    ),
  ).rejects.toThrow("unknown field specc");
  await expect(
    service.create({
      ...base,
      name: "prototype-input",
      spec: {
        ...base.spec,
        inputs: {},
        access: { visibility: "workspace", resourceUriInput: "toString" },
      },
    }),
  ).rejects.toThrow("must name an Interface input");

  const invalidUri = await service.create({
    ...base,
    name: "relative-uri",
    spec: {
      ...base.spec,
      inputs: { endpoint: { source: "literal", value: "/relative" } },
    },
  });
  expect(invalidUri.status.phase).toBe("NotReady");
  expect(invalidUri.status.conditions?.[0]?.reason).toBe("InvalidResourceUri");

  const insecureUri = await service.create({
    ...base,
    name: "insecure-uri",
    spec: {
      ...base.spec,
      inputs: {
        endpoint: { source: "literal", value: "http://example.test/mcp" },
      },
    },
  });
  expect(insecureUri.status.phase).toBe("NotReady");
  expect(insecureUri.status.conditions?.[0]?.reason).toBe("InvalidResourceUri");

  const opaqueMetadata = await service.create({
    ...base,
    name: "opaque-metadata",
    spec: {
      ...base.spec,
      document: {
        token: "oauth2",
        credential: { mode: "invocation" },
        password: false,
        authorizationExample: "Bearer example-value",
      },
      inputs: {
        endpoint: { source: "literal", value: "https://example.test" },
        metadata: {
          source: "literal",
          value: {
            token: "oauth2",
            credential: "runtime-provided",
            authorizationExample: "Basic example-value",
          },
        },
      },
    },
  });
  expect(opaqueMetadata.status.phase).toBe("Resolved");
  expect(opaqueMetadata.spec.document).toEqual({
    token: "oauth2",
    credential: { mode: "invocation" },
    password: false,
    authorizationExample: "Bearer example-value",
  });
  expect(opaqueMetadata.status.resolvedInputs?.metadata).toEqual({
    token: "oauth2",
    credential: "runtime-provided",
    authorizationExample: "Basic example-value",
  });
  const opaqueAuthorizationDocument = await service.create({
    ...base,
    name: "opaque-authorization-document",
    spec: {
      ...base.spec,
      document: {
        headersExample: { Authorization: "Basic example-value" },
      },
    },
  });
  expect(opaqueAuthorizationDocument.status.phase).toBe("Resolved");
  const credentialQuery = await service.create({
    ...base,
    name: "credential-query",
    spec: {
      ...base.spec,
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://example.test/mcp?access_token=example-value",
        },
      },
    },
  });
  expect(credentialQuery.status.phase).toBe("NotReady");
  expect(credentialQuery.status.conditions?.[0]?.reason).toBe(
    "InvalidResourceUri",
  );
  await expect(
    service.createBinding(created.metadata.id, {
      subjectRef: { kind: "ServiceAccount", id: "runtime" },
      permissions: ["invoke"],
      delivery: {
        type: "future-workload-token",
        credentialRef: "Bearer obvious-raw-secret",
      },
    }),
  ).rejects.toThrow("must be a secret/... or credential/...");
  expect(() =>
    validateCapsuleInterfaceBlueprints([
      {
        name: "missing-key",
        spec: {
          type: "mcp.server",
          version: "2025-11-25",
          document: {},
          access: { visibility: "private" },
        },
      } as never,
    ]),
  ).toThrow("blueprint.key");
  expect(() =>
    validateCapsuleInterfaceBlueprints([
      {
        key: "unsafe-blueprint-v1",
        name: "unsafe-blueprint",
        spec: {
          type: "mcp.server",
          version: "2025-11-25",
          document: { transport: "streamable-http" },
          inputs: {
            endpoint: {
              source: "capsule_output",
              outputName: "endpoint",
              Authorization: "Basic dXNlcjpwYXNzd29yZA==",
            } as never,
          },
          access: {
            visibility: "workspace",
            resourceUriInput: "endpoint",
          },
        },
      },
    ]),
  ).toThrow("unknown field Authorization");
  expect(() =>
    validateCapsuleInterfaceBlueprints([
      {
        key: "opaque-binding-options-v1",
        name: "opaque-binding-options",
        spec: {
          type: "mcp.server",
          version: "2025-11-25",
          document: { transport: "streamable-http" },
          inputs: {
            endpoint: {
              source: "literal",
              value: "https://mcp.example.test/mcp",
            },
          },
          access: {
            visibility: "workspace",
            resourceUriInput: "endpoint",
          },
        },
        bindings: [
          {
            key: "principal",
            subjectRef: { kind: "Principal", id: "principal_1" },
            permissions: ["mcp.invoke"],
            delivery: {
              type: "oauth2",
              options: { authorizationExample: "Bearer example-value" },
            },
          },
        ],
      },
    ]),
  ).not.toThrow();
  expect(() =>
    validateCapsuleInterfaceBlueprints([
      {
        key: "unknown-binding-field-v1",
        name: "unknown-binding-field",
        spec: {
          type: "mcp.server",
          version: "2025-11-25",
          document: {},
          access: { visibility: "private" },
        },
        bindings: [
          {
            key: "principal",
            subjectRef: { kind: "Principal", id: "principal_1" },
            permissions: ["mcp.invoke"],
            delivery: { type: "oauth2" },
            token: "not-allowed",
          } as never,
        ],
      },
    ]),
  ).toThrow("unknown field token");
});

test("Interface activity records actor identity without resolved values", async () => {
  const activities: Array<Record<string, unknown>> = [];
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
    activity: {
      record: (event) => {
        activities.push(event as unknown as Record<string, unknown>);
        return Promise.resolve();
      },
    },
  });
  const actor = {
    actorAccountId: "principal_1",
    roles: ["workspace-admin"],
    requestId: "request_1",
  };
  const iface = await service.create(
    {
      workspaceId: "workspace_1",
      name: "audited-runtime",
      ownerRef: { kind: "Workspace", id: "workspace_1" },
      spec: {
        type: "example.runtime",
        version: "v1",
        document: { protocol: "https" },
        inputs: {
          endpoint: {
            source: "literal",
            value: "https://private.example.test",
          },
        },
        access: { visibility: "workspace" },
      },
    },
    actor,
  );
  const binding = await service.createBinding(
    iface.metadata.id,
    {
      subjectRef: { kind: "Principal", id: "principal_1" },
      permissions: ["invoke"],
      delivery: { type: "none" },
    },
    actor,
  );
  await service.revokeBinding(iface.metadata.id, binding.metadata.id, actor);
  expect(activities.map((event) => event.action)).toEqual([
    "interface.created",
    "interface_binding.created",
    "interface_binding.revoked",
  ]);
  expect(activities.every((event) => event.actorId === "principal_1")).toBe(
    true,
  );
  expect(JSON.stringify(activities)).not.toContain("private.example.test");
});

test("status self-report is idempotent: a no-op re-report writes no activity", async () => {
  const stores = createInMemoryInterfaceStores();
  const activities: Array<Record<string, unknown>> = [];
  let id = 0;
  const service = new InterfaceService({
    stores,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++id}`,
    activity: {
      record: (event) => {
        activities.push(event as unknown as Record<string, unknown>);
        return Promise.resolve();
      },
    },
  });
  const iface = await service.create({
    workspaceId: "workspace_1",
    name: "status-app",
    ownerRef: { kind: "Capsule", id: "capsule_status" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://status.example.test/mcp",
        },
      },
      access: { visibility: "workspace" },
    },
  });
  activities.length = 0;

  const conditions = [{ type: "Healthy", status: "true" as const }];
  await service.reportStatusConditions(iface.metadata.id, conditions);
  await service.reportStatusConditions(iface.metadata.id, conditions);
  await service.reportStatusConditions(iface.metadata.id, conditions);

  // Only the first (real) transition is audited; identical re-reports are no-ops.
  expect(
    activities.filter((event) => event.action === "interface.status_reported"),
  ).toHaveLength(1);
});

test("status self-report rejects observer condition types case-insensitively", async () => {
  const stores = createInMemoryInterfaceStores();
  let id = 0;
  const service = new InterfaceService({
    stores,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++id}`,
  });
  const iface = await service.create({
    workspaceId: "workspace_1",
    name: "reserved-app",
    ownerRef: { kind: "Capsule", id: "capsule_reserved" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://reserved.example.test/mcp",
        },
      },
      access: { visibility: "workspace" },
    },
  });
  for (const type of ["drifted", "READY", "ObservationPending"]) {
    await expect(
      service.reportStatusConditions(iface.metadata.id, [
        { type, status: "true" as const },
      ]),
    ).rejects.toThrow(/observer-owned/u);
  }
});

test("status self-report replaces condition types case-insensitively", async () => {
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
  });
  const iface = await service.create({
    workspaceId: "workspace_1",
    name: "case-status-app",
    ownerRef: { kind: "Capsule", id: "capsule_case_status" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      access: { visibility: "workspace" },
    },
  });

  await service.reportStatusConditions(iface.metadata.id, [
    { type: "Healthy", status: "true" },
  ]);
  const reported = await service.reportStatusConditions(iface.metadata.id, [
    { type: "healthy", status: "false" },
  ]);

  expect(
    reported.status.conditions?.filter(
      (condition) => condition.type.toLowerCase() === "healthy",
    ),
  ).toEqual([
    {
      type: "healthy",
      status: "false",
      observedGeneration: 1,
      lastTransitionAt: NOW,
    },
  ]);
});
