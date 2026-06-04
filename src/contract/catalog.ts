import type { JsonValue } from "./types.ts";

export const OFFICIAL_MATERIAL_KIND_NAMES = [
  "http-endpoint",
  "service-binding",
  "object-store",
  "event-channel",
  "identity.oidc@v1",
  "billing.port@v1",
  "mcp-server@v1",
] as const;

export type OfficialMaterialKindName =
  typeof OFFICIAL_MATERIAL_KIND_NAMES[number];

export const OUTPUT_FIELD_TYPE_NAMES = [
  "boolean",
  "integer",
  "number",
  "object[]",
  "string",
  "string[]",
] as const;

export type OutputFieldTypeName = typeof OUTPUT_FIELD_TYPE_NAMES[number];

export const PROJECTION_FAMILY_NAMES = [
  "env",
  "secret-env",
  "upstream",
  "config-mount",
] as const;

export type ProjectionFamilyName = typeof PROJECTION_FAMILY_NAMES[number];

export const ACCESS_MODES = [
  "read",
  "read-write",
  "admin",
  "invoke-only",
  "observe-only",
] as const;

export type AccessMode = typeof ACCESS_MODES[number];

export const SAFE_DEFAULT_ACCESS_MODES = [
  null,
  "read",
  "invoke-only",
  "observe-only",
] as const;

export type SafeDefaultAccessMode = typeof SAFE_DEFAULT_ACCESS_MODES[number];

export const OFFICIAL_SENSITIVITY_CLASSES = [
  "public-config",
  "internal",
  "restricted",
  "secret-bearing",
] as const;

export type OfficialSensitivityClass =
  typeof OFFICIAL_SENSITIVITY_CLASSES[number];

export interface SecretReference {
  readonly secretRef: string;
}

export type EndpointVisibility =
  | "private"
  | "space"
  | "public"
  | "internal";

export interface HttpEndpointTarget {
  readonly name?: string;
  readonly url?: string;
  readonly protocol?: string;
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly visibility?: EndpointVisibility;
}

export interface HttpEndpointRouteSummary {
  readonly pathPrefix: string;
  readonly to: string;
}

export interface HttpEndpointPublicEndpoint {
  readonly url: string;
  readonly scheme?: string;
  readonly host?: string;
  readonly listener?: string;
  readonly visibility?: EndpointVisibility;
  readonly primary?: boolean;
  readonly routes?: readonly HttpEndpointRouteSummary[];
}

export interface HttpEndpointMaterial {
  readonly targets?: readonly HttpEndpointTarget[];
  readonly endpoints?: readonly HttpEndpointPublicEndpoint[];
}

export interface ServiceBindingMaterial {
  readonly service?: string;
  readonly protocol: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly username?: string;
  readonly connectionUrl?: string;
  readonly caCertRef?: string;
  readonly passwordRef?: SecretReference;
  readonly tokenRef?: SecretReference;
  readonly tokenRefs?: Readonly<Record<string, SecretReference>>;
}

export interface ObjectStoreMaterial {
  readonly bucket: string;
  readonly endpoint: string;
  readonly region?: string;
  readonly pathStyle?: boolean;
  readonly publicBaseUrl?: string;
  readonly policyRefs?: readonly string[];
  readonly accessKeyIdRef?: SecretReference;
  readonly secretAccessKeyRef?: SecretReference;
  readonly sessionTokenRef?: SecretReference;
}

export interface EventChannelMaterial {
  readonly channel: string;
  readonly protocol: string;
  readonly endpoint?: string;
  readonly topic?: string;
  readonly queue?: string;
  readonly stream?: string;
  readonly deliveryPolicyRefs?: readonly string[];
  readonly producerCredentialRef?: SecretReference;
  readonly consumerCredentialRef?: SecretReference;
}

export interface IdentityOidcMaterial {
  readonly issuerUrl: string;
  readonly discoveryUrl?: string;
  readonly clientId: string;
  readonly redirectOrigin?: string;
  readonly jwksRef?: string;
  readonly clientSecretRef?: SecretReference;
}

export interface BillingPortMaterial {
  readonly portalUrl?: string;
  readonly usageReportEndpoint?: string;
  readonly billingSubjectRef: string;
  readonly meteringCredentialRef?: SecretReference;
}

