import {
  formRefKey,
  formRefOfInstalled,
  isInstalledFormReference,
  isResourceShapeKind,
  TAKOSUMI_API_VERSION,
  type InstalledFormReference,
  type NativeResourceRef,
  type ResourceObject,
  type ResourcePortability,
  type ResourceShapeKind,
} from "takosumi-contract";
import type {
  Interface,
  InterfaceBinding,
  InterfaceSubjectKind,
} from "takosumi-contract/interfaces";
import { deployControlD1TableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import { freezeClone } from "../../shared/freeze.ts";
import type { D1Like } from "../resource-shape/d1_stores.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
} from "../resource-shape/records.ts";
import {
  parseResourceShapeId,
  resourceFormIdentitiesEqual,
} from "../resource-shape/records.ts";
import {
  canonicalInterfaceOAuth2ResourceUri,
  interfaceOAuth2ResourceUri,
} from "./oauth_resource.ts";

/** Exact subject supplied by a host runtime activation request. */
export interface RuntimeCapabilityBindingSubject {
  readonly kind: InterfaceSubjectKind;
  readonly id: string;
}

/**
 * Exact four-row identity required for one runtime capability read.
 *
 * `interfaceResolvedRevision` is deliberately caller supplied. A host that
 * observed an older Interface revision cannot accidentally receive a current
 * grant by asking the reader to select one.
 */
export interface RuntimeCapabilityReadInput {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly resourceKind: ResourceShapeKind;
  readonly interfaceId: string;
  readonly interfaceBindingId: string;
  readonly bindingSubject: RuntimeCapabilityBindingSubject;
  readonly requiredPermission: string;
  readonly interfaceResolvedRevision: number;
  /** Required for Principal/oauth2 delivery; omitted for Resource/none. */
  readonly audience?: string;
}

/** Immutable evidence a host may use for one already-authorized capability. */
export interface RuntimeCapability {
  readonly resource: ResourceObject;
  readonly resourceGeneration: number;
  /** Canonical backend lifecycle revision (the completed operation id). */
  readonly resourceRevisionId: string;
  readonly nativeResources: readonly NativeResourceRef[];
  readonly iface: Interface;
  readonly binding: InterfaceBinding;
}

/** Public composition port shared by D1, memory, and hosted callers. */
export interface RuntimeCapabilityReader {
  read(
    input: RuntimeCapabilityReadInput,
  ): Promise<RuntimeCapability | undefined>;
}

interface RuntimeCapabilitySnapshot {
  readonly resource: ResourceShapeRecord;
  readonly lock: ResolutionLockRecord;
  readonly iface: Interface;
  readonly binding: InterfaceBinding;
  /** Durable unique audience claim, when present in a SQL projection. */
  readonly interfaceOAuthResourceUri?: string;
}

/**
 * D1 implementation. `read` intentionally performs one and only one
 * terminal Control-D1 statement; all lifecycle and lineage validation happens
 * on that joined snapshot without follow-up reads.
 */
export class D1RuntimeCapabilityReader implements RuntimeCapabilityReader {
  constructor(private readonly db: D1Like) {}

