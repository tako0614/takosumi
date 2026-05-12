/**
 * Spec extraction helpers for `LifecycleApplyRequest.spec`.
 *
 * The contract types `req.spec` as `JsonValue` because the kernel does not
 * know which connector will receive the request. Each connector knows the
 * shape it expects and previously coerced the value with
 * `req.spec as unknown as { ... }`. That cast lies to the type system and
 * silently produces wrong behavior if the kernel ever sends a malformed
 * spec.
 *
 * These helpers replace the cast with explicit structural validation that
 * throws a descriptive `Error` instead of corrupting downstream state.
 *
 * Naming: `requireX` throws when missing/wrong type, `optionalX` returns
 * `undefined` when absent, throws when present with the wrong type.
 */

import type { Artifact, JsonObject, JsonValue } from "takosumi-contract";

export type SpecObject = JsonObject;

export type { JsonValue };

export function asSpecObject(spec: JsonValue, shape: string): SpecObject {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error(`${shape} spec must be a JSON object`);
  }
  return spec;
}

export function requireString(
  obj: SpecObject,
  key: string,
  shape: string,
): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`${shape}.${key} must be a string`);
  }
  return value;
}

export function optionalString(
  obj: SpecObject,
  key: string,
  shape: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${shape}.${key} must be a string when present`);
  }
  return value;
}

export function requireNumber(
  obj: SpecObject,
  key: string,
  shape: string,
): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${shape}.${key} must be a finite number`);
  }
  return value;
}

export function optionalNumber(
  obj: SpecObject,
  key: string,
  shape: string,
): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${shape}.${key} must be a finite number when present`);
  }
  return value;
}

export function optionalBoolean(
  obj: SpecObject,
  key: string,
  shape: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${shape}.${key} must be a boolean when present`);
  }
  return value;
}

export function requireObject(
  obj: SpecObject,
  key: string,
  shape: string,
): SpecObject {
  const value = obj[key];
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
  ) {
    throw new Error(`${shape}.${key} must be a JSON object`);
  }
  return value;
}

export function optionalObject(
  obj: SpecObject,
  key: string,
  shape: string,
): SpecObject | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${shape}.${key} must be a JSON object when present`);
  }
  return value;
}

export function optionalStringRecord(
  obj: SpecObject,
  key: string,
  shape: string,
): Record<string, string> | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${shape}.${key} must be a string-valued object when present`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new Error(`${shape}.${key}.${k} must be a string`);
    }
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shape-specific parsers. Each captures the spec contract for a single shape
// so connectors that share a shape share one validator.
// ---------------------------------------------------------------------------

export interface WebServiceSpec {
  readonly image?: string;
  readonly artifact?: { readonly kind: string; readonly uri?: string };
  readonly port: number;
  readonly scale: { readonly min: number; readonly max: number };
  readonly resources?: {
    readonly cpu?: string;
    readonly memory?: string;
  };
  readonly env?: Record<string, string>;
  readonly bindings?: Record<string, string>;
}

export function parseWebServiceSpec(value: JsonValue): WebServiceSpec {
  const shape = "web-service@v1";
  const obj = asSpecObject(value, shape);
  const scale = requireObject(obj, "scale", shape);
  const artifactRaw = optionalObject(obj, "artifact", shape);
  const resourcesRaw = optionalObject(obj, "resources", shape);
  return {
    image: optionalString(obj, "image", shape),
    artifact: artifactRaw === undefined ? undefined : {
      kind: requireString(artifactRaw, "kind", `${shape}.artifact`),
      uri: optionalString(artifactRaw, "uri", `${shape}.artifact`),
    },
    port: requireNumber(obj, "port", shape),
    scale: {
      min: requireNumber(scale, "min", `${shape}.scale`),
      max: requireNumber(scale, "max", `${shape}.scale`),
    },
    resources: resourcesRaw === undefined ? undefined : {
      cpu: optionalString(resourcesRaw, "cpu", `${shape}.resources`),
      memory: optionalString(resourcesRaw, "memory", `${shape}.resources`),
    },
    env: optionalStringRecord(obj, "env", shape),
    bindings: optionalStringRecord(obj, "bindings", shape),
  };
}

export interface ObjectStoreSpec {
  readonly name: string;
  readonly region?: string;
  readonly versioning?: boolean;
  readonly public?: boolean;
}

export function parseObjectStoreSpec(value: JsonValue): ObjectStoreSpec {
  const shape = "object-store@v1";
  const obj = asSpecObject(value, shape);
  return {
    name: requireString(obj, "name", shape),
    region: optionalString(obj, "region", shape),
    versioning: optionalBoolean(obj, "versioning", shape),
    public: optionalBoolean(obj, "public", shape),
  };
}

