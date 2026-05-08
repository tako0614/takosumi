import type { JsonObject, JsonValue } from "./types.ts";

/**
 * Pinned envelope identifier for every Takosumi manifest. The `apiVersion`
 * and `kind` fields are required from 0.13 onward — operators that omit
 * them are rejected at the deploy public route. The version is bumped when
 * a future manifest schema breaks compatibility (additive shape /
 * provider / template changes do NOT bump it).
 */
export const MANIFEST_API_VERSION = "1.0" as const;
export const MANIFEST_KIND = "Manifest" as const;
export const TAKOSUMI_MANIFEST_JSONLD_CONTEXT =
  "https://takosumi.com/contexts/manifest-v1.jsonld" as const;

export type ManifestJsonLdContext =
  | string
  | JsonObject
  | readonly (string | JsonObject)[];

export interface ManifestMetadata {
  readonly name?: string;
  readonly labels?: { readonly [key: string]: string };
  readonly takosumiServiceImports?: ManifestServiceImportPinsMetadata;
}

export interface ManifestServiceImportPinsMetadata {
  readonly kind: "takosumi.service-import-pins@v1";
  readonly pins: readonly ManifestServiceImportPin[];
}

export interface ManifestServiceImportPin {
  readonly alias: string;
  readonly serviceId: string;
  readonly descriptorDigest: string;
  readonly resolverUrl: string;
  readonly providerInstance: string;
  readonly expiresAt: string;
}

export interface ManifestRefreshPolicy {
  readonly kind: "ttl" | "event-driven";
  readonly ttl?: string;
  readonly triggers?: readonly JsonValue[];
}

export interface ManifestServiceEndpoint {
  readonly role: string;
  readonly url: string;
  readonly path: string;
}

export interface ManifestServicePublication {
  readonly anchors: readonly string[];
  readonly signing: {
    readonly privateKeyRef: string;
  };
}

export interface ManifestService {
  readonly id: string;
  readonly version: string;
  readonly contract: string;
  readonly endpoints: readonly ManifestServiceEndpoint[];
  readonly metadata?: JsonObject;
  readonly publish: ManifestServicePublication;
}

export interface ManifestImport {
  readonly alias: string;
  readonly service: string;
  readonly refreshPolicy?: ManifestRefreshPolicy;
}

export interface ManifestServiceResolver {
  readonly kind: "anchor";
  readonly url: string;
  readonly publicKey: string;
}

/**
 * Top-level shape of a Takosumi manifest. The wire representation is YAML
 * or JSON; the envelope must pin `apiVersion` and `kind` so the kernel can
 * route future schema versions to compatible validators.
 */
export interface Manifest {
  readonly "@context"?: ManifestJsonLdContext;
  readonly apiVersion: typeof MANIFEST_API_VERSION;
  readonly kind: typeof MANIFEST_KIND;
  readonly namespace?: string;
  readonly metadata?: ManifestMetadata;
  readonly template?: ManifestTemplateInvocation;
  readonly services?: readonly ManifestService[];
  readonly imports?: readonly ManifestImport[];
  readonly serviceResolvers?: readonly ManifestServiceResolver[];
  readonly resources?: readonly ManifestResource[];
}

export interface ManifestEnvelopeIssue {
  readonly path: string;
  readonly message: string;
}

export interface ManifestEnvelopeValidationOptions {
  /**
   * CLI local compatibility for the friendlier shorthand
   * `template: { name: "id" }`. Canonical remote manifests must use
   * `template.template: "id@version"`.
   */
  readonly allowTemplateName?: boolean;
  /**
   * Backward compatibility for early v1 public deploy clients that used
   * `template.ref` as the pinned template reference.
   */
  readonly allowLegacyTemplateRef?: boolean;
}

/**
 * Validate the top-level apiVersion / kind of a manifest body. Returns
 * issues (empty == valid). Designed to run BEFORE template expansion or
 * resource resolution so misversioned manifests fail fast with an actionable
 * error.
 */
