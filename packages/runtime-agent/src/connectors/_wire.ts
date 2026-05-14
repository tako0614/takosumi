/**
 * Wire-shape validators for connector HTTP responses.
 *
 * The `Direct*Lifecycle` classes call external REST APIs (Cloudflare REST,
 * GCP REST, Kubernetes API server, ...). The response bodies are foreign
 * JSON: even when the operator's credentials are correct, the upstream
 * service is free to change its envelope, omit fields, or substitute
 * surprising types. Previously we coerced those payloads with
 * `JSON.parse(text) as T` / `await res.json() as T` which lies to the type
 * system — a malformed response would silently propagate corrupt values
 * downstream (wrong URLs, missing IPs, fabricated descriptors).
 *
 * This module mirrors the spirit of `_spec.ts` but for **ingress wire
 * payloads** rather than `req.spec`: each parser walks the JSON structurally,
 * throws a typed `ConnectorContractError` with the field path that failed,
 * and returns a value whose static type matches the runtime check.
 *
 * Naming convention: `parseX` throws on missing required / wrong-type;
 * `optionalX` returns `undefined` when absent; both throw on type mismatch
 * when the field *is* present. Field paths follow JSON-Pointer-like dot
 * notation (e.g. `cf.subdomain.result.subdomain`).
 *
 * Validators here intentionally do NOT touch test mocks/fixtures — they are
 * production-connector ingress only. Tests construct values with full known
 * shape and have no `JSON.parse(_) as T` to widen.
 */

/**
 * Thrown when an external API response fails structural validation. The
 * `path` field identifies the JSON-Pointer-like location of the offending
 * field so operator logs surface "which response field broke" rather than
 * an opaque cast failure.
 */
export class ConnectorContractError extends Error {
  readonly path: string;
  readonly context: string;
  constructor(context: string, path: string, message: string) {
    super(`${context}: ${path} ${message}`);
    this.name = "ConnectorContractError";
    this.path = path;
    this.context = context;
  }
}

// ---------------------------------------------------------------------------
// Primitive structural assertions. All raise `ConnectorContractError` so the
// thrown message uniformly carries the failing field path. They take `unknown`
// rather than `JsonValue` because the inputs are post-`JSON.parse` and can in
// principle be any value (including non-JSON shapes from malformed APIs).
// ---------------------------------------------------------------------------

export function expectObject(
  value: unknown,
  context: string,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConnectorContractError(context, path, "must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function expectString(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  parent: string,
): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new ConnectorContractError(
      context,
      `${parent}.${key}`,
      "must be a string",
    );
  }
  return value;
}

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  parent: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ConnectorContractError(
      context,
      `${parent}.${key}`,
      "must be a string when present",
    );
  }
  return value;
}

export function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  parent: string,
): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConnectorContractError(
      context,
      `${parent}.${key}`,
      "must be a finite number when present",
    );
  }
  return value;
}

export function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  parent: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ConnectorContractError(
      context,
      `${parent}.${key}`,
      "must be a boolean when present",
    );
  }
  return value;
}

export function optionalObject(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  parent: string,
): Record<string, unknown> | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorContractError(
      context,
      `${parent}.${key}`,
      "must be a JSON object when present",
    );
  }
  return value as Record<string, unknown>;
}

export function optionalArray(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  parent: string,
): readonly unknown[] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ConnectorContractError(
      context,
      `${parent}.${key}`,
      "must be an array when present",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Cloudflare envelope. CF responses always have shape:
//   { result: T, success: bool, errors?: [{code,message}], messages?: [...] }
// ---------------------------------------------------------------------------

export interface CloudflareError {
  readonly code: number;
  readonly message: string;
}

export interface CloudflareEnvelope<T = unknown> {
  readonly result: T;
  readonly success: boolean;
  readonly errors?: readonly CloudflareError[];
  readonly messages?: readonly CloudflareError[];
}

function parseCloudflareErrors(
  value: unknown,
  context: string,
  path: string,
): readonly CloudflareError[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ConnectorContractError(
      context,
      path,
      "must be an array when present",
    );
  }
  return value.map((entry, i) => {
    const e = expectObject(entry, context, `${path}[${i}]`);
    const codeRaw = e.code;
    const messageRaw = e.message;
    if (typeof codeRaw !== "number" || !Number.isFinite(codeRaw)) {
      throw new ConnectorContractError(
        context,
        `${path}[${i}].code`,
        "must be a finite number",
      );
    }
    if (typeof messageRaw !== "string") {
      throw new ConnectorContractError(
        context,
        `${path}[${i}].message`,
        "must be a string",
      );
    }
    return { code: codeRaw, message: messageRaw };
  });
}

