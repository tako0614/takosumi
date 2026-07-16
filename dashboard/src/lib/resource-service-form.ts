import type { ResourceShapeJsonObject } from "./control-api.ts";

export const GUIDED_RESOURCE_SERVICE_KINDS = [
  "EdgeWorker",
  "ObjectBucket",
  "KVStore",
  "SQLDatabase",
  "Queue",
  "VectorIndex",
  "DurableWorkflow",
  "ContainerService",
  "StatefulActorNamespace",
  "Schedule",
] as const;

export type GuidedResourceServiceKind =
  (typeof GUIDED_RESOURCE_SERVICE_KINDS)[number];
export type EdgeWorkerArtifactSource = "url" | "ref";
export type OptionalBooleanChoice = "" | "true" | "false";
export type KVStoreConsistency = "" | "eventual" | "strong";
export type ObjectBucketStorageClass = "standard" | "infrequent_access";

export type GuidedSpecErrorCode =
  | "artifact_url_required"
  | "artifact_url_https"
  | "artifact_ref_required"
  | "artifact_sha256_required"
  | "queue_max_retries_invalid"
  | "queue_max_batch_size_invalid"
  | "container_image_required"
  | "container_ports_invalid"
  | "container_environment_invalid"
  | "vector_dimensions_invalid"
  | "workflow_entrypoint_required"
  | "workflow_max_attempts_invalid"
  | "workflow_backoff_invalid"
  | "actor_class_required"
  | "actor_class_invalid"
  | "schedule_cron_required"
  | "schedule_cron_invalid"
  | "schedule_connection_invalid"
  | "schedule_target_required";

export type GuidedSpecResult =
  | { readonly ok: true; readonly value: ResourceShapeJsonObject }
  | { readonly ok: false; readonly code: GuidedSpecErrorCode };

export interface EdgeWorkerServiceForm {
  readonly name: string;
  readonly artifactSource: EdgeWorkerArtifactSource;
  readonly artifactUrl: string;
  readonly artifactRef: string;
  readonly artifactSha256: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: string;
  readonly profiles: string;
}

export interface ObjectBucketServiceForm {
  readonly name: string;
  readonly storageClass: ObjectBucketStorageClass;
  readonly interfaces: string;
}

export interface KVStoreServiceForm {
  readonly name: string;
  readonly consistency: KVStoreConsistency;
}

export interface SQLDatabaseServiceForm {
  readonly name: string;
  readonly engine: string;
  readonly migrationsPath: string;
}

export interface QueueServiceForm {
  readonly name: string;
  readonly maxRetries: string;
  readonly maxBatchSize: string;
}

export interface VectorIndexServiceForm {
  readonly name: string;
  readonly dimensions: string;
  readonly metric: string;
}

export interface DurableWorkflowServiceForm {
  readonly name: string;
  readonly artifactSource: EdgeWorkerArtifactSource;
  readonly artifactUrl: string;
  readonly artifactRef: string;
  readonly artifactSha256: string;
  readonly entrypoint: string;
  readonly maxAttempts: string;
  readonly initialBackoffSeconds: string;
}

export interface ContainerServiceForm {
  readonly name: string;
  readonly image: string;
  readonly ports: string;
  readonly publicHttp: OptionalBooleanChoice;
  readonly environment: string;
}

export interface StatefulActorNamespaceServiceForm {
  readonly name: string;
  readonly className: string;
  readonly storageProfile: string;
  readonly migrationTag: string;
}

export interface ScheduleServiceForm {
  readonly name: string;
  readonly cron: string;
  readonly timezone: string;
  readonly connectionName: string;
  readonly targetResource: string;
}