export interface McpServerMaterial {
  readonly endpointUrl: string;
  readonly transport: "streamable-http";
  readonly protocolVersion?: string;
  readonly serverName?: string;
  readonly description?: string;
  readonly tokenRef?: SecretReference;
}

export interface OfficialMaterialByKind {
  readonly "http-endpoint": HttpEndpointMaterial;
  readonly "service-binding": ServiceBindingMaterial;
  readonly "object-store": ObjectStoreMaterial;
  readonly "event-channel": EventChannelMaterial;
  readonly "identity.oidc@v1": IdentityOidcMaterial;
  readonly "billing.port@v1": BillingPortMaterial;
  readonly "mcp-server@v1": McpServerMaterial;
}

export type OfficialMaterial = OfficialMaterialByKind[OfficialMaterialKindName];

export interface CatalogValidationIssue {
  readonly path: string;
  readonly message: string;
}

const MATERIAL_KIND_SET = new Set<string>(OFFICIAL_MATERIAL_KIND_NAMES);
const OUTPUT_FIELD_TYPE_SET = new Set<string>(OUTPUT_FIELD_TYPE_NAMES);
const PROJECTION_FAMILY_SET = new Set<string>(PROJECTION_FAMILY_NAMES);
const ACCESS_MODE_SET = new Set<string>(ACCESS_MODES);
const OFFICIAL_SENSITIVITY_CLASS_SET = new Set<string>(
  OFFICIAL_SENSITIVITY_CLASSES,
);

export function isOfficialMaterialKindName(
  value: string,
): value is OfficialMaterialKindName {
  return MATERIAL_KIND_SET.has(value);
}

export function isOutputFieldTypeName(
  value: string,
): value is OutputFieldTypeName {
  return OUTPUT_FIELD_TYPE_SET.has(value);
}

export function isProjectionFamilyName(
  value: string,
): value is ProjectionFamilyName {
  return PROJECTION_FAMILY_SET.has(value);
}

export function isAccessMode(value: string): value is AccessMode {
  return ACCESS_MODE_SET.has(value);
}

export function isOfficialSensitivityClass(
  value: string,
): value is OfficialSensitivityClass {
  return OFFICIAL_SENSITIVITY_CLASS_SET.has(value);
}

export function isSafeDefaultAccessMode(
  value: unknown,
): value is SafeDefaultAccessMode {
  return value === null || value === "read" || value === "invoke-only" ||
    value === "observe-only";
}

export function isSecretReference(value: unknown): value is SecretReference {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { readonly secretRef?: unknown }).secretRef === "string" &&
    (value as { readonly secretRef: string }).secretRef.length > 0;
}

export function allowedProjectionFamiliesForMaterialKind(
  kind: OfficialMaterialKindName,
): readonly ProjectionFamilyName[] {
  return kind === "http-endpoint"
    ? ["upstream", "env", "config-mount"]
    : ["secret-env", "config-mount"];
}

export function isProjectionAllowedForMaterialKind(
  kind: OfficialMaterialKindName,
  projection: ProjectionFamilyName,
): boolean {
  return allowedProjectionFamiliesForMaterialKind(kind).includes(projection);
}

