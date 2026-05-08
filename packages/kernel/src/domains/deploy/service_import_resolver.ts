import { createHash } from "node:crypto";
import type {
  CrossInstanceRefreshPolicy,
  CrossInstanceShare,
  Digest,
  JsonObject,
  ServiceDescriptor,
} from "takosumi-contract";
import {
  assertServiceDescriptorContract,
  parseServiceIdentifier,
} from "takosumi-contract";

export interface ServiceImportResolverOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => string;
  readonly deploymentId?: string;
}

export interface ResolvedServiceImport {
  readonly alias: string;
  readonly serviceId: string;
  readonly resolverUrl: string;
  readonly descriptor: ServiceDescriptor;
  readonly descriptorDigest: Digest;
  readonly share: CrossInstanceShare;
}

export type ServiceImportResolution =
  | { readonly ok: true; readonly value: readonly ResolvedServiceImport[] }
  | { readonly ok: false; readonly error: string };

export async function resolveManifestServiceImports(
  manifest: unknown,
  options: ServiceImportResolverOptions = {},
): Promise<ServiceImportResolution> {
  if (!isRecord(manifest)) {
    return { ok: false, error: "manifest must be a JSON object" };
  }
  const imports = manifest.imports;
  if (imports === undefined) return { ok: true, value: [] };
  if (!Array.isArray(imports)) {
    return { ok: false, error: "manifest.imports must be an array" };
  }
  if (imports.length === 0) return { ok: true, value: [] };

  const resolvers = manifest.serviceResolvers;
  if (!Array.isArray(resolvers) || resolvers.length === 0) {
    return {
      ok: false,
      error: "manifest.serviceResolvers is required when imports are declared",
    };
  }

  const fetcher = options.fetch ?? fetch;
  const resolvedAt = options.now?.() ?? new Date().toISOString();
  const output: ResolvedServiceImport[] = [];
  for (const [index, rawImport] of imports.entries()) {
    if (!isRecord(rawImport)) {
      return {
        ok: false,
        error: `manifest.imports[${index}] must be an object`,
      };
    }
    const alias = stringValue(rawImport.alias);
    const serviceId = stringValue(rawImport.service);
    if (!alias || !serviceId || !parseServiceIdentifier(serviceId)) {
      return {
        ok: false,
        error:
          `manifest.imports[${index}] must declare alias and service identifier`,
      };
    }
    const refreshPolicy = readRefreshPolicy(rawImport.refreshPolicy);
    if (!refreshPolicy.ok) {
      return {
        ok: false,
        error:
          `manifest.imports[${index}].refreshPolicy: ${refreshPolicy.error}`,
      };
    }
    const resolved = await resolveOneImport({
      alias,
      serviceId,
      refreshPolicy: refreshPolicy.value,
      resolvers,
      fetcher,
      resolvedAt,
      deploymentId: options.deploymentId ?? "deployment:unassigned",
    });
    if (!resolved.ok) return resolved;
    output.push(resolved.value);
  }
  return { ok: true, value: output };
}

export function serviceDescriptorDigest(descriptor: ServiceDescriptor): Digest {
  return digestOf(serviceDescriptorSigningPayload(descriptor));
}

export function serviceDescriptorSigningPayload(
  descriptor: ServiceDescriptor,
): Omit<ServiceDescriptor, "signature"> {
  const { signature: _signature, ...payload } = descriptor;
  return payload;
}

export function serviceDescriptorSigningBytes(
  descriptor: ServiceDescriptor,
): Uint8Array {
  return new TextEncoder().encode(
    stableStringify(serviceDescriptorSigningPayload(descriptor)),
  );
}

async function resolveOneImport(input: {
  readonly alias: string;
  readonly serviceId: string;
  readonly refreshPolicy: CrossInstanceRefreshPolicy;
  readonly resolvers: readonly unknown[];
  readonly fetcher: typeof fetch;
  readonly resolvedAt: string;
  readonly deploymentId: string;
}): Promise<
  | { readonly ok: true; readonly value: ResolvedServiceImport }
  | { readonly ok: false; readonly error: string }