export function validateManifestEnvelope(
  body: unknown,
  issues: ManifestEnvelopeIssue[],
  options: ManifestEnvelopeValidationOptions = {},
): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    issues.push({ path: "$", message: "manifest must be a JSON object" });
    return;
  }
  const m = body as Record<string, unknown>;
  pushUnknownKeys("$", m, [
    "@context",
    "apiVersion",
    "kind",
    "namespace",
    "metadata",
    "template",
    "services",
    "imports",
    "serviceResolvers",
    "resources",
  ], issues);
  validateManifestJsonLdContext(m["@context"], issues);
  if (m.apiVersion !== MANIFEST_API_VERSION) {
    issues.push({
      path: "$.apiVersion",
      message: `apiVersion must be "${MANIFEST_API_VERSION}" ` +
        `(got: ${JSON.stringify(m.apiVersion)})`,
    });
  }
  if (m.kind !== MANIFEST_KIND) {
    issues.push({
      path: "$.kind",
      message: `kind must be "${MANIFEST_KIND}" ` +
        `(got: ${JSON.stringify(m.kind)})`,
    });
  }
  validateManifestNamespace(m.namespace, m.services, issues);
  validateManifestMetadata(m.metadata, issues);
  validateManifestTemplateInvocation(m.template, issues, options);
  validateManifestServices(m.services, m.namespace, issues);
  validateManifestImports(m.imports, m.serviceResolvers, issues);
  validateManifestServiceResolvers(m.serviceResolvers, issues);
  validateManifestResources(m.resources, issues);
}

function validateManifestJsonLdContext(
  context: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (context === undefined) return;
  if (isNonEmptyString(context)) return;
  if (isRecord(context) && isJsonValue(context)) return;
  if (Array.isArray(context) && context.length > 0) {
    const invalidIndex = context.findIndex((entry) =>
      !(isNonEmptyString(entry) || (isRecord(entry) && isJsonValue(entry)))
    );
    if (invalidIndex < 0) return;
    issues.push({
      path: `$["@context"][${invalidIndex}]`,
      message:
        "@context entries must be non-empty strings or JSON-LD context objects",
    });
    return;
  }
  issues.push({
    path: `$["@context"]`,
    message:
      "@context must be a non-empty string, JSON-LD context object, or non-empty array of those values",
  });
}