export function validateOfficialMaterial(
  kind: OfficialMaterialKindName,
  value: unknown,
): readonly CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ path: "$", message: "material must be an object" }];
  }
  switch (kind) {
    case "http-endpoint":
      checkNoUnknownKeys(value, "$", issues, [
        "targets",
        "endpoints",
      ]);
      checkHttpEndpointMaterial(value, issues);
      break;
    case "service-binding":
      checkNoUnknownKeys(value, "$", issues, [
        "service",
        "protocol",
        "host",
        "port",
        "database",
        "username",
        "connectionUrl",
        "caCertRef",
        "passwordRef",
        "tokenRef",
        "tokenRefs",
      ]);
      requireString(value.service, "$.service", issues, { optional: true });
      requireString(value.protocol, "$.protocol", issues);
      requireString(value.host, "$.host", issues, { optional: true });
      requirePortNumber(value.port, "$.port", issues, { optional: true });
      requireString(value.database, "$.database", issues, { optional: true });
      requireString(value.username, "$.username", issues, { optional: true });
      requireString(value.connectionUrl, "$.connectionUrl", issues, {
        optional: true,
      });
      requireAbsoluteUri(value.connectionUrl, "$.connectionUrl", issues, {
        optional: true,
      });
      requireCredentialFreeConnectionUrl(
        value.connectionUrl,
        "$.connectionUrl",
        issues,
        { optional: true },
      );
      requireString(value.caCertRef, "$.caCertRef", issues, {
        optional: true,
      });
      requireSecretReference(value.passwordRef, "$.passwordRef", issues, {
        optional: true,
      });
      requireSecretReference(value.tokenRef, "$.tokenRef", issues, {
        optional: true,
      });
      checkSecretReferenceRecord(value.tokenRefs, "$.tokenRefs", issues);
      checkServiceBindingAddress(value, issues);
      break;
    case "object-store":
      checkNoUnknownKeys(value, "$", issues, [
        "bucket",
        "endpoint",
        "region",
        "pathStyle",
        "publicBaseUrl",
        "policyRefs",
        "accessKeyIdRef",
        "secretAccessKeyRef",
        "sessionTokenRef",
      ]);
      requireString(value.bucket, "$.bucket", issues);
      requireString(value.endpoint, "$.endpoint", issues);
      requireAbsoluteUri(value.endpoint, "$.endpoint", issues);
      requireCredentialFreeUri(value.endpoint, "$.endpoint", issues);
      requireString(value.region, "$.region", issues, { optional: true });
      requireBoolean(value.pathStyle, "$.pathStyle", issues, {
        optional: true,
      });
      requireString(value.publicBaseUrl, "$.publicBaseUrl", issues, {
        optional: true,
      });
      requireHttpUrl(value.publicBaseUrl, "$.publicBaseUrl", issues, {
        optional: true,
      });
      checkStringArray(value.policyRefs, "$.policyRefs", issues);
      requireSecretReference(
        value.accessKeyIdRef,
        "$.accessKeyIdRef",
        issues,
        { optional: true },
      );
      requireSecretReference(
        value.secretAccessKeyRef,
        "$.secretAccessKeyRef",
        issues,
        { optional: true },
      );
      requireSecretReference(
        value.sessionTokenRef,
        "$.sessionTokenRef",
        issues,
        { optional: true },
      );
      checkObjectStoreCredentialRefs(value, "$", issues);
      break;
    case "event-channel":
      checkNoUnknownKeys(value, "$", issues, [
        "channel",
        "protocol",
        "endpoint",
        "topic",
        "queue",
        "stream",
        "deliveryPolicyRefs",
        "producerCredentialRef",
        "consumerCredentialRef",
      ]);
      requireString(value.channel, "$.channel", issues);
      requireString(value.protocol, "$.protocol", issues);
      requireString(value.endpoint, "$.endpoint", issues, { optional: true });
      requireAbsoluteUri(value.endpoint, "$.endpoint", issues, {
        optional: true,
      });
      requireCredentialFreeUri(value.endpoint, "$.endpoint", issues, {
        optional: true,
      });
      requireString(value.topic, "$.topic", issues, { optional: true });
      requireString(value.queue, "$.queue", issues, { optional: true });
      requireString(value.stream, "$.stream", issues, { optional: true });
      checkStringArray(
        value.deliveryPolicyRefs,
        "$.deliveryPolicyRefs",
        issues,
      );
      requireSecretReference(
        value.producerCredentialRef,
        "$.producerCredentialRef",
        issues,
        { optional: true },
      );
      requireSecretReference(
        value.consumerCredentialRef,
        "$.consumerCredentialRef",
        issues,
        { optional: true },
      );
      break;
    case "identity.oidc@v1":
      checkNoUnknownKeys(value, "$", issues, [
        "issuerUrl",
        "discoveryUrl",
        "clientId",
        "redirectOrigin",
        "jwksRef",
        "clientSecretRef",
      ]);
      requireString(value.issuerUrl, "$.issuerUrl", issues);
      requireHttpUrl(value.issuerUrl, "$.issuerUrl", issues);
      requireString(value.discoveryUrl, "$.discoveryUrl", issues, {
        optional: true,
      });
      requireHttpUrl(value.discoveryUrl, "$.discoveryUrl", issues, {
        optional: true,
      });
      requireString(value.clientId, "$.clientId", issues);
      requireString(value.redirectOrigin, "$.redirectOrigin", issues, {
        optional: true,
      });
      requireHttpUrl(value.redirectOrigin, "$.redirectOrigin", issues, {
        optional: true,
      });
      requireString(value.jwksRef, "$.jwksRef", issues, { optional: true });
      requireSecretReference(
        value.clientSecretRef,
        "$.clientSecretRef",
        issues,
        { optional: true },
      );
      break;
    case "billing.port@v1":
      checkNoUnknownKeys(value, "$", issues, [
        "portalUrl",
        "usageReportEndpoint",
        "billingSubjectRef",
        "meteringCredentialRef",
      ]);
      requireString(value.billingSubjectRef, "$.billingSubjectRef", issues);
      requireString(value.portalUrl, "$.portalUrl", issues, {
        optional: true,
      });
      requireHttpUrl(value.portalUrl, "$.portalUrl", issues, {
        optional: true,
      });
      requireString(
        value.usageReportEndpoint,
        "$.usageReportEndpoint",
        issues,
        { optional: true },
      );
      requireHttpUrl(
        value.usageReportEndpoint,
        "$.usageReportEndpoint",
        issues,
        { optional: true },
      );
      if (
        value.portalUrl === undefined && value.usageReportEndpoint === undefined
      ) {
        issues.push({
          path: "$",
          message:
            "billing.port@v1 material requires portalUrl or usageReportEndpoint",
        });
      }
      requireSecretReference(
        value.meteringCredentialRef,
        "$.meteringCredentialRef",
        issues,
        { optional: true },
      );
      break;
    case "mcp-server@v1":
      checkNoUnknownKeys(value, "$", issues, [
        "endpointUrl",
        "transport",
        "protocolVersion",
        "serverName",
        "description",
        "tokenRef",
      ]);
      requireString(value.endpointUrl, "$.endpointUrl", issues);
      requireHttpUrl(value.endpointUrl, "$.endpointUrl", issues);
      requireString(value.transport, "$.transport", issues);
      requireMcpTransport(value.transport, "$.transport", issues);
      requireString(value.protocolVersion, "$.protocolVersion", issues, {
        optional: true,
      });
      requireString(value.serverName, "$.serverName", issues, {
        optional: true,
      });
      requireString(value.description, "$.description", issues, {
        optional: true,
      });
      requireSecretReference(value.tokenRef, "$.tokenRef", issues, {
        optional: true,
      });
      break;
  }
  return issues;
}