export type GuidedResourceServiceForm =
  | { readonly kind: "EdgeWorker"; readonly form: EdgeWorkerServiceForm }
  | { readonly kind: "ObjectBucket"; readonly form: ObjectBucketServiceForm }
  | { readonly kind: "KVStore"; readonly form: KVStoreServiceForm }
  | { readonly kind: "SQLDatabase"; readonly form: SQLDatabaseServiceForm }
  | { readonly kind: "Queue"; readonly form: QueueServiceForm }
  | { readonly kind: "VectorIndex"; readonly form: VectorIndexServiceForm }
  | {
      readonly kind: "DurableWorkflow";
      readonly form: DurableWorkflowServiceForm;
    }
  | { readonly kind: "ContainerService"; readonly form: ContainerServiceForm }
  | {
      readonly kind: "StatefulActorNamespace";
      readonly form: StatefulActorNamespaceServiceForm;
    }
  | { readonly kind: "Schedule"; readonly form: ScheduleServiceForm };

export function isGuidedResourceServiceKind(
  value: string,
): value is GuidedResourceServiceKind {
  return (GUIDED_RESOURCE_SERVICE_KINDS as readonly string[]).includes(value);
}

/**
 * Capability/profile fields are human-entered comma/newline lists. Tokens are
 * endpoint-defined, so the dashboard only normalizes whitespace and duplicates;
 * the Deploy API remains the schema/capability authority.
 */
export function parseResourceServiceTokens(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/u)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];
}

export function buildGuidedResourceServiceSpec(
  input: GuidedResourceServiceForm,
): GuidedSpecResult {
  switch (input.kind) {
    case "EdgeWorker":
      return buildEdgeWorkerServiceSpec(input.form);
    case "ObjectBucket":
      return buildObjectBucketServiceSpec(input.form);
    case "KVStore":
      return buildKVStoreServiceSpec(input.form);
    case "SQLDatabase":
      return buildSQLDatabaseServiceSpec(input.form);
    case "Queue":
      return buildQueueServiceSpec(input.form);
    case "VectorIndex":
      return buildVectorIndexServiceSpec(input.form);
    case "DurableWorkflow":
      return buildDurableWorkflowServiceSpec(input.form);
    case "ContainerService":
      return buildContainerServiceSpec(input.form);
    case "StatefulActorNamespace":
      return buildStatefulActorNamespaceServiceSpec(input.form);
    case "Schedule":
      return buildScheduleServiceSpec(input.form);
  }
}

/** Preserve a partially completed guided form when opting into raw JSON. */
export function draftGuidedResourceServiceSpec(
  input: GuidedResourceServiceForm,
): ResourceShapeJsonObject {
  const built = buildGuidedResourceServiceSpec(input);
  if (built.ok) return built.value;

  switch (input.kind) {
    case "EdgeWorker":
      return edgeWorkerSpec(input.form, draftArtifactSource(input.form));
    case "ObjectBucket":
      return objectBucketSpec(input.form);
    case "KVStore":
      return kvStoreSpec(input.form);
    case "SQLDatabase":
      return sqlDatabaseSpec(input.form);
    case "Queue":
      return queueSpec(input.form, true);
    case "VectorIndex":
      return vectorIndexSpec(input.form, true);
    case "DurableWorkflow":
      return durableWorkflowSpec(input.form, true);
    case "ContainerService":
      return containerServiceSpec(input.form, true);
    case "StatefulActorNamespace":
      return statefulActorNamespaceSpec(input.form);
    case "Schedule":
      return scheduleSpec(input.form);
  }
}