> {
  const errors: string[] = [];
  for (const [index, rawResolver] of input.resolvers.entries()) {
    if (!isRecord(rawResolver)) {
      errors.push(`serviceResolvers[${index}] must be an object`);
      continue;
    }
    const resolverUrl = stringValue(rawResolver.url);
    const publicKey = stringValue(rawResolver.publicKey);
    if (rawResolver.kind !== "anchor" || !resolverUrl || !publicKey) {
      errors.push(
        `serviceResolvers[${index}] must declare anchor url and publicKey`,
      );
      continue;
    }
    const url = serviceDescriptorUrl(resolverUrl, input.serviceId);
    let response: Response;
    try {
      response = await input.fetcher(url, {
        method: "GET",
        headers: { accept: "application/json" },
      });
    } catch (error) {
      errors.push(`${url}: ${errorMessage(error)}`);
      continue;
    }
    if (response.status !== 200) {
      errors.push(`${url}: anchor returned ${response.status}`);
      continue;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      errors.push(`${url}: invalid JSON: ${errorMessage(error)}`);
      continue;
    }
    const descriptor = readServiceDescriptor(body);
    if (!descriptor.ok) {
      errors.push(`${url}: ${descriptor.error}`);
      continue;
    }
    const verified = await verifyServiceDescriptor({
      descriptor: descriptor.value,
      expectedServiceId: input.serviceId,
      publicKey,
      now: input.resolvedAt,
    });
    if (!verified.ok) {
      errors.push(`${url}: ${verified.error}`);
      continue;
    }
    const descriptorDigest = serviceDescriptorDigest(descriptor.value);
    const share = buildCrossInstanceShare({
      alias: input.alias,
      serviceId: input.serviceId,
      deploymentId: input.deploymentId,
      descriptor: descriptor.value,
      descriptorDigest,
      resolverUrl,
      resolvedAt: input.resolvedAt,
      refreshPolicy: input.refreshPolicy,
    });
    return {
      ok: true,
      value: {
        alias: input.alias,
        serviceId: input.serviceId,
        resolverUrl,
        descriptor: descriptor.value,
        descriptorDigest,
        share,
      },
    };
  }
  return {
    ok: false,
    error:
      `failed to resolve service import ${input.alias} (${input.serviceId}): ` +
      errors.join("; "),
  };
}

function readServiceDescriptor(
  value: unknown,
): { readonly ok: true; readonly value: ServiceDescriptor } | {
  readonly ok: false;
  readonly error: string;
} {
  if (!isRecord(value)) {
    return { ok: false, error: "descriptor must be an object" };
  }
  if (
    !stringValue(value.id) ||
    !stringValue(value.version) ||
    !stringValue(value.contract) ||
    !stringValue(value.signature) ||
    !stringValue(value.publishedAt) ||
    !stringValue(value.expiresAt) ||
    !stringValue(value.providerInstance)
  ) {
    return { ok: false, error: "descriptor is missing required string fields" };
  }
  const id = stringValue(value.id)!;
  const version = stringValue(value.version)!;
  const contract = stringValue(value.contract)!;
  const signature = stringValue(value.signature)!;
  const publishedAt = stringValue(value.publishedAt)!;
  const expiresAt = stringValue(value.expiresAt)!;
  const providerInstance = stringValue(value.providerInstance)!;
  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) {
    return { ok: false, error: "descriptor endpoints must be non-empty" };
  }
  const endpoints = [];
  for (const [index, endpoint] of value.endpoints.entries()) {
    if (!isRecord(endpoint)) {
      return {
        ok: false,
        error: `descriptor endpoints[${index}] must be an object`,
      };
    }
    const role = stringValue(endpoint.role);
    const url = stringValue(endpoint.url);
    const path = stringValue(endpoint.path);
    if (!role || !url || !path) {
      return {
        ok: false,
        error: `descriptor endpoints[${index}] requires role, url, and path`,
      };
    }
    endpoints.push({ role, url, path });
  }
  const metadata = value.metadata === undefined ? {} : value.metadata;
  if (!isRecord(metadata) || !isJsonValue(metadata)) {
    return { ok: false, error: "descriptor metadata must be JSON-compatible" };
  }
  return {
    ok: true,
    value: {
      id,
      version,
      contract,
      endpoints,
      metadata: metadata as JsonObject,
      signature,
      publishedAt,
      expiresAt,
      providerInstance,
    },
  };
}