export interface DnsRecordSpec {
  readonly name: string;
  readonly target: string;
}

export function parseDnsRecordSpec(value: JsonValue): DnsRecordSpec {
  const shape = "custom-domain@v1";
  const obj = asSpecObject(value, shape);
  return {
    name: requireString(obj, "name", shape),
    target: requireString(obj, "target", shape),
  };
}

export interface PostgresSpec {
  readonly version: string;
  readonly size: string;
  readonly storage?: { readonly sizeGiB?: number };
  readonly highAvailability?: boolean;
}

export function parsePostgresSpec(value: JsonValue): PostgresSpec {
  const shape = "database-postgres@v1";
  const obj = asSpecObject(value, shape);
  const storageRaw = optionalObject(obj, "storage", shape);
  return {
    version: requireString(obj, "version", shape),
    size: requireString(obj, "size", shape),
    storage: storageRaw === undefined ? undefined : {
      sizeGiB: optionalNumber(storageRaw, "sizeGiB", `${shape}.storage`),
    },
    highAvailability: optionalBoolean(obj, "highAvailability", shape),
  };
}

export interface PostgresVersionSpec {
  readonly version: string;
}

export function parsePostgresVersionSpec(
  value: JsonValue,
): PostgresVersionSpec {
  const shape = "database-postgres@v1";
  const obj = asSpecObject(value, shape);
  return { version: requireString(obj, "version", shape) };
}

export interface SelfhostWebServiceSpec {
  readonly image?: string;
  readonly artifact?: { readonly kind: string; readonly uri?: string };
  readonly port: number;
  readonly env?: Record<string, string>;
  readonly bindings?: Record<string, string>;
  readonly command?: readonly string[];
}

function optionalStringArray(
  obj: SpecObject,
  key: string,
  shape: string,
): readonly string[] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${shape}.${key} must be an array of strings when present`);
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "string") {
      throw new Error(`${shape}.${key}[${i}] must be a string`);
    }
    out.push(v);
  }
  return out;
}

export function parseSelfhostWebServiceSpec(
  value: JsonValue,
): SelfhostWebServiceSpec {
  const shape = "web-service@v1";
  const obj = asSpecObject(value, shape);
  const artifactRaw = optionalObject(obj, "artifact", shape);
  return {
    image: optionalString(obj, "image", shape),
    artifact: artifactRaw === undefined ? undefined : {
      kind: requireString(artifactRaw, "kind", `${shape}.artifact`),
      uri: optionalString(artifactRaw, "uri", `${shape}.artifact`),
    },
    port: requireNumber(obj, "port", shape),
    env: optionalStringRecord(obj, "env", shape),
    bindings: optionalStringRecord(obj, "bindings", shape),
    command: optionalStringArray(obj, "command", shape),
  };
}

export interface NamedBucketSpec {
  readonly name: string;
}

export function parseNamedBucketSpec(value: JsonValue): NamedBucketSpec {
  const shape = "object-store@v1";
  const obj = asSpecObject(value, shape);
  return { name: requireString(obj, "name", shape) };
}

export interface WorkerSpec {
  readonly artifact: Artifact;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly routes?: readonly string[];
}

function parseArtifact(value: JsonValue, shape: string): Artifact {
  const path = `${shape}.artifact`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  const obj = value;
  const metadataRaw = obj.metadata;
  let metadata: JsonObject | undefined;
  if (metadataRaw !== undefined && metadataRaw !== null) {
    if (
      typeof metadataRaw !== "object" || Array.isArray(metadataRaw)
    ) {
      throw new Error(`${path}.metadata must be a JSON object when present`);
    }
    metadata = metadataRaw;
  }
  return {
    kind: requireString(obj, "kind", path),
    hash: optionalString(obj, "hash", path),
    uri: optionalString(obj, "uri", path),
    metadata,
  };
}

export function parseWorkerSpec(value: JsonValue): WorkerSpec {
  const shape = "worker@v1";
  const obj = asSpecObject(value, shape);
  const artifactRaw = obj.artifact;
  if (artifactRaw === undefined) {
    throw new Error(`${shape}.artifact is required`);
  }
  return {
    artifact: parseArtifact(artifactRaw, shape),
    compatibilityDate: requireString(obj, "compatibilityDate", shape),
    compatibilityFlags: optionalStringArray(obj, "compatibilityFlags", shape),
    env: optionalStringRecord(obj, "env", shape),
    routes: optionalStringArray(obj, "routes", shape),
  };
}