  async read(
    input: RuntimeCapabilityReadInput,
  ): Promise<RuntimeCapability | undefined> {
    if (!validReadInput(input)) return undefined;

    const queryDb = d1PrimarySession(this.db);
    const rows = await queryDb
      .prepare(
        `select
           r.id as resource_id,
           r.space_id as resource_space_id,
           r.kind as resource_kind,
           r.form_ref_json as resource_form_ref_json,
           r.package_digest as resource_package_digest,
           r.project as resource_project,
           r.environment as resource_environment,
           r.name as resource_name,
           r.managed_by as resource_managed_by,
           r.spec_json as resource_spec_json,
           r.phase as resource_phase,
           r.generation as resource_generation,
           r.observed_generation as resource_observed_generation,
           r.outputs_json as resource_outputs_json,
           r.execution_json as resource_execution_json,
           r.conditions_json as resource_conditions_json,
           r.labels_json as resource_labels_json,
           r.created_at as resource_created_at,
           r.updated_at as resource_updated_at,
           r.revision as resource_revision,
           r.owner_json as resource_owner_json,
           r.last_operation_run_id as resource_last_operation_run_id,
           l.resource_id as lock_resource_id,
           l.form_ref_json as lock_form_ref_json,
           l.package_digest as lock_package_digest,
           l.selected_implementation as lock_selected_implementation,
           l.target as lock_target,
           l.target_snapshot_json as lock_target_snapshot_json,
           l.implementation_snapshot_json as lock_implementation_snapshot_json,
           l.implementation_plugin as lock_implementation_plugin,
           l.implementation_options_json as lock_implementation_options_json,
           l.implementation_fingerprint as lock_implementation_fingerprint,
           l.locked as lock_locked,
           l.reason_json as lock_reason_json,
           l.portability as lock_portability,
           l.native_resources_json as lock_native_resources_json,
           l.locked_at as lock_locked_at,
           l.updated_at as lock_updated_at,
           i.id as interface_id,
           i.workspace_id as interface_workspace_id,
           i.owner_kind as interface_owner_kind,
           i.owner_id as interface_owner_id,
           i.phase as interface_phase,
           i.generation as interface_generation,
           i.resolved_revision as interface_resolved_revision,
           i.oauth_resource_uri as interface_oauth_resource_uri,
           i.form_ref_key as interface_form_ref_key,
           i.form_schema_digest as interface_form_schema_digest,
           i.descriptor_name as interface_descriptor_name,
           i.descriptor_version as interface_descriptor_version,
           i.record_json as interface_record_json,
           b.id as binding_id,
           b.workspace_id as binding_workspace_id,
           b.interface_id as binding_interface_id,
           b.subject_kind as binding_subject_kind,
           b.subject_id as binding_subject_id,
           b.phase as binding_phase,
           b.generation as binding_generation,
           b.record_json as binding_record_json
         from ${names.resourceShapes} r
         join ${names.resolutionLocks} l
           on l.resource_id = r.id
          and l.resource_id = ?
         join ${names.interfaces} i
           on i.id = ?
          and i.workspace_id = ?
          and i.owner_kind = 'Resource'
          and i.owner_id = r.id
          and i.resolved_revision = ?
         join ${names.interfaceBindings} b
           on b.id = ?
          and b.interface_id = i.id
          and b.workspace_id = i.workspace_id
          and b.subject_kind = ?
          and b.subject_id = ?
         where r.id = ?
           and r.space_id = ?
           and r.kind = ?
         limit 2`,
      )
      .bind(
        input.resourceId,
        input.interfaceId,
        input.workspaceId,
        input.interfaceResolvedRevision,
        input.interfaceBindingId,
        input.bindingSubject.kind,
        input.bindingSubject.id,
        input.resourceId,
        input.workspaceId,
        input.resourceKind,
      )
      .all<RuntimeCapabilityD1Row>();
    if (
      rows.meta?.rows_read !== undefined &&
      (!Number.isSafeInteger(rows.meta.rows_read) ||
        rows.meta.rows_read < 0 ||
        rows.meta.rows_read > 8)
    ) {
      return undefined;
    }
    const resultRows = rows.results ?? [];
    if (resultRows.length !== 1) return undefined;
    try {
      return evaluateRuntimeCapability(
        input,
        runtimeCapabilitySnapshotFromD1Row(resultRows[0]!),
      );
    } catch {
      return undefined;
    }
  }
}

/**
 * Explicit in-memory composition for tests and non-D1 hosts. It uses the
 * same exact-row validator as the durable reader and never selects by order.
 */
