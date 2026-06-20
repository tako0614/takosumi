import type {
  JsonObject,
  JsonValue,
  ServiceBinding,
  ServiceBindingDependencyMode,
  ServiceBindingSelector,
  ServiceBindingTarget,
  ServiceExport,
  ServiceGraphAuth,
  ServiceGraphCapability,
  ServiceGraphEndpoint,
  ServiceGrant,
  ServiceGrantDeliveryMetadata,
  ServiceGrantRequest,
} from "takosumi-contract";
import {
  assertValidServiceBinding,
  assertValidServiceExport,
  assertValidServiceGrant,
  isServiceExportVisibility,
  isServiceGraphCapability,
  isStandardServiceGraphCapability,
} from "takosumi-contract/service-graph";
import type { StorageDriver } from "../../adapters/storage/mod.ts";
import type {
  ServiceBindingStore,
  ServiceExportStore,
  ServiceGraphGrantStore,
} from "./stores.ts";

export interface ServiceGraphServiceStores {
  readonly exports: ServiceExportStore;
  readonly bindings: ServiceBindingStore;
  readonly grants: ServiceGraphGrantStore;
}

export interface ServiceGraphServiceOptions {
  readonly stores: ServiceGraphServiceStores;
  readonly clock?: () => string;
  readonly idGenerator?: (prefix: string) => string;
  readonly allowExtensionCapabilities?: boolean;
}

export interface ServiceGraphOperations {
  recordExport(input: RecordServiceExportInput): Promise<ServiceExport>;
  listExportsByWorkspace(
    workspaceId: string,
  ): Promise<readonly ServiceExport[]>;
  requestBinding(input: RequestServiceBindingInput): Promise<ServiceBinding>;
  getBinding(bindingId: string): Promise<ServiceBinding | undefined>;
  listBindingsByConsumerCapsule(
    consumerCapsuleId: string,
  ): Promise<readonly ServiceBinding[]>;
  listGrantsByBinding(bindingId: string): Promise<readonly ServiceGrant[]>;
  resolveBinding(bindingId: string): Promise<ServiceBinding>;
  issueGrant(input: IssueServiceGrantInput): Promise<ServiceGrant>;
  projectExportsFromOutputSnapshot(
    input: ProjectExportsFromOutputSnapshotInput,
  ): Promise<readonly ServiceExport[]>;
}

export interface RecordServiceExportInput {
  readonly id?: string;
  readonly workspaceId: string;
  readonly producerCapsuleId: string;
  readonly outputId?: string;
  readonly outputGeneration?: number;
  readonly stateVersionId?: string;
  readonly applyRunId?: string;
  readonly name: string;
  readonly capabilities: readonly ServiceGraphCapability[];
  readonly visibility?: ServiceExport["visibility"];
  readonly status?: ServiceExport["status"];
  readonly endpoints?: readonly ServiceGraphEndpoint[];
  readonly auth?: readonly ServiceGraphAuth[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly metadata?: JsonObject;
}

export interface RequestServiceBindingInput {
  readonly id?: string;
  readonly workspaceId: string;
  readonly consumerCapsuleId: string;
  readonly target: ServiceBindingTarget;
  readonly selector: ServiceBindingSelector;
  readonly dependencyMode?: ServiceBindingDependencyMode;
  readonly grantRequest: ServiceGrantRequest;
  readonly dependencySnapshotId?: string;
}

export interface IssueServiceGrantInput {
  readonly id?: string;
  readonly bindingId: string;
  readonly material?: ServiceGrantDeliveryMetadata;
  readonly secretRef?: string;
  readonly expiresAt?: string;
  readonly rotatedAt?: string;
}

export interface ProjectExportsFromOutputSnapshotInput {
  readonly workspaceId: string;
  readonly producerCapsuleId: string;
  readonly applyRunId?: string;
  readonly stateVersionId?: string;
  readonly outputId: string;
  readonly outputGeneration?: number;
  readonly outputs: Readonly<Record<string, JsonValue>>;
}

type NormalizedProjectedExportInput = Omit<
  RecordServiceExportInput,
  "id" | "workspaceId" | "producerCapsuleId"
>;

export class ServiceGraphService implements ServiceGraphOperations {
  readonly #stores: ServiceGraphServiceStores;
  readonly #clock: () => string;
  readonly #idGenerator: (prefix: string) => string;
  readonly #allowExtensionCapabilities: boolean;