export function readGuidedResourceServiceForm(
  kind: GuidedResourceServiceKind,
  spec: ResourceShapeJsonObject,
  resourceName: string,
): GuidedResourceServiceForm | undefined {
  switch (kind) {
    case "EdgeWorker": {
      const form = readEdgeWorkerServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
    case "ObjectBucket": {
      const form = readObjectBucketServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
    case "KVStore": {
      const form = readKVStoreServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
    case "SQLDatabase": {
      const form = readSQLDatabaseServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
    case "Queue": {
      const form = readQueueServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
    case "VectorIndex": {
      const form = readVectorIndexServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
    case "DurableWorkflow": {
      const form = readDurableWorkflowServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
    case "ContainerService": {
      const form = readContainerServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
    case "StatefulActorNamespace": {
      const form = readStatefulActorNamespaceServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
    case "Schedule": {
      const form = readScheduleServiceForm(spec, resourceName);
      return form ? { kind, form } : undefined;
    }
  }
}

export function buildEdgeWorkerServiceSpec(
  form: EdgeWorkerServiceForm,
): GuidedSpecResult {
  const source = buildArtifactSource(form);
  return source.ok
    ? { ok: true, value: edgeWorkerSpec(form, source.value) }
    : source;
}

/** Preserve the previous public helper used by focused form tests. */
export function draftEdgeWorkerServiceSpec(
  form: EdgeWorkerServiceForm,
): ResourceShapeJsonObject {
  return edgeWorkerSpec(form, draftArtifactSource(form));
}

export function buildObjectBucketServiceSpec(
  form: ObjectBucketServiceForm,
): GuidedSpecResult {
  return { ok: true, value: objectBucketSpec(form) };
}

export function buildKVStoreServiceSpec(
  form: KVStoreServiceForm,
): GuidedSpecResult {
  return { ok: true, value: kvStoreSpec(form) };
}

export function buildSQLDatabaseServiceSpec(
  form: SQLDatabaseServiceForm,
): GuidedSpecResult {
  return { ok: true, value: sqlDatabaseSpec(form) };
}

export function buildQueueServiceSpec(
  form: QueueServiceForm,
): GuidedSpecResult {
  const maxRetries = optionalInteger(form.maxRetries, 0);
  if (maxRetries === null) {
    return { ok: false, code: "queue_max_retries_invalid" };
  }
  const maxBatchSize = optionalInteger(form.maxBatchSize, 0);
  if (maxBatchSize === null) {
    return { ok: false, code: "queue_max_batch_size_invalid" };
  }
  return {
    ok: true,
    value: {
      name: form.name.trim(),
      ...(maxRetries !== undefined || maxBatchSize !== undefined
        ? {
            delivery: {
              ...(maxRetries !== undefined ? { maxRetries } : {}),
              ...(maxBatchSize !== undefined ? { maxBatchSize } : {}),
            },
          }
        : {}),
    },
  };
}

export function buildVectorIndexServiceSpec(
  form: VectorIndexServiceForm,
): GuidedSpecResult {
  const dimensions = optionalInteger(form.dimensions, 1);
  if (dimensions === undefined || dimensions === null) {
    return { ok: false, code: "vector_dimensions_invalid" };
  }
  return {
    ok: true,
    value: vectorIndexSpec({ ...form, dimensions: String(dimensions) }, false),
  };
}

export function buildDurableWorkflowServiceSpec(
  form: DurableWorkflowServiceForm,
): GuidedSpecResult {
  const source = buildArtifactSource(form);
  if (!source.ok) return source;
  if (!form.entrypoint.trim()) {
    return { ok: false, code: "workflow_entrypoint_required" };
  }
  const maxAttempts = optionalInteger(form.maxAttempts, 1);
  if (maxAttempts === null) {
    return { ok: false, code: "workflow_max_attempts_invalid" };
  }
  const initialBackoffSeconds = optionalInteger(form.initialBackoffSeconds, 0);
  if (initialBackoffSeconds === null) {
    return { ok: false, code: "workflow_backoff_invalid" };
  }
  return {
    ok: true,
    value: {
      name: form.name.trim(),
      source: source.value,
      entrypoint: form.entrypoint.trim(),
      ...(maxAttempts !== undefined || initialBackoffSeconds !== undefined
        ? {
            retry: {
              ...(maxAttempts !== undefined ? { maxAttempts } : {}),
              ...(initialBackoffSeconds !== undefined
                ? { initialBackoffSeconds }
                : {}),
            },
          }
        : {}),
    },
  };
}

export function buildContainerServiceSpec(
  form: ContainerServiceForm,
): GuidedSpecResult {
  if (!form.image.trim()) {
    return { ok: false, code: "container_image_required" };
  }
  const ports = optionalPositiveIntegerList(form.ports);
  if (ports === null) {
    return { ok: false, code: "container_ports_invalid" };
  }
  const environment = optionalStringMap(form.environment);
  if (environment === null) {
    return { ok: false, code: "container_environment_invalid" };
  }
  return {
    ok: true,
    value: {
      name: form.name.trim(),
      image: form.image.trim(),
      ...(ports !== undefined ? { ports: [...ports] } : {}),
      ...(form.publicHttp ? { publicHttp: form.publicHttp === "true" } : {}),
      ...(environment !== undefined ? { environment } : {}),
    },
  };
}

export function buildStatefulActorNamespaceServiceSpec(
  form: StatefulActorNamespaceServiceForm,
): GuidedSpecResult {
  if (!form.className.trim()) {
    return { ok: false, code: "actor_class_required" };
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(form.className.trim())) {
    return { ok: false, code: "actor_class_invalid" };
  }
  return { ok: true, value: statefulActorNamespaceSpec(form) };
}

export function buildScheduleServiceSpec(
  form: ScheduleServiceForm,
): GuidedSpecResult {
  const cron = form.cron.trim().replace(/\s+/gu, " ");
  if (!cron) return { ok: false, code: "schedule_cron_required" };
  if (cron.split(" ").length !== 5) {
    return { ok: false, code: "schedule_cron_invalid" };
  }
  const connectionName = form.connectionName.trim();
  if (!connectionName || /\s/u.test(connectionName)) {
    return { ok: false, code: "schedule_connection_invalid" };
  }
  const targetResource = form.targetResource.trim();
  if (!targetResource || /\s/u.test(targetResource)) {
    return { ok: false, code: "schedule_target_required" };
  }
  return {
    ok: true,
    value: scheduleSpec({
      ...form,
      cron,
      connectionName,
      targetResource,
    }),
  };
}

export function readEdgeWorkerServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): EdgeWorkerServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, [
      "name",
      "source",
      "compatibilityDate",
      "compatibilityFlags",
      "profiles",
    ]) ||
    spec.name !== resourceName
  ) {
    return undefined;
  }
  const artifact = readArtifactForm(spec.source);
  if (!artifact) return undefined;
  const compatibilityDate = optionalString(spec.compatibilityDate);
  const compatibilityFlags = optionalStringArray(spec.compatibilityFlags);
  const profiles = optionalStringArray(spec.profiles);
  if (
    compatibilityDate === null ||
    compatibilityFlags === null ||
    profiles === null
  ) {
    return undefined;
  }
  return {
    name: resourceName,
    ...artifact,
    compatibilityDate: compatibilityDate ?? "",
    compatibilityFlags: (compatibilityFlags ?? []).join("\n"),
    profiles: (profiles ?? []).join("\n"),
  };
}

export function readObjectBucketServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): ObjectBucketServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, ["name", "storageClass", "interfaces"]) ||
    spec.name !== resourceName ||
    (spec.storageClass !== undefined &&
      spec.storageClass !== "standard" &&
      spec.storageClass !== "infrequent_access")
  ) {
    return undefined;
  }
  const interfaces = optionalStringArray(spec.interfaces);
  if (interfaces === null) return undefined;
  return {
    name: resourceName,
    // The Deploy API canonicalizes legacy omission to the portable default.
    storageClass: (spec.storageClass ?? "standard") as ObjectBucketStorageClass,
    interfaces: (interfaces ?? []).join("\n"),
  };
}

export function readKVStoreServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): KVStoreServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, ["name", "consistency"]) ||
    spec.name !== resourceName ||
    (spec.consistency !== undefined &&
      spec.consistency !== "eventual" &&
      spec.consistency !== "strong")
  ) {
    return undefined;
  }
  return {
    name: resourceName,
    consistency: (spec.consistency ?? "") as KVStoreConsistency,
  };
}

