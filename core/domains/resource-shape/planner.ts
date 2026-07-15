// Resource Shape Planner - PURE.
//
// The Planner validates one shape-specific spec and lowers a resolved
// implementation to an operator-selected OpenTofu module call. It deliberately keeps
// shape-specific resource types (EdgeWorker, ObjectBucket, Queue, ...) instead of
// accepting a catch-all `takosumi_resource { type, spec }` object, so OpenTofu
// plan diffs, validation, import, drift, and state upgrades can remain
// resource-aware. Existing generic providers and standards such as S3/R2/GCS
// stay in the plain OpenTofu Stack flow, not in Takosumi-owned shapes.

import type {
  ContainerServiceSpec,
  DurableWorkflowSpec,
  EdgeWorkerSpec,
  JsonObject,
  JsonValue,
  KVStoreSpec,
  ObjectBucketSpec,
  OutputValueType,
  QueueSpec,
  ResourceConnectionPermission,
  ResourceConnectionSpec,
  ResourceDeletePolicy,
  ResourceProjectionKind,
  ResourceShapeKind,
  ScheduleSpec,
  SQLDatabaseSpec,
  StatefulActorNamespaceSpec,
  TargetImplementationDescriptor,
  TargetModuleInputMapping,
  TargetPoolEntry,
  VectorIndexSpec,
} from "takosumi-contract";
import {
  isBundledResourceShapeKind,
  isResourceShapeKind,
} from "takosumi-contract";
import { secretLikeJsonPath } from "./secret_guard.ts";

export interface ResourceShapeOperatorModule {
  readonly files: readonly {
    readonly path: string;
    readonly text: string;
  }[];
}

/** Operator-owned lookup. Takosumi OSS ships no implicit module catalog. */
export interface ResourceShapeModuleRegistry {
  get(moduleTemplate: string): ResourceShapeOperatorModule | undefined;
}

export const EMPTY_RESOURCE_SHAPE_MODULE_REGISTRY: ResourceShapeModuleRegistry =
  {
    get: () => undefined,
  };

export class MapResourceShapeModuleRegistry implements ResourceShapeModuleRegistry {
  readonly #modules: ReadonlyMap<string, ResourceShapeOperatorModule>;

  constructor(
    modules:
      | ReadonlyMap<string, ResourceShapeOperatorModule>
      | Readonly<Record<string, ResourceShapeOperatorModule>>,
  ) {
    this.#modules =
      modules instanceof Map ? modules : new Map(Object.entries(modules));
  }

  get(moduleTemplate: string): ResourceShapeOperatorModule | undefined {
    const module = this.#modules.get(moduleTemplate);
    return module
      ? { files: module.files.map((file) => ({ ...file })) }
      : undefined;
  }
}

/** Normalized result produced by one explicitly installed shape schema. */
export interface RegisteredResourceShapeSpec {
  readonly spec: JsonObject;
  readonly interfaces: readonly string[];
  readonly lifecyclePolicy?: { readonly delete: ResourceDeletePolicy };
  readonly connections?: Readonly<Record<string, ResourceConnectionSpec>>;
}