export interface ManifestResource {
  readonly shape: string;
  readonly name: string;
  readonly provider: string;
  readonly spec: JsonValue;
  readonly requires?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ManifestTemplateInvocation {
  readonly template: string;
  readonly inputs?: JsonObject;
}

const serviceNamePattern =
  /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const serviceIdentifierPattern =
  /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*@v\d+(?:-[a-z][a-z0-9-]*)?$/;
const serviceVersionPattern = /^v\d+(?:-[a-z][a-z0-9-]*)?$/;
const aliasPattern = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;
const endpointRolePattern = /^[a-z][a-z0-9-]*$/;
const ttlDurationPattern = /^\d+[smhd]$/;
const pathPattern = /^\/[^?#]*$/;

function validateManifestNamespace(
  namespace: unknown,
  services: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (namespace !== undefined && !isNonEmptyString(namespace)) {
    issues.push({
      path: "$.namespace",
      message: "namespace must be a non-empty string",
    });
  }
  if (
    namespace === undefined &&
    Array.isArray(services) &&
    services.length > 0
  ) {
    issues.push({
      path: "$.namespace",
      message: "namespace is required when services are exported",
    });
  }
}

function validateManifestMetadata(
  metadata: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (metadata === undefined) return;
  if (!isRecord(metadata)) {
    issues.push({
      path: "$.metadata",
      message: "metadata must be a JSON object",
    });
    return;
  }
  pushUnknownKeys("$.metadata", metadata, [
    "name",
    "labels",
    "takosumiServiceImports",
  ], issues);
  if (metadata.name !== undefined && !isNonEmptyString(metadata.name)) {
    issues.push({
      path: "$.metadata.name",
      message: "metadata.name must be a non-empty string",
    });
  }
  if (metadata.labels !== undefined) {
    validateStringMap("$.metadata.labels", metadata.labels, issues);
  }
  validateManifestServiceImportPinsMetadata(
    metadata.takosumiServiceImports,
    "$.metadata.takosumiServiceImports",
    issues,
  );
}

function validateManifestServiceImportPinsMetadata(
  value: unknown,
  path: string,
  issues: ManifestEnvelopeIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, message: "takosumiServiceImports must be an object" });
    return;
  }
  pushUnknownKeys(path, value, ["kind", "pins"], issues);
  if (value.kind !== "takosumi.service-import-pins@v1") {
    issues.push({
      path: `${path}.kind`,
      message: "kind must be takosumi.service-import-pins@v1",
    });
  }
  if (!Array.isArray(value.pins)) {
    issues.push({ path: `${path}.pins`, message: "pins must be an array" });
    return;
  }
  value.pins.forEach((pin, index) => {
    const pinPath = `${path}.pins[${index}]`;
    if (!isRecord(pin)) {
      issues.push({ path: pinPath, message: "pin must be a JSON object" });
      return;
    }
    pushUnknownKeys(pinPath, pin, [
      "alias",
      "serviceId",
      "descriptorDigest",
      "resolverUrl",
      "providerInstance",
      "expiresAt",
    ], issues);
    if (!isNonEmptyString(pin.alias) || !aliasPattern.test(pin.alias)) {
      issues.push({
        path: `${pinPath}.alias`,
        message: "alias must match binding name syntax",
      });
    }
    if (
      !isNonEmptyString(pin.serviceId) ||
      !serviceIdentifierPattern.test(pin.serviceId)
    ) {
      issues.push({
        path: `${pinPath}.serviceId`,
        message: "serviceId must be a service identifier",
      });
    }
    if (
      !isNonEmptyString(pin.descriptorDigest) ||
      !pin.descriptorDigest.startsWith("sha256:")
    ) {
      issues.push({
        path: `${pinPath}.descriptorDigest`,
        message: "descriptorDigest must be a sha256 digest",
      });
    }
    if (!isHttpUrl(pin.resolverUrl)) {
      issues.push({
        path: `${pinPath}.resolverUrl`,
        message: "resolverUrl must be an http or https URL",
      });
    }
    if (!isNonEmptyString(pin.providerInstance)) {
      issues.push({
        path: `${pinPath}.providerInstance`,
        message: "providerInstance must be a non-empty string",
      });
    }
    if (
      !isNonEmptyString(pin.expiresAt) ||
      !Number.isFinite(Date.parse(pin.expiresAt))
    ) {
      issues.push({
        path: `${pinPath}.expiresAt`,
        message: "expiresAt must be a timestamp",
      });
    }
  });
}

function validateManifestServices(
  services: unknown,
  namespace: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (services === undefined) return;
  if (!Array.isArray(services)) {
    issues.push({ path: "$.services", message: "services must be an array" });
    return;
  }
  const seenContracts = new Set<string>();
  services.forEach((service, index) => {
    const path = `$.services[${index}]`;
    if (!isRecord(service)) {
      issues.push({ path, message: "service must be a JSON object" });
      return;
    }
    pushUnknownKeys(path, service, [
      "id",
      "version",
      "contract",
      "endpoints",
      "metadata",
      "publish",
    ], issues);
    if (!isNonEmptyString(service.id) || !serviceNamePattern.test(service.id)) {
      issues.push({
        path: `${path}.id`,
        message: "id must be a forward 3-level dotted service name",
      });
    } else if (
      typeof namespace === "string" &&
      service.id.split(".")[0] !== namespace
    ) {
      issues.push({
        path: `${path}.id`,
        message: "id must use the manifest namespace prefix",
      });
    }
    if (
      !isNonEmptyString(service.version) ||
      !serviceVersionPattern.test(service.version)
    ) {
      issues.push({
        path: `${path}.version`,
        message: "version must be v<major> or v<major>-<label>",
      });
    }
    if (
      !isNonEmptyString(service.contract) ||
      !serviceIdentifierPattern.test(service.contract)
    ) {
      issues.push({
        path: `${path}.contract`,
        message: "contract must be a service identifier",
      });
    } else {
      if (seenContracts.has(service.contract)) {
        issues.push({
          path: `${path}.contract`,
          message: "contract must be unique",
        });
      }
      seenContracts.add(service.contract);
    }
    if (
      isNonEmptyString(service.id) &&
      isNonEmptyString(service.version) &&
      isNonEmptyString(service.contract) &&
      service.contract !== `${service.id}@${service.version}`
    ) {
      issues.push({
        path: `${path}.contract`,
        message: "contract must equal <id>@<version>",
      });
    }
    validateManifestServiceEndpoints(
      service.endpoints,
      `${path}.endpoints`,
      issues,
    );
    if (service.metadata !== undefined && !isRecord(service.metadata)) {
      issues.push({
        path: `${path}.metadata`,
        message: "metadata must be a JSON object",
      });
    } else if (isRecord(service.metadata) && !isJsonValue(service.metadata)) {
      issues.push({
        path: `${path}.metadata`,
        message: "metadata must be JSON-compatible",
      });
    }
    validateManifestServicePublish(service.publish, `${path}.publish`, issues);
  });
}

