import { expect, test } from "bun:test";
import {
  capsuleInterfaceBlueprintsNeedInstallingPrincipal,
  resolveCapsuleInterfaceBlueprintInstallingPrincipal,
  type CapsuleInterfaceBlueprint,
} from "takosumi-contract/interfaces";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
  validateCapsuleInterfaceBlueprints,
} from "../../../../core/domains/interfaces/mod.ts";

const BLUEPRINTS: readonly CapsuleInterfaceBlueprint[] = [
  {
    key: "launcher",
    name: "example.launcher",
    spec: {
      type: "interface.ui.surface",
      version: "1",
      document: { launcher: true },
      inputs: {
        url: { source: "literal", value: "https://example.test" },
      },
      access: { visibility: "workspace" },
    },
    bindings: [
      {
        key: "installer",
        subject: { source: "installing_principal" },
        permissions: ["ui.open"],
        delivery: { type: "none" },
      },
    ],
  },
];

test("installing Principal placeholder resolves once before durable binding materialization", async () => {
  expect(() => validateCapsuleInterfaceBlueprints(BLUEPRINTS)).not.toThrow();
  expect(capsuleInterfaceBlueprintsNeedInstallingPrincipal(BLUEPRINTS)).toBe(
    true,
  );
  const resolved = resolveCapsuleInterfaceBlueprintInstallingPrincipal(
    BLUEPRINTS,
    "account_installer",
  )!;
  expect(capsuleInterfaceBlueprintsNeedInstallingPrincipal(resolved)).toBe(
    false,
  );
  expect(resolved[0]?.bindings?.[0]).toEqual({
    key: "installer",
    subjectRef: { kind: "Principal", id: "account_installer" },
    permissions: ["ui.open"],
    delivery: { type: "none" },
  });

  let sequence = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => "2026-07-14T00:00:00.000Z",
    newId: (prefix) => `${prefix}_${++sequence}`,
  });
  const [iface] = await service.ensureCapsuleBlueprints({
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    blueprints: resolved,
  });
  expect(iface).toBeDefined();
  expect(await service.listBindings(iface!.metadata.id)).toEqual([
    expect.objectContaining({
      spec: expect.objectContaining({
        subjectRef: { kind: "Principal", id: "account_installer" },
        permissions: ["ui.open"],
        delivery: { type: "none" },
      }),
    }),
  ]);
});

test("unresolved placeholder is never persisted as a wildcard subject", async () => {
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
  });
  await expect(
    service.ensureCapsuleBlueprints({
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      blueprints: BLUEPRINTS,
    }),
  ).rejects.toThrow("must be resolved");
});
