// Resource Shape Planner - PURE.
//
// The Planner validates one shape-specific spec and lowers a resolved
// implementation to a first-party OpenTofu module call. It deliberately keeps
// shape-specific resource types (EdgeWorker, ObjectBucket, Queue, ...) instead of
// accepting a catch-all `takosumi_resource { type, spec }` object, so OpenTofu
// plan diffs, validation, import, drift, and state upgrades can remain
// resource-aware. Existing generic providers and standards such as S3/R2/GCS
// stay in the plain OpenTofu Stack flow, not in Takosumi-owned shapes.

import type {
  ContainerServiceSpec,
  EdgeWorkerSpec,
  KVStoreSpec,
  ObjectBucketSpec,
  OutputValueType,
  QueueSpec,
  ResourceConnectionPermission,
  ResourceConnectionSpec,
  ResourceDeletePolicy,
  ResourceProjectionKind,
  ResourceShapeKind,
  SQLDatabaseSpec,
  TargetPoolEntry,
} from "takosumi-contract";
import { firstPartyModuleFilesByTemplateId } from "../../../opentofu-modules/module-files.ts";

export interface ResourceShapePlan {
  readonly shape: ResourceShapeKind;
  readonly templateId: string;
  readonly moduleFiles: readonly {
    readonly path: string;
    readonly text: string;
  }[];
  readonly inputs: Record<string, unknown>;
  readonly publicOutputs: readonly ResourceShapePublicOutput[];
}

export interface ResourceShapePublicOutput {
  readonly name: string;
  readonly type: OutputValueType;
}

export type ParsedResourceSpec =
  | {
      readonly kind: "EdgeWorker";
      readonly spec: EdgeWorkerSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: EdgeWorkerSpec["lifecyclePolicy"];
    }
  | {
      readonly kind: "ObjectBucket";
      readonly spec: ObjectBucketSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: ObjectBucketSpec["lifecyclePolicy"];
    }
  | {
      readonly kind: "KVStore";
      readonly spec: KVStoreSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: KVStoreSpec["lifecyclePolicy"];
    }
  | {
      readonly kind: "Queue";
      readonly spec: QueueSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: QueueSpec["lifecyclePolicy"];
    }
  | {
      readonly kind: "SQLDatabase";
      readonly spec: SQLDatabaseSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: SQLDatabaseSpec["lifecyclePolicy"];
    }
  | {
      readonly kind: "ContainerService";
      readonly spec: ContainerServiceSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: ContainerServiceSpec["lifecyclePolicy"];
    };