  constructor(options: ServiceGraphServiceOptions) {
    this.#stores = options.stores;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#allowExtensionCapabilities =
      options.allowExtensionCapabilities === true;
    this.#idGenerator =
      options.idGenerator ??
      ((prefix) =>
        `${prefix}_${globalThis.crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 24)}`);
  }

  async recordExport(input: RecordServiceExportInput): Promise<ServiceExport> {
    assertCapabilitiesAllowed(
      input.capabilities,
      this.#allowExtensionCapabilities,
      "capabilities",
    );
    const now = this.#clock();
    const record: ServiceExport = {
      id: input.id ?? this.#idGenerator("sexp"),
      workspaceId: input.workspaceId,
      producerCapsuleId: input.producerCapsuleId,
      outputId: input.outputId,
      outputGeneration: input.outputGeneration,
      stateVersionId: input.stateVersionId,
      applyRunId: input.applyRunId,
      name: input.name,
      capabilities: input.capabilities,
      visibility: input.visibility ?? "space",
      status: input.status ?? "ready",
      endpoints: input.endpoints,
      auth: input.auth,
      labels: input.labels,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    assertValidServiceExport(record);
    return this.#stores.exports.put(record);
  }

  listExportsByWorkspace(
    workspaceId: string,
  ): Promise<readonly ServiceExport[]> {
    return this.#stores.exports.listByWorkspace(workspaceId);
  }

  async requestBinding(
    input: RequestServiceBindingInput,
  ): Promise<ServiceBinding> {
    assertCapabilitiesAllowed(
      input.selector.capabilities,
      this.#allowExtensionCapabilities,
      "selector.capabilities",
    );
    const now = this.#clock();
    const record: ServiceBinding = {
      id: input.id ?? this.#idGenerator("sbind"),
      workspaceId: input.workspaceId,
      consumerCapsuleId: input.consumerCapsuleId,
      target: input.target,
      selector: input.selector,
      dependencySnapshotId: input.dependencySnapshotId,
      dependencyMode: input.dependencyMode ?? "variable_injection",
      grantRequest: input.grantRequest,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    assertValidServiceBinding(record);
    return this.#stores.bindings.put(record);
  }

  getBinding(bindingId: string): Promise<ServiceBinding | undefined> {
    return this.#stores.bindings.get(bindingId);
  }

  listBindingsByConsumerCapsule(
    consumerCapsuleId: string,
  ): Promise<readonly ServiceBinding[]> {
    return this.#stores.bindings.listByConsumerCapsule(consumerCapsuleId);
  }

  listGrantsByBinding(bindingId: string): Promise<readonly ServiceGrant[]> {
    return this.#stores.grants.listByBinding(bindingId);
  }

  async resolveBinding(bindingId: string): Promise<ServiceBinding> {
    const binding = await this.#stores.bindings.get(bindingId);
    if (!binding) {
      throw new Error(`ServiceBinding not found: ${bindingId}`);
    }

    const candidates = await this.#candidateExports(binding);
    const selected = candidates.length === 1 ? candidates[0] : undefined;
    const now = this.#clock();
    const updated: ServiceBinding = selected
      ? {
          ...binding,
          selectedServiceExportId: selected.id,
          status: "bound",
          updatedAt: now,
        }
      : {
          ...binding,
          selectedServiceExportId: undefined,
          status: "blocked",
          updatedAt: now,
        };
    return this.#stores.bindings.put(updated);
  }

  async issueGrant(input: IssueServiceGrantInput): Promise<ServiceGrant> {
    const binding = await this.#stores.bindings.get(input.bindingId);
    if (!binding) {
      throw new Error(`ServiceBinding not found: ${input.bindingId}`);
    }
    if (binding.status !== "bound" || !binding.selectedServiceExportId) {
      throw new Error(
        `ServiceBinding must be bound before issuing a ServiceGrant: ${binding.id}`,
      );
    }
    const serviceExport = await this.#stores.exports.get(
      binding.selectedServiceExportId,
    );
    if (!serviceExport || serviceExport.status !== "ready") {
      throw new Error(
        `selected ServiceExport is not ready: ${binding.selectedServiceExportId}`,
      );
    }
    const now = this.#clock();
    const material = input.material ?? {};
    assertGrantMaterialEnvAllowed(material, binding.grantRequest);
    const expiresAt = resolveGrantExpiresAt(
      binding.grantRequest,
      now,
      input.expiresAt,
    );
    const record: ServiceGrant = {
      id: input.id ?? this.#idGenerator("sgrant"),
      workspaceId: binding.workspaceId,
      bindingId: binding.id,
      serviceExportId: serviceExport.id,
      consumerCapsuleId: binding.consumerCapsuleId,
      scopes: binding.grantRequest.scopes,
      audience: binding.grantRequest.audience ?? [
        binding.consumerCapsuleId,
      ],
      material,
      secretRef: input.secretRef,
      status: "active",
      createdAt: now,
      rotatedAt: input.rotatedAt,
      expiresAt,
    };
    assertValidServiceGrant(record);
    return this.#stores.grants.put(record);
  }

  async projectExportsFromOutputSnapshot(
    input: ProjectExportsFromOutputSnapshotInput,
  ): Promise<readonly ServiceExport[]> {
    const projectedExports = normalizeProjectedExports(
      input.outputs,
      this.#allowExtensionCapabilities,
    );

    const records: ServiceExport[] = [];
    for (const normalized of projectedExports) {
      records.push(
        await this.recordExport({
          id: stableProjectedExportId({
            producerCapsuleId: input.producerCapsuleId,
            outputId: input.outputId,
            name: normalized.name,
          }),
          workspaceId: input.workspaceId,
          producerCapsuleId: input.producerCapsuleId,
          outputId: input.outputId,
          outputGeneration: input.outputGeneration,
          stateVersionId: input.stateVersionId,
          applyRunId: input.applyRunId,
          ...normalized,
        }),
      );
    }
    return records;
  }

  async #candidateExports(
    binding: ServiceBinding,
  ): Promise<readonly ServiceExport[]> {
    const selector = binding.selector;
    if (selector.serviceExportId) {
      const selected = await this.#stores.exports.get(selector.serviceExportId);
      return selected && exportMatchesBinding(selected, binding)
        ? [selected]
        : [];
    }

    const firstCapability = selector.capabilities[0];
    if (!firstCapability) return [];
    const byCapability = await this.#stores.exports.listByCapability(
      binding.workspaceId,
      firstCapability,
    );
    return byCapability.filter((serviceExport) =>
      exportMatchesBinding(serviceExport, binding),
    );
  }
}