/**
 * Parse a Cloudflare API envelope. `parseResult` describes how to validate
 * `result`. For 4xx/5xx responses CF may return `result: null`, so we accept
 * a missing/null `result` and pass `undefined` to `parseResult` — callers
 * already handle `envelope.result` as optional via existing error paths.
 */
export function parseCloudflareEnvelope<T>(
  value: unknown,
  context: string,
  parseResult: (raw: unknown, ctx: string, path: string) => T,
): CloudflareEnvelope<T> {
  const obj = expectObject(value, context, "$");
  const successRaw = obj.success;
  if (typeof successRaw !== "boolean") {
    throw new ConnectorContractError(
      context,
      "$.success",
      "must be a boolean",
    );
  }
  const errors = parseCloudflareErrors(obj.errors, context, "$.errors");
  const messages = parseCloudflareErrors(obj.messages, context, "$.messages");
  // result may legitimately be null (e.g. on error envelopes); parseResult
  // decides whether that is acceptable for the caller's shape.
  const result = parseResult(obj.result, context, "$.result");
  return { result, success: successRaw, errors, messages };
}

/** `result` validator that accepts any object-shaped result (or null). */
export function passthroughObjectResult(
  raw: unknown,
  context: string,
  path: string,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConnectorContractError(
      context,
      path,
      "must be a JSON object when present",
    );
  }
  return raw as Record<string, unknown>;
}

/** Cloudflare `/accounts/{id}/workers/subdomain` response. */
export interface CloudflareSubdomainResult {
  readonly subdomain?: string;
}

export function parseCloudflareSubdomainResult(
  raw: unknown,
  context: string,
  path: string,
): CloudflareSubdomainResult | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = expectObject(raw, context, path);
  return { subdomain: optionalString(obj, "subdomain", context, path) };
}

// ---------------------------------------------------------------------------
// GCP. Each Direct*Lifecycle declares a per-endpoint shape; the parsers below
// validate only the fields the lifecycle reads (we deliberately do not pin
// the full GCP API surface — only what we depend on).
// ---------------------------------------------------------------------------

/** Cloud Run service GET / POST response. */
export interface CloudRunServiceResponse {
  readonly name?: string;
  readonly uri?: string;
  readonly template?: {
    readonly containers?: ReadonlyArray<
      { readonly ports?: ReadonlyArray<{ readonly containerPort?: number }> }
    >;
  };
}

export function parseCloudRunServiceResponse(
  raw: unknown,
  context: string,
): CloudRunServiceResponse | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = expectObject(raw, context, "$");
  const templateRaw = optionalObject(obj, "template", context, "$");
  let template: CloudRunServiceResponse["template"] | undefined;
  if (templateRaw !== undefined) {
    const containersRaw = optionalArray(
      templateRaw,
      "containers",
      context,
      "$.template",
    );
    const containers = containersRaw?.map((entry, i) => {
      const c = expectObject(entry, context, `$.template.containers[${i}]`);
      const portsRaw = optionalArray(
        c,
        "ports",
        context,
        `$.template.containers[${i}]`,
      );
      const ports = portsRaw?.map((p, j) => {
        const portsPath = `$.template.containers[${i}].ports[${j}]`;
        const pObj = expectObject(p, context, portsPath);
        return {
          containerPort: optionalNumber(
            pObj,
            "containerPort",
            context,
            portsPath,
          ),
        };
      });
      return { ports };
    });
    template = { containers };
  }
  return {
    name: optionalString(obj, "name", context, "$"),
    uri: optionalString(obj, "uri", context, "$"),
    template,
  };
}