function validateManifestServiceEndpoints(
  endpoints: unknown,
  path: string,
  issues: ManifestEnvelopeIssue[],
): void {
  if (!Array.isArray(endpoints) || endpoints.length < 1) {
    issues.push({
      path,
      message: "endpoints must be a non-empty array",
    });
    return;
  }
  const seenRoles = new Set<string>();
  endpoints.forEach((endpoint, index) => {
    const endpointPath = `${path}[${index}]`;
    if (!isRecord(endpoint)) {
      issues.push({
        path: endpointPath,
        message: "endpoint must be a JSON object",
      });
      return;
    }
    pushUnknownKeys(endpointPath, endpoint, ["role", "url", "path"], issues);
    if (
      !isNonEmptyString(endpoint.role) ||
      !endpointRolePattern.test(endpoint.role)
    ) {
      issues.push({
        path: `${endpointPath}.role`,
        message: "role must be an endpoint role identifier",
      });
    } else {
      if (seenRoles.has(endpoint.role)) {
        issues.push({
          path: `${endpointPath}.role`,
          message: "role must be unique",
        });
      }
      seenRoles.add(endpoint.role);
    }
    if (!isNonEmptyString(endpoint.url)) {
      issues.push({
        path: `${endpointPath}.url`,
        message: "url must be a non-empty string",
      });
    }
    if (!isNonEmptyString(endpoint.path) || !pathPattern.test(endpoint.path)) {
      issues.push({
        path: `${endpointPath}.path`,
        message: "path must be a slash-prefixed path",
      });
    }
  });
}

function validateManifestServicePublish(
  publish: unknown,
  path: string,
  issues: ManifestEnvelopeIssue[],
): void {
  if (!isRecord(publish)) {
    issues.push({ path, message: "publish must be a JSON object" });
    return;
  }
  pushUnknownKeys(path, publish, ["anchors", "signing"], issues);
  if (
    !Array.isArray(publish.anchors) ||
    publish.anchors.length < 1 ||
    publish.anchors.some((anchor) => !isNonEmptyString(anchor))
  ) {
    issues.push({
      path: `${path}.anchors`,
      message: "anchors must be a non-empty string array",
    });
  }
  if (!isRecord(publish.signing)) {
    issues.push({
      path: `${path}.signing`,
      message: "signing must be a JSON object",
    });
    return;
  }
  pushUnknownKeys(
    `${path}.signing`,
    publish.signing,
    ["privateKeyRef"],
    issues,
  );
  if (!isNonEmptyString(publish.signing.privateKeyRef)) {
    issues.push({
      path: `${path}.signing.privateKeyRef`,
      message: "privateKeyRef must be a non-empty string",
    });
  }
}