export function validateProjectedServiceExportsFromOutputSnapshot(
  outputs: Readonly<Record<string, JsonValue>>,
  options: { readonly allowExtensionCapabilities?: boolean } = {},
): void {
  normalizeProjectedExports(
    outputs,
    options.allowExtensionCapabilities === true,
  );
}

export function createStorageBackedServiceGraphService(
  storage: StorageDriver,
  options: { readonly allowExtensionCapabilities?: boolean } = {},
): ServiceGraphOperations {
  const withService = <T>(
    fn: (service: ServiceGraphService) => Promise<T>,
  ): Promise<T> =>
    storage.transaction((transaction) =>
      fn(
        new ServiceGraphService({
          stores: transaction.serviceGraph,
          allowExtensionCapabilities:
            options.allowExtensionCapabilities === true,
        }),
      ),
    );
  return {
    recordExport: (input) =>
      withService((service) => service.recordExport(input)),
    listExportsByWorkspace: (workspaceId) =>
      withService((service) => service.listExportsByWorkspace(workspaceId)),
    requestBinding: (input) =>
      withService((service) => service.requestBinding(input)),
    getBinding: (bindingId) =>
      withService((service) => service.getBinding(bindingId)),
    listBindingsByConsumerCapsule: (consumerCapsuleId) =>
      withService((service) =>
        service.listBindingsByConsumerCapsule(consumerCapsuleId),
      ),
    listGrantsByBinding: (bindingId) =>
      withService((service) => service.listGrantsByBinding(bindingId)),
    resolveBinding: (bindingId) =>
      withService((service) => service.resolveBinding(bindingId)),
    issueGrant: (input) => withService((service) => service.issueGrant(input)),
    projectExportsFromOutputSnapshot: (input) =>
      withService((service) => service.projectExportsFromOutputSnapshot(input)),
  };
}