export type ParseResourceSpecResult =
  | { readonly ok: true; readonly parsed: ParsedResourceSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseEdgeWorkerSpecResult =
  | { readonly ok: true; readonly spec: EdgeWorkerSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseObjectBucketSpecResult =
  | { readonly ok: true; readonly spec: ObjectBucketSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseKVStoreSpecResult =
  | { readonly ok: true; readonly spec: KVStoreSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseQueueSpecResult =
  | { readonly ok: true; readonly spec: QueueSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseSQLDatabaseSpecResult =
  | { readonly ok: true; readonly spec: SQLDatabaseSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseContainerServiceSpecResult =
  | { readonly ok: true; readonly spec: ContainerServiceSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

const RESOURCE_DELETE_POLICIES: readonly ResourceDeletePolicy[] = [
  "delete",
  "retain",
  "snapshot_then_delete",
  "block",
];
const RESOURCE_CONNECTION_PERMISSIONS: readonly ResourceConnectionPermission[] =
  ["read", "write", "connect", "publish", "consume"];
const RESOURCE_PROJECTION_KINDS: readonly ResourceProjectionKind[] = [
  "env",
  "database_url",
  "runtime_binding",
  "volume_mount",
  "sdk_client",
];
const SECRET_KEY_PATTERN =
  /(^|[_-])(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|client[_-]?secret)([_-]|$)/i;
const SECRET_VALUE_PATTERN =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|sk-[A-Za-z0-9_-]{12,})/;

/** Map EdgeWorker implementation -> first-party Capsule module template id. */
export const EDGE_WORKER_IMPLEMENTATION_TEMPLATE: Readonly<
  Record<string, string>
> = Object.freeze({
  cloudflare_workers: "cloudflare-worker-service",
});

export const OBJECT_BUCKET_IMPLEMENTATION_TEMPLATE: Readonly<
  Record<string, string>
> = Object.freeze({
  cloudflare_r2_bucket: "cloudflare-r2-bucket",
});

export const KV_STORE_IMPLEMENTATION_TEMPLATE: Readonly<
  Record<string, string>
> = Object.freeze({
  cloudflare_kv_namespace: "cloudflare-kv-store",
});

export const QUEUE_IMPLEMENTATION_TEMPLATE: Readonly<Record<string, string>> =
  Object.freeze({
    cloudflare_queue: "cloudflare-queue",
  });

export const SQL_DATABASE_IMPLEMENTATION_TEMPLATE: Readonly<
  Record<string, string>
> = Object.freeze({
  cloudflare_d1_database: "cloudflare-sql-database",
});

export const CONTAINER_SERVICE_GENERIC_TEMPLATE_ID =
  "takosumi-container-service";

export const CONTAINER_SERVICE_IMPLEMENTATION_TEMPLATE: Readonly<
  Record<string, string>
> = Object.freeze({
  cloudflare_container: CONTAINER_SERVICE_GENERIC_TEMPLATE_ID,
  kubernetes_deployment: CONTAINER_SERVICE_GENERIC_TEMPLATE_ID,
  aws_ecs_service: CONTAINER_SERVICE_GENERIC_TEMPLATE_ID,
  takosumi_container_service: CONTAINER_SERVICE_GENERIC_TEMPLATE_ID,
});

export function parseResourceSpec(
  kind: ResourceShapeKind,
  spec: unknown,
): ParseResourceSpecResult {
  switch (kind) {
    case "EdgeWorker": {
      const r = parseEdgeWorkerSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              kind,
              spec: r.spec,
              interfaces: requiredEdgeWorkerInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "ObjectBucket": {
      const r = parseObjectBucketSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              kind,
              spec: r.spec,
              interfaces: requiredObjectBucketInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "KVStore": {
      const r = parseKVStoreSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              kind,
              spec: r.spec,
              interfaces: requiredKVStoreInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "Queue": {
      const r = parseQueueSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              kind,
              spec: r.spec,
              interfaces: requiredQueueInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "SQLDatabase": {
      const r = parseSQLDatabaseSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              kind,
              spec: r.spec,
              interfaces: requiredSQLDatabaseInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "ContainerService": {
      const r = parseContainerServiceSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              kind,
              spec: r.spec,
              interfaces: requiredContainerServiceInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    default:
      return {
        ok: false,
        error: {
          code: "unsupported_shape",
          message: `planner does not implement shape ${kind}`,
        },
      };
  }
}

export function parseObjectBucketSpec(
  spec: unknown,
): ParseObjectBucketSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;

  const name = parseName(candidate);
  if (!name.ok) return name;

  const interfaces =
    candidate.interfaces === undefined
      ? undefined
      : parseExtensibleTokenList(candidate.interfaces, "interfaces", false);
  if (interfaces && !interfaces.ok) return interfaces;

  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;

  return {
    ok: true,
    spec: {
      name: name.value,
      ...(interfaces?.value ? { interfaces: interfaces.value } : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function parseKVStoreSpec(spec: unknown): ParseKVStoreSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;
  const name = parseName(candidate);
  if (!name.ok) return name;
  const consistency = candidate.consistency;
  if (
    consistency !== undefined &&
    consistency !== "eventual" &&
    consistency !== "strong"
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_consistency",
        message: "spec.consistency must be eventual or strong",
      },
    };
  }
  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;
  return {
    ok: true,
    spec: {
      name: name.value,
      ...(consistency ? { consistency } : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function parseQueueSpec(spec: unknown): ParseQueueSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;
  const name = parseName(candidate);
  if (!name.ok) return name;
  const delivery = parseQueueDelivery(candidate.delivery);
  if (!delivery.ok) return delivery;
  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;
  return {
    ok: true,
    spec: {
      name: name.value,
      ...(delivery.value ? { delivery: delivery.value } : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function parseSQLDatabaseSpec(
  spec: unknown,
): ParseSQLDatabaseSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;
  const name = parseName(candidate);
  if (!name.ok) return name;
  const engine = candidate.engine;
  if (
    engine !== undefined &&
    engine !== "sqlite" &&
    engine !== "postgres" &&
    engine !== "mysql"
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_engine",
        message: "spec.engine must be sqlite, postgres, or mysql",
      },
    };
  }
  const migrationsPath = candidate.migrationsPath;
  if (migrationsPath !== undefined && typeof migrationsPath !== "string") {
    return {
      ok: false,
      error: {
        code: "invalid_migrations_path",
        message: "spec.migrationsPath must be a string",
      },
    };
  }
  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;
  return {
    ok: true,
    spec: {
      name: name.value,
      ...(engine ? { engine } : {}),
      ...(typeof migrationsPath === "string" && migrationsPath.length > 0
        ? { migrationsPath }
        : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function parseContainerServiceSpec(
  spec: unknown,
): ParseContainerServiceSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;
  const name = parseName(candidate);
  if (!name.ok) return name;
  if (typeof candidate.image !== "string" || candidate.image.trim() === "") {
    return {
      ok: false,
      error: {
        code: "invalid_image",
        message: "spec.image must be a non-empty OCI image reference",
      },
    };
  }
  const ports = parseNumberList(candidate.ports, "ports", false);
  if (!ports.ok) return ports;
  const environment = parseStringMap(candidate.environment, "environment");
  if (!environment.ok) return environment;
  const connections = parseConnectionsMap(candidate.connections);
  if (!connections.ok) return connections;
  const publicHttp = candidate.publicHttp;
  if (publicHttp !== undefined && typeof publicHttp !== "boolean") {
    return {
      ok: false,
      error: {
        code: "invalid_public_http",
        message: "spec.publicHttp must be a boolean",
      },
    };
  }
  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;
  return {
    ok: true,
    spec: {
      name: name.value,
      image: candidate.image,
      ...(ports.value ? { ports: ports.value } : {}),
      ...(publicHttp !== undefined ? { publicHttp } : {}),
      ...(environment.value ? { environment: environment.value } : {}),
      ...(connections.value ? { connections: connections.value } : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function parseEdgeWorkerSpec(spec: unknown): ParseEdgeWorkerSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;

  const name = parseName(candidate);
  if (!name.ok) return name;

  const source = parseEdgeWorkerSource(candidate.source);
  if (!source.ok) return source;

  const profiles =
    candidate.profiles === undefined
      ? undefined
      : parseExtensibleTokenList(candidate.profiles, "profiles", false);
  if (profiles && !profiles.ok) return profiles;

  const compatibilityFlags =
    candidate.compatibilityFlags === undefined
      ? undefined
      : parseExtensibleTokenList(
          candidate.compatibilityFlags,
          "compatibilityFlags",
          false,
        );
  if (compatibilityFlags && !compatibilityFlags.ok) return compatibilityFlags;

  const compatibilityDate = candidate.compatibilityDate;
  if (
    compatibilityDate !== undefined &&
    typeof compatibilityDate !== "string"
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_compatibility_date",
        message: "spec.compatibilityDate must be a string",
      },
    };
  }

  const connections = parseConnectionsMap(candidate.connections);
  if (!connections.ok) return connections;

  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;

  return {
    ok: true,
    spec: {
      name: name.value,
      source: source.value,
      ...(typeof compatibilityDate === "string" && compatibilityDate.length > 0
        ? { compatibilityDate }
        : {}),
      ...(compatibilityFlags?.value
        ? { compatibilityFlags: compatibilityFlags.value }
        : {}),
      ...(profiles?.value ? { profiles: profiles.value } : {}),
      ...(connections.value ? { connections: connections.value } : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function planResourceShape(
  implementation: string,
  parsed: ParsedResourceSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  switch (parsed.kind) {
    case "EdgeWorker":
      return planEdgeWorker(implementation, parsed.spec, target);
    case "ObjectBucket":
      return planObjectBucket(implementation, parsed.spec, target);
    case "KVStore":
      return planKVStore(implementation, parsed.spec, target);
    case "Queue":
      return planQueue(implementation, parsed.spec, target);
    case "SQLDatabase":
      return planSQLDatabase(implementation, parsed.spec, target);
    case "ContainerService":
      return planContainerService(implementation, parsed.spec, target);
  }
}

/**
 * Plan a Worker-compatible EdgeWorker. The module reads a prebuilt artifact
 * with OpenTofu `file(var.artifactPath)` or fetches a CI/release artifact with
 * the declared `artifactUrl` + `artifactSha256`. Takosumi does not own the
 * build or choose the artifact; the generated OpenTofu module consumes the
 * declared source of truth.
 */
export function planEdgeWorker(
  implementation: string,
  spec: EdgeWorkerSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = EDGE_WORKER_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId) {
    throw new Error(
      `planEdgeWorker: no first-party module for implementation "${implementation}"`,
    );
  }
  const moduleFiles = moduleFilesFor(templateId, "planEdgeWorker");
  const artifactPath = spec.source.artifactPath;
  const artifactUrl = spec.source.artifactUrl;
  const artifactSha256 = spec.source.artifactSha256;
  if (!artifactPath && !artifactUrl) {
    throw new Error(
      "planEdgeWorker: cloudflare_workers requires source.artifactPath or source.artifactUrl",
    );
  }
  const inputs: Record<string, unknown> = {
    appName: spec.name,
    accountId: target.ref ?? "",
  };
  if (artifactPath) inputs.artifactPath = artifactPath;
  if (artifactUrl) inputs.artifactUrl = artifactUrl;
  if (artifactSha256) inputs.artifactSha256 = artifactSha256;
  if (spec.connections && Object.keys(spec.connections).length > 0) {
    inputs.connections = normalizedConnectionsForPlan(spec.connections);
  }
  return {
    shape: "EdgeWorker",
    templateId,
    moduleFiles,
    inputs,
    publicOutputs: [
      { name: "worker_name", type: "string" },
      { name: "url", type: "url" },
      { name: "connections", type: "json" },
    ],
  };
}

export function planObjectBucket(
  implementation: string,
  spec: ObjectBucketSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = OBJECT_BUCKET_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId)
    return planGenericServiceShape(
      "ObjectBucket",
      implementation,
      spec,
      target,
    );
  const moduleFiles = moduleFilesFor(templateId, "planObjectBucket");
  return {
    shape: "ObjectBucket",
    templateId,
    moduleFiles,
    inputs: { bucketName: spec.name, accountId: target.ref ?? "" },
    publicOutputs: [
      { name: "bucket_name", type: "string" },
      { name: "s3_endpoint", type: "url" },
    ],
  };
}

export function planKVStore(
  implementation: string,
  spec: KVStoreSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = KV_STORE_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId)
    return planGenericServiceShape("KVStore", implementation, spec, target);
  const moduleFiles = moduleFilesFor(templateId, "planKVStore");
  return {
    shape: "KVStore",
    templateId,
    moduleFiles,
    inputs: { namespaceTitle: spec.name, accountId: target.ref ?? "" },
    publicOutputs: [
      { name: "namespace_id", type: "string" },
      { name: "namespace_title", type: "string" },
    ],
  };
}

export function planQueue(
  implementation: string,
  spec: QueueSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = QUEUE_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId)
    return planGenericServiceShape("Queue", implementation, spec, target);
  const moduleFiles = moduleFilesFor(templateId, "planQueue");
  return {
    shape: "Queue",
    templateId,
    moduleFiles,
    inputs: { queueName: spec.name, accountId: target.ref ?? "" },
    publicOutputs: [{ name: "queue_name", type: "string" }],
  };
}

export function planSQLDatabase(
  implementation: string,
  spec: SQLDatabaseSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = SQL_DATABASE_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId)
    return planGenericServiceShape("SQLDatabase", implementation, spec, target);
  const moduleFiles = moduleFilesFor(templateId, "planSQLDatabase");
  return {
    shape: "SQLDatabase",
    templateId,
    moduleFiles,
    inputs: { databaseName: spec.name, accountId: target.ref ?? "" },
    publicOutputs: [
      { name: "database_id", type: "string" },
      { name: "database_name", type: "string" },
    ],
  };
}

export function planContainerService(
  implementation: string,
  spec: ContainerServiceSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId =
    CONTAINER_SERVICE_IMPLEMENTATION_TEMPLATE[implementation] ??
    CONTAINER_SERVICE_GENERIC_TEMPLATE_ID;
  const moduleFiles = moduleFilesFor(templateId, "planContainerService");
  return {
    shape: "ContainerService",
    templateId,
    moduleFiles,
    inputs: {
      serviceName: spec.name,
      implementation,
      targetName: target.name,
      targetType: target.type,
      image: spec.image,
      ports: spec.ports ?? [],
      publicHttp: spec.publicHttp ?? false,
      environment: spec.environment ?? {},
      connections: spec.connections
        ? normalizedConnectionsForPlan(spec.connections)
        : {},
    },
    publicOutputs: [
      { name: "service_name", type: "string" },
      { name: "url", type: "url" },
      { name: "connections", type: "json" },
    ],
  };
}

function planGenericServiceShape(
  shape: ResourceShapeKind,
  implementation: string,
  spec: { readonly name: string },
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = "takosumi-service-shape";
  const moduleFiles = moduleFilesFor(templateId, "planGenericServiceShape");
  return {
    shape,
    templateId,
    moduleFiles,
    inputs: {
      resourceName: spec.name,
      shape,
      implementation,
      targetName: target.name,
      targetType: target.type,
    },
    publicOutputs: [{ name: "resource_name", type: "string" }],
  };
}

function requiredEdgeWorkerInterfaces(spec: EdgeWorkerSpec): readonly string[] {
  const interfaces: string[] = ["worker_fetch"];
  for (const profile of spec.profiles ?? []) interfaces.push(profile);
  appendConnectionInterfaces(interfaces, spec.connections);
  return interfaces;
}

function requiredObjectBucketInterfaces(
  spec: ObjectBucketSpec,
): readonly string[] {
  return ["object_store", ...(spec.interfaces ?? ["s3_api"])];
}

function requiredKVStoreInterfaces(_spec: KVStoreSpec): readonly string[] {
  return ["kv_store", "runtime_binding"];
}

function requiredQueueInterfaces(_spec: QueueSpec): readonly string[] {
  return ["queue", "publish", "consume"];
}

function requiredSQLDatabaseInterfaces(
  spec: SQLDatabaseSpec,
): readonly string[] {
  const engine = spec.engine ?? "sqlite";
  return ["sql", engine === "postgres" ? "postgres_protocol" : engine];
}

function requiredContainerServiceInterfaces(
  spec: ContainerServiceSpec,
): readonly string[] {
  const interfaces = [
    "oci_container",
    ...(spec.publicHttp ? ["public_http"] : []),
    ...(spec.environment && Object.keys(spec.environment).length > 0
      ? ["env_projection"]
      : []),
  ];
  appendConnectionInterfaces(interfaces, spec.connections);
  return interfaces;
}

function appendConnectionInterfaces(
  interfaces: string[],
  connections: Readonly<Record<string, ResourceConnectionSpec>> | undefined,
): void {
  if (!connections || Object.keys(connections).length === 0) return;
  interfaces.push("resource_connection");
  for (const connection of Object.values(connections)) {
    interfaces.push(connection.projection);
    for (const permission of connection.permissions) {
      interfaces.push(`grant_${permission}`);
    }
  }
}

function moduleFilesFor(
  templateId: string,
  caller: string,
): ResourceShapePlan["moduleFiles"] {
  const moduleFiles = firstPartyModuleFilesByTemplateId[templateId];
  if (!moduleFiles) {
    throw new Error(
      `${caller}: missing module files for template "${templateId}"`,
    );
  }
  return moduleFiles;
}

type ObjectResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

function objectCandidate(spec: unknown): ObjectResult {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return {
      ok: false,
      error: { code: "invalid_spec", message: "spec must be an object" },
    };
  }
  return { ok: true, value: spec as Record<string, unknown> };
}

function parseName(candidate: Record<string, unknown>):
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  const name = candidate.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_name",
        message: "spec.name must be a non-empty string",
      },
    };
  }
  return { ok: true, value: name };
}

function parseExtensibleTokenList(
  value: unknown,
  field: string,
  requireNonEmpty: boolean,
):
  | { readonly ok: true; readonly value: readonly string[] }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    return {
      ok: false,
      error: {
        code: field === "interfaces" ? "invalid_interfaces" : "invalid_profile",
        message: `spec.${field} must be ${requireNonEmpty ? "a non-empty" : "an"} array`,
      },
    };
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return {
        ok: false,
        error: {
          code:
            field === "interfaces" ? "invalid_interface" : "invalid_profile",
          message: `spec.${field} values must be non-empty strings`,
        },
      };
    }
    if (/\s/.test(item)) {
      return {
        ok: false,
        error: {
          code:
            field === "interfaces" ? "invalid_interface" : "invalid_profile",
          message: `spec.${field} values must be capability tokens without whitespace: ${item}`,
        },
      };
    }
  }
  return { ok: true, value: value as readonly string[] };
}

function parseNumberList(
  value: unknown,
  field: string,
  requireNonEmpty: boolean,
):
  | {
      readonly ok: true;
      readonly value: readonly number[] | undefined;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    return {
      ok: false,
      error: {
        code: `invalid_${field}`,
        message: `spec.${field} must be ${requireNonEmpty ? "a non-empty" : "an"} array`,
      },
    };
  }
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) {
      return {
        ok: false,
        error: {
          code: `invalid_${field}`,
          message: `spec.${field} values must be positive integers`,
        },
      };
    }
  }
  return { ok: true, value: value as readonly number[] };
}

function parseStringMap(
  value: unknown,
  field: string,
):
  | {
      readonly ok: true;
      readonly value: Readonly<Record<string, string>> | undefined;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: `invalid_${field}`,
        message: `spec.${field} must be an object`,
      },
    };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    if (!key || typeof item !== "string") {
      return {
        ok: false,
        error: {
          code: `invalid_${field}`,
          message: `spec.${field} must map non-empty string keys to string values`,
        },
      };
    }
    if (SECRET_KEY_PATTERN.test(key) || SECRET_VALUE_PATTERN.test(item)) {
      return {
        ok: false,
        error: {
          code: `invalid_${field}`,
          message:
            `spec.${field} must not contain secret-looking keys or values; ` +
            "use Credential or ProviderConnection materialization instead",
        },
      };
    }
  }
  return { ok: true, value: value as Readonly<Record<string, string>> };
}

function parseConnectionsMap(value: unknown):
  | {
      readonly ok: true;
      readonly value:
        Readonly<Record<string, ResourceConnectionSpec>> | undefined;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_connections",
        message: "spec.connections must be an object keyed by connection name",
      },
    };
  }

  const out: Record<string, ResourceConnectionSpec> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!name || /\s/.test(name)) {
      return {
        ok: false,
        error: {
          code: "invalid_connection",
          message:
            "spec.connections keys must be non-empty capability tokens without whitespace",
        },
      };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        ok: false,
        error: {
          code: "invalid_connection",
          message: `spec.connections.${name} must be an object`,
        },
      };
    }
    const candidate = raw as Record<string, unknown>;
    if (
      typeof candidate.resource !== "string" ||
      candidate.resource.trim() === "" ||
      /\s/.test(candidate.resource)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_connection",
          message: `spec.connections.${name}.resource must be a non-empty resource reference token`,
        },
      };
    }
    if (
      !Array.isArray(candidate.permissions) ||
      candidate.permissions.length === 0
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_connection",
          message: `spec.connections.${name}.permissions must be a non-empty array`,
        },
      };
    }
    const permissions: ResourceConnectionPermission[] = [];
    for (const permission of candidate.permissions) {
      if (
        typeof permission !== "string" ||
        !RESOURCE_CONNECTION_PERMISSIONS.includes(
          permission as ResourceConnectionPermission,
        )
      ) {
        return {
          ok: false,
          error: {
            code: "invalid_connection",
            message:
              `spec.connections.${name}.permissions values must be one of: ` +
              RESOURCE_CONNECTION_PERMISSIONS.join(", "),
          },
        };
      }
      permissions.push(permission as ResourceConnectionPermission);
    }
    if (
      typeof candidate.projection !== "string" ||
      !RESOURCE_PROJECTION_KINDS.includes(
        candidate.projection as ResourceProjectionKind,
      )
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_connection",
          message:
            `spec.connections.${name}.projection must be one of: ` +
            RESOURCE_PROJECTION_KINDS.join(", "),
        },
      };
    }
    out[name] = {
      resource: candidate.resource,
      permissions,
      projection: candidate.projection as ResourceProjectionKind,
    };
  }

  return {
    ok: true,
    value: Object.keys(out).length > 0 ? out : undefined,
  };
}

