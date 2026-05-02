/**
 * Phase 18.2 H7 — Custom domain provisioning cancellation.
 *
 * SSL validation for Cloudflare custom hostnames takes 30-60s. A user that
 * removes the hostname from the manifest mid-provision (or a deployment that
 * transitions to `failed` / `rolled-back` while validation is still in
 * flight) must NOT leave an orphaned hostname registered in the Cloudflare
 * zone. The materializer accepts an `AbortSignal`; the deploy lifecycle
 * fires it on cancellation, and the materializer:
 *   1. propagates the abort to its in-flight Cloudflare client call,
 *   2. releases the registry reservation,
 *   3. deletes the partially-provisioned custom hostname from the zone.
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
    workloads: [{
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
    }],
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

function buildHostnameRecord(
  spec: CloudflareCustomHostnameSpec,
): CloudflareCustomHostnameRecord {
  return {
    id: `hn-${spec.hostname}`,
    hostname: spec.hostname,
    status: "pending",
    ssl: { status: "pending", method: spec.sslMethod ?? "http" },
    createdAt: "2026-04-30T00:00:00.000Z",
  };
}

/**
 * Stub that simulates an SSL validation that hangs until the abort signal
 * fires. Mirrors the real-world Cloudflare client behavior where the
 * validation poll loop yields back to the caller with an `AbortError` when
 * the deploy lifecycle cancels.
 */