export class InMemoryRuntimeCapabilityReader
  implements RuntimeCapabilityReader
{
  readonly #resources: readonly ResourceShapeRecord[];
  readonly #locks: readonly ResolutionLockRecord[];
  readonly #interfaces: readonly Interface[];
  readonly #bindings: readonly InterfaceBinding[];

  constructor(
    input: {
      readonly resources?: readonly ResourceShapeRecord[];
      readonly locks?: readonly ResolutionLockRecord[];
      readonly interfaces?: readonly Interface[];
      readonly bindings?: readonly InterfaceBinding[];
    } = {},
  ) {
    this.#resources = input.resources?.map(freezeClone) ?? [];
    this.#locks = input.locks?.map(freezeClone) ?? [];
    this.#interfaces = input.interfaces?.map(freezeClone) ?? [];
    this.#bindings = input.bindings?.map(freezeClone) ?? [];
  }

  async read(
    input: RuntimeCapabilityReadInput,
  ): Promise<RuntimeCapability | undefined> {
    if (!validReadInput(input)) return undefined;
    const resources = this.#resources.filter(
      (candidate) => candidate.id === input.resourceId,
    );
    const locks = this.#locks.filter(
      (candidate) => candidate.resourceId === input.resourceId,
    );
    const interfaces = this.#interfaces.filter(
      (candidate) => candidate.metadata.id === input.interfaceId,
    );
    const bindings = this.#bindings.filter(
      (candidate) => candidate.metadata.id === input.interfaceBindingId,
    );
    if (
      resources.length !== 1 ||
      locks.length !== 1 ||
      interfaces.length !== 1 ||
      bindings.length !== 1
    ) {
      return undefined;
    }
    try {
      return evaluateRuntimeCapability(input, {
        resource: resources[0]!,
        lock: locks[0]!,
        iface: interfaces[0]!,
        binding: bindings[0]!,
        ...(interfaceOAuth2ResourceUri(interfaces[0]!)
          ? {
              interfaceOAuthResourceUri: interfaceOAuth2ResourceUri(
                interfaces[0]!,
              ),
            }
          : {}),
      });
    } catch {
      return undefined;
    }
  }
}

export function createD1RuntimeCapabilityReader(
  db: D1Like,
): RuntimeCapabilityReader {
  return new D1RuntimeCapabilityReader(db);
}

export function createInMemoryRuntimeCapabilityReader(
  input: {
    readonly resources?: readonly ResourceShapeRecord[];
    readonly locks?: readonly ResolutionLockRecord[];
    readonly interfaces?: readonly Interface[];
    readonly bindings?: readonly InterfaceBinding[];
  } = {},
): RuntimeCapabilityReader {
  return new InMemoryRuntimeCapabilityReader(input);
}

