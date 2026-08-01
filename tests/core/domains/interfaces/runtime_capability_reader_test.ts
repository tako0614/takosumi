import { describe, expect, test } from "bun:test";
import type { Interface, InterfaceBinding } from "takosumi-contract/interfaces";
import type {
  InstalledFormReference,
  NativeResourceRef,
} from "takosumi-contract";
import { formRefKey, formRefOfInstalled } from "takosumi-contract";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import {
  D1RuntimeCapabilityReader,
  InMemoryRuntimeCapabilityReader,
  type RuntimeCapabilityReadInput,
} from "../../../../core/domains/interfaces/runtime_capability_reader.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const FORM: InstalledFormReference = {
  type: "app_edge",
  version: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
  packageDigest: `sha256:${"b".repeat(64)}`,
};
const RESOURCE_ID = "tkrn:ws_runtime:EdgeWorker:app";
const AUDIENCE = "https://runtime.example/";

function fixture() {
  const native: NativeResourceRef = {
    type: "worker",
    id: "native-app",
    form: FORM,
  };
  const resource: ResourceShapeRecord = {
    id: RESOURCE_ID,
    spaceId: "ws_runtime",
    kind: "EdgeWorker",
    form: FORM,
    name: "app",
    managedBy: "opentofu",
    spec: { name: "app" },
    phase: "Ready",
    generation: 3,
    observedGeneration: 3,
    revision: 2,
    execution: {
      runId: "run_apply_3",
      stateGeneration: 3,
      stateRef: "state:3",
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const lock: ResolutionLockRecord = {
    resourceId: RESOURCE_ID,
    form: FORM,
    selectedImplementation: "edge_worker",
    target: "target-a",
    locked: true,
    reason: [],
    portability: "portable",
    nativeResources: [native],
    lockedAt: NOW,
    updatedAt: NOW,
  };
  const iface: Interface = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: "if_runtime",
      workspaceId: "ws_runtime",
      name: "runtime",
      ownerRef: { kind: "Resource", id: RESOURCE_ID },
      generation: 2,
      materializedFrom: {
        source: "form_descriptor",
        formRefKey: formRefKey(formRefOfInstalled(FORM)),
        formSchemaDigest: FORM.schemaDigest,
        descriptorName: "runtime",
        descriptorVersion: "1",
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    spec: {
      type: "app.runtime",
      version: "1",
      document: {},
      access: { visibility: "workspace" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 2,
      resolvedRevision: 4,
      resourceUri: AUDIENCE,
    },
  };
  const binding: InterfaceBinding = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "InterfaceBinding",
    metadata: {
      id: "ifb_runtime",
      workspaceId: "ws_runtime",
      generation: 1,
      materializedFrom: {
        source: "form_host_descriptor",
        formRefKey: iface.metadata.materializedFrom!.formRefKey,
        descriptorName: "runtime",
        descriptorVersion: "1",
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    spec: {
      interfaceId: iface.metadata.id,
      subjectRef: { kind: "Resource", id: RESOURCE_ID },
      permissions: ["read"],
      delivery: { type: "none" },
    },
    status: {
      phase: "Ready",
      observedInterfaceRevision: 4,
    },
  };
  return { resource, lock, iface, binding };
}

function input(
  overrides: Partial<RuntimeCapabilityReadInput> = {},
): RuntimeCapabilityReadInput {
  return {
    workspaceId: "ws_runtime",
    resourceId: RESOURCE_ID,
    resourceKind: "EdgeWorker",
    interfaceId: "if_runtime",
    interfaceBindingId: "ifb_runtime",
    bindingSubject: { kind: "Resource", id: RESOURCE_ID },
    requiredPermission: "read",
    interfaceResolvedRevision: 4,
    audience: AUDIENCE,
    ...overrides,
  };
}

describe("RuntimeCapabilityReader", () => {
  test("returns one immutable capability for Resource/none with an audience", async () => {
    const records = fixture();
    const result = await memoryReader(records).read(input());
    expect(result?.resourceGeneration).toBe(3);
    expect(result?.resourceRevisionId).toBe("run_apply_3");
    expect(result?.nativeResources).toEqual(records.lock.nativeResources);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.resource)).toBe(true);
  });

  test("Resource/none audience does not require the durable OAuth claim", async () => {
    const records = fixture();
    const result = await readD1Row({
      ...d1Row(records),
      interface_oauth_resource_uri: null,
    });
    expect(result?.iface.status.resourceUri).toBe(AUDIENCE);
  });

  test("Principal/oauth2 requires the exact durable OAuth claim", async () => {
    const records = fixture();
    const binding: InterfaceBinding = {
      ...records.binding,
      spec: {
        ...records.binding.spec,
        subjectRef: { kind: "Principal", id: "principal-runtime" },
        delivery: { type: "oauth2" },
      },
    };
    const principalInput = input({
      bindingSubject: { kind: "Principal", id: "principal-runtime" },
    });
    const withoutClaim = await readD1Row(
      {
        ...d1Row({ ...records, binding }),
        interface_oauth_resource_uri: null,
      },
      principalInput,
    );
    expect(withoutClaim).toBeUndefined();
    const exactClaim = await readD1Row(
      d1Row({ ...records, binding }),
      principalInput,
    );
    expect(exactClaim?.resourceGeneration).toBe(3);
  });

  test("resource observation timestamp changes do not revoke the capability", async () => {
    const records = fixture();
    const result = await memoryReader({
      ...records,
      resource: {
        ...records.resource,
        updatedAt: "2026-08-01T00:01:00.000Z",
      },
    }).read(input());
    expect(result?.resourceRevisionId).toBe("run_apply_3");
  });

  test("reconstructs the installed Form from FormRef plus package digest", async () => {
    const records = fixture();
    const result = await readD1Row(d1Row(records));
    expect(result?.resource.form).toEqual(FORM);
    expect(result?.iface.metadata.materializedFrom?.formSchemaDigest).toBe(
      FORM.schemaDigest,
    );
    const mismatched = await readD1Row({
      ...d1Row(records),
      resource_package_digest: `sha256:${"c".repeat(64)}`,
    });
    expect(mismatched).toBeUndefined();
  });

  test("malformed non-null native_resources_json fails closed", async () => {
    const records = fixture();
    const result = await readD1Row({
      ...d1Row(records),
      lock_native_resources_json: JSON.stringify({ type: "worker" }),
    });
    expect(result).toBeUndefined();
  });

  test("fails closed for revoked Binding, NotReady Interface, stale revision, and Form drift", async () => {
    const records = fixture();
    const reader = (next: Partial<typeof records>) =>
      memoryReader({ ...records, ...next });
    expect(
      await reader({
        binding: {
          ...records.binding,
          status: { ...records.binding.status, phase: "Revoked" },
        },
      }).read(input()),
    ).toBeUndefined();
    expect(
      await reader({
        iface: {
          ...records.iface,
          status: { ...records.iface.status, phase: "NotReady" },
        },
      }).read(input()),
    ).toBeUndefined();
    expect(
      await memoryReader(records).read(input({ interfaceResolvedRevision: 3 })),
    ).toBeUndefined();
    expect(
      await reader({
        lock: {
          ...records.lock,
          form: { ...FORM, packageDigest: `sha256:${"c".repeat(64)}` },
        },
      }).read(input()),
    ).toBeUndefined();
  });

  test("uses one primary D1 terminal statement", async () => {
    const records = fixture();
    const row = d1Row(records);
    let prepares = 0;
    let sessions = 0;
    const db = {
      withSession(bookmark: "first-primary") {
        expect(bookmark).toBe("first-primary");
        sessions += 1;
        return this;
      },
      prepare(_query: string) {
        prepares += 1;
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: [row], meta: { rows_read: 8 } };
          },
        };
      },
    };
    const result = await new D1RuntimeCapabilityReader(db).read(input());
    expect(result?.resourceRevisionId).toBe("run_apply_3");
    expect(prepares).toBe(1);
    expect(sessions).toBe(1);
  });
});