async function verifyServiceDescriptor(input: {
  readonly descriptor: ServiceDescriptor;
  readonly expectedServiceId: string;
  readonly publicKey: string;
  readonly now: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  try {
    assertServiceDescriptorContract(input.descriptor);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  if (input.descriptor.contract !== input.expectedServiceId) {
    return {
      ok: false,
      error:
        `descriptor contract ${input.descriptor.contract} does not match import ${input.expectedServiceId}`,
    };
  }
  if (Date.parse(input.descriptor.expiresAt) <= Date.parse(input.now)) {
    return { ok: false, error: "descriptor is expired" };
  }
  const valid = await verifyEd25519Signature({
    publicKey: input.publicKey,
    signature: input.descriptor.signature,
    payload: serviceDescriptorSigningBytes(input.descriptor),
  });
  return valid
    ? { ok: true }
    : { ok: false, error: "descriptor signature invalid" };
}

function buildCrossInstanceShare(input: {
  readonly alias: string;
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly descriptor: ServiceDescriptor;
  readonly descriptorDigest: Digest;
  readonly resolverUrl: string;
  readonly resolvedAt: string;
  readonly refreshPolicy: CrossInstanceRefreshPolicy;
}): CrossInstanceShare {
  const resolved = auditEvent({
    at: input.resolvedAt,
    kind: "resolved",
    detail: {
      alias: input.alias,
      resolverUrl: input.resolverUrl,
      descriptorDigest: input.descriptorDigest,
    },
  });
  const verified = auditEvent({
    at: input.resolvedAt,
    kind: "verified",
    detail: {
      contract: input.descriptor.contract,
      providerInstance: input.descriptor.providerInstance,
    },
    prevHash: resolved.hash,
  });
  return {
    id: `cross-instance-share:${input.alias}:${input.descriptorDigest}`,
    serviceId: input.serviceId,
    toDeploymentId: input.deploymentId,
    resolvedDescriptor: input.descriptor,
    resolvedAt: input.resolvedAt,
    refreshPolicy: input.refreshPolicy,
    auditTrail: [resolved, verified],
  };
}

function auditEvent(input: {
  readonly at: string;
  readonly kind: "resolved" | "verified";
  readonly detail: JsonObject;
  readonly prevHash?: Digest;
}) {
  const unsigned = {
    at: input.at,
    kind: input.kind,
    detail: input.detail,
    ...(input.prevHash ? { prevHash: input.prevHash } : {}),
  };
  return {
    ...unsigned,
    hash: digestOf(unsigned),
  };
}

function readRefreshPolicy(
  value: unknown,
): { readonly ok: true; readonly value: CrossInstanceRefreshPolicy } | {
  readonly ok: false;
  readonly error: string;
} {
  if (value === undefined) {
    return { ok: true, value: { kind: "ttl", ttl: "300s" } };
  }
  if (!isRecord(value)) return { ok: false, error: "must be an object" };
  if (value.kind === "ttl" && typeof value.ttl === "string") {
    return { ok: true, value: { kind: "ttl", ttl: value.ttl } };
  }
  if (value.kind === "event-driven") {
    const triggers = Array.isArray(value.triggers)
      ? value.triggers.filter(isRecord).map((entry) => entry as JsonObject)
      : undefined;
    return { ok: true, value: { kind: "event-driven", triggers } };
  }
  return { ok: false, error: "kind must be ttl or event-driven" };
}

function serviceDescriptorUrl(anchorUrl: string, serviceId: string): string {
  return `${anchorUrl.replace(/\/+$/, "")}/${serviceId}`;
}

async function verifyEd25519Signature(input: {
  readonly publicKey: string;
  readonly signature: string;
  readonly payload: Uint8Array;
}): Promise<boolean> {
  try {
    const publicKey = await importEd25519PublicKey(input.publicKey);
    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      toArrayBuffer(base64ToBytes(stripPrefix(input.signature, "ed25519:"))),
      toArrayBuffer(input.payload),
    );
  } catch {
    return false;
  }
}

async function importEd25519PublicKey(value: string): Promise<CryptoKey> {
  const pem = pemBody(value);
  if (pem) {
    return await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(base64ToBytes(pem)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64ToBytes(value)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

function pemBody(value: string): string | undefined {
  const match = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/
    .exec(value);
  return match?.[1]?.replace(/\s+/g, "");
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function digestOf(value: unknown): Digest {
  return `sha256:${
    createHash("sha256").update(stableStringify(value)).digest("hex")
  }`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${stableStringify(object[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function base64ToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __serviceImportResolverTestHooks = {
  bytesToBase64,
};