interface RuntimeCapabilityD1Row {
  readonly resource_id: unknown;
  readonly resource_space_id: unknown;
  readonly resource_kind: unknown;
  readonly resource_form_ref_json: unknown;
  readonly resource_package_digest: unknown;
  readonly resource_project: unknown;
  readonly resource_environment: unknown;
  readonly resource_name: unknown;
  readonly resource_managed_by: unknown;
  readonly resource_spec_json: unknown;
  readonly resource_phase: unknown;
  readonly resource_generation: unknown;
  readonly resource_observed_generation: unknown;
  readonly resource_outputs_json: unknown;
  readonly resource_execution_json: unknown;
  readonly resource_conditions_json: unknown;
  readonly resource_labels_json: unknown;
  readonly resource_created_at: unknown;
  readonly resource_updated_at: unknown;
  readonly resource_revision: unknown;
  readonly resource_owner_json: unknown;
  readonly resource_last_operation_run_id: unknown;
  readonly lock_resource_id: unknown;
  readonly lock_form_ref_json: unknown;
  readonly lock_package_digest: unknown;
  readonly lock_selected_implementation: unknown;
  readonly lock_target: unknown;
  readonly lock_target_snapshot_json: unknown;
  readonly lock_implementation_snapshot_json: unknown;
  readonly lock_implementation_plugin: unknown;
  readonly lock_implementation_options_json: unknown;
  readonly lock_implementation_fingerprint: unknown;
  readonly lock_locked: unknown;
  readonly lock_reason_json: unknown;
  readonly lock_portability: unknown;
  readonly lock_native_resources_json: unknown;
  readonly lock_locked_at: unknown;
  readonly lock_updated_at: unknown;
  readonly interface_id: unknown;
  readonly interface_workspace_id: unknown;
  readonly interface_owner_kind: unknown;
  readonly interface_owner_id: unknown;
  readonly interface_phase: unknown;
  readonly interface_generation: unknown;
  readonly interface_resolved_revision: unknown;
  readonly interface_oauth_resource_uri: unknown;
  readonly interface_form_ref_key: unknown;
  readonly interface_form_schema_digest: unknown;
  readonly interface_descriptor_name: unknown;
  readonly interface_descriptor_version: unknown;
  readonly interface_record_json: unknown;
  readonly binding_id: unknown;
  readonly binding_workspace_id: unknown;
  readonly binding_interface_id: unknown;
  readonly binding_subject_kind: unknown;
  readonly binding_subject_id: unknown;
  readonly binding_phase: unknown;
  readonly binding_generation: unknown;
  readonly binding_record_json: unknown;
}