export function readSQLDatabaseServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): SQLDatabaseServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, ["name", "engine", "migrationsPath"]) ||
    spec.name !== resourceName
  ) {
    return undefined;
  }
  const engine = optionalString(spec.engine);
  const migrationsPath = optionalString(spec.migrationsPath);
  if (engine === null || migrationsPath === null) return undefined;
  return {
    name: resourceName,
    engine: engine ?? "",
    migrationsPath: migrationsPath ?? "",
  };
}

export function readQueueServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): QueueServiceForm | undefined {
  if (!hasOnlyKeys(spec, ["name", "delivery"]) || spec.name !== resourceName) {
    return undefined;
  }
  if (spec.delivery === undefined) {
    return { name: resourceName, maxRetries: "", maxBatchSize: "" };
  }
  if (
    !isJsonObject(spec.delivery) ||
    !hasOnlyKeys(spec.delivery, ["maxRetries", "maxBatchSize"])
  ) {
    return undefined;
  }
  const maxRetries = optionalStoredInteger(spec.delivery.maxRetries, 0);
  const maxBatchSize = optionalStoredInteger(spec.delivery.maxBatchSize, 0);
  if (maxRetries === null || maxBatchSize === null) return undefined;
  return {
    name: resourceName,
    maxRetries: maxRetries === undefined ? "" : String(maxRetries),
    maxBatchSize: maxBatchSize === undefined ? "" : String(maxBatchSize),
  };
}

