/**
 * Phase 18 — Custom domain cross-tenant collision detection.
 *
 * The kernel exposes a `CustomDomainRegistryService` that serializes
 * hostname ownership across tenants. Provider materializers (here the
 * Cloudflare custom domain materializer) MUST reserve a hostname with the
 * registry before mutating upstream DNS / SSL state. A second tenant that
 * requests the same hostname while the first reservation is still active
 * is rejected with a `conflict` error and the apply is short-circuited.
 *
 * These tests wire `CloudflareCustomDomainProviderMaterializer` to the
 * in-memory registry service via a thin adapter and assert:
 *   - tenant-A reserves first; tenant-B is rejected
 *   - rollback / uninstall releases the reservation; tenant-B can then claim
 *   - same-tenant re-deploy is idempotent
 *   - cross-tenant collision short-circuits before Cloudflare is mutated
 *   - registry-less materializer skips reservation checks
 */
import assert from "node:assert/strict";
import type { RuntimeDesiredState } from "takosumi-contract";
import {
  type CloudflareCustomDomainClient,
  type CloudflareCustomDomainMaterializationInput,
  type CloudflareCustomDomainMaterializationResult,
  CloudflareCustomDomainProviderMaterializer,
  type CloudflareCustomHostnameRecord,
  type CloudflareCustomHostnameSpec,
  type CloudflareCustomHostnameSslState,
  type CustomDomainRegistryClient,
} from "../src/providers/cloudflare/custom_domain.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function clockFrom(start: string) {
  let now = Date.parse(start);
  return () => {
    const value = new Date(now);
    now += 1;
    return value;
  };
}

function counterId(prefix: string) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function buildDesiredState(overrides: {
  readonly host: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly deploymentId: string;
}): RuntimeDesiredState {
  return {
    id: overrides.deploymentId,
    spaceId: overrides.spaceId,
    groupId: overrides.groupId,
    activationId: `activation_${overrides.deploymentId}`,
    appName: `app_${overrides.spaceId}`,
    materializedAt: "2026-04-30T00:00:00.000Z",
    workloads: [
      {
        id: `wl_${overrides.deploymentId}`,
        spaceId: overrides.spaceId,
        groupId: overrides.groupId,
        activationId: `activation_${overrides.deploymentId}`,
        componentName: "api",
        runtimeName: "runtime/oci-container@v1",
        type: "container",
        image: "ghcr.io/example/api:1.0",
        command: [],
        args: [],
        env: {},
        depends: [],
      },
    ],
    resources: [],
    routes: [{
      id: `route_${overrides.deploymentId}`,
      spaceId: overrides.spaceId,
      groupId: overrides.groupId,
      activationId: `activation_${overrides.deploymentId}`,
      routeName: "tenant",
      targetComponentName: "api",
      host: overrides.host,
      path: "/",
      protocol: "https",
      port: 443,
      targetPort: 8080,
    }],
  };
}

class StubCloudflareCustomDomainClient implements CloudflareCustomDomainClient {
  readonly calls: CloudflareCustomDomainMaterializationInput[] = [];
  ensureCustomHostname(input: {
    readonly zoneId: string;
    readonly spec: CloudflareCustomHostnameSpec;
  }): Promise<CloudflareCustomHostnameRecord> {
    return Promise.resolve(buildHostnameRecord(input.spec));
  }
  getCustomHostname(): Promise<CloudflareCustomHostnameRecord | undefined> {
    return Promise.resolve(undefined);
  }
  refreshSsl(): Promise<CloudflareCustomHostnameSslState> {
    return Promise.resolve({ status: "active", method: "http" });
  }
  verify(): Promise<CloudflareCustomHostnameRecord> {
    return Promise.resolve(buildHostnameRecord({
      hostname: "verified.example.test",
      sslMethod: "http",
    }));
  }
  deleteCustomHostname(): Promise<boolean> {
    return Promise.resolve(true);
  }
  materializeHostnames(
    input: CloudflareCustomDomainMaterializationInput,
  ): Promise<CloudflareCustomDomainMaterializationResult> {
    this.calls.push(input);
    return Promise.resolve({
      hostnames: input.hostnames.map(buildHostnameRecord),
      stdout: `applied ${input.hostnames.length} custom hostnames`,
    });
  }
}