function runtimeCapabilitySnapshotFromD1Row(
  row: RuntimeCapabilityD1Row,
): RuntimeCapabilitySnapshot {
  const resourceForm = exactFormIdentity(
    row.resource_form_ref_json,
    row.resource_package_digest,
  );
  const lockForm = exactFormIdentity(
    row.lock_form_ref_json,
    row.lock_package_digest,
  );
  const resource = {
    id: text(row.resource_id),
    spaceId: text(row.resource_space_id),
    project: optionalText(row.resource_project),
    environment: optionalText(row.resource_environment),
    kind: text(row.resource_kind),
    ...(resourceForm ? { form: resourceForm } : {}),
    name: text(row.resource_name),
    managedBy: text(row.resource_managed_by),
    spec: jsonObject(row.resource_spec_json, "Resource spec"),
    phase: text(row.resource_phase) as ResourceShapeRecord["phase"],
    generation: integer(row.resource_generation, "Resource generation"),
    observedGeneration: integer(
      row.resource_observed_generation,
      "Resource observed generation",
    ),
    ...(jsonObjectOrUndefined(row.resource_outputs_json)
      ? { outputs: jsonObjectOrUndefined(row.resource_outputs_json) }
      : {}),
    ...(jsonObjectOrUndefined(row.resource_execution_json)
      ? { execution: jsonObjectOrUndefined(row.resource_execution_json) }
      : {}),
    ...(jsonArrayOrUndefined(row.resource_conditions_json)
      ? { conditions: jsonArrayOrUndefined(row.resource_conditions_json) }
      : {}),
    ...(jsonObjectOrUndefined(row.resource_labels_json)
      ? { labels: jsonObjectOrUndefined(row.resource_labels_json) }
      : {}),
    createdAt: text(row.resource_created_at),
    updatedAt: text(row.resource_updated_at),
    revision: integerOrUndefined(row.resource_revision),
    ...(jsonValueOrUndefined(row.resource_owner_json) !== undefined
      ? { owner: jsonValueOrUndefined(row.resource_owner_json) }
      : {}),
    ...(optionalText(row.resource_last_operation_run_id)
      ? { lastOperationRunId: optionalText(row.resource_last_operation_run_id) }
      : {}),
  } as ResourceShapeRecord;
  const nativeResources = jsonArrayOrUndefined(row.lock_native_resources_json);
  if (
    row.lock_native_resources_json !== null &&
    row.lock_native_resources_json !== undefined &&
    nativeResources === undefined
  ) {
    throw new Error("ResolutionLock native resources are invalid");
  }
  const lock = {
    resourceId: text(row.lock_resource_id),
    ...(lockForm ? { form: lockForm } : {}),
    selectedImplementation: text(row.lock_selected_implementation),
    target: text(row.lock_target),
    ...(jsonObjectOrUndefined(row.lock_target_snapshot_json)
      ? { targetSnapshot: jsonObjectOrUndefined(row.lock_target_snapshot_json) }
      : {}),
    ...(jsonObjectOrUndefined(row.lock_implementation_snapshot_json)
      ? {
          implementationSnapshot: jsonObjectOrUndefined(
            row.lock_implementation_snapshot_json,
          ),
        }
      : {}),
    ...(optionalText(row.lock_implementation_plugin)
      ? {
          selectedImplementationPlugin: optionalText(
            row.lock_implementation_plugin,
          ),
        }
      : {}),
    ...(jsonObjectOrUndefined(row.lock_implementation_options_json)
      ? {
          selectedImplementationOptions: jsonObjectOrUndefined(
            row.lock_implementation_options_json,
          ),
        }
      : {}),
    ...(optionalText(row.lock_implementation_fingerprint)
      ? {
          implementationFingerprint: optionalText(
            row.lock_implementation_fingerprint,
          ),
        }
      : {}),
    locked: integer(row.lock_locked, "ResolutionLock locked") === 1,
    reason: jsonStringArray(row.lock_reason_json, "ResolutionLock reason"),
    ...(optionalText(row.lock_portability)
      ? {
          portability: optionalText(
            row.lock_portability,
          ) as ResourcePortability,
        }
      : {}),
    ...(nativeResources ? { nativeResources } : {}),
    lockedAt: text(row.lock_locked_at),
    updatedAt: text(row.lock_updated_at),
  } as ResolutionLockRecord;
  const iface = jsonRecord(
    row.interface_record_json,
    "Interface",
  ) as unknown as Interface;
  const binding = jsonRecord(
    row.binding_record_json,
    "InterfaceBinding",
  ) as unknown as InterfaceBinding;
  if (
    text(row.interface_id) !== iface.metadata?.id ||
    text(row.interface_workspace_id) !== iface.metadata?.workspaceId ||
    text(row.interface_owner_kind) !== iface.metadata?.ownerRef?.kind ||
    text(row.interface_owner_id) !== iface.metadata?.ownerRef?.id ||
    text(row.interface_phase) !== iface.status?.phase ||
    integer(row.interface_generation, "Interface generation") !==
      iface.metadata?.generation ||
    integer(row.interface_resolved_revision, "Interface revision") !==
      iface.status?.resolvedRevision ||
    (optionalText(row.interface_form_ref_key) ?? undefined) !==
      (iface.metadata?.materializedFrom?.source === "form_descriptor"
        ? iface.metadata.materializedFrom.formRefKey
        : undefined) ||
    (optionalText(row.interface_form_schema_digest) ?? undefined) !==
      (iface.metadata?.materializedFrom?.source === "form_descriptor"
        ? iface.metadata.materializedFrom.formSchemaDigest
        : undefined) ||
    (optionalText(row.interface_descriptor_name) ?? undefined) !==
      (iface.metadata?.materializedFrom?.source === "form_descriptor"
        ? iface.metadata.materializedFrom.descriptorName
        : undefined) ||
    (optionalText(row.interface_descriptor_version) ?? undefined) !==
      (iface.metadata?.materializedFrom?.source === "form_descriptor"
        ? iface.metadata.materializedFrom.descriptorVersion
        : undefined) ||
    text(row.binding_id) !== binding.metadata?.id ||
    text(row.binding_workspace_id) !== binding.metadata?.workspaceId ||
    text(row.binding_interface_id) !== binding.spec?.interfaceId ||
    text(row.binding_subject_kind) !== binding.spec?.subjectRef?.kind ||
    text(row.binding_subject_id) !== binding.spec?.subjectRef?.id ||
    text(row.binding_phase) !== binding.status?.phase ||
    integer(row.binding_generation, "Binding generation") !==
      binding.metadata?.generation
  ) {
    throw new Error("runtime capability Interface projection is incoherent");
  }
  const interfaceOAuthResourceUri = optionalText(
    row.interface_oauth_resource_uri,
  );
  if (
    interfaceOAuthResourceUri !== undefined &&
    interfaceOAuth2ResourceUri(iface) !== interfaceOAuthResourceUri
  ) {
    throw new Error("runtime capability Interface audience claim is stale");
  }
  return {
    resource,
    lock,
    iface,
    binding,
    ...(interfaceOAuthResourceUri
      ? {
          interfaceOAuthResourceUri,
        }
      : {}),
  };
}