function normalizedConnectionsForPlan(
  connections: Readonly<Record<string, ResourceConnectionSpec>>,
): Record<string, ResourceConnectionSpec> {
  const normalized: Record<string, ResourceConnectionSpec> = {};
  for (const name of Object.keys(connections).sort()) {
    const connection = connections[name]!;
    normalized[name] = {
      resource: connection.resource,
      permissions: [...connection.permissions].sort(),
      projection: connection.projection,
    };
  }
  return normalized;
}

function parseQueueDelivery(value: unknown):
  | {
      readonly ok: true;
      readonly value:
        | { readonly maxRetries?: number; readonly maxBatchSize?: number }
        | undefined;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_delivery",
        message: "spec.delivery must be an object",
      },
    };
  }
  const delivery = value as Record<string, unknown>;
  for (const field of ["maxRetries", "maxBatchSize"] as const) {
    const item = delivery[field];
    if (
      item !== undefined &&
      (typeof item !== "number" || !Number.isInteger(item) || item < 0)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_delivery",
          message: `spec.delivery.${field} must be a non-negative integer`,
        },
      };
    }
  }
  return {
    ok: true,
    value: {
      ...(typeof delivery.maxRetries === "number"
        ? { maxRetries: delivery.maxRetries }
        : {}),
      ...(typeof delivery.maxBatchSize === "number"
        ? { maxBatchSize: delivery.maxBatchSize }
        : {}),
    },
  };
}

