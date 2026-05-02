import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import {
  CustomDomainRegistryService,
  InMemoryCustomDomainReservationStore,
} from "./mod.ts";

function buildService(start = "2026-04-30T00:00:00.000Z") {
  let nowMs = Date.parse(start);
  const store = new InMemoryCustomDomainReservationStore();
  const service = new CustomDomainRegistryService({
    store,
    clock: () => {
      const value = new Date(nowMs);
      nowMs += 1;
      return value;
    },
  });
  return { store, service };
}

Deno.test("CustomDomainRegistryService: tenant-A reserves api.example.com first, claim is recorded", async () => {
  const { service } = buildService();
  const reservation = await service.reserve({
    hostname: "api.example.com",
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  assert.equal(reservation.hostname, "api.example.com");
  assert.equal(reservation.owner.tenantId, "tenant-a");
  assert.equal(reservation.owner.deploymentId, "deployment-a-1");
  assert.equal(reservation.status, "pending");
});

Deno.test("CustomDomainRegistryService: cross-tenant collision rejects the second reservation with conflict", async () => {
  const { service } = buildService();
  await service.reserve({
    hostname: "api.example.com",
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  await assert.rejects(
    () =>
      service.reserve({
        hostname: "api.example.com",
        tenantId: "tenant-b",
        groupId: "group-b",
        deploymentId: "deployment-b-1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "conflict");
      assert.deepEqual(err.details?.requestedOwner, {
        tenantId: "tenant-b",
        groupId: "group-b",
        deploymentId: "deployment-b-1",
      });
      return true;
    },
  );
});

Deno.test("CustomDomainRegistryService: same-owner re-reserve is idempotent and does not raise", async () => {
  const { service } = buildService();
  const first = await service.reserve({
    hostname: "api.example.com",
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  const second = await service.reserve({
    hostname: "api.example.com",
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  assert.equal(second.hostname, first.hostname);
  assert.equal(second.owner.deploymentId, "deployment-a-1");
});

Deno.test("CustomDomainRegistryService: hostname is canonicalized (case + trailing dot) so collisions are detected across casing", async () => {
  const { service } = buildService();
  await service.reserve({
    hostname: "API.example.com.",
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  await assert.rejects(
    () =>
      service.reserve({
        hostname: "api.EXAMPLE.com",
        tenantId: "tenant-b",
        groupId: "group-b",
        deploymentId: "deployment-b-1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "conflict");
      assert.equal(err.details?.hostname, "api.example.com");
      return true;
    },
  );
});

Deno.test("CustomDomainRegistryService: release frees the hostname so a different tenant can claim it", async () => {
  const { service } = buildService();
  await service.reserve({
    hostname: "api.example.com",
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  await service.release({
    hostname: "api.example.com",
    owner: {
      tenantId: "tenant-a",
      groupId: "group-a",
      deploymentId: "deployment-a-1",
    },
  });
  const claim = await service.reserve({
    hostname: "api.example.com",
    tenantId: "tenant-b",
    groupId: "group-b",
    deploymentId: "deployment-b-1",
  });
  assert.equal(claim.owner.tenantId, "tenant-b");
});

Deno.test("CustomDomainRegistryService: release rejects callers from a different deployment owner", async () => {
  const { service } = buildService();
  await service.reserve({
    hostname: "api.example.com",
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  await assert.rejects(
    () =>
      service.release({
        hostname: "api.example.com",
        owner: {
          tenantId: "tenant-b",
          groupId: "group-b",
          deploymentId: "deployment-b-1",
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "conflict");
      return true;
    },
  );
});

Deno.test("CustomDomainRegistryService: verify transitions a pending reservation to verified", async () => {
  const { service } = buildService();
  const owner = {
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  };
  await service.reserve({ hostname: "api.example.com", ...owner });
  const verified = await service.verify({
    hostname: "api.example.com",
    owner,
  });
  assert.equal(verified.status, "verified");
});

Deno.test("CustomDomainRegistryService: listByOwner returns reservations for the requested tenant", async () => {
  const { service } = buildService();
  await service.reserve({
    hostname: "api.example.com",
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  await service.reserve({
    hostname: "admin.example.com",
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-2",
  });
  await service.reserve({
    hostname: "api.tenant-b.example.com",
    tenantId: "tenant-b",
    groupId: "group-b",
    deploymentId: "deployment-b-1",
  });
  const list = await service.listByOwner("tenant-a");
  assert.equal(list.length, 2);
  for (const record of list) {
    assert.equal(record.owner.tenantId, "tenant-a");
  }
});

Deno.test("CustomDomainRegistryService: rejects empty hostname / owner fields up-front", async () => {
  const { service } = buildService();
  await assert.rejects(
    () =>
      service.reserve({
        hostname: "",
        tenantId: "tenant-a",
        groupId: "group-a",
        deploymentId: "deployment-a-1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "invalid_argument");
      return true;
    },
  );
  await assert.rejects(
    () =>
      service.reserve({
        hostname: "api.example.com",
        tenantId: "",
        groupId: "group-a",
        deploymentId: "deployment-a-1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "invalid_argument");
      return true;
    },
  );
});