function evaluateRuntimeCapability(
  input: RuntimeCapabilityReadInput,
  snapshot: RuntimeCapabilitySnapshot,
): RuntimeCapability | undefined {
  const { resource, lock, iface, binding } = snapshot;
  const parsedId = parseResourceShapeId(input.resourceId);
  if (
    !parsedId ||
    parsedId.spaceId !== input.workspaceId ||
    parsedId.kind !== input.resourceKind ||
    resource.id !== input.resourceId ||
    resource.spaceId !== input.workspaceId ||
    resource.kind !== input.resourceKind ||
    resource.name !== parsedId.name ||
    resource.phase !== "Ready" ||
    resource.generation !== resource.observedGeneration ||
    !Number.isSafeInteger(resource.generation) ||
    resource.generation < 1 ||
    lock.resourceId !== input.resourceId ||
    !lock.locked ||
    !resourceFormIdentitiesEqual(resource.form, lock.form)
  ) {
    return undefined;
  }
  const revisionId = canonicalResourceRevisionId(resource, lock);
  if (!revisionId) return undefined;
  const nativeResources = exactNativeResources(
    lock.nativeResources,
    resource.form,
  );
  if (!nativeResources) return undefined;

  if (
    iface.kind !== "Interface" ||
    iface.apiVersion !== TAKOSUMI_API_VERSION ||
    iface.metadata.id !== input.interfaceId ||
    iface.metadata.workspaceId !== input.workspaceId ||
    iface.metadata.ownerRef.kind !== "Resource" ||
    iface.metadata.ownerRef.id !== input.resourceId ||
    iface.status.phase !== "Resolved" ||
    iface.status.observedGeneration !== iface.metadata.generation ||
    iface.status.resolvedRevision !== input.interfaceResolvedRevision ||
    !Number.isSafeInteger(iface.status.resolvedRevision) ||
    iface.status.resolvedRevision < 1
  ) {
    return undefined;
  }
  if (!formLineageMatchesResource(iface, resource.form)) return undefined;
  const expectedAudience =
    input.audience === undefined
      ? undefined
      : canonicalInterfaceOAuth2ResourceUri(input.audience);
  if (
    input.bindingSubject.kind === "Principal" &&
    (expectedAudience === undefined ||
      snapshot.interfaceOAuthResourceUri !== expectedAudience)
  ) {
    return undefined;
  }

  if (
    binding.kind !== "InterfaceBinding" ||
    binding.apiVersion !== TAKOSUMI_API_VERSION ||
    binding.metadata.id !== input.interfaceBindingId ||
    binding.metadata.workspaceId !== input.workspaceId ||
    binding.spec.interfaceId !== input.interfaceId ||
    binding.spec.subjectRef.kind !== input.bindingSubject.kind ||
    binding.spec.subjectRef.id !== input.bindingSubject.id ||
    binding.status.phase !== "Ready" ||
    binding.status.observedInterfaceRevision !==
      iface.status.resolvedRevision ||
    !binding.spec.permissions.every(
      (permission) => typeof permission === "string",
    ) ||
    !binding.spec.permissions.includes(input.requiredPermission) ||
    !bindingDeliveryMatches(binding, iface, input)
  ) {
    return undefined;
  }
  if (!bindingLineageMatchesResource(binding, iface, resource.form)) {
    return undefined;
  }
  const resourceObject = resourceObjectFromRecord(resource, lock);
  return freezeClone({
    resource: resourceObject,
    resourceGeneration: resource.generation,
    resourceRevisionId: revisionId,
    nativeResources,
    iface,
    binding,
  });
}

