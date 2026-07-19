import { expect, test } from "bun:test";
import type {
  InterfaceInput,
  InterfaceInputProvenance,
  JsonValue,
  ResourceObject,
} from "../../../../contract/index.ts";
import {
  CompatibilityRouteControlError,
  CompatibilityRouteControlService,
} from "../../../../core/domains/interfaces/compatibility_route_control.ts";
import {
  InterfaceService,
  type InterfaceInputResolver,
} from "../../../../core/domains/interfaces/service.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/stores.ts";

const PROFILE = "compat.example.v1";
const WORKSPACE = "workspace_1";
const RESOURCE = "api";
const RESOURCE_ID = `tkrn:${WORKSPACE}:EdgeWorker:${RESOURCE}`;
const ENDPOINT = "https://api.system.example/";

test("compatibility route control converges concurrent creates and retry onto one canonical Interface and Binding", async () => {
  const fixture = routeFixture();
  const attempts = await Promise.all(
    Array.from({ length: 12 }, () =>
      fixture.control.ensure(scope(), {
        resourceName: RESOURCE,
        pathPattern: "/*",
      }),
    ),
  );
  expect(new Set(attempts.map((route) => route.interfaceId)).size).toBe(1);
  expect(new Set(attempts.map((route) => route.bindingId)).size).toBe(1);

  const retried = await fixture.control.ensure(scope(), {
    resourceName: RESOURCE,
    pathPattern: "/*",
  });
  expect(retried.interfaceId).toBe(attempts[0]!.interfaceId);
  expect(retried.bindingId).toBe(attempts[0]!.bindingId);
  expect(retried.pattern).toBe("api.system.example/*");

  const interfaces = await fixture.interfaces.list({
    workspaceId: WORKSPACE,
    includeRetired: true,
  });
  expect(interfaces).toHaveLength(1);
  expect(interfaces[0]!.metadata.materializedFrom).toEqual({
    source: "compatibility_profile",
    profile: PROFILE,
    key: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(interfaces[0]!.spec).toMatchObject({
    type: "http.route",
    version: "v1alpha1",
    document: {
      permission: "edge.request",
      pathPattern: "/*",
    },
    inputs: {
      endpoint: {
        source: "resource_output",
        resourceId: RESOURCE_ID,
        outputName: "url",
      },
    },
    access: { visibility: "public", resourceUriInput: "endpoint" },
  });
  const bindings = await fixture.interfaces.listBindings(
    interfaces[0]!.metadata.id,
  );
  expect(bindings).toHaveLength(1);
  expect(bindings[0]).toMatchObject({
    metadata: {
      materializedFrom: {
        source: "compatibility_profile",
        profile: PROFILE,
      },
    },
    spec: {
      subjectRef: { kind: "Principal" },
      permissions: ["edge.request"],
      delivery: { type: "none" },
    },
    status: { phase: "Ready" },
  });
});

test("compatibility route reads and mutations are Workspace- and profile-owned", async () => {
  const fixture = routeFixture();
  const route = await fixture.control.ensure(scope(), {
    resourceName: RESOURCE,
    pathPattern: "/*",
  });

  expect(await fixture.control.list(scope())).toHaveLength(1);
  expect(await fixture.control.get(scope(), route.interfaceId)).toMatchObject({
    interfaceId: route.interfaceId,
  });
  expect(
    await fixture.control.list({
      profile: "compat.other.v1",
      workspaceId: WORKSPACE,
    }),
  ).toEqual([]);
  expect(
    await fixture.control.get(
      { profile: "compat.other.v1", workspaceId: WORKSPACE },
      route.interfaceId,
    ),
  ).toBeUndefined();
  expect(
    await fixture.control.get(
      { profile: PROFILE, workspaceId: "workspace_2" },
      route.interfaceId,
    ),
  ).toBeUndefined();

  await expect(
    fixture.control.update(
      { profile: "compat.other.v1", workspaceId: WORKSPACE },
      {
        interfaceId: route.interfaceId,
        resourceName: RESOURCE,
        pathPattern: "/other/*",
      },
    ),
  ).rejects.toMatchObject({ code: "not_found" });

  const manual = await fixture.interfaces.create({
    workspaceId: WORKSPACE,
    name: "manual-route",
    ownerRef: { kind: "Resource", id: RESOURCE_ID },
    labels: { "takosumi.dev/compat-profile": PROFILE },
    spec: {
      type: "http.route",
      version: "v1alpha1",
      document: {
        principalId: `compat-route:${PROFILE}:${WORKSPACE}`,
        permission: "edge.request",
        pathPattern: "/manual/*",
      },
      inputs: {
        endpoint: {
          source: "resource_output",
          resourceId: RESOURCE_ID,
          outputName: "url",
        },
      },
      access: { visibility: "public", resourceUriInput: "endpoint" },
    },
  });
  expect(
    await fixture.control.get(scope(), manual.metadata.id),
  ).toBeUndefined();
  expect(
    (await fixture.control.list(scope())).map((row) => row.interfaceId),
  ).toEqual([route.interfaceId]);
});

test("compatibility route update is ETag fenced and idempotent after a lost response", async () => {
  const fixture = routeFixture();
  const created = await fixture.control.ensure(scope(), {
    resourceName: RESOURCE,
    pathPattern: "/*",
  });
  const updated = await fixture.control.update(scope(), {
    interfaceId: created.interfaceId,
    resourceName: RESOURCE,
    pathPattern: "/api/*",
    expectedEtag: created.etag,
  });
  expect(updated.interfaceId).toBe(created.interfaceId);
  expect(updated.pathPattern).toBe("/api/*");
  expect(updated.etag).not.toBe(created.etag);

  const lostResponseRetry = await fixture.control.update(scope(), {
    interfaceId: created.interfaceId,
    resourceName: RESOURCE,
    pathPattern: "/api/*",
    expectedEtag: created.etag,
  });
  expect(lostResponseRetry.etag).toBe(updated.etag);
  await expect(
    fixture.control.update(scope(), {
      interfaceId: created.interfaceId,
      resourceName: RESOURCE,
      pathPattern: "/stale/*",
      expectedEtag: created.etag,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await fixture.control.list(scope()))[0]!.pathPattern).toBe("/api/*");
});

test("compatibility route permits only one active route per EdgeWorker", async () => {
  const fixture = routeFixture();
  const original = await fixture.control.ensure(scope(), {
    resourceName: RESOURCE,
    pathPattern: "/*",
  });
  await expect(
    fixture.control.ensure(scope(), {
      resourceName: RESOURCE,
      pathPattern: "/api/*",
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await fixture.control.list(scope())).toHaveLength(1);

  const updates = await Promise.allSettled([
    fixture.control.update(scope(), {
      interfaceId: original.interfaceId,
      resourceName: RESOURCE,
      pathPattern: "/a/*",
      expectedEtag: original.etag,
    }),
    fixture.control.update(scope(), {
      interfaceId: original.interfaceId,
      resourceName: RESOURCE,
      pathPattern: "/b/*",
      expectedEtag: original.etag,
    }),
  ]);
  expect(
    updates.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(updates.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(await fixture.control.list(scope())).toHaveLength(1);
});

test("compatibility route concurrent creates with different paths have one winner", async () => {
  const fixture = routeFixture();
  const attempts = await Promise.allSettled([
    fixture.control.ensure(scope(), {
      resourceName: RESOURCE,
      pathPattern: "/a/*",
    }),
    fixture.control.ensure(scope(), {
      resourceName: RESOURCE,
      pathPattern: "/b/*",
    }),
  ]);
  expect(
    attempts.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    attempts.filter((result) => result.status === "rejected"),
  ).toHaveLength(1);
  expect(await fixture.control.list(scope())).toHaveLength(1);
});

test("compatibility route rejects infix and repeated wildcards", async () => {
  const fixture = routeFixture();
  for (const pathPattern of ["/foo*bar", "/**", "/foo*/bar"]) {
    await expect(
      fixture.control.ensure(scope(), {
        resourceName: RESOURCE,
        pathPattern,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  }
  expect(
    await fixture.control.ensure(scope(), {
      resourceName: RESOURCE,
      pathPattern: "/assets/*",
    }),
  ).toMatchObject({ pathPattern: "/assets/*" });
});

test("compatibility route refreshes its canonical endpoint and Binding revision", async () => {
  const fixture = routeFixture();
  const created = await fixture.control.ensure(scope(), {
    resourceName: RESOURCE,
    pathPattern: "/*",
  });
  fixture.setEndpoint("https://api-v2.system.example/");

  const refreshed = await fixture.control.ensure(scope(), {
    resourceName: RESOURCE,
    pathPattern: "/*",
  });
  expect(refreshed.interfaceId).toBe(created.interfaceId);
  expect(refreshed.endpoint).toBe("https://api-v2.system.example/");
  expect(refreshed.pattern).toBe("api-v2.system.example/*");
  expect(refreshed.interfaceResolvedRevision).toBeGreaterThan(
    created.interfaceResolvedRevision,
  );
  const binding = await fixture.interfaces.getBinding(
    refreshed.interfaceId,
    refreshed.bindingId,
  );
  expect(binding.status.observedInterfaceRevision).toBe(
    refreshed.interfaceResolvedRevision,
  );
});

test("compatibility route delete revokes its exact Binding, retires the Interface, and retries safely", async () => {
  const fixture = routeFixture();
  const created = await fixture.control.ensure(scope(), {
    resourceName: RESOURCE,
    pathPattern: "/*",
  });
  await expect(
    fixture.control.retire(scope(), {
      interfaceId: created.interfaceId,
      expectedEtag: '"stale:1:1"',
    }),
  ).rejects.toMatchObject({ code: "conflict" });

  expect(
    await fixture.control.retire(scope(), {
      interfaceId: created.interfaceId,
      expectedEtag: created.etag,
    }),
  ).toEqual({ interfaceId: created.interfaceId, retired: true });
  expect(
    await fixture.control.retire(scope(), { interfaceId: created.interfaceId }),
  ).toEqual({ interfaceId: created.interfaceId, retired: true });
  expect(
    await fixture.control.get(scope(), created.interfaceId),
  ).toBeUndefined();
  expect(await fixture.control.list(scope())).toEqual([]);

  const iface = await fixture.interfaces.get(created.interfaceId);
  expect(iface.status.phase).toBe("Retired");
  expect(
    (await fixture.interfaces.listBindings(created.interfaceId)).map(
      (binding) => binding.status.phase,
    ),
  ).toEqual(["Revoked"]);
});

test("a stale concurrent delete cannot revoke the Binding of a successful update", async () => {
  const fixture = routeFixture();
  const created = await fixture.control.ensure(scope(), {
    resourceName: RESOURCE,
    pathPattern: "/*",
  });
  const originalRetire = fixture.interfaces.retire.bind(fixture.interfaces);
  const enteredRetire = Promise.withResolvers<void>();
  const releaseRetire = Promise.withResolvers<void>();
  fixture.interfaces.retire = async (...args) => {
    enteredRetire.resolve();
    await releaseRetire.promise;
    return await originalRetire(...args);
  };

  const deleting = fixture.control.retire(scope(), {
    interfaceId: created.interfaceId,
    expectedEtag: created.etag,
  });
  await enteredRetire.promise;
  const updated = await fixture.control.update(scope(), {
    interfaceId: created.interfaceId,
    resourceName: RESOURCE,
    pathPattern: "/updated/*",
    expectedEtag: created.etag,
  });
  releaseRetire.resolve();

  await expect(deleting).rejects.toMatchObject({ code: "conflict" });
  expect(await fixture.control.get(scope(), created.interfaceId)).toMatchObject(
    {
      pathPattern: "/updated/*",
      bindingId: updated.bindingId,
    },
  );
  expect(
    await fixture.interfaces.getBinding(updated.interfaceId, updated.bindingId),
  ).toMatchObject({ status: { phase: "Ready" } });
});

test("compatibility route fails before Interface mutation when the EdgeWorker is not profile-owned", async () => {
  const fixture = routeFixture({ resourceManagedBy: "opentofu" });
  await expect(
    fixture.control.ensure(scope(), {
      resourceName: RESOURCE,
      pathPattern: "/*",
    }),
  ).rejects.toBeInstanceOf(CompatibilityRouteControlError);
  expect(
    await fixture.interfaces.list({
      workspaceId: WORKSPACE,
      includeRetired: true,
    }),
  ).toEqual([]);
});

test("compatibility route fences the endpoint validated by the protocol adapter", async () => {
  const fixture = routeFixture();
  await expect(
    fixture.control.ensure(scope(), {
      resourceName: RESOURCE,
      pathPattern: "/*",
      expectedEndpoint: "https://stale.system.example/",
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
  expect(
    await fixture.interfaces.list({
      workspaceId: WORKSPACE,
      includeRetired: true,
    }),
  ).toEqual([]);
});

function scope() {
  return { profile: PROFILE, workspaceId: WORKSPACE } as const;
}

function routeFixture(options: { readonly resourceManagedBy?: string } = {}): {
  readonly interfaces: InterfaceService;
  readonly control: CompatibilityRouteControlService;
  readonly setEndpoint: (endpoint: string) => void;
} {
  let id = 0;
  const resource = edgeWorker(options.resourceManagedBy ?? PROFILE);
  const interfaces = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    resolver: resourceOutputResolver(resource),
    ownerExists: async ({ ownerRef }) => ownerRef.id === RESOURCE_ID,
    ownerReady: async ({ ownerRef }) => ownerRef.id === RESOURCE_ID,
    newId: (prefix) => `${prefix}_route_${++id}`,
    now: () => `2026-07-15T00:00:${String(id).padStart(2, "0")}.000Z`,
  });
  return {
    interfaces,
    control: new CompatibilityRouteControlService(interfaces, {
      resolveReadyEdgeWorker: async ({ workspaceId, resourceName }) =>
        workspaceId === WORKSPACE && resourceName === RESOURCE
          ? resource
          : undefined,
    }),
    setEndpoint(endpoint: string) {
      if (resource.status) {
        resource.status.outputs = { ...resource.status.outputs, url: endpoint };
        resource.status.observedGeneration += 1;
      }
    },
  };
}

function edgeWorker(managedBy: string): ResourceObject {
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "EdgeWorker",
    metadata: { name: RESOURCE, space: WORKSPACE, managedBy },
    spec: {
      name: RESOURCE,
      source: {
        artifactRef: "artifact_1",
        artifactSha256: `sha256:${"1".repeat(64)}`,
      },
    },
    status: {
      phase: "Ready",
      observedGeneration: 1,
      outputs: { url: ENDPOINT },
    },
  };
}

function resourceOutputResolver(
  resource: ResourceObject,
): InterfaceInputResolver {
  return {
    async resolve(input: {
      readonly inputs: Readonly<Record<string, InterfaceInput>>;
    }) {
      const source = input.inputs.endpoint;
      if (
        source?.source !== "resource_output" ||
        source.resourceId !== RESOURCE_ID ||
        source.outputName !== "url" ||
        resource.status?.phase !== "Ready"
      ) {
        return {
          ok: false as const,
          phase: "NotReady" as const,
          reason: "ResourceUnavailable",
          message: "resource output is unavailable",
        };
      }
      const endpoint = resource.status.outputs?.url;
      if (typeof endpoint !== "string") {
        return {
          ok: false as const,
          phase: "NotReady" as const,
          reason: "ResourceUnavailable",
          message: "resource output is unavailable",
        };
      }
      return {
        ok: true as const,
        resolvedInputs: { endpoint } satisfies Readonly<
          Record<string, JsonValue>
        >,
        provenance: {
          endpoint: {
            source: "resource_output",
            resourceId: RESOURCE_ID,
            resourceGeneration: resource.status.observedGeneration,
            outputName: "url",
          },
        } satisfies Readonly<Record<string, InterfaceInputProvenance>>,
      };
    },
  };
}