function checkServiceBindingAddress(
  value: Record<string, unknown>,
  issues: CatalogValidationIssue[],
): void {
  const hasService = value.service !== undefined;
  const hasConnectionUrl = value.connectionUrl !== undefined;
  const hasHost = value.host !== undefined;
  const hasPort = value.port !== undefined;

  if (hasHost !== hasPort) {
    issues.push({
      path: "$",
      message: "service-binding host and port must appear together",
    });
  }
  if (!hasService && !hasConnectionUrl && !hasHost && !hasPort) {
    issues.push({
      path: "$",
      message:
        "service-binding requires service, connectionUrl, or host + port",
    });
  }
}

function checkHttpEndpointMaterial(
  value: Record<string, unknown>,
  issues: CatalogValidationIssue[],
): void {
  const targets = value.targets;
  const endpoints = value.endpoints;
  const hasTargets = Array.isArray(targets) && targets.length > 0;
  const hasEndpoints = Array.isArray(endpoints) && endpoints.length > 0;
  if (!hasTargets && !hasEndpoints) {
    issues.push({
      path: "$",
      message: "http-endpoint requires at least one target or endpoint",
    });
  }
  if (targets !== undefined) {
    if (!Array.isArray(targets)) {
      issues.push({ path: "$.targets", message: "must be an array" });
    } else {
      targets.forEach((target, index) =>
        checkHttpEndpointTarget(target, `$.targets[${index}]`, issues)
      );
    }
  }
  if (endpoints !== undefined) {
    if (!Array.isArray(endpoints)) {
      issues.push({ path: "$.endpoints", message: "must be an array" });
    } else {
      endpoints.forEach((endpoint, index) =>
        checkHttpEndpoint(endpoint, `$.endpoints[${index}]`, issues)
      );
      if (endpoints.length > 1) {
        const primaryCount = endpoints.filter((endpoint) =>
          isRecord(endpoint) && endpoint.primary === true
        ).length;
        if (primaryCount !== 1) {
          issues.push({
            path: "$.endpoints",
            message: "multiple endpoints require exactly one primary endpoint",
          });
        }
      }
    }
  }
}