function resourceObjectFromRecord(
  record: ResourceShapeRecord,
  lock: ResolutionLockRecord,
): ResourceObject {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: record.kind,
    ...(record.form ? { form: record.form } : {}),
    metadata: {
      name: record.name,
      space: record.spaceId,
      generation: record.generation,
      ...(record.project ? { project: record.project } : {}),
      ...(record.environment ? { environment: record.environment } : {}),
      ...(record.owner !== undefined ? { owner: record.owner } : {}),
      ...(record.labels ? { labels: record.labels } : {}),
      managedBy: record.managedBy,
    },
    spec: record.spec,
    status: {
      phase: record.phase,
      observedGeneration: record.observedGeneration,
      resolution: {
        selectedImplementation: lock.selectedImplementation,
        target: lock.target,
        locked: lock.locked,
        portability: lock.portability ?? "partial",
      },
      ...(record.outputs ? { outputs: record.outputs } : {}),
      ...(record.conditions ? { conditions: record.conditions } : {}),
    },
  };
}

function bindingDeliveryMatches(
  binding: InterfaceBinding,
  iface: Interface,
  input: RuntimeCapabilityReadInput,
): boolean {
  const delivery = binding.spec.delivery;
  if (delivery.options !== undefined) return false;
  if (input.bindingSubject.kind === "Resource") {
    const expectedAudience =
      input.audience === undefined
        ? undefined
        : canonicalInterfaceOAuth2ResourceUri(input.audience);
    return (
      delivery.type === "none" &&
      (delivery.credentialRef === undefined ||
        delivery.credentialRef.startsWith("capability:")) &&
      (expectedAudience === undefined ||
        interfaceOAuth2ResourceUri(iface) === expectedAudience)
    );
  }
  if (input.bindingSubject.kind !== "Principal") return false;
  const expectedAudience =
    input.audience === undefined
      ? undefined
      : canonicalInterfaceOAuth2ResourceUri(input.audience);
  return (
    delivery.type === "oauth2" &&
    delivery.credentialRef === undefined &&
    expectedAudience !== undefined &&
    interfaceOAuth2ResourceUri(iface) === expectedAudience
  );
}

function formLineageMatchesResource(
  iface: Interface,
  resourceForm: InstalledFormReference | undefined,
): boolean {
  const source = iface.metadata.materializedFrom;
  if (source?.source !== "form_descriptor") return true;
  if (!resourceForm) return false;
  return (
    source.formRefKey === formRefKey(formRefOfInstalled(resourceForm)) &&
    source.formSchemaDigest === resourceForm.schemaDigest
  );
}

function bindingLineageMatchesResource(
  binding: InterfaceBinding,
  iface: Interface,
  resourceForm: InstalledFormReference | undefined,
): boolean {
  const source = binding.metadata.materializedFrom;
  if (source?.source !== "form_host_descriptor") return true;
  if (!resourceForm) return false;
  const ifaceSource = iface.metadata.materializedFrom;
  return (
    ifaceSource?.source === "form_descriptor" &&
    source.formRefKey === formRefKey(formRefOfInstalled(resourceForm)) &&
    source.formRefKey === ifaceSource.formRefKey &&
    source.descriptorName === ifaceSource.descriptorName &&
    source.descriptorVersion === ifaceSource.descriptorVersion
  );
}