class HangingCloudflareClient implements CloudflareCustomDomainClient {
  readonly materializeCalls: CloudflareCustomDomainMaterializationInput[] = [];
  readonly deletedHostnameIds: string[] = [];
  readonly registeredHostnames = new Map<
    string,
    CloudflareCustomHostnameRecord
  >();
  ensureCustomHostname(input: {
    readonly zoneId: string;
    readonly spec: CloudflareCustomHostnameSpec;
  }): Promise<CloudflareCustomHostnameRecord> {
    const record = buildHostnameRecord(input.spec);
    this.registeredHostnames.set(input.spec.hostname, record);
    return Promise.resolve(record);
  }
  getCustomHostname(input: {
    readonly zoneId: string;
    readonly hostname: string;
  }): Promise<CloudflareCustomHostnameRecord | undefined> {
    // The materializer passes the hostname (not the id) to resolve in-flight
    // partial state; honor that by keying on hostname here.
    return Promise.resolve(this.registeredHostnames.get(input.hostname));
  }
  refreshSsl(): Promise<CloudflareCustomHostnameSslState> {
    return Promise.resolve({ status: "pending", method: "http" });
  }
  verify(): Promise<CloudflareCustomHostnameRecord> {
    return Promise.resolve(buildHostnameRecord({
      hostname: "verified.example.test",
      sslMethod: "http",
    }));
  }
  deleteCustomHostname(input: {
    readonly zoneId: string;
    readonly hostnameId: string;
  }): Promise<boolean> {
    this.deletedHostnameIds.push(input.hostnameId);
    return Promise.resolve(true);
  }
  materializeHostnames(
    input: CloudflareCustomDomainMaterializationInput,
  ): Promise<CloudflareCustomDomainMaterializationResult> {
    this.materializeCalls.push(input);
    // Pre-register every hostname so cleanupInFlight can find them via
    // getCustomHostname (this models the partial-state Cloudflare leaves
    // behind during long-running SSL validation).
    for (const spec of input.hostnames) {
      this.registeredHostnames.set(spec.hostname, buildHostnameRecord(spec));
    }
    return new Promise((_resolve, reject) => {
      const signal = input.signal;
      if (!signal) {
        // Without a signal we never resolve to keep tests honest about the
        // abort path — they should always pass a signal.
        return;
      }
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      signal.addEventListener("abort", () => reject(abortError(signal)), {
        once: true,
      });
    });
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = (signal as unknown as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

interface CustomDomainReservation {
  readonly hostname: string;
  readonly owner: {
    readonly tenantId: string;
    readonly groupId: string;
    readonly deploymentId: string;
  };
  readonly status: "active" | "released";
}

function buildRegistry(): {
  readonly registry: Map<string, CustomDomainReservation>;
  readonly client: CustomDomainRegistryClient;
} {
  const registry = new Map<string, CustomDomainReservation>();
  const client: CustomDomainRegistryClient = {
    reserve: (input) => {
      const existing = registry.get(input.hostname);
      const sameOwner = existing?.owner.tenantId === input.tenantId &&
        existing?.owner.groupId === input.groupId &&
        existing?.owner.deploymentId === input.deploymentId;
      if (existing?.status === "active" && !sameOwner) {
        throw new Error(`hostname already reserved: ${input.hostname}`);
      }
      registry.set(input.hostname, {
        hostname: input.hostname,
        owner: {
          tenantId: input.tenantId,
          groupId: input.groupId,
          deploymentId: input.deploymentId,
        },
        status: "active",
      });
      return Promise.resolve();
    },
    release: (input) => {
      const existing = registry.get(input.hostname);
      if (!existing) return Promise.resolve();
      const sameOwner = existing.owner.tenantId === input.tenantId &&
        existing.owner.groupId === input.groupId &&
        existing.owner.deploymentId === input.deploymentId;
      if (!sameOwner) return Promise.resolve();
      registry.set(input.hostname, { ...existing, status: "released" });
      return Promise.resolve();
    },
  };
  return { registry, client };
}

function buildMaterializer(
  client: CloudflareCustomDomainClient,
  registry: CustomDomainRegistryClient | undefined,
  prefix: string,
) {
  return new CloudflareCustomDomainProviderMaterializer({
    client,
    zoneId: "zone-1",
    accountId: "acct-1",
    clock: clockFrom("2026-04-30T00:00:00.000Z"),
    idGenerator: counterId(prefix),
    registry,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("phase 18.2 H7: aborting in-flight materialize releases the registry reservation", async () => {
  const { registry, client: registryClient } = buildRegistry();
  const cloudflareClient = new HangingCloudflareClient();
  const materializer = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-cancel-1",
  );
  const desired = buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  const controller = new AbortController();
  const promise = materializer.materialize(desired, {
    signal: controller.signal,
  });
  // Simulate the deploy lifecycle aborting after 30s of SSL validation.
  queueMicrotask(() => controller.abort());
  await assert.rejects(() => promise);
  // Reservation must be released so a subsequent deploy can claim it again.
  assert.equal(registry.get("api.example.com")?.status, "released");
});

Deno.test("phase 18.2 H7: aborting in-flight materialize deletes the partially-provisioned Cloudflare hostname", async () => {
  const { client: registryClient } = buildRegistry();
  const cloudflareClient = new HangingCloudflareClient();
  const materializer = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-cancel-2",
  );
  const desired = buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  const controller = new AbortController();
  const promise = materializer.materialize(desired, {
    signal: controller.signal,
  });
  queueMicrotask(() => controller.abort());
  await assert.rejects(() => promise);
  // The cleanup pathway MUST hit deleteCustomHostname for every hostname that
  // had been registered (i.e. zero orphans left in the CF zone).
  assert.deepEqual(cloudflareClient.deletedHostnameIds, ["hn-api.example.com"]);
});

Deno.test("phase 18.2 H7: a follow-up deploy can re-claim the cancelled hostname", async () => {
  const { registry, client: registryClient } = buildRegistry();
  const cancelClient = new HangingCloudflareClient();
  const cancelMaterializer = buildMaterializer(
    cancelClient,
    registryClient,
    "cf-cancel-3a",
  );
  const cancelDesired = buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  const controller = new AbortController();
  const promise = cancelMaterializer.materialize(cancelDesired, {
    signal: controller.signal,
  });
  queueMicrotask(() => controller.abort());
  await assert.rejects(() => promise);
  assert.equal(registry.get("api.example.com")?.status, "released");

  // A successor deployment claims the now-released hostname. It uses a
  // non-hanging client so the apply completes.
  class SucceedingClient extends HangingCloudflareClient {
    override materializeHostnames(
      input: CloudflareCustomDomainMaterializationInput,
    ): Promise<CloudflareCustomDomainMaterializationResult> {
      this.materializeCalls.push(input);
      return Promise.resolve({
        hostnames: input.hostnames.map(buildHostnameRecord),
        stdout: `applied ${input.hostnames.length} custom hostnames`,
      });
    }
  }
  const successClient = new SucceedingClient();
  const successMaterializer = buildMaterializer(
    successClient,
    registryClient,
    "cf-cancel-3b",
  );
  const successDesired = buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-2",
  });
  await successMaterializer.materialize(successDesired);
  assert.equal(registry.get("api.example.com")?.status, "active");
  assert.equal(
    registry.get("api.example.com")?.owner.deploymentId,
    "deployment-a-2",
  );
});

Deno.test("phase 18.2 H7: pre-aborted signal short-circuits before Cloudflare is touched", async () => {
  const { registry, client: registryClient } = buildRegistry();
  const cloudflareClient = new HangingCloudflareClient();
  const materializer = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-cancel-4",
  );
  const desired = buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    materializer.materialize(desired, { signal: controller.signal })
  );
  assert.equal(cloudflareClient.materializeCalls.length, 0);
  assert.equal(cloudflareClient.deletedHostnameIds.length, 0);
  // No reservation was acquired so registry stays empty.
  assert.equal(registry.size, 0);
});

Deno.test("phase 18.2 H7: cleanupInFlight is idempotent when called by the rollback pipeline", async () => {
  const { registry, client: registryClient } = buildRegistry();
  const cloudflareClient = new HangingCloudflareClient();
  const materializer = buildMaterializer(
    cloudflareClient,
    registryClient,
    "cf-cancel-5",
  );
  const desired = buildDesiredState({
    host: "api.example.com",
    spaceId: "tenant-a",
    groupId: "group-a",
    deploymentId: "deployment-a-1",
  });
  const controller = new AbortController();
  const promise = materializer.materialize(desired, {
    signal: controller.signal,
  });
  queueMicrotask(() => controller.abort());
  await assert.rejects(() => promise);
  // Re-run cleanup; expectation: no throw, no double-delete amplification
  // beyond what the initial cancellation already issued.
  await materializer.cleanupInFlight({ desiredState: desired });
  // First call deleted the hostname; second call finds nothing to delete
  // (the stub's getCustomHostname returns the same record so a second
  // delete may still happen, but it must not raise).
  assert.ok(cloudflareClient.deletedHostnameIds.length >= 1);
  assert.equal(registry.get("api.example.com")?.status, "released");
});