function d1Row(records: ReturnType<typeof fixture>): Record<string, unknown> {
  const { resource, lock, iface, binding } = records;
  const source = iface.metadata.materializedFrom!;
  return {
    resource_id: resource.id,
    resource_space_id: resource.spaceId,
    resource_kind: resource.kind,
    resource_form_ref_json: JSON.stringify(formRefOfInstalled(resource.form!)),
    resource_package_digest: resource.form!.packageDigest,
    resource_project: null,
    resource_environment: null,
    resource_name: resource.name,
    resource_managed_by: resource.managedBy,
    resource_spec_json: JSON.stringify(resource.spec),
    resource_phase: resource.phase,
    resource_generation: resource.generation,
    resource_observed_generation: resource.observedGeneration,
    resource_outputs_json: null,
    resource_execution_json: JSON.stringify(resource.execution),
    resource_conditions_json: null,
    resource_labels_json: null,
    resource_created_at: resource.createdAt,
    resource_updated_at: resource.updatedAt,
    resource_revision: resource.revision,
    resource_owner_json: null,
    resource_last_operation_run_id: null,
    lock_resource_id: lock.resourceId,
    lock_form_ref_json: JSON.stringify(formRefOfInstalled(lock.form!)),
    lock_package_digest: lock.form!.packageDigest,
    lock_selected_implementation: lock.selectedImplementation,
    lock_target: lock.target,
    lock_target_snapshot_json: null,
    lock_implementation_snapshot_json: null,
    lock_implementation_plugin: null,
    lock_implementation_options_json: null,
    lock_implementation_fingerprint: null,
    lock_locked: 1,
    lock_reason_json: JSON.stringify(lock.reason),
    lock_portability: lock.portability,
    lock_native_resources_json: JSON.stringify(lock.nativeResources),
    lock_locked_at: lock.lockedAt,
    lock_updated_at: lock.updatedAt,
    interface_id: iface.metadata.id,
    interface_workspace_id: iface.metadata.workspaceId,
    interface_owner_kind: iface.metadata.ownerRef.kind,
    interface_owner_id: iface.metadata.ownerRef.id,
    interface_phase: iface.status.phase,
    interface_generation: iface.metadata.generation,
    interface_resolved_revision: iface.status.resolvedRevision,
    interface_oauth_resource_uri: AUDIENCE,
    interface_form_ref_key: source.formRefKey,
    interface_form_schema_digest: source.formSchemaDigest,
    interface_descriptor_name: source.descriptorName,
    interface_descriptor_version: source.descriptorVersion,
    interface_record_json: JSON.stringify(iface),
    binding_id: binding.metadata.id,
    binding_workspace_id: binding.metadata.workspaceId,
    binding_interface_id: binding.spec.interfaceId,
    binding_subject_kind: binding.spec.subjectRef.kind,
    binding_subject_id: binding.spec.subjectRef.id,
    binding_phase: binding.status.phase,
    binding_generation: binding.metadata.generation,
    binding_record_json: JSON.stringify(binding),
  };
}

function memoryReader(records: ReturnType<typeof fixture>) {
  return new InMemoryRuntimeCapabilityReader({
    resources: [records.resource],
    locks: [records.lock],
    interfaces: [records.iface],
    bindings: [records.binding],
  });
}

async function readD1Row(
  row: Record<string, unknown>,
  overrides: Partial<RuntimeCapabilityReadInput> = {},
) {
  const db = {
    withSession(bookmark: "first-primary") {
      expect(bookmark).toBe("first-primary");
      return this;
    },
    prepare(_query: string) {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [row], meta: { rows_read: 1 } };
        },
      };
    },
  };
  return new D1RuntimeCapabilityReader(db).read(input(overrides));
}