export function readVectorIndexServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): VectorIndexServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, ["name", "dimensions", "metric"]) ||
    spec.name !== resourceName ||
    optionalStoredInteger(spec.dimensions, 1) === null ||
    optionalStoredInteger(spec.dimensions, 1) === undefined
  ) {
    return undefined;
  }
  const metric = optionalString(spec.metric);
  if (metric === null) return undefined;
  return {
    name: resourceName,
    dimensions: String(spec.dimensions),
    metric: metric ?? "",
  };
}

export function readDurableWorkflowServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): DurableWorkflowServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, ["name", "source", "entrypoint", "retry"]) ||
    spec.name !== resourceName
  ) {
    return undefined;
  }
  const artifact = readArtifactForm(spec.source);
  const entrypoint = stringValue(spec.entrypoint);
  if (!artifact || !entrypoint) return undefined;
  let maxAttempts: number | undefined;
  let initialBackoffSeconds: number | undefined;
  if (spec.retry !== undefined) {
    if (
      !isJsonObject(spec.retry) ||
      !hasOnlyKeys(spec.retry, ["maxAttempts", "initialBackoffSeconds"])
    ) {
      return undefined;
    }
    const parsedMaxAttempts = optionalStoredInteger(spec.retry.maxAttempts, 1);
    const parsedBackoff = optionalStoredInteger(
      spec.retry.initialBackoffSeconds,
      0,
    );
    if (parsedMaxAttempts === null || parsedBackoff === null) return undefined;
    maxAttempts = parsedMaxAttempts;
    initialBackoffSeconds = parsedBackoff;
  }
  return {
    name: resourceName,
    ...artifact,
    entrypoint,
    maxAttempts: maxAttempts === undefined ? "" : String(maxAttempts),
    initialBackoffSeconds:
      initialBackoffSeconds === undefined ? "" : String(initialBackoffSeconds),
  };
}

export function readContainerServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): ContainerServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, [
      "name",
      "image",
      "ports",
      "publicHttp",
      "environment",
    ]) ||
    spec.name !== resourceName
  ) {
    return undefined;
  }
  const image = stringValue(spec.image);
  const ports = optionalStoredPositiveIntegerList(spec.ports);
  const environment = optionalStoredStringMap(spec.environment);
  if (
    !image ||
    ports === null ||
    environment === null ||
    (spec.publicHttp !== undefined && typeof spec.publicHttp !== "boolean")
  ) {
    return undefined;
  }
  return {
    name: resourceName,
    image,
    ports: (ports ?? []).join(", "),
    publicHttp:
      spec.publicHttp === undefined ? "" : spec.publicHttp ? "true" : "false",
    environment:
      environment === undefined ? "" : JSON.stringify(environment, null, 2),
  };
}

export function readStatefulActorNamespaceServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): StatefulActorNamespaceServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, [
      "name",
      "className",
      "storageProfile",
      "migrationTag",
    ]) ||
    spec.name !== resourceName
  ) {
    return undefined;
  }
  const className = stringValue(spec.className);
  const storageProfile = optionalString(spec.storageProfile);
  const migrationTag = optionalString(spec.migrationTag);
  if (
    !className ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(className) ||
    storageProfile === null ||
    migrationTag === null
  ) {
    return undefined;
  }
  return {
    name: resourceName,
    className,
    storageProfile: storageProfile ?? "",
    migrationTag: migrationTag ?? "",
  };
}

export function readScheduleServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): ScheduleServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, ["name", "cron", "timezone", "connections"]) ||
    spec.name !== resourceName ||
    !isJsonObject(spec.connections)
  ) {
    return undefined;
  }
  const cron = stringValue(spec.cron);
  const timezone = optionalString(spec.timezone);
  const entries = Object.entries(spec.connections);
  if (!cron || timezone === null || entries.length !== 1) return undefined;
  const [connectionName, candidate] = entries[0]!;
  if (
    !connectionName ||
    /\s/u.test(connectionName) ||
    !isJsonObject(candidate) ||
    !hasOnlyKeys(candidate, ["resource", "permissions", "projection"]) ||
    !stringValue(candidate.resource) ||
    candidate.projection !== "schedule_trigger" ||
    !Array.isArray(candidate.permissions) ||
    candidate.permissions.length !== 1 ||
    candidate.permissions[0] !== "invoke"
  ) {
    return undefined;
  }
  return {
    name: resourceName,
    cron,
    timezone: timezone ?? "",
    connectionName,
    targetResource: String(candidate.resource),
  };
}

function buildArtifactSource(
  form: Pick<
    EdgeWorkerServiceForm,
    "artifactSource" | "artifactUrl" | "artifactRef" | "artifactSha256"
  >,
):
  | { readonly ok: true; readonly value: ResourceShapeJsonObject }
  | { readonly ok: false; readonly code: GuidedSpecErrorCode } {
  const artifactSha256 = form.artifactSha256.trim();
  if (!artifactSha256) {
    return { ok: false, code: "artifact_sha256_required" };
  }
  if (form.artifactSource === "url") {
    const artifactUrl = form.artifactUrl.trim();
    if (!artifactUrl) return { ok: false, code: "artifact_url_required" };
    if (!artifactUrl.startsWith("https://")) {
      return { ok: false, code: "artifact_url_https" };
    }
    return { ok: true, value: { artifactUrl, artifactSha256 } };
  }
  const artifactRef = form.artifactRef.trim();
  if (!artifactRef) return { ok: false, code: "artifact_ref_required" };
  return { ok: true, value: { artifactRef, artifactSha256 } };
}

function draftArtifactSource(
  form: Pick<
    EdgeWorkerServiceForm,
    "artifactSource" | "artifactUrl" | "artifactRef" | "artifactSha256"
  >,
): ResourceShapeJsonObject {
  const artifactValue =
    form.artifactSource === "url"
      ? form.artifactUrl.trim()
      : form.artifactRef.trim();
  const sourceKey =
    form.artifactSource === "url" ? "artifactUrl" : "artifactRef";
  const artifactSha256 = form.artifactSha256.trim();
  return {
    ...(artifactValue ? { [sourceKey]: artifactValue } : {}),
    ...(artifactSha256 ? { artifactSha256 } : {}),
  };
}

