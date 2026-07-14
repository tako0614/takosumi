import { expect, test } from "bun:test";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
} from "../../../../core/domains/interfaces/mod.ts";

const NOW = "2026-07-13T12:00:00.000Z";

function service(
  bindingDeliveryHandlers?: ConstructorParameters<
    typeof InterfaceService
  >[0]["bindingDeliveryHandlers"],
) {
  let id = 0;
  return new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++id}`,
    ...(bindingDeliveryHandlers ? { bindingDeliveryHandlers } : {}),
  });
}

async function literalInterface(instance: InterfaceService) {
  return await instance.create({
    workspaceId: "workspace_1",
    name: "runtime-endpoint",
    ownerRef: { kind: "Workspace", id: "workspace_1" },
    spec: {
      type: "example.runtime",
      version: "v1",
      document: {},
      access: { visibility: "workspace" },
    },
  });
}

test("custom InterfaceBinding delivery readiness is selected by exact registry key", async () => {
  const instance = service({
    "workload-token.v1": ({ subjectRef, delivery }) => ({
      ready:
        subjectRef.kind === "ServiceAccount" &&
        delivery.credentialRef?.startsWith("credential/") === true,
      reason: "WorkloadCredentialResolved",
    }),
  });
  const iface = await literalInterface(instance);
  const binding = await instance.createBinding(iface.metadata.id, {
    subjectRef: { kind: "ServiceAccount", id: "runtime_1" },
    permissions: ["invoke"],
    delivery: {
      type: "workload-token.v1",
      credentialRef: "credential/runtime_1",
    },
  });

  expect(binding.status).toMatchObject({
    phase: "Ready",
    conditions: [{ reason: "WorkloadCredentialResolved" }],
  });
});

test("missing or throwing delivery handlers fail closed", async () => {
  const instance = service({
    "broken.v1": () => {
      throw new Error("adapter unavailable");
    },
  });
  const iface = await literalInterface(instance);
  const missing = await instance.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Resource", id: "resource_1" },
    permissions: ["read"],
    delivery: { type: "not-installed.v1" },
  });
  const broken = await instance.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Resource", id: "resource_2" },
    permissions: ["read"],
    delivery: { type: "broken.v1" },
  });

  expect(missing.status.conditions?.[0]?.reason).toBe("UnsupportedDelivery");
  expect(broken.status.conditions?.[0]?.reason).toBe("DeliveryHandlerFailed");
});

test("standard and reserved delivery ids cannot be shadowed by host handlers", () => {
  for (const type of ["none", "oauth2", "workload_token"]) {
    expect(() =>
      service({ [type]: () => ({ ready: true, reason: "shadow" }) }),
    ).toThrow(`delivery handler ${type} is already registered`);
  }
});

test("reserved workload_token remains NotReady for a ServiceAccount", async () => {
  const instance = service();
  const iface = await literalInterface(instance);
  const binding = await instance.createBinding(iface.metadata.id, {
    subjectRef: { kind: "ServiceAccount", id: "runtime_1" },
    permissions: ["invoke"],
    delivery: { type: "workload_token" },
  });

  expect(binding.status).toMatchObject({
    phase: "NotReady",
    conditions: [{ reason: "UnsupportedDelivery" }],
  });
});