/** Cloud SQL instance GET / POST response. */
export interface CloudSqlInstanceResponse {
  readonly name?: string;
  readonly databaseVersion?: string;
  readonly ipAddresses?: ReadonlyArray<{
    readonly ipAddress?: string;
    readonly type?: string;
  }>;
}

export function parseCloudSqlInstanceResponse(
  raw: unknown,
  context: string,
): CloudSqlInstanceResponse | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = expectObject(raw, context, "$");
  const ipsRaw = optionalArray(obj, "ipAddresses", context, "$");
  const ipAddresses = ipsRaw?.map((entry, i) => {
    const e = expectObject(entry, context, `$.ipAddresses[${i}]`);
    return {
      ipAddress: optionalString(
        e,
        "ipAddress",
        context,
        `$.ipAddresses[${i}]`,
      ),
      type: optionalString(e, "type", context, `$.ipAddresses[${i}]`),
    };
  });
  return {
    name: optionalString(obj, "name", context, "$"),
    databaseVersion: optionalString(obj, "databaseVersion", context, "$"),
    ipAddresses,
  };
}

/** GCS bucket GET / POST response. */
export interface GcsBucketResponse {
  readonly name?: string;
  readonly location?: string;
}

export function parseGcsBucketResponse(
  raw: unknown,
  context: string,
): GcsBucketResponse | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = expectObject(raw, context, "$");
  return {
    name: optionalString(obj, "name", context, "$"),
    location: optionalString(obj, "location", context, "$"),
  };
}

// ---------------------------------------------------------------------------
// Kubernetes. Validates the subset of `Deployment` / `Service` objects the
// k3s lifecycle reads. Plus the generic `POST` response which may carry a
// `spec.clusterIP` for the Service-create branch.
// ---------------------------------------------------------------------------

export interface K8sDeploymentResponse {
  readonly spec?: { readonly replicas?: number };
  readonly status?: { readonly replicas?: number };
}

export function parseK8sDeploymentResponse(
  raw: unknown,
  context: string,
): K8sDeploymentResponse | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = expectObject(raw, context, "$");
  const specRaw = optionalObject(obj, "spec", context, "$");
  const statusRaw = optionalObject(obj, "status", context, "$");
  return {
    spec: specRaw === undefined ? undefined : {
      replicas: optionalNumber(specRaw, "replicas", context, "$.spec"),
    },
    status: statusRaw === undefined ? undefined : {
      replicas: optionalNumber(statusRaw, "replicas", context, "$.status"),
    },
  };
}

export interface K8sServiceResponse {
  readonly spec?: {
    readonly clusterIP?: string;
    readonly ports?: ReadonlyArray<{ readonly port: number }>;
  };
}

export function parseK8sServiceResponse(
  raw: unknown,
  context: string,
): K8sServiceResponse | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = expectObject(raw, context, "$");
  const specRaw = optionalObject(obj, "spec", context, "$");
  let spec: K8sServiceResponse["spec"] | undefined;
  if (specRaw !== undefined) {
    const portsRaw = optionalArray(specRaw, "ports", context, "$.spec");
    const ports = portsRaw?.map((entry, i) => {
      const e = expectObject(entry, context, `$.spec.ports[${i}]`);
      const portRaw = e.port;
      if (typeof portRaw !== "number" || !Number.isFinite(portRaw)) {
        throw new ConnectorContractError(
          context,
          `$.spec.ports[${i}].port`,
          "must be a finite number",
        );
      }
      return { port: portRaw };
    });
    spec = {
      clusterIP: optionalString(specRaw, "clusterIP", context, "$.spec"),
      ports,
    };
  }
  return { spec };
}

/**
 * Validate a generic Kubernetes object-creation response. Used by the
 * fallthrough `#postOrIgnoreConflict` path which only reads
 * `spec.clusterIP` when present (Service create branch).
 */
export function parseK8sObjectResponse(
  raw: unknown,
  context: string,
): { readonly spec?: { readonly clusterIP?: string } } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = expectObject(raw, context, "$");
  const specRaw = optionalObject(obj, "spec", context, "$");
  return {
    spec: specRaw === undefined ? undefined : {
      clusterIP: optionalString(specRaw, "clusterIP", context, "$.spec"),
    },
  };
}