function checkHttpEndpointTarget(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  checkNoUnknownKeys(value, path, issues, [
    "name",
    "url",
    "protocol",
    "host",
    "port",
    "basePath",
    "visibility",
  ]);
  requireString(value.name, `${path}.name`, issues, { optional: true });
  requireIdentifier(value.name, `${path}.name`, issues, { optional: true });
  requireString(value.url, `${path}.url`, issues, { optional: true });
  requireHttpUrl(value.url, `${path}.url`, issues, { optional: true });
  requireString(value.protocol, `${path}.protocol`, issues, {
    optional: true,
  });
  requireHttpScheme(value.protocol, `${path}.protocol`, issues, {
    optional: true,
  });
  requireString(value.host, `${path}.host`, issues, { optional: true });
  requirePortNumber(value.port, `${path}.port`, issues, { optional: true });
  requireString(value.basePath, `${path}.basePath`, issues, {
    optional: true,
  });
  requirePathPrefix(value.basePath, `${path}.basePath`, issues, {
    optional: true,
  });
  requireString(value.visibility, `${path}.visibility`, issues, {
    optional: true,
  });
  requireEndpointVisibility(
    value.visibility,
    `${path}.visibility`,
    issues,
    { optional: true },
  );
  const hasUrl = typeof value.url === "string" && value.url.length > 0;
  const hasHostField = value.host !== undefined;
  const hasPortField = value.port !== undefined;
  const hasHostPort = typeof value.host === "string" &&
    value.host.length > 0 && typeof value.port === "number";
  if (!hasUrl && !hasHostPort) {
    issues.push({
      path,
      message: "target requires url or host + port",
    });
  }
  if (hasUrl && hasHostField !== hasPortField) {
    issues.push({
      path,
      message: "target host and port must appear together",
    });
  }
  if (
    (value.protocol !== undefined || value.basePath !== undefined) &&
    !hasHostPort
  ) {
    issues.push({
      path,
      message: "target protocol/basePath requires host + port",
    });
  }
}

function checkHttpEndpoint(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  checkNoUnknownKeys(value, path, issues, [
    "url",
    "scheme",
    "host",
    "listener",
    "visibility",
    "primary",
    "routes",
  ]);
  requireString(value.url, `${path}.url`, issues);
  requireHttpUrl(value.url, `${path}.url`, issues);
  requireString(value.scheme, `${path}.scheme`, issues, { optional: true });
  requireHttpScheme(value.scheme, `${path}.scheme`, issues, {
    optional: true,
  });
  requireString(value.host, `${path}.host`, issues, { optional: true });
  requireString(value.listener, `${path}.listener`, issues, {
    optional: true,
  });
  requireIdentifier(value.listener, `${path}.listener`, issues, {
    optional: true,
  });
  requireString(value.visibility, `${path}.visibility`, issues, {
    optional: true,
  });
  requireEndpointVisibility(
    value.visibility,
    `${path}.visibility`,
    issues,
    { optional: true },
  );
  requireBoolean(value.primary, `${path}.primary`, issues, { optional: true });
  crossCheckHttpEndpointUrl(value, path, issues);
  if (value.routes !== undefined) {
    if (!Array.isArray(value.routes)) {
      issues.push({ path: `${path}.routes`, message: "must be an array" });
    } else {
      value.routes.forEach((route, index) =>
        checkRouteSummary(route, `${path}.routes[${index}]`, issues)
      );
    }
  }
}

function checkRouteSummary(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  checkNoUnknownKeys(value, path, issues, ["pathPrefix", "to"]);
  requireString(value.pathPrefix, `${path}.pathPrefix`, issues);
  requirePathPrefix(value.pathPrefix, `${path}.pathPrefix`, issues);
  requireString(value.to, `${path}.to`, issues);
  requireIdentifier(value.to, `${path}.to`, issues);
}

function checkNoUnknownKeys(
  value: Record<string, unknown>,
  path: string,
  issues: CatalogValidationIssue[],
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issues.push({ path: `${path}.${key}`, message: "unknown field" });
    }
  }
}