function validateManifestImports(
  imports: unknown,
  serviceResolvers: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (imports === undefined) return;
  if (!Array.isArray(imports)) {
    issues.push({ path: "$.imports", message: "imports must be an array" });
    return;
  }
  if (
    imports.length > 0 &&
    (!Array.isArray(serviceResolvers) || serviceResolvers.length < 1)
  ) {
    issues.push({
      path: "$.serviceResolvers",
      message: "serviceResolvers is required when imports are declared",
    });
  }
  const seenAliases = new Set<string>();
  imports.forEach((entry, index) => {
    const path = `$.imports[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path, message: "import must be a JSON object" });
      return;
    }
    pushUnknownKeys(path, entry, ["alias", "service", "refreshPolicy"], issues);
    if (!isNonEmptyString(entry.alias) || !aliasPattern.test(entry.alias)) {
      issues.push({
        path: `${path}.alias`,
        message: "alias must match binding name syntax",
      });
    } else {
      if (seenAliases.has(entry.alias)) {
        issues.push({
          path: `${path}.alias`,
          message: "alias must be unique",
        });
      }
      seenAliases.add(entry.alias);
    }
    if (
      !isNonEmptyString(entry.service) ||
      !serviceIdentifierPattern.test(entry.service)
    ) {
      issues.push({
        path: `${path}.service`,
        message: "service must be a service identifier",
      });
    }
    validateManifestRefreshPolicy(
      entry.refreshPolicy,
      `${path}.refreshPolicy`,
      issues,
    );
  });
}

function validateManifestServiceResolvers(
  serviceResolvers: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (serviceResolvers === undefined) return;
  if (!Array.isArray(serviceResolvers)) {
    issues.push({
      path: "$.serviceResolvers",
      message: "serviceResolvers must be an array",
    });
    return;
  }
  serviceResolvers.forEach((resolver, index) => {
    const path = `$.serviceResolvers[${index}]`;
    if (!isRecord(resolver)) {
      issues.push({ path, message: "service resolver must be a JSON object" });
      return;
    }
    pushUnknownKeys(path, resolver, ["kind", "url", "publicKey"], issues);
    if (resolver.kind !== "anchor") {
      issues.push({
        path: `${path}.kind`,
        message: "kind must be anchor",
      });
    }
    if (!isHttpUrl(resolver.url)) {
      issues.push({
        path: `${path}.url`,
        message: "url must be an http or https URL",
      });
    }
    if (!isNonEmptyString(resolver.publicKey)) {
      issues.push({
        path: `${path}.publicKey`,
        message: "publicKey must be a non-empty string",
      });
    }
  });
}

function validateManifestRefreshPolicy(
  refreshPolicy: unknown,
  path: string,
  issues: ManifestEnvelopeIssue[],
): void {
  if (refreshPolicy === undefined) return;
  if (!isRecord(refreshPolicy)) {
    issues.push({ path, message: "refreshPolicy must be a JSON object" });
    return;
  }
  pushUnknownKeys(path, refreshPolicy, ["kind", "ttl", "triggers"], issues);
  if (refreshPolicy.kind === "ttl") {
    if (
      typeof refreshPolicy.ttl !== "string" ||
      !ttlDurationPattern.test(refreshPolicy.ttl)
    ) {
      issues.push({
        path: `${path}.ttl`,
        message: "ttl must be a duration such as 300s or 1h",
      });
    }
    return;
  }
  if (refreshPolicy.kind === "event-driven") {
    if (
      refreshPolicy.triggers !== undefined &&
      (!Array.isArray(refreshPolicy.triggers) ||
        !isJsonValue(refreshPolicy.triggers))
    ) {
      issues.push({
        path: `${path}.triggers`,
        message: "triggers must be a JSON-compatible array",
      });
    }
    return;
  }
  issues.push({
    path: `${path}.kind`,
    message: "kind must be ttl or event-driven",
  });
}

function validateManifestTemplateInvocation(
  template: unknown,
  issues: ManifestEnvelopeIssue[],
  options: ManifestEnvelopeValidationOptions,
): void {
  if (template === undefined) return;
  if (!isRecord(template)) {
    issues.push({
      path: "$.template",
      message: "template must be a JSON object",
    });
    return;
  }

  const allowed = ["template", "inputs"];
  if (options.allowLegacyTemplateRef !== false) allowed.push("ref");
  if (options.allowTemplateName === true) allowed.push("name");
  pushUnknownKeys("$.template", template, allowed, issues);

  for (const key of ["template", "ref", "name"]) {
    if (
      template[key] !== undefined &&
      !isNonEmptyString(template[key])
    ) {
      issues.push({
        path: `$.template.${key}`,
        message: `template.${key} must be a non-empty string`,
      });
    }
  }
  if (template.inputs !== undefined && !isRecord(template.inputs)) {
    issues.push({
      path: "$.template.inputs",
      message: "template.inputs must be a JSON object",
    });
  }
}

function validateManifestResources(
  resources: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (resources === undefined) return;
  if (!Array.isArray(resources)) {
    issues.push({
      path: "$.resources",
      message: "resources must be an array",
    });
    return;
  }
  resources.forEach((resource, index) => {
    const path = `$.resources[${index}]`;
    if (!isRecord(resource)) {
      issues.push({ path, message: "resource must be a JSON object" });
      return;
    }
    pushUnknownKeys(path, resource, [
      "shape",
      "name",
      "provider",
      "spec",
      "requires",
      "metadata",
    ], issues);
    for (const key of ["shape", "name", "provider"]) {
      if (!isNonEmptyString(resource[key])) {
        issues.push({
          path: `${path}.${key}`,
          message: `${key} must be a non-empty string`,
        });
      }
    }
    if (resource.spec === undefined) {
      issues.push({ path: `${path}.spec`, message: "spec is required" });
    } else if (!isJsonValue(resource.spec)) {
      issues.push({
        path: `${path}.spec`,
        message: "spec must be JSON-compatible",
      });
    }
    if (resource.requires !== undefined) {
      if (!Array.isArray(resource.requires)) {
        issues.push({
          path: `${path}.requires`,
          message: "requires must be an array of non-empty strings",
        });
      } else {
        resource.requires.forEach((required, requiredIndex) => {
          if (!isNonEmptyString(required)) {
            issues.push({
              path: `${path}.requires[${requiredIndex}]`,
              message: "requires entries must be non-empty strings",
            });
          }
        });
      }
    }
    if (resource.metadata !== undefined && !isRecord(resource.metadata)) {
      issues.push({
        path: `${path}.metadata`,
        message: "metadata must be a JSON object",
      });
    }
  });
}

function pushUnknownKeys(
  path: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  issues: ManifestEnvelopeIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: `${key} is not a known field`,
      });
    }
  }
}

function validateStringMap(
  path: string,
  value: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be a JSON object of strings" });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      issues.push({
        path: `${path}.${key}`,
        message: "must be a string",
      });
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null || typeof value === "string" ||
    typeof value === "number" || typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

export type ResolvedRefKind = "ref" | "secret-ref";

export interface ResolvedRef {
  readonly kind: ResolvedRefKind;
  readonly source: string;
  readonly field: string;
}

const REF_NAME = "[A-Za-z_][\\w-]*";
const REF_FULL_PATTERN = new RegExp(
  `^\\$\\{(ref|secret-ref):(${REF_NAME})\\.(${REF_NAME})\\}$`,
);
const REF_GLOBAL_PATTERN = new RegExp(
  `\\$\\{(ref|secret-ref):(${REF_NAME})\\.(${REF_NAME})\\}`,
  "g",
);

export function parseRef(expression: string): ResolvedRef | undefined {
  const match = REF_FULL_PATTERN.exec(expression);
  if (!match) return undefined;
  return {
    kind: match[1] === "secret-ref" ? "secret-ref" : "ref",
    source: match[2],
    field: match[3],
  };
}

export function extractRefs(value: string): readonly ResolvedRef[] {
  const refs: ResolvedRef[] = [];
  let match: RegExpExecArray | null;
  REF_GLOBAL_PATTERN.lastIndex = 0;
  while ((match = REF_GLOBAL_PATTERN.exec(value)) !== null) {
    refs.push({
      kind: match[1] === "secret-ref" ? "secret-ref" : "ref",
      source: match[2],
      field: match[3],
    });
  }
  return refs;
}

export function extractRefsFromValue(value: JsonValue): readonly ResolvedRef[] {
  const refs: ResolvedRef[] = [];
  walkValue(value, refs);
  return refs;
}

function walkValue(value: JsonValue, refs: ResolvedRef[]): void {
  if (typeof value === "string") {
    for (const ref of extractRefs(value)) refs.push(ref);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walkValue(entry, refs);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) walkValue(entry, refs);
  }
}