function readArtifactForm(
  value: unknown,
):
  | Pick<
      EdgeWorkerServiceForm,
      "artifactSource" | "artifactUrl" | "artifactRef" | "artifactSha256"
    >
  | undefined {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["artifactUrl", "artifactRef", "artifactSha256"])
  ) {
    return undefined;
  }
  const artifactUrl = stringValue(value.artifactUrl);
  const artifactRef = stringValue(value.artifactRef);
  const artifactSha256 = stringValue(value.artifactSha256);
  if (
    Boolean(artifactUrl) === Boolean(artifactRef) ||
    !artifactSha256 ||
    (artifactUrl !== undefined && !artifactUrl.startsWith("https://"))
  ) {
    return undefined;
  }
  return {
    artifactSource: artifactUrl ? "url" : "ref",
    artifactUrl: artifactUrl ?? "",
    artifactRef: artifactRef ?? "",
    artifactSha256,
  };
}

function edgeWorkerSpec(
  form: EdgeWorkerServiceForm,
  source: ResourceShapeJsonObject,
): ResourceShapeJsonObject {
  const compatibilityDate = form.compatibilityDate.trim();
  const compatibilityFlags = parseResourceServiceTokens(
    form.compatibilityFlags,
  );
  const profiles = parseResourceServiceTokens(form.profiles);
  return {
    name: form.name.trim(),
    source,
    ...(compatibilityDate ? { compatibilityDate } : {}),
    ...(compatibilityFlags.length > 0
      ? { compatibilityFlags: [...compatibilityFlags] }
      : {}),
    ...(profiles.length > 0 ? { profiles: [...profiles] } : {}),
  };
}

function objectBucketSpec(
  form: ObjectBucketServiceForm,
): ResourceShapeJsonObject {
  const interfaces = parseResourceServiceTokens(form.interfaces);
  return {
    name: form.name.trim(),
    storageClass: form.storageClass,
    ...(interfaces.length > 0 ? { interfaces: [...interfaces] } : {}),
  };
}

function kvStoreSpec(form: KVStoreServiceForm): ResourceShapeJsonObject {
  return {
    name: form.name.trim(),
    ...(form.consistency ? { consistency: form.consistency } : {}),
  };
}

function sqlDatabaseSpec(
  form: SQLDatabaseServiceForm,
): ResourceShapeJsonObject {
  const engine = form.engine.trim();
  const migrationsPath = form.migrationsPath.trim();
  return {
    name: form.name.trim(),
    ...(engine ? { engine } : {}),
    ...(migrationsPath ? { migrationsPath } : {}),
  };
}

function queueSpec(
  form: QueueServiceForm,
  preserveInvalid: boolean,
): ResourceShapeJsonObject {
  const maxRetries = optionalInteger(form.maxRetries, 0);
  const maxBatchSize = optionalInteger(form.maxBatchSize, 0);
  const delivery: ResourceShapeJsonObject = {
    ...(maxRetries !== undefined
      ? { maxRetries: maxRetries ?? form.maxRetries.trim() }
      : {}),
    ...(maxBatchSize !== undefined
      ? { maxBatchSize: maxBatchSize ?? form.maxBatchSize.trim() }
      : {}),
  };
  if (preserveInvalid) {
    if (maxRetries === null && form.maxRetries.trim()) {
      delivery.maxRetries = form.maxRetries.trim();
    }
    if (maxBatchSize === null && form.maxBatchSize.trim()) {
      delivery.maxBatchSize = form.maxBatchSize.trim();
    }
  }
  return {
    name: form.name.trim(),
    ...(Object.keys(delivery).length > 0 ? { delivery } : {}),
  };
}

function vectorIndexSpec(
  form: VectorIndexServiceForm,
  preserveInvalid: boolean,
): ResourceShapeJsonObject {
  const dimensions = optionalInteger(form.dimensions, 1);
  const metric = form.metric.trim();
  return {
    name: form.name.trim(),
    dimensions:
      dimensions ?? (preserveInvalid ? form.dimensions.trim() : Number.NaN),
    ...(metric ? { metric } : {}),
  };
}