function parseLifecyclePolicy(value: unknown):
  | {
      readonly ok: true;
      readonly value: { readonly delete: ResourceDeletePolicy } | undefined;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_lifecycle_policy",
        message: "spec.lifecyclePolicy must be an object",
      },
    };
  }
  const del = (value as Record<string, unknown>).delete;
  if (
    typeof del !== "string" ||
    !RESOURCE_DELETE_POLICIES.includes(del as ResourceDeletePolicy)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_delete_policy",
        message: `spec.lifecyclePolicy.delete must be one of: ${RESOURCE_DELETE_POLICIES.join(", ")}`,
      },
    };
  }
  return { ok: true, value: { delete: del as ResourceDeletePolicy } };
}

function parseEdgeWorkerSource(value: unknown):
  | { readonly ok: true; readonly value: EdgeWorkerSpec["source"] }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: "spec.source.artifactPath is required for EdgeWorker",
      },
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: "spec.runtime.source must be an object",
      },
    };
  }
  const source = value as Record<string, unknown>;
  if (source.artifactRef !== undefined || source.image !== undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message:
          "EdgeWorker currently supports source.artifactPath or source.artifactUrl only",
      },
    };
  }
  const artifactPath =
    typeof source.artifactPath === "string" &&
    source.artifactPath.trim().length > 0
      ? source.artifactPath
      : undefined;
  const artifactUrl =
    typeof source.artifactUrl === "string" &&
    source.artifactUrl.trim().length > 0
      ? source.artifactUrl
      : undefined;
  if (artifactPath && artifactUrl) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message:
          "spec.source must set only one of artifactPath or artifactUrl for EdgeWorker",
      },
    };
  }
  if (artifactPath) {
    return { ok: true, value: { artifactPath } };
  }
  if (artifactUrl) {
    if (!artifactUrl.startsWith("https://")) {
      return {
        ok: false,
        error: {
          code: "invalid_source",
          message: "spec.source.artifactUrl must be an https URL",
        },
      };
    }
    const artifactSha256 =
      typeof source.artifactSha256 === "string" &&
      source.artifactSha256.trim().length > 0
        ? source.artifactSha256
        : undefined;
    if (!artifactSha256) {
      return {
        ok: false,
        error: {
          code: "invalid_source",
          message:
            "spec.source.artifactSha256 is required when artifactUrl is set",
        },
      };
    }
    return { ok: true, value: { artifactUrl, artifactSha256 } };
  }
  return {
    ok: false,
    error: {
      code: "invalid_source",
      message:
        "spec.source.artifactPath or spec.source.artifactUrl must be a non-empty string",
    },
  };
}
