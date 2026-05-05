import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import {
  DEFAULT_ROUTING_TOKEN_ROTATION_MS,
  RoutingTokenService,
} from "./mod.ts";

function buildService(options?: {
  readonly start?: string;
  readonly secret?: string;
  readonly rotationPeriodMs?: number;
}): {
  readonly service: RoutingTokenService;
  readonly tick: (ms: number) => void;
} {
  let nowMs = Date.parse(options?.start ?? "2026-04-30T00:00:00.000Z");
  const service = new RoutingTokenService({
    secret: options?.secret ?? "kernel-routing-secret-v1",
    rotationPeriodMs: options?.rotationPeriodMs,
    clock: () => new Date(nowMs),
  });
  return {
    service,
    tick(ms: number) {
      nowMs += ms;
    },
  };
}

Deno.test("RoutingTokenService: issue + verify happy path returns the original scope and hostnames", async () => {
  const { service } = buildService();
  const issued = await service.issue({
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
    hostnames: ["api.example.com", "API.Example.com."],
  });
  assert.equal(issued.scope.tenantId, "tenant-a");
  assert.equal(issued.scope.groupId, "group-a");
  assert.equal(issued.scope.deploymentId, "deployment-a-1");
  assert.deepEqual(issued.hostnames, ["api.example.com"]);
  const verified = await service.verify({ token: issued.token });
  assert.equal(verified.ok, true);
  assert.equal(verified.scope.tenantId, "tenant-a");
  assert.equal(verified.fromPrevious, false);
  assert.deepEqual(verified.hostnames, ["api.example.com"]);
});

Deno.test("RoutingTokenService: scope assertion rejects token issued for a different tenant", async () => {
  const { service } = buildService();
  const issued = await service.issue({
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  await assert.rejects(
    () =>
      service.verify({
        token: issued.token,
        expectedScope: { tenantId: "tenant-b" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "conflict");
      assert.equal(err.details?.expected, "tenant-b");
      return true;
    },
  );
});

Deno.test("RoutingTokenService: hostname assertion rejects token issued without that hostname", async () => {
  const { service } = buildService();
  const issued = await service.issue({
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
    hostnames: ["api.example.com"],
  });
  await assert.rejects(
    () =>
      service.verify({
        token: issued.token,
        expectedHostname: "admin.example.com",
      }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "conflict");
      return true;
    },
  );
  // Case-insensitive match for the in-scope hostname succeeds.
  const verified = await service.verify({
    token: issued.token,
    expectedHostname: "API.Example.com.",
  });
  assert.equal(verified.ok, true);
});

Deno.test("RoutingTokenService: rotation honors previously-issued tokens within the rotation window", async () => {
  const { service, tick } = buildService({
    rotationPeriodMs: 60 * 60 * 1000,
  });
  const issued = await service.issue({
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  // Rotate to a fresh signing secret. Tokens minted under the previous
  // secret must still verify until they expire.
  tick(10 * 60 * 1000);
  service.rotate("kernel-routing-secret-v2");
  const verified = await service.verify({ token: issued.token });
  assert.equal(verified.ok, true);
  assert.equal(verified.fromPrevious, true);
});

Deno.test("RoutingTokenService: tokens minted under the previous secret stop verifying after a full rotation period", async () => {
  const { service, tick } = buildService({
    rotationPeriodMs: 60 * 60 * 1000,
  });
  const issued = await service.issue({
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  service.rotate("kernel-routing-secret-v2");
  // Advance well past the rotation period; the previous-key fallback closes.
  tick(2 * 60 * 60 * 1000);
  await assert.rejects(
    () => service.verify({ token: issued.token }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      // either expired (current key match but exp passed) or signature
      // miss (current key only, previous key dropped). Both surface as
      // conflict / not_found respectively.
      assert.ok(err.code === "conflict" || err.code === "not_found");
      return true;
    },
  );
});

Deno.test("RoutingTokenService: expired token is rejected with conflict", async () => {
  const { service, tick } = buildService({
    rotationPeriodMs: 60 * 60 * 1000,
  });
  const issued = await service.issue({
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  tick(2 * 60 * 60 * 1000);
  await assert.rejects(
    () => service.verify({ token: issued.token }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "conflict");
      return true;
    },
  );
  // sanity check: original token expiry is set to issuedAt + rotationPeriodMs.
  assert.equal(
    Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt),
    DEFAULT_ROUTING_TOKEN_ROTATION_MS,
  );
});

Deno.test("RoutingTokenService: tampered token (modified payload) fails verification", async () => {
  const { service } = buildService();
  const issued = await service.issue({
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  const [header, _body, signature] = issued.token.split(".");
  const forgedPayload = {
    iss: "takosumi-routing",
    sub: "deployment-a-1",
    tenantId: "tenant-attacker",
    groupId: "group-attacker",
    deploymentId: "deployment-a-1",
    hostnames: [],
    iat: 0,
    exp: 9_999_999_999,
  };
  const forgedBody = btoa(JSON.stringify(forgedPayload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const tampered = `${header}.${forgedBody}.${signature}`;
  await assert.rejects(
    () => service.verify({ token: tampered }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "not_found");
      return true;
    },
  );
});

Deno.test("RoutingTokenService: rotation rejects re-using the current secret", () => {
  const { service } = buildService({ secret: "kernel-routing-secret-v1" });
  assert.throws(
    () => service.rotate("kernel-routing-secret-v1"),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "conflict");
      return true;
    },
  );
});

Deno.test("RoutingTokenService: issue rejects empty scope fields up-front", async () => {
  const { service } = buildService();
  await assert.rejects(
    () =>
      service.issue({
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

Deno.test("RoutingTokenService: cross-tenant token replay (different tenant token) is rejected by scope check", async () => {
  const { service } = buildService();
  const tokenA = await service.issue({
    tenantId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
    hostnames: ["a.example.com"],
  });
  // Routing edge for tenant-b receives tenant-a's token — must reject.
  await assert.rejects(
    () =>
      service.verify({
        token: tokenA.token,
        expectedScope: {
          tenantId: "tenant-b",
          groupId: "group-b",
          deploymentId: "deployment-b-1",
        },
        expectedHostname: "b.example.com",
      }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "conflict");
      return true;
    },
  );
});