function durableWorkflowSpec(
  form: DurableWorkflowServiceForm,
  preserveInvalid: boolean,
): ResourceShapeJsonObject {
  const maxAttempts = optionalInteger(form.maxAttempts, 1);
  const initialBackoffSeconds = optionalInteger(form.initialBackoffSeconds, 0);
  const retry: ResourceShapeJsonObject = {};
  if (maxAttempts !== undefined) {
    retry.maxAttempts =
      maxAttempts ?? (preserveInvalid ? form.maxAttempts.trim() : "");
  }
  if (initialBackoffSeconds !== undefined) {
    retry.initialBackoffSeconds =
      initialBackoffSeconds ??
      (preserveInvalid ? form.initialBackoffSeconds.trim() : "");
  }
  return {
    name: form.name.trim(),
    source: draftArtifactSource(form),
    entrypoint: form.entrypoint.trim(),
    ...(Object.keys(retry).length > 0 ? { retry } : {}),
  };
}

function containerServiceSpec(
  form: ContainerServiceForm,
  preserveInvalid: boolean,
): ResourceShapeJsonObject {
  const ports = optionalPositiveIntegerList(form.ports);
  const environment = optionalStringMap(form.environment);
  return {
    name: form.name.trim(),
    image: form.image.trim(),
    ...(ports !== undefined
      ? {
          ports:
            ports === null
              ? preserveInvalid
                ? form.ports.trim()
                : []
              : [...ports],
        }
      : {}),
    ...(form.publicHttp ? { publicHttp: form.publicHttp === "true" } : {}),
    ...(environment !== undefined
      ? {
          environment:
            environment ?? (preserveInvalid ? form.environment.trim() : {}),
        }
      : {}),
  };
}

function statefulActorNamespaceSpec(
  form: StatefulActorNamespaceServiceForm,
): ResourceShapeJsonObject {
  const storageProfile = form.storageProfile.trim();
  const migrationTag = form.migrationTag.trim();
  return {
    name: form.name.trim(),
    className: form.className.trim(),
    ...(storageProfile ? { storageProfile } : {}),
    ...(migrationTag ? { migrationTag } : {}),
  };
}

function scheduleSpec(form: ScheduleServiceForm): ResourceShapeJsonObject {
  const timezone = form.timezone.trim();
  const connectionName = form.connectionName.trim();
  return {
    name: form.name.trim(),
    cron: form.cron.trim().replace(/\s+/gu, " "),
    ...(timezone ? { timezone } : {}),
    connections: {
      [connectionName || "target"]: {
        resource: form.targetResource.trim(),
        permissions: ["invoke"],
        projection: "schedule_trigger",
      },
    },
  };
}

function optionalInteger(
  text: string,
  minimum: number,
): number | undefined | null {
  const value = text.trim();
  if (!value) return undefined;
  if (!/^-?\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function optionalStoredInteger(
  value: unknown,
  minimum: number,
): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : null;
}

function optionalPositiveIntegerList(
  text: string,
): readonly number[] | undefined | null {
  const tokens = parseResourceServiceTokens(text);
  if (tokens.length === 0) return undefined;
  const values = tokens.map(Number);
  return values.every((value) => Number.isSafeInteger(value) && value > 0)
    ? values
    : null;
}

function optionalStoredPositiveIntegerList(
  value: unknown,
): readonly number[] | undefined | null {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0,
    )
  ) {
    return null;
  }
  return value as readonly number[];
}

function optionalStringMap(
  text: string,
): Readonly<Record<string, string>> | undefined | null {
  const value = text.trim();
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    const stored = optionalStoredStringMap(parsed);
    return stored === null ? null : (stored ?? {});
  } catch {
    return null;
  }
}

function optionalStoredStringMap(
  value: unknown,
): Readonly<Record<string, string>> | undefined | null {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) return null;
  return Object.values(value).every((item) => typeof item === "string")
    ? (value as Readonly<Record<string, string>>)
    : null;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isJsonObject(value: unknown): value is ResourceShapeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function optionalStringArray(
  value: unknown,
): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value as readonly string[];
}
