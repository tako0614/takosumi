import { expect, test } from "bun:test";

import { TAKOSUMI_API_VERSION } from "../../contract/capabilities.ts";
import type {
  Interface as InternalCompatibleInterface,
  InterfaceBinding as InternalCompatibleInterfaceBinding,
} from "../../contract/interfaces.ts";
import {
  INTERFACE_NAME_PATTERN,
  INTERFACE_PERMISSION_TOKEN_MAX_LENGTH,
  INTERFACE_PERMISSION_TOKEN_PATTERN,
  isValidInterfaceName,
  isValidInterfacePermissionToken,
} from "../../contract/runtime-interfaces.ts";
import type {
  Interface,
  InterfaceBinding,
} from "../../contract/runtime-interfaces.ts";

const runtimeInterface = {
  apiVersion: TAKOSUMI_API_VERSION,
  kind: "Interface",
  metadata: {
    id: "ifc_public",
    workspaceId: "ws_public",
    name: "app.runtime",
    ownerRef: { kind: "Capsule", id: "cap_public" },
    generation: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  },
  spec: {
    type: "app.runtime",
    version: "1",
    document: { endpoint: "https://app.example" },
    access: { visibility: "workspace" },
  },
  status: {
    phase: "Resolved",
    observedGeneration: 1,
    resolvedRevision: 1,
    resourceUri: "https://app.example/",
  },
} satisfies Interface;

const runtimeBinding = {
  apiVersion: TAKOSUMI_API_VERSION,
  kind: "InterfaceBinding",
  metadata: {
    id: "ifb_public",
    workspaceId: "ws_public",
    generation: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  },
  spec: {
    interfaceId: runtimeInterface.metadata.id,
    subjectRef: { kind: "Principal", id: "tsub_public" },
    permissions: ["app.invoke"],
    delivery: { type: "oauth2" },
  },
  status: {
    phase: "Ready",
    observedInterfaceRevision: 1,
  },
} satisfies InterfaceBinding;

test("runtime Interface wire declarations remain source-compatible internally", () => {
  const internalInterface: InternalCompatibleInterface = runtimeInterface;
  const internalBinding: InternalCompatibleInterfaceBinding = runtimeBinding;
  const publicInterface: Interface = internalInterface;
  const publicBinding: InterfaceBinding = internalBinding;

  expect(publicInterface.kind).toBe("Interface");
  expect(publicBinding.kind).toBe("InterfaceBinding");
});

test("runtime Interface lexical validators are public and bounded", () => {
  expect(INTERFACE_NAME_PATTERN.test("app.runtime-v1")).toBe(true);
  expect(isValidInterfaceName("app.runtime-v1")).toBe(true);
  expect(isValidInterfaceName("1-invalid")).toBe(false);
  expect(INTERFACE_PERMISSION_TOKEN_PATTERN.test("app.invoke")).toBe(true);
  expect(isValidInterfacePermissionToken("app.invoke")).toBe(true);
  expect(
    isValidInterfacePermissionToken(
      "x".repeat(INTERFACE_PERMISSION_TOKEN_MAX_LENGTH + 1),
    ),
  ).toBe(false);
});

test("runtime Interface source excludes service-only request and blueprint APIs", async () => {
  const runtimeSource = await Bun.file(
    new URL("../../contract/runtime-interfaces.ts", import.meta.url),
  ).text();
  const compatibilitySource = await Bun.file(
    new URL("../../contract/interfaces.ts", import.meta.url),
  ).text();

  for (const forbidden of [
    "CapsuleInterfaceBlueprint",
    "InterfaceCapsuleOutputInput",
    "InterfaceInputProvenance",
    "InterfaceProjectionSink",
    "CreateInterfaceRequest",
    "UpdateInterfaceRequest",
    "ReportInterfaceStatusRequest",
    "IssueInterfaceTokenRequest",
    "resolveCapsuleInterfaceBlueprintInstallingPrincipal",
    "capsule_blueprint",
    "capsule_required_interface",
    "materializedFrom",
    "stateVersionId",
  ]) {
    expect(runtimeSource).not.toContain(forbidden);
  }
  expect(compatibilitySource).toContain(
    'export * from "./runtime-interfaces.ts";',
  );
  expect(compatibilitySource).toContain("Interface as PublicInterface");
  expect(compatibilitySource).toContain(
    "extends Omit<PublicInterface,",
  );
  expect(compatibilitySource).toContain(
    "extends Omit<PublicInterfaceBinding,",
  );
});