function normalizeProjectedExports(
  outputs: Readonly<Record<string, JsonValue>>,
  allowExtensionCapabilities: boolean,
): readonly NormalizedProjectedExportInput[] {
  const rawExports = outputs.service_exports;
  if (rawExports === undefined) return [];
  if (!Array.isArray(rawExports)) {
    throw new TypeError("service_exports output must be an array");
  }
  return rawExports.map((value, index) => {
    const normalized = normalizeProjectedExport(value, index);
    assertCapabilitiesAllowed(
      normalized.capabilities,
      allowExtensionCapabilities,
      `service_exports[${index}].capabilities`,
    );
    return normalized;
  });
}

function assertCapabilitiesAllowed(
  capabilities: readonly ServiceGraphCapability[],
  allowExtensionCapabilities: boolean,
  field: string,
): void {
  if (allowExtensionCapabilities) return;
  for (const [index, capability] of capabilities.entries()) {
    if (!isStandardServiceGraphCapability(capability)) {
      throw new TypeError(
        `${field}[${index}] must be a standard Service Graph capability unless extension capabilities are explicitly enabled`,
      );
    }
  }
}

function resolveGrantExpiresAt(
  request: ServiceGrantRequest,
  nowIso: string,
  requestedExpiresAt: string | undefined,
): string | undefined {
  if (request.ttlSeconds === undefined) return requestedExpiresAt;
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return requestedExpiresAt;
  const maxExpiresAtMs = nowMs + request.ttlSeconds * 1000;
  if (requestedExpiresAt !== undefined) {
    const requestedMs = Date.parse(requestedExpiresAt);
    if (Number.isFinite(requestedMs) && requestedMs > maxExpiresAtMs) {
      throw new TypeError(
        "ServiceGrant.expiresAt must not exceed grantRequest.ttlSeconds",
      );
    }
    return requestedExpiresAt;
  }
  return new Date(maxExpiresAtMs).toISOString();
}

function assertGrantMaterialEnvAllowed(
  material: ServiceGrantDeliveryMetadata,
  request: ServiceGrantRequest,
): void {
  const envNames = materialEnvNames(material);
  if (envNames.length === 0) return;
  const allowed = new Set(request.env ?? []);
  if (allowed.size === 0) {
    throw new TypeError(
      "ServiceGrant material declares env names but grantRequest.env is empty",
    );
  }
  for (const envName of envNames) {
    if (!allowed.has(envName)) {
      throw new TypeError(
        `ServiceGrant material env ${envName} is not listed in grantRequest.env`,
      );
    }
  }
}

function materialEnvNames(value: JsonValue, keyHint = ""): readonly string[] {
  const names: string[] = [];
  if (typeof value === "string") {
    if (isEnvNameKey(keyHint)) names.push(value);
    return names;
  }
  if (Array.isArray(value)) {
    if (isEnvNameKey(keyHint)) {
      for (const item of value) {
        if (typeof item === "string") names.push(item);
      }
      return names;
    }
    for (const item of value) {
      names.push(...materialEnvNames(item, keyHint));
    }
    return names;
  }
  if (!isJsonObject(value)) return names;
  for (const [key, item] of Object.entries(value)) {
    names.push(...materialEnvNames(item, key));
  }
  return names;
}

function isEnvNameKey(key: string): boolean {
  return (
    key === "env" ||
    key === "envName" ||
    key === "envNames" ||
    key === "envVars" ||
    /Env(Name|Names)?$/.test(key)
  );
}

function exportMatchesBinding(
  serviceExport: ServiceExport,
  binding: ServiceBinding,
): boolean {
  const selector = binding.selector;
  return (
    serviceExport.workspaceId === binding.workspaceId &&
    serviceExport.status === "ready" &&
    isVisibleToConsumer(serviceExport, binding) &&
    selector.capabilities.every((capability) =>
      serviceExport.capabilities.includes(capability),
    ) &&
    (selector.producerCapsuleId === undefined ||
      selector.producerCapsuleId === serviceExport.producerCapsuleId) &&
    (selector.name === undefined || selector.name === serviceExport.name) &&
    labelsMatch(serviceExport.labels, selector.labels)
  );
}

function isVisibleToConsumer(
  serviceExport: ServiceExport,
  binding: ServiceBinding,
): boolean {
  if (serviceExport.visibility === "private") {
    return (
      serviceExport.producerCapsuleId === binding.consumerCapsuleId
    );
  }
  return ["space", "shared", "public"].includes(serviceExport.visibility);
}