function requireString(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
  }
}

function requirePortNumber(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "must be a finite number" });
    return;
  }
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    issues.push({ path, message: "must be an integer port from 1 to 65535" });
  }
}

function requireBoolean(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "boolean") {
    issues.push({ path, message: "must be a boolean" });
  }
}

function requireSecretReference(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be a secretRef object" });
    return;
  }
  checkNoUnknownKeys(value, path, issues, ["secretRef"]);
  requireString(value.secretRef, `${path}.secretRef`, issues);
}

function requireHttpUrl(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string") return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push({ path, message: "must be an absolute http(s) URL" });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    issues.push({ path, message: "must use http or https" });
  }
  requireNoUrlUserinfo(url, path, issues);
}

function requireCredentialFreeUri(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string") return;
  try {
    requireNoUrlUserinfo(new URL(value), path, issues);
  } catch {
    return;
  }
}

function requireCredentialFreeConnectionUrl(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string") return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.password.length > 0) {
    issues.push({
      path,
      message: "must not include an embedded password",
    });
  }
}

function requireNoUrlUserinfo(
  url: URL,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (url.username.length > 0 || url.password.length > 0) {
    issues.push({
      path,
      message: "must not contain embedded credentials",
    });
  }
}

function requireAbsoluteUri(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string") return;
  try {
    new URL(value);
  } catch {
    issues.push({ path, message: "must be an absolute URI" });
  }
}

function requireHttpScheme(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string") return;
  if (value !== "http" && value !== "https") {
    issues.push({ path, message: 'must be "http" or "https"' });
  }
}

function requireMcpTransport(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string") return;
  if (value !== "streamable-http") {
    issues.push({ path, message: 'must be "streamable-http"' });
  }
}

function crossCheckHttpEndpointUrl(
  value: Record<string, unknown>,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (typeof value.url !== "string") return;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return;
  }
  if (typeof value.scheme === "string") {
    const scheme = url.protocol.replace(/:$/, "");
    if (value.scheme !== scheme) {
      issues.push({
        path: `${path}.scheme`,
        message: "must match the scheme in url",
      });
    }
  }
  if (typeof value.host === "string" && value.host.length > 0) {
    if (value.host !== url.hostname) {
      issues.push({
        path: `${path}.host`,
        message: "must match the host in url",
      });
    }
  }
}

function requireEndpointVisibility(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string") return;
  if (
    value !== "private" && value !== "space" && value !== "public" &&
    value !== "internal"
  ) {
    issues.push({
      path,
      message: 'must be "private", "space", "public", or "internal"',
    });
  }
}

function requirePathPrefix(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string") return;
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    issues.push({
      path,
      message: 'must start with "/" and must not contain "?" or "#"',
    });
  }
}

function requireIdentifier(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  opts: { readonly optional?: boolean } = {},
): void {
  if (value === undefined && opts.optional) return;
  if (typeof value !== "string") return;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    issues.push({
      path,
      message:
        "must start with an ASCII letter or digit and contain only ASCII letters, digits, _, ., or -",
    });
  }
}

function checkStringArray(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array of strings" });
    return;
  }
  value.forEach((entry, index) =>
    requireString(entry, `${path}[${index}]`, issues)
  );
}

function checkSecretReferenceRecord(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object of secretRef values" });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    requireIdentifier(key, `${path}.${key}`, issues);
    requireSecretReference(entry, `${path}.${key}`, issues);
  }
}

function checkObjectStoreCredentialRefs(
  value: Record<string, unknown>,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  const hasAccessKey = value.accessKeyIdRef !== undefined;
  const hasSecretKey = value.secretAccessKeyRef !== undefined;
  const hasSessionToken = value.sessionTokenRef !== undefined;
  if (hasAccessKey !== hasSecretKey) {
    issues.push({
      path,
      message:
        "object-store credential refs require accessKeyIdRef and secretAccessKeyRef together",
    });
  }
  if (hasSessionToken && !(hasAccessKey && hasSecretKey)) {
    issues.push({
      path: `${path}.sessionTokenRef`,
      message: "sessionTokenRef requires accessKeyIdRef and secretAccessKeyRef",
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type JsonMaterialRecord = Readonly<
  Record<string, JsonValue | SecretReference>
>;