function buildHostnameRecord(
  spec: CloudflareCustomHostnameSpec,
): CloudflareCustomHostnameRecord {
  return {
    id: `hn-${spec.hostname}`,
    hostname: spec.hostname,
    status: "active",
    ssl: { status: "active", method: spec.sslMethod ?? "http" },
    createdAt: "2026-04-30T00:00:00.000Z",
  };
}

class DomainError extends Error {
  constructor(
    readonly code: "conflict",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

interface CustomDomainReservation {
  readonly hostname: string;
  readonly owner: {
    readonly tenantId: string;
    readonly groupId: string;
    readonly deploymentId: string;
  };
  readonly status: "active" | "released";
  readonly reservedAt: string;
  readonly releasedAt?: string;
}

class InMemoryCustomDomainReservationStore {
  readonly reservations = new Map<string, CustomDomainReservation>();
}

class CustomDomainRegistryService {
  readonly #store: InMemoryCustomDomainReservationStore;
  readonly #clock: () => Date;

  constructor(options: {
    readonly store: InMemoryCustomDomainReservationStore;
    readonly clock: () => Date;
  }) {
    this.#store = options.store;
    this.#clock = options.clock;
  }

  reserve(input: {
    readonly hostname: string;
    readonly tenantId: string;
    readonly groupId: string;
    readonly deploymentId: string;
  }): Promise<CustomDomainReservation> {
    const existing = this.#store.reservations.get(input.hostname);
    const sameOwner = existing?.owner.tenantId === input.tenantId &&
      existing?.owner.groupId === input.groupId &&
      existing?.owner.deploymentId === input.deploymentId;
    if (existing?.status === "active" && !sameOwner) {
      throw new DomainError(
        "conflict",
        `hostname already reserved: ${input.hostname}`,
      );
    }
    const reservation: CustomDomainReservation = {
      hostname: input.hostname,
      owner: {
        tenantId: input.tenantId,
        groupId: input.groupId,
        deploymentId: input.deploymentId,
      },
      status: "active",
      reservedAt: existing?.reservedAt ?? this.#clock().toISOString(),
    };
    this.#store.reservations.set(input.hostname, reservation);
    return Promise.resolve(reservation);
  }

  release(input: {
    readonly hostname: string;
    readonly owner: {
      readonly tenantId: string;
      readonly groupId: string;
      readonly deploymentId: string;
    };
  }): Promise<CustomDomainReservation | undefined> {
    const existing = this.#store.reservations.get(input.hostname);
    if (!existing) return Promise.resolve(undefined);
    const sameOwner = existing.owner.tenantId === input.owner.tenantId &&
      existing.owner.groupId === input.owner.groupId &&
      existing.owner.deploymentId === input.owner.deploymentId;
    if (!sameOwner) return Promise.resolve(existing);
    const released: CustomDomainReservation = {
      ...existing,
      status: "released",
      releasedAt: this.#clock().toISOString(),
    };
    this.#store.reservations.set(input.hostname, released);
    return Promise.resolve(released);
  }

  get(hostname: string): Promise<CustomDomainReservation | undefined> {
    return Promise.resolve(this.#store.reservations.get(hostname));
  }
}

function buildRegistry(): {
  readonly registry: CustomDomainRegistryService;
  readonly client: CustomDomainRegistryClient;
} {
  const registry = new CustomDomainRegistryService({
    store: new InMemoryCustomDomainReservationStore(),
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
  });
  const client: CustomDomainRegistryClient = {
    reserve: async (input) => {
      await registry.reserve(input);
    },
    release: async (input) => {
      await registry.release({
        hostname: input.hostname,
        owner: {
          tenantId: input.tenantId,
          groupId: input.groupId,
          deploymentId: input.deploymentId,
        },
      });
    },
  };
  return { registry, client };
}

function buildMaterializer(
  cloudflareClient: CloudflareCustomDomainClient,
  registryClient: CustomDomainRegistryClient | undefined,
  prefix: string,
) {
  return new CloudflareCustomDomainProviderMaterializer({
    client: cloudflareClient,
    zoneId: "zone-1",
    accountId: "acct-1",
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: counterId(prefix),
    registry: registryClient,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("phase 18: tenant-A reserves api.example.com first; tenant-B materialize is rejected with conflict", async () => {
  const { client: registryClient } = buildRegistry();
  const cloudflareClient = new StubCloudflareCustomDomainClient();
  const tenantAMaterializer = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-a",
  );
  const tenantBMaterializer = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-b",
  );

  // tenant-A applies first.
  await tenantAMaterializer.materialize(buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  }));
  assert.equal(cloudflareClient.calls.length, 1);

  // tenant-B requests the same hostname -> conflict, no Cloudflare call.
  await assert.rejects(
    () =>
      tenantBMaterializer.materialize(buildDesiredState({
        host: "api.example.com",
        spaceId: "tenant-b",
        groupId: "group-b",
        deploymentId: "deployment-b-1",
      })),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "conflict");
      return true;
    },
  );
  // The Cloudflare materialize call count must NOT have advanced when
  // collision detection rejects the apply.
  assert.equal(cloudflareClient.calls.length, 1);
});