export type RegisteredResourceShapeSpecResult =
  | { readonly ok: true; readonly value: RegisteredResourceShapeSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/** Trusted host parser for an operator-defined Resource Shape token. */
export type ResourceShapeSchemaParser = (
  spec: unknown,
) => RegisteredResourceShapeSpecResult;

/**
 * Explicit schema registry for operator-defined shapes. A registry entry is
 * validation authority only; execution still requires an exact TargetPool
 * descriptor and installed adapter plugin/module.
 */
export interface ResourceShapeSchemaRegistry {
  get(kind: ResourceShapeKind): ResourceShapeSchemaParser | undefined;
  kinds(): readonly ResourceShapeKind[];
}

export const EMPTY_RESOURCE_SHAPE_SCHEMA_REGISTRY: ResourceShapeSchemaRegistry =
  {
    get: () => undefined,
    kinds: () => [],
  };

export class MapResourceShapeSchemaRegistry implements ResourceShapeSchemaRegistry {
  readonly #schemas: ReadonlyMap<ResourceShapeKind, ResourceShapeSchemaParser>;

  constructor(
    schemas:
      | ReadonlyMap<ResourceShapeKind, ResourceShapeSchemaParser>
      | Readonly<Record<string, ResourceShapeSchemaParser>>,
  ) {
    const entries =
      schemas instanceof Map ? [...schemas.entries()] : Object.entries(schemas);
    for (const [kind, parser] of entries) {
      if (!isResourceShapeKind(kind)) {
        throw new TypeError(`invalid Resource Shape schema token: ${kind}`);
      }
      if (isBundledResourceShapeKind(kind)) {
        throw new TypeError(
          `registered Resource Shape schema must not shadow bundled kind ${kind}`,
        );
      }
      if (typeof parser !== "function") {
        throw new TypeError(
          `registered Resource Shape schema ${kind} must be a parser function`,
        );
      }
    }
    this.#schemas = new Map(entries);
  }

  get(kind: ResourceShapeKind): ResourceShapeSchemaParser | undefined {
    return this.#schemas.get(kind);
  }

  kinds(): readonly ResourceShapeKind[] {
    return [...this.#schemas.keys()];
  }
}

export interface ResourceShapePlan {
  readonly shape: ResourceShapeKind;
  /** Complete shape-specific spec after parser validation and normalization. */
  readonly validatedSpec: JsonObject;
  /** Stable adapter-visible execution label; never a Capsule discriminator. */
  readonly executionId: string;
  readonly moduleTemplate?: string;
  readonly operatorModule?: ResourceShapeOperatorModule;
  readonly inputs: Record<string, JsonValue>;
  readonly publicOutputs: readonly ResourceShapePublicOutput[];
  /**
   * Planner-only control modules describe typed inputs/outputs but do not
   * materialize a backend resource. They must never reach Ready unless a
   * selected adapter plugin performs the actual operation.
   */
  readonly requiresAdapterPlugin?: true;
}

export interface ResourceShapePublicOutput {
  readonly name: string;
  readonly type: OutputValueType;
}

export type ParsedResourceSpec =
  | {
      readonly schema: "bundled";
      readonly kind: "EdgeWorker";
      readonly spec: EdgeWorkerSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: EdgeWorkerSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "bundled";
      readonly kind: "ObjectBucket";
      readonly spec: ObjectBucketSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: ObjectBucketSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "bundled";
      readonly kind: "KVStore";
      readonly spec: KVStoreSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: KVStoreSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "bundled";
      readonly kind: "Queue";
      readonly spec: QueueSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: QueueSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "bundled";
      readonly kind: "SQLDatabase";
      readonly spec: SQLDatabaseSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: SQLDatabaseSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "bundled";
      readonly kind: "ContainerService";
      readonly spec: ContainerServiceSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: ContainerServiceSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "bundled";
      readonly kind: "VectorIndex";
      readonly spec: VectorIndexSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: VectorIndexSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "bundled";
      readonly kind: "DurableWorkflow";
      readonly spec: DurableWorkflowSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: DurableWorkflowSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "bundled";
      readonly kind: "StatefulActorNamespace";
      readonly spec: StatefulActorNamespaceSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: StatefulActorNamespaceSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "bundled";
      readonly kind: "Schedule";
      readonly spec: ScheduleSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: ScheduleSpec["lifecyclePolicy"];
    }
  | {
      readonly schema: "registered";
      readonly kind: ResourceShapeKind;
      readonly spec: JsonObject;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: { readonly delete: ResourceDeletePolicy };
      readonly connections?: Readonly<Record<string, ResourceConnectionSpec>>;
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

export type ParseVectorIndexSpecResult =
  | { readonly ok: true; readonly spec: VectorIndexSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseDurableWorkflowSpecResult =
  | { readonly ok: true; readonly spec: DurableWorkflowSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseStatefulActorNamespaceSpecResult =
  | { readonly ok: true; readonly spec: StatefulActorNamespaceSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseScheduleSpecResult =
  | { readonly ok: true; readonly spec: ScheduleSpec }
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
const RESOURCE_CAPABILITY_TOKEN_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const ARTIFACT_SHA256_RE = /^(?:sha256:)?[A-Fa-f0-9]{64}$/u;
const CRON_FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;
export function parseResourceSpec(
  kind: ResourceShapeKind,
  spec: unknown,
  schemaRegistry: ResourceShapeSchemaRegistry = EMPTY_RESOURCE_SHAPE_SCHEMA_REGISTRY,
): ParseResourceSpecResult {
  switch (kind) {
    case "EdgeWorker": {
      const r = parseEdgeWorkerSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              schema: "bundled",
              kind: "EdgeWorker",
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
              schema: "bundled",
              kind: "ObjectBucket",
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
              schema: "bundled",
              kind: "KVStore",
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
              schema: "bundled",
              kind: "Queue",
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
              schema: "bundled",
              kind: "SQLDatabase",
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
              schema: "bundled",
              kind: "ContainerService",
              spec: r.spec,
              interfaces: requiredContainerServiceInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "VectorIndex": {
      const r = parseVectorIndexSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              schema: "bundled",
              kind: "VectorIndex",
              spec: r.spec,
              interfaces: requiredVectorIndexInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "DurableWorkflow": {
      const r = parseDurableWorkflowSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              schema: "bundled",
              kind: "DurableWorkflow",
              spec: r.spec,
              interfaces: requiredDurableWorkflowInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "StatefulActorNamespace": {
      const r = parseStatefulActorNamespaceSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              schema: "bundled",
              kind: "StatefulActorNamespace",
              spec: r.spec,
              interfaces: requiredStatefulActorNamespaceInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "Schedule": {
      const r = parseScheduleSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              schema: "bundled",
              kind: "Schedule",
              spec: r.spec,
              interfaces: requiredScheduleInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    default:
      return parseRegisteredResourceSpec(kind, spec, schemaRegistry);
  }
}

function parseRegisteredResourceSpec(
  kind: ResourceShapeKind,
  spec: unknown,
  schemaRegistry: ResourceShapeSchemaRegistry,
): ParseResourceSpecResult {
  const parser = schemaRegistry.get(kind);
  if (!parser) {
    return {
      ok: false,
      error: {
        code: "unsupported_shape",
        message: `Resource Shape kind is not registered: ${String(kind)}`,
      },
    };
  }
  const candidate = objectCandidate(spec);
  if (!candidate.ok) return candidate;
  const secretPath = secretLikeJsonPath(candidate.value, "spec");
  if (secretPath) {
    return {
      ok: false,
      error: {
        code: "invalid_spec",
        message: `${secretPath} contains secret-looking material; use Credential or ProviderConnection materialization instead`,
      },
    };
  }

  let result: RegisteredResourceShapeSpecResult;
  try {
    result = parser(spec);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_spec",
        message:
          `registered Resource Shape schema ${kind} rejected the spec: ` +
          (error instanceof Error ? error.message : String(error)),
      },
    };
  }
  if (!result.ok) return result;
  const normalized = objectCandidate(result.value.spec);
  if (!normalized.ok) return normalized;
  const interfaces = parseExtensibleTokenList(
    result.value.interfaces,
    "interfaces",
    false,
  );
  if (!interfaces.ok) return interfaces;
  const lifecyclePolicy = parseLifecyclePolicy(result.value.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;
  const connections = parseConnectionsMap(result.value.connections);
  if (!connections.ok) return connections;
  return {
    ok: true,
    parsed: {
      schema: "registered",
      kind,
      spec: JSON.parse(JSON.stringify(normalized.value)) as JsonObject,
      interfaces: [...new Set(interfaces.value)],
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
      ...(connections.value ? { connections: connections.value } : {}),
    },
  };
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
    (typeof engine !== "string" || !RESOURCE_CAPABILITY_TOKEN_RE.test(engine))
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_engine",
        message: "spec.engine must be a valid capability token",
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

  const source = parseArtifactSource(candidate.source, "EdgeWorker");
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

export function parseVectorIndexSpec(
  spec: unknown,
): ParseVectorIndexSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;
  const name = parseName(candidate);
  if (!name.ok) return name;
  if (
    typeof candidate.dimensions !== "number" ||
    !Number.isInteger(candidate.dimensions) ||
    candidate.dimensions <= 0
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_dimensions",
        message: "spec.dimensions must be a positive integer",
      },
    };
  }
  const metric = candidate.metric;
  if (
    metric !== undefined &&
    (typeof metric !== "string" || !RESOURCE_CAPABILITY_TOKEN_RE.test(metric))
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_metric",
        message: "spec.metric must be a valid capability token",
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
      dimensions: candidate.dimensions,
      ...(typeof metric === "string" ? { metric } : {}),
      ...(connections.value ? { connections: connections.value } : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function parseDurableWorkflowSpec(
  spec: unknown,
): ParseDurableWorkflowSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;
  const name = parseName(candidate);
  if (!name.ok) return name;
  const source = parseArtifactSource(candidate.source, "DurableWorkflow");
  if (!source.ok) return source;
  const entrypoint = candidate.entrypoint;
  if (
    typeof entrypoint !== "string" ||
    entrypoint.trim().length === 0 ||
    entrypoint.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(entrypoint)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_entrypoint",
        message:
          "spec.entrypoint must be a non-empty printable string of at most 256 characters",
      },
    };
  }
  const retry = parseDurableWorkflowRetry(candidate.retry);
  if (!retry.ok) return retry;
  const connections = parseConnectionsMap(candidate.connections);
  if (!connections.ok) return connections;
  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;
  return {
    ok: true,
    spec: {
      name: name.value,
      source: source.value,
      entrypoint: entrypoint.trim(),
      ...(retry.value ? { retry: retry.value } : {}),
      ...(connections.value ? { connections: connections.value } : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function parseStatefulActorNamespaceSpec(
  spec: unknown,
): ParseStatefulActorNamespaceSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;
  const name = parseName(candidate);
  if (!name.ok) return name;
  if (
    typeof candidate.className !== "string" ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(candidate.className)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_class_name",
        message: "spec.className must be a valid runtime class identifier",
      },
    };
  }
  const storageProfile = candidate.storageProfile;
  if (
    storageProfile !== undefined &&
    (typeof storageProfile !== "string" ||
      !RESOURCE_CAPABILITY_TOKEN_RE.test(storageProfile))
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_storage_profile",
        message: "spec.storageProfile must be a valid capability token",
      },
    };
  }
  const migrationTag = candidate.migrationTag;
  if (
    migrationTag !== undefined &&
    (typeof migrationTag !== "string" ||
      migrationTag.trim().length === 0 ||
      migrationTag.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(migrationTag))
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_migration_tag",
        message:
          "spec.migrationTag must be a non-empty printable string of at most 128 characters",
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
      className: candidate.className,
      ...(typeof storageProfile === "string" ? { storageProfile } : {}),
      ...(typeof migrationTag === "string"
        ? { migrationTag: migrationTag.trim() }
        : {}),
      ...(connections.value ? { connections: connections.value } : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function parseScheduleSpec(spec: unknown): ParseScheduleSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;
  const name = parseName(candidate);
  if (!name.ok) return name;
  const cron = candidate.cron;
  const cronFields = typeof cron === "string" ? cron.trim().split(/\s+/u) : [];
  if (
    typeof cron !== "string" ||
    cronFields.length !== 5 ||
    cronFields.some((field, index) => {
      const range = CRON_FIELD_RANGES[index]!;
      return !isPortableCronField(field, range[0], range[1]);
    })
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_cron",
        message:
          "spec.cron must be a portable five-field cron expression using numbers, *, comma, range, or step syntax",
      },
    };
  }
  const timezone = candidate.timezone;
  if (
    timezone !== undefined &&
    (typeof timezone !== "string" ||
      timezone.trim().length === 0 ||
      timezone.length > 128 ||
      /\s|[\u0000-\u001f\u007f]/u.test(timezone))
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_timezone",
        message:
          "spec.timezone must be a non-empty timezone token without whitespace",
      },
    };
  }
  const connections = parseConnectionsMap(candidate.connections);
  if (!connections.ok) return connections;
  const connectionEntries = Object.entries(connections.value ?? {});
  if (connectionEntries.length !== 1) {
    return {
      ok: false,
      error: {
        code: "invalid_schedule_target",
        message: "spec.connections must contain exactly one schedule target",
      },
    };
  }
  const [, target] = connectionEntries[0]!;
  if (
    target.projection !== "schedule_trigger" ||
    !target.permissions.includes("invoke")
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_schedule_target",
        message:
          "the schedule target connection must use schedule_trigger projection and include invoke permission",
      },
    };
  }
  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;
  return {
    ok: true,
    spec: {
      name: name.value,
      cron: cronFields.join(" "),
      ...(typeof timezone === "string" ? { timezone: timezone.trim() } : {}),
      connections: connections.value!,
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

function isPortableCronField(field: string, min: number, max: number): boolean {
  if (!/^[0-9*,/-]+$/u.test(field)) return false;
  return field.split(",").every((item) => {
    const stepParts = item.split("/");
    if (stepParts.length > 2) return false;
    const [base, step] = stepParts;
    if (!base) return false;
    if (
      step !== undefined &&
      (!/^[1-9][0-9]*$/u.test(step) || Number(step) < 1)
    ) {
      return false;
    }
    if (base === "*") return true;
    const rangeParts = base.split("-");
    if (
      rangeParts.length > 2 ||
      rangeParts.some((part) => !/^[0-9]+$/u.test(part))
    ) {
      return false;
    }
    const start = Number(rangeParts[0]);
    const end = Number(rangeParts[1] ?? rangeParts[0]);
    return start >= min && end <= max && start <= end;
  });
}

export function planResourceShape(
  descriptor: TargetImplementationDescriptor,
  parsed: ParsedResourceSpec,
  target: TargetPoolEntry,
  moduleRegistry: ResourceShapeModuleRegistry = EMPTY_RESOURCE_SHAPE_MODULE_REGISTRY,
): ResourceShapePlan {
  if (descriptor.shape !== parsed.kind) {
    throw new Error(
      `implementation descriptor shape ${descriptor.shape} does not match Resource ${parsed.kind}`,
    );
  }
  const validatedSpec = validatedSpecForPlan(parsed.spec);
  const publicOutputs = (descriptor.moduleOutputs ?? []).map((output) => ({
    name: output.name,
    type: output.type,
  }));

  if (descriptor.plugin) {
    return {
      shape: parsed.kind,
      validatedSpec,
      executionId: `adapter-plugin:${descriptor.plugin}`,
      inputs: {},
      publicOutputs,
      requiresAdapterPlugin: true,
    };
  }

  if (!descriptor.providerSource || !descriptor.moduleTemplate) {
    throw new Error(
      `implementation ${descriptor.implementation} must declare either plugin or providerSource + moduleTemplate`,
    );
  }
  const operatorModule = moduleRegistry.get(descriptor.moduleTemplate);
  if (!operatorModule || operatorModule.files.length === 0) {
    throw new Error(
      `planResourceShape(${descriptor.implementation}): operator module registry has no entry for moduleTemplate "${descriptor.moduleTemplate}"`,
    );
  }
  return {
    shape: parsed.kind,
    validatedSpec,
    executionId: descriptor.moduleTemplate,
    moduleTemplate: descriptor.moduleTemplate,
    operatorModule,
    inputs: projectModuleInputs(
      descriptor.moduleInputMappings ?? {},
      validatedSpec,
      target,
    ),
    publicOutputs,
  };
}

function validatedSpecForPlan(spec: object): JsonObject {
  return JSON.parse(JSON.stringify(spec)) as JsonObject;
}

function projectModuleInputs(
  mappings: Readonly<Record<string, TargetModuleInputMapping>>,
  spec: JsonObject,
  target: TargetPoolEntry,
): Record<string, JsonValue> {
  const inputs: Record<string, JsonValue> = {};
  const targetJson = JSON.parse(JSON.stringify(target)) as JsonObject;
  for (const [inputName, mapping] of Object.entries(mappings)) {
    const projected = projectModuleInput(mapping, spec, targetJson);
    if (projected.found) inputs[inputName] = projected.value;
  }
  return inputs;
}

type ProjectedModuleInput =
  | { readonly found: true; readonly value: JsonValue }
  | { readonly found: false };

function projectModuleInput(
  mapping: TargetModuleInputMapping,
  spec: JsonObject,
  target: JsonObject,
): ProjectedModuleInput {
  let projected: ProjectedModuleInput;
  if (mapping.source === "literal") {
    projected = Object.prototype.hasOwnProperty.call(mapping, "value")
      ? { found: true, value: mapping.value ?? null }
      : { found: false };
  } else {
    const root = mapping.source === "spec" ? spec : target;
    projected = jsonPointerValue(root, mapping.path);
  }
  if (projected.found) return projected;
  if (Object.prototype.hasOwnProperty.call(mapping, "default")) {
    return { found: true, value: mapping.default ?? null };
  }
  if (mapping.required) {
    throw new Error(
      `required module input mapping is missing (${mapping.source}:${mapping.path ?? ""})`,
    );
  }
  return { found: false };
}

function jsonPointerValue(
  root: JsonValue,
  pointer: string | undefined,
): ProjectedModuleInput {
  if (pointer === undefined || (pointer !== "" && !pointer.startsWith("/"))) {
    return { found: false };
  }
  if (pointer === "") return { found: true, value: root };
  let current: JsonValue = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(token)) return { found: false };
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index]!;
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, token)
    ) {
      return { found: false };
    }
    current = (current as Readonly<Record<string, JsonValue>>)[token]!;
  }
  return { found: true, value: current };
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
  return ["sql", engine];
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

function requiredVectorIndexInterfaces(
  spec: VectorIndexSpec,
): readonly string[] {
  const interfaces = [
    "vector_index",
    "vector_query",
    "runtime_binding",
    spec.metric ?? "cosine",
  ];
  appendConnectionInterfaces(interfaces, spec.connections);
  return interfaces;
}

function requiredDurableWorkflowInterfaces(
  spec: DurableWorkflowSpec,
): readonly string[] {
  const interfaces = ["durable_workflow", "invoke", "signal"];
  appendConnectionInterfaces(interfaces, spec.connections);
  return interfaces;
}

function requiredStatefulActorNamespaceInterfaces(
  spec: StatefulActorNamespaceSpec,
): readonly string[] {
  const interfaces = [
    "stateful_actor_namespace",
    "runtime_binding",
    spec.storageProfile ?? "durable_sqlite",
  ];
  appendConnectionInterfaces(interfaces, spec.connections);
  return interfaces;
}

function requiredScheduleInterfaces(spec: ScheduleSpec): readonly string[] {
  const interfaces = ["schedule", "cron", "invoke"];
  if ((spec.timezone ?? "UTC") !== "UTC") {
    // Non-UTC support is target/backend dependent. Requiring explicit Resolver
    // evidence keeps v1alpha1 fail closed instead of silently shifting time.
    interfaces.push("non_utc_timezone");
  }
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
    if (secretLikeJsonPath({ [key]: item }, `spec.${field}`)) {
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
        !RESOURCE_CAPABILITY_TOKEN_RE.test(permission)
      ) {
        return {
          ok: false,
          error: {
            code: "invalid_connection",
            message: `spec.connections.${name}.permissions values must be valid capability tokens`,
          },
        };
      }
      permissions.push(permission as ResourceConnectionPermission);
    }
    if (
      typeof candidate.projection !== "string" ||
      !RESOURCE_CAPABILITY_TOKEN_RE.test(candidate.projection)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_connection",
          message: `spec.connections.${name}.projection must be a valid capability token`,
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

function parseDurableWorkflowRetry(value: unknown):
  | {
      readonly ok: true;
      readonly value:
        | {
            readonly maxAttempts?: number;
            readonly initialBackoffSeconds?: number;
          }
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
        code: "invalid_retry",
        message: "spec.retry must be an object",
      },
    };
  }
  const retry = value as Record<string, unknown>;
  const maxAttempts = retry.maxAttempts;
  if (
    maxAttempts !== undefined &&
    (typeof maxAttempts !== "number" ||
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_retry",
        message: "spec.retry.maxAttempts must be a positive integer",
      },
    };
  }
  const initialBackoffSeconds = retry.initialBackoffSeconds;
  if (
    initialBackoffSeconds !== undefined &&
    (typeof initialBackoffSeconds !== "number" ||
      !Number.isInteger(initialBackoffSeconds) ||
      initialBackoffSeconds < 0)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_retry",
        message:
          "spec.retry.initialBackoffSeconds must be a non-negative integer",
      },
    };
  }
  return {
    ok: true,
    value: {
      ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
      ...(typeof initialBackoffSeconds === "number"
        ? { initialBackoffSeconds }
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

function parseArtifactSource(
  value: unknown,
  owner: "EdgeWorker" | "DurableWorkflow",
):
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
        message: `spec.source.artifactPath, spec.source.artifactUrl, or spec.source.artifactRef is required for ${owner}`,
      },
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: "spec.source must be an object",
      },
    };
  }
  const source = value as Record<string, unknown>;
  if (source.image !== undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: `${owner} supports source.artifactPath, source.artifactUrl, or source.artifactRef only`,
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
  const artifactRef =
    typeof source.artifactRef === "string" &&
    source.artifactRef.trim().length > 0
      ? source.artifactRef.trim()
      : undefined;
  const selectedSources = [artifactPath, artifactUrl, artifactRef].filter(
    (candidate) => candidate !== undefined,
  );
  if (selectedSources.length > 1) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: `spec.source must set only one of artifactPath, artifactUrl, or artifactRef for ${owner}`,
      },
    };
  }
  if (artifactPath) {
    return { ok: true, value: { artifactPath } };
  }
  if (artifactRef) {
    const artifactSha256 =
      typeof source.artifactSha256 === "string" &&
      source.artifactSha256.trim().length > 0
        ? source.artifactSha256.trim()
        : undefined;
    if (!artifactSha256) {
      return {
        ok: false,
        error: {
          code: "invalid_source",
          message:
            "spec.source.artifactSha256 is required when artifactRef is set",
        },
      };
    }
    if (!ARTIFACT_SHA256_RE.test(artifactSha256)) {
      return {
        ok: false,
        error: {
          code: "invalid_source",
          message:
            "spec.source.artifactSha256 must be a 64-character SHA-256 hex digest",
        },
      };
    }
    return { ok: true, value: { artifactRef, artifactSha256 } };
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
        ? source.artifactSha256.trim()
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
    if (!ARTIFACT_SHA256_RE.test(artifactSha256)) {
      return {
        ok: false,
        error: {
          code: "invalid_source",
          message:
            "spec.source.artifactSha256 must be a 64-character SHA-256 hex digest",
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
        "spec.source.artifactPath, spec.source.artifactUrl, or spec.source.artifactRef must be a non-empty string",
    },
  };
}