function exactNativeResources(
  value: readonly NativeResourceRef[] | undefined,
  resourceForm: InstalledFormReference | undefined,
): readonly NativeResourceRef[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  for (const native of value) {
    if (
      !native ||
      typeof native.type !== "string" ||
      native.type.trim() !== native.type ||
      native.type.length === 0 ||
      typeof native.id !== "string" ||
      native.id.trim() !== native.id ||
      native.id.length === 0
    ) {
      return undefined;
    }
    if (
      resourceForm === undefined
        ? native.form !== undefined
        : native.form === undefined ||
          !resourceFormIdentitiesEqual(native.form, resourceForm)
    ) {
      return undefined;
    }
  }
  return value;
}

function canonicalResourceRevisionId(
  record: ResourceShapeRecord,
  lock: ResolutionLockRecord,
): string | undefined {
  const plugin =
    lock.implementationSnapshot?.plugin ?? lock.selectedImplementationPlugin;
  const candidate = plugin
    ? record.lastOperationRunId
    : (record.lastOperationRunId ?? record.execution?.runId);
  return typeof candidate === "string" &&
    candidate.trim() === candidate &&
    candidate.length > 0 &&
    candidate.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : undefined;
}

function validReadInput(input: RuntimeCapabilityReadInput): boolean {
  if (!input || typeof input !== "object") return false;
  if (
    !safeText(input.workspaceId) ||
    !safeText(input.resourceId) ||
    !isResourceShapeKind(input.resourceKind) ||
    !safeText(input.interfaceId) ||
    !safeText(input.interfaceBindingId) ||
    !input.bindingSubject ||
    !isSubjectKind(input.bindingSubject.kind) ||
    !safeText(input.bindingSubject.id) ||
    !Number.isSafeInteger(input.interfaceResolvedRevision) ||
    input.interfaceResolvedRevision < 1
  ) {
    return false;
  }
  if (!safeText(input.requiredPermission)) return false;
  return (
    input.audience === undefined ||
    canonicalInterfaceOAuth2ResourceUri(input.audience) !== undefined
  );
}

function isSubjectKind(value: unknown): value is InterfaceSubjectKind {
  return value === "Principal" || value === "Resource";
}

function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function text(value: unknown): string {
  if (!safeText(value)) throw new Error("runtime capability text is invalid");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value);
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return value as number;
}

function integerOrUndefined(value: unknown): number | undefined {
  return value === null || value === undefined
    ? undefined
    : integer(value, "integer");
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
}

function jsonValueOrUndefined(value: unknown): unknown {
  return parseJson(value);
}

function jsonObjectOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function jsonArrayOrUndefined(value: unknown): readonly unknown[] | undefined {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : undefined;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = jsonObjectOrUndefined(value);
  if (!parsed) throw new Error(`${label} is invalid`);
  return parsed;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} record is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function jsonStringArray(value: unknown, label: string): readonly string[] {
  const parsed = parseJson(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return parsed as readonly string[];
}

function exactFormIdentity(
  formRefJson: unknown,
  packageDigest: unknown,
): InstalledFormReference | undefined {
  if (
    (formRefJson === undefined || formRefJson === null || formRefJson === "") &&
    (packageDigest === undefined || packageDigest === null)
  ) {
    return undefined;
  }
  const formRef =
    formRefJson === undefined || formRefJson === null || formRefJson === ""
      ? undefined
      : parseJson(formRefJson);
  const identity = {
    ...(formRef && typeof formRef === "object" && !Array.isArray(formRef)
      ? formRef
      : {}),
    packageDigest,
  };
  if (!isInstalledFormReference(identity)) {
    throw new Error("runtime capability Form package lineage is invalid");
  }
  return identity;
}

interface D1SessionLike extends D1Like {
  withSession?(bookmark: "first-primary"): D1Like;
}

function d1PrimarySession(db: D1Like): D1Like {
  const candidate = db as D1SessionLike;
  return typeof candidate.withSession === "function"
    ? candidate.withSession("first-primary")
    : db;
}