Deno.test("phase 18: rollback releases the reservation so a different tenant can claim it afterwards", async () => {
  const { client: registryClient, registry } = buildRegistry();
  const cloudflareClient = new StubCloudflareCustomDomainClient();
  const tenantAMaterializer = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-a",
  );
  const tenantBMaterializer = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-b",
  );

  const desiredA = buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  await tenantAMaterializer.materialize(desiredA);

  // Simulate rollback / uninstall pipeline calling releaseReservations().
  await tenantAMaterializer.releaseReservations(desiredA);
  const released = await registry.get("api.example.com");
  assert.equal(released?.status, "released");

  // tenant-B can now claim it.
  await tenantBMaterializer.materialize(buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-b",
    groupId: "group-b",
    deploymentId: "deployment-b-1",
  }));
  const reclaimed = await registry.get("api.example.com");
  assert.equal(reclaimed?.owner.tenantId, "tenant-b");
});

Deno.test("phase 18: same-tenant same-deployment re-materialize is idempotent (no conflict)", async () => {
  const { client: registryClient } = buildRegistry();
  const cloudflareClient = new StubCloudflareCustomDomainClient();
  const materializer = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-idem",
  );
  const desired = buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  await materializer.materialize(desired);
  await materializer.materialize(desired);
  assert.equal(cloudflareClient.calls.length, 2);
});

Deno.test("phase 18: collision short-circuits before Cloudflare is touched (no partial state)", async () => {
  const { client: registryClient } = buildRegistry();
  const cloudflareClient = new StubCloudflareCustomDomainClient();
  const materializerA = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-shortcircuit-a",
  );
  const materializerB = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-shortcircuit-b",
  );

  await materializerA.materialize(buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  }));
  const beforeCalls = cloudflareClient.calls.length;
  await assert.rejects(() =>
    materializerB.materialize(buildDesiredState({
      host: "api.example.com",
      spaceId: "tenant-b",
      groupId: "group-b",
      deploymentId: "deployment-b-1",
    }))
  );
  assert.equal(cloudflareClient.calls.length, beforeCalls);
});

Deno.test("phase 18: registry-less materializer skips collision checks", async () => {
  const cloudflareClient = new StubCloudflareCustomDomainClient();
  const materializerA = buildMaterializer(
    cloudflareClient,
    undefined,
    "cf-unregistered-a",
  );
  const materializerB = buildMaterializer(
    cloudflareClient,
    undefined,
    "cf-unregistered-b",
  );
  // Without a registry, both apply paths run.
  await materializerA.materialize(buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  }));
  await materializerB.materialize(buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-b",
    groupId: "group-b",
    deploymentId: "deployment-b-1",
  }));
  assert.equal(cloudflareClient.calls.length, 2);
});