function labelsMatch(
  labels: Readonly<Record<string, string>> | undefined,
  selectorLabels: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!selectorLabels) return true;
  if (!labels) return false;
  return Object.entries(selectorLabels).every(
    ([key, value]) => labels[key] === value,
  );
}

function normalizeProjectedExport(
  value: JsonValue,
  index: number,
): NormalizedProjectedExportInput {
  if (!isJsonObject(value)) {
    throw new TypeError(`service_exports[${index}] must be an object`);
  }
  const name = stringField(value, "name", index);
  const capabilities = capabilityArrayField(value, "capabilities", index);
  const visibilityRaw = optionalStringField(value, "visibility", index);
  const visibility = visibilityRaw ?? "space";
  if (!isServiceExportVisibility(visibility)) {
    throw new TypeError(
      `service_exports[${index}].visibility must be private, space, public, or shared`,
    );
  }
  return {
    name,
    capabilities,
    visibility,
    endpoints: optionalEndpointArrayField(value, "endpoints", index),
    auth: optionalAuthArrayField(value, "auth", index),
    labels: optionalStringRecordField(value, "labels", index),
    metadata: optionalJsonObjectField(value, "metadata", index),
  };
}

function stableProjectedExportId(input: {
  readonly producerCapsuleId: string;
  readonly outputId: string;
  readonly name: string;
}): string {
  return [
    "sexp",
    sanitizeIdPart(input.producerCapsuleId),
    sanitizeIdPart(input.outputId),
    sanitizeIdPart(input.name),
  ].join("_");
}

function sanitizeIdPart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return cleaned.replace(/^_+|_+$/g, "").slice(0, 48) || "unnamed";
}

function stringField(value: JsonObject, field: string, index: number): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new TypeError(`service_exports[${index}].${field} is required`);
  }
  return item;
}

function optionalStringField(
  value: JsonObject,
  field: string,
  index: number,
): string | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (typeof item !== "string" || item.length === 0) {
    throw new TypeError(
      `service_exports[${index}].${field} must be a non-empty string`,
    );
  }
  return item;
}

function capabilityArrayField(
  value: JsonObject,
  field: string,
  index: number,
): readonly ServiceGraphCapability[] {
  const item = value[field];
  if (!Array.isArray(item) || item.length === 0) {
    throw new TypeError(
      `service_exports[${index}].${field} must contain at least one capability`,
    );
  }
  return item.map((capability, capabilityIndex) => {
    if (
      typeof capability !== "string" ||
      !isServiceGraphCapability(capability)
    ) {
      throw new TypeError(
        `service_exports[${index}].${field}[${capabilityIndex}] must be a dotted capability token`,
      );
    }
    return capability;
  });
}

function optionalEndpointArrayField(
  value: JsonObject,
  field: string,
  index: number,
): readonly ServiceGraphEndpoint[] | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!Array.isArray(item)) {
    throw new TypeError(`service_exports[${index}].${field} must be an array`);
  }
  return item.map((endpoint, endpointIndex) => {
    if (!isJsonObject(endpoint)) {
      throw new TypeError(
        `service_exports[${index}].${field}[${endpointIndex}] must be an object`,
      );
    }
    return endpoint as ServiceGraphEndpoint;
  });
}

function optionalAuthArrayField(
  value: JsonObject,
  field: string,
  index: number,
): readonly ServiceGraphAuth[] | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!Array.isArray(item)) {
    throw new TypeError(`service_exports[${index}].${field} must be an array`);
  }
  return item.map((auth, authIndex) => {
    if (!isJsonObject(auth)) {
      throw new TypeError(
        `service_exports[${index}].${field}[${authIndex}] must be an object`,
      );
    }
    return auth as unknown as ServiceGraphAuth;
  });
}

function optionalStringRecordField(
  value: JsonObject,
  field: string,
  index: number,
): Readonly<Record<string, string>> | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!isJsonObject(item)) {
    throw new TypeError(`service_exports[${index}].${field} must be an object`);
  }
  for (const [key, entry] of Object.entries(item)) {
    if (key.length === 0 || typeof entry !== "string") {
      throw new TypeError(
        `service_exports[${index}].${field} entries must be string:string`,
      );
    }
  }
  return item as Readonly<Record<string, string>>;
}

function optionalJsonObjectField(
  value: JsonObject,
  field: string,
  index: number,
): JsonObject | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (!isJsonObject(item)) {
    throw new TypeError(`service_exports[${index}].${field} must be an object`);
  }
  return item;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
