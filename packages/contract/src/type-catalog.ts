import type { JsonValue } from "./types.ts";

export const OFFICIAL_OUTPUT_TYPE_NAMES = [
  "http-endpoint",
  "service-binding",
  "object-store",
  "event-channel",
  "identity.oidc@v1",
  "billing.port@v1",
] as const;

export type OfficialOutputTypeName = typeof OFFICIAL_OUTPUT_TYPE_NAMES[number];

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
  readonly host: string;
  readonly port: number;
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

export interface OfficialOutputMaterialByType {
  readonly "http-endpoint": HttpEndpointMaterial;
  readonly "service-binding": ServiceBindingMaterial;
  readonly "object-store": ObjectStoreMaterial;
  readonly "event-channel": EventChannelMaterial;
  readonly "identity.oidc@v1": IdentityOidcMaterial;
  readonly "billing.port@v1": BillingPortMaterial;
}

export type OfficialOutputMaterial =
  OfficialOutputMaterialByType[OfficialOutputTypeName];

export interface CatalogValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface OutputFieldTypeDefinition {
  readonly name: string;
  readonly type: string;
  readonly required?: boolean;
}

const OUTPUT_TYPE_SET = new Set<string>(OFFICIAL_OUTPUT_TYPE_NAMES);
const PROJECTION_FAMILY_SET = new Set<string>(PROJECTION_FAMILY_NAMES);
const ACCESS_MODE_SET = new Set<string>(ACCESS_MODES);
const OFFICIAL_SENSITIVITY_CLASS_SET = new Set<string>(
  OFFICIAL_SENSITIVITY_CLASSES,
);

export function isOfficialOutputTypeName(
  value: string,
): value is OfficialOutputTypeName {
  return OUTPUT_TYPE_SET.has(value);
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
    typeof (value as { readonly secretRef?: unknown }).secretRef === "string" &&
    (value as { readonly secretRef: string }).secretRef.length > 0;
}

export function allowedProjectionFamiliesForOutputType(
  type: OfficialOutputTypeName,
): readonly ProjectionFamilyName[] {
  return type === "http-endpoint"
    ? ["upstream", "env", "config-mount"]
    : ["secret-env", "config-mount"];
}

export function isProjectionAllowedForOutputType(
  type: OfficialOutputTypeName,
  projection: ProjectionFamilyName,
): boolean {
  return allowedProjectionFamiliesForOutputType(type).includes(projection);
}

export function validateOfficialOutputMaterial(
  type: OfficialOutputTypeName,
  value: unknown,
): readonly CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ path: "$", message: "material must be an object" }];
  }
  switch (type) {
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
      requireString(value.host, "$.host", issues);
      requirePortNumber(value.port, "$.port", issues);
      requireString(value.database, "$.database", issues, { optional: true });
      requireString(value.username, "$.username", issues, { optional: true });
      requireString(value.connectionUrl, "$.connectionUrl", issues, {
        optional: true,
      });
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
  }
  return issues;
}

export function validateOfficialOutputMaterialMapping(
  type: OfficialOutputTypeName,
  value: unknown,
): readonly CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ path: "$", message: "mapping must be an object" }];
  }
  switch (type) {
    case "http-endpoint":
      checkNoUnknownKeys(value, "$", issues, ["targets", "endpoints"]);
      checkHttpEndpointMaterialMapping(value, issues);
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
      requireStringMappingValue(value.protocol, "$.protocol", issues);
      requireStringMappingValue(value.host, "$.host", issues);
      requirePortNumberMappingValue(value.port, "$.port", issues);
      checkOptionalStringMappingValue(value.service, "$.service", issues);
      checkOptionalStringMappingValue(value.database, "$.database", issues);
      checkOptionalStringMappingValue(value.username, "$.username", issues);
      checkOptionalStringMappingValue(
        value.connectionUrl,
        "$.connectionUrl",
        issues,
      );
      checkOptionalStringMappingValue(value.caCertRef, "$.caCertRef", issues);
      checkOptionalSecretReferenceMapping(
        value.passwordRef,
        "$.passwordRef",
        issues,
      );
      checkOptionalSecretReferenceMapping(value.tokenRef, "$.tokenRef", issues);
      checkSecretReferenceRecordMapping(value.tokenRefs, "$.tokenRefs", issues);
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
      requireStringMappingValue(value.bucket, "$.bucket", issues);
      requireAbsoluteUriMappingValue(value.endpoint, "$.endpoint", issues);
      checkOptionalStringMappingValue(value.region, "$.region", issues);
      checkOptionalBooleanMappingValue(
        value.pathStyle,
        "$.pathStyle",
        issues,
      );
      checkOptionalHttpUrlMappingValue(
        value.publicBaseUrl,
        "$.publicBaseUrl",
        issues,
      );
      checkOptionalStringMappingArray(
        value.policyRefs,
        "$.policyRefs",
        issues,
      );
      checkOptionalSecretReferenceMapping(
        value.accessKeyIdRef,
        "$.accessKeyIdRef",
        issues,
      );
      checkOptionalSecretReferenceMapping(
        value.secretAccessKeyRef,
        "$.secretAccessKeyRef",
        issues,
      );
      checkOptionalSecretReferenceMapping(
        value.sessionTokenRef,
        "$.sessionTokenRef",
        issues,
      );
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
      requireStringMappingValue(value.channel, "$.channel", issues);
      requireStringMappingValue(value.protocol, "$.protocol", issues);
      checkOptionalStringMappingValue(value.endpoint, "$.endpoint", issues);
      checkOptionalStringMappingValue(value.topic, "$.topic", issues);
      checkOptionalStringMappingValue(value.queue, "$.queue", issues);
      checkOptionalStringMappingValue(value.stream, "$.stream", issues);
      checkOptionalStringMappingArray(
        value.deliveryPolicyRefs,
        "$.deliveryPolicyRefs",
        issues,
      );
      checkOptionalSecretReferenceMapping(
        value.producerCredentialRef,
        "$.producerCredentialRef",
        issues,
      );
      checkOptionalSecretReferenceMapping(
        value.consumerCredentialRef,
        "$.consumerCredentialRef",
        issues,
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
      requireHttpUrlMappingValue(value.issuerUrl, "$.issuerUrl", issues);
      requireStringMappingValue(value.clientId, "$.clientId", issues);
      checkOptionalHttpUrlMappingValue(
        value.discoveryUrl,
        "$.discoveryUrl",
        issues,
      );
      checkOptionalHttpUrlMappingValue(
        value.redirectOrigin,
        "$.redirectOrigin",
        issues,
      );
      checkOptionalStringMappingValue(value.jwksRef, "$.jwksRef", issues);
      checkOptionalSecretReferenceMapping(
        value.clientSecretRef,
        "$.clientSecretRef",
        issues,
      );
      break;
    case "billing.port@v1":
      checkNoUnknownKeys(value, "$", issues, [
        "portalUrl",
        "usageReportEndpoint",
        "billingSubjectRef",
        "meteringCredentialRef",
      ]);
      requireStringMappingValue(
        value.billingSubjectRef,
        "$.billingSubjectRef",
        issues,
      );
      checkOptionalHttpUrlMappingValue(value.portalUrl, "$.portalUrl", issues);
      checkOptionalHttpUrlMappingValue(
        value.usageReportEndpoint,
        "$.usageReportEndpoint",
        issues,
      );
      if (
        value.portalUrl === undefined && value.usageReportEndpoint === undefined
      ) {
        issues.push({
          path: "$",
          message:
            "billing.port@v1 mapping requires portalUrl or usageReportEndpoint",
        });
      }
      checkOptionalSecretReferenceMapping(
        value.meteringCredentialRef,
        "$.meteringCredentialRef",
        issues,
      );
      break;
  }
  return issues;
}

export function validateOfficialOutputMaterialMappingOutputTypes(
  type: OfficialOutputTypeName,
  value: unknown,
  outputs: readonly OutputFieldTypeDefinition[],
): readonly CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  const outputDefinitions = new Map(outputs.map((output) => [
    output.name,
    output,
  ]));

  collectOutputMappingMarkerUses(type, value, "$", outputDefinitions, issues);
  return issues;
}

export function isOutputMappingMarker(value: unknown): value is string {
  return typeof value === "string" &&
    value.startsWith("$outputs.") &&
    value.length > "$outputs.".length;
}

export function isOutputMaterialMappingValue(value: unknown): boolean {
  if (isOutputMappingMarker(value)) return true;
  if (typeof value === "string") {
    if (value.startsWith("$outputs.")) return false;
    return value.length > 0;
  }
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean";
}

type ExpectedOutputMarkerType =
  | "string"
  | "number"
  | "boolean"
  | "string-array"
  | "object-array";

function collectOutputMappingMarkerUses(
  outputType: OfficialOutputTypeName,
  value: unknown,
  path: string,
  outputDefinitions: ReadonlyMap<string, OutputFieldTypeDefinition>,
  issues: CatalogValidationIssue[],
): void {
  if (isOutputMappingMarker(value)) {
    const name = value.slice("$outputs.".length);
    const definition = outputDefinitions.get(name);
    const expectedType = expectedOutputMarkerType(outputType, path);

    if (definition === undefined) {
      issues.push({
        path,
        message: `${value} is not declared in outputs[]`,
      });
      return;
    }
    if (expectedType === undefined) {
      issues.push({
        path,
        message: `${value} is not valid at this material mapping path`,
      });
      return;
    }
    if (definition.required !== true) {
      issues.push({
        path,
        message: `${value} must reference a required output`,
      });
    }
    if (!isCompatibleOutputMarkerType(expectedType, definition.type)) {
      issues.push({
        path,
        message: `${value} has output type ${definition.type}, expected ${
          formatExpectedOutputMarkerType(expectedType)
        }`,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectOutputMappingMarkerUses(
        outputType,
        entry,
        `${path}[]`,
        outputDefinitions,
        issues,
      );
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      collectOutputMappingMarkerUses(
        outputType,
        entry,
        `${path}.${key}`,
        outputDefinitions,
        issues,
      );
    }
  }
}

function expectedOutputMarkerType(
  outputType: OfficialOutputTypeName,
  path: string,
): ExpectedOutputMarkerType | undefined {
  switch (outputType) {
    case "http-endpoint":
      return expectedHttpEndpointMarkerType(path);
    case "service-binding":
      return expectedServiceBindingMarkerType(path);
    case "object-store":
      return expectedObjectStoreMarkerType(path);
    case "event-channel":
      return expectedEventChannelMarkerType(path);
    case "identity.oidc@v1":
      return expectedIdentityOidcMarkerType(path);
    case "billing.port@v1":
      return expectedBillingPortMarkerType(path);
  }
}

function expectedHttpEndpointMarkerType(
  path: string,
): ExpectedOutputMarkerType | undefined {
  if (
    path === "$.targets" || path === "$.endpoints" ||
    path === "$.endpoints[].routes"
  ) {
    return "object-array";
  }
  if (path === "$.targets[].port") return "number";
  if (path === "$.endpoints[].primary") return "boolean";
  if (
    HTTP_ENDPOINT_STRING_MARKER_PATHS.has(path) ||
    path === "$.endpoints[].routes[].pathPrefix" ||
    path === "$.endpoints[].routes[].to"
  ) {
    return "string";
  }
}

function expectedServiceBindingMarkerType(
  path: string,
): ExpectedOutputMarkerType | undefined {
  if (path === "$.port") return "number";
  if (
    SERVICE_BINDING_STRING_MARKER_PATHS.has(path) ||
    path === "$.passwordRef.secretRef" ||
    path === "$.tokenRef.secretRef" ||
    /^\$\.tokenRefs\..+\.secretRef$/.test(path)
  ) {
    return "string";
  }
}

function expectedObjectStoreMarkerType(
  path: string,
): ExpectedOutputMarkerType | undefined {
  if (path === "$.pathStyle") return "boolean";
  if (path === "$.policyRefs") return "string-array";
  if (path === "$.policyRefs[]") return "string";
  if (
    OBJECT_STORE_STRING_MARKER_PATHS.has(path) ||
    path === "$.accessKeyIdRef.secretRef" ||
    path === "$.secretAccessKeyRef.secretRef" ||
    path === "$.sessionTokenRef.secretRef"
  ) {
    return "string";
  }
}

function expectedEventChannelMarkerType(
  path: string,
): ExpectedOutputMarkerType | undefined {
  if (path === "$.deliveryPolicyRefs") return "string-array";
  if (path === "$.deliveryPolicyRefs[]") return "string";
  if (
    EVENT_CHANNEL_STRING_MARKER_PATHS.has(path) ||
    path === "$.producerCredentialRef.secretRef" ||
    path === "$.consumerCredentialRef.secretRef"
  ) {
    return "string";
  }
}

function expectedIdentityOidcMarkerType(
  path: string,
): ExpectedOutputMarkerType | undefined {
  if (
    IDENTITY_OIDC_STRING_MARKER_PATHS.has(path) ||
    path === "$.clientSecretRef.secretRef"
  ) {
    return "string";
  }
}

function expectedBillingPortMarkerType(
  path: string,
): ExpectedOutputMarkerType | undefined {
  if (
    BILLING_PORT_STRING_MARKER_PATHS.has(path) ||
    path === "$.meteringCredentialRef.secretRef"
  ) {
    return "string";
  }
}

function isCompatibleOutputMarkerType(
  expected: ExpectedOutputMarkerType,
  actual: string,
): boolean {
  switch (expected) {
    case "string":
      return actual === "string";
    case "number":
      return actual === "number" || actual === "integer";
    case "boolean":
      return actual === "boolean";
    case "string-array":
      return actual === "string[]";
    case "object-array":
      return actual === "object[]";
  }
}

function formatExpectedOutputMarkerType(
  expected: ExpectedOutputMarkerType,
): string {
  switch (expected) {
    case "number":
      return "number or integer";
    case "string-array":
      return "string[]";
    case "object-array":
      return "object[]";
    default:
      return expected;
  }
}

const HTTP_ENDPOINT_STRING_MARKER_PATHS = new Set([
  "$.targets[].name",
  "$.targets[].url",
  "$.targets[].protocol",
  "$.targets[].host",
  "$.targets[].basePath",
  "$.targets[].visibility",
  "$.endpoints[].url",
  "$.endpoints[].scheme",
  "$.endpoints[].host",
  "$.endpoints[].listener",
  "$.endpoints[].visibility",
]);

const SERVICE_BINDING_STRING_MARKER_PATHS = new Set([
  "$.service",
  "$.protocol",
  "$.host",
  "$.database",
  "$.username",
  "$.connectionUrl",
  "$.caCertRef",
]);

const OBJECT_STORE_STRING_MARKER_PATHS = new Set([
  "$.bucket",
  "$.endpoint",
  "$.region",
  "$.publicBaseUrl",
]);

const EVENT_CHANNEL_STRING_MARKER_PATHS = new Set([
  "$.channel",
  "$.protocol",
  "$.endpoint",
  "$.topic",
  "$.queue",
  "$.stream",
]);

const IDENTITY_OIDC_STRING_MARKER_PATHS = new Set([
  "$.issuerUrl",
  "$.discoveryUrl",
  "$.clientId",
  "$.redirectOrigin",
  "$.jwksRef",
]);

const BILLING_PORT_STRING_MARKER_PATHS = new Set([
  "$.portalUrl",
  "$.usageReportEndpoint",
  "$.billingSubjectRef",
]);

function isStringMappingValue(value: unknown): boolean {
  return isOutputMappingMarker(value) || isLiteralStringMappingValue(value);
}

function isLiteralStringMappingValue(value: unknown): value is string {
  return typeof value === "string" &&
    !value.startsWith("$outputs.") &&
    value.length > 0;
}

function isNumberMappingValue(value: unknown): boolean {
  return isOutputMappingMarker(value) ||
    (typeof value === "number" && Number.isFinite(value));
}

function isBooleanMappingValue(value: unknown): boolean {
  return isOutputMappingMarker(value) || typeof value === "boolean";
}

function checkHttpEndpointMaterialMapping(
  value: Record<string, unknown>,
  issues: CatalogValidationIssue[],
): void {
  if (value.targets === undefined && value.endpoints === undefined) {
    issues.push({
      path: "$",
      message: "http-endpoint mapping requires targets or endpoints",
    });
  }
  checkOptionalTargetArrayMapping(value.targets, "$.targets", issues);
  checkOptionalEndpointArrayMapping(value.endpoints, "$.endpoints", issues);
}

function checkOptionalTargetArrayMapping(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (isOutputMappingMarker(value)) return;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({
      path,
      message: "must be a non-empty array or output marker",
    });
    return;
  }
  for (const [index, entry] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path: itemPath, message: "must be an object" });
      continue;
    }
    checkNoUnknownKeys(entry, itemPath, issues, [
      "name",
      "url",
      "protocol",
      "host",
      "port",
      "basePath",
      "visibility",
    ]);
    checkOptionalIdentifierMappingValue(entry.name, `${itemPath}.name`, issues);
    checkOptionalHttpUrlMappingValue(entry.url, `${itemPath}.url`, issues);
    checkOptionalHttpSchemeMappingValue(
      entry.protocol,
      `${itemPath}.protocol`,
      issues,
    );
    checkOptionalStringMappingValue(entry.host, `${itemPath}.host`, issues);
    checkOptionalPortNumberMappingValue(entry.port, `${itemPath}.port`, issues);
    checkOptionalPathPrefixMappingValue(
      entry.basePath,
      `${itemPath}.basePath`,
      issues,
    );
    checkOptionalEndpointVisibilityMappingValue(
      entry.visibility,
      `${itemPath}.visibility`,
      issues,
    );
    if (entry.url === undefined && entry.host === undefined) {
      issues.push({ path: itemPath, message: "target must map url or host" });
    }
  }
}

function checkOptionalEndpointArrayMapping(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (isOutputMappingMarker(value)) return;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({
      path,
      message: "must be a non-empty array or output marker",
    });
    return;
  }
  for (const [index, entry] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path: itemPath, message: "must be an object" });
      continue;
    }
    checkNoUnknownKeys(entry, itemPath, issues, [
      "url",
      "scheme",
      "host",
      "listener",
      "visibility",
      "primary",
      "routes",
    ]);
    requireHttpUrlMappingValue(entry.url, `${itemPath}.url`, issues);
    checkOptionalHttpSchemeMappingValue(
      entry.scheme,
      `${itemPath}.scheme`,
      issues,
    );
    checkOptionalStringMappingValue(entry.host, `${itemPath}.host`, issues);
    checkOptionalIdentifierMappingValue(
      entry.listener,
      `${itemPath}.listener`,
      issues,
    );
    checkOptionalEndpointVisibilityMappingValue(
      entry.visibility,
      `${itemPath}.visibility`,
      issues,
    );
    checkOptionalBooleanMappingValue(
      entry.primary,
      `${itemPath}.primary`,
      issues,
    );
    checkOptionalRouteArrayMapping(entry.routes, `${itemPath}.routes`, issues);
  }
}

function checkOptionalRouteArrayMapping(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (isOutputMappingMarker(value)) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array or output marker" });
    return;
  }
  for (const [index, entry] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path: itemPath, message: "must be an object" });
      continue;
    }
    checkNoUnknownKeys(entry, itemPath, issues, ["pathPrefix", "to"]);
    requirePathPrefixMappingValue(
      entry.pathPrefix,
      `${itemPath}.pathPrefix`,
      issues,
    );
    requireIdentifierMappingValue(entry.to, `${itemPath}.to`, issues);
  }
}

function requireStringMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (!isStringMappingValue(value)) {
    issues.push({
      path,
      message: "must be a string value or $outputs.<field> marker",
    });
  }
}

function checkOptionalStringMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  requireStringMappingValue(value, path, issues);
}

function requireNumberMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (!isNumberMappingValue(value)) {
    issues.push({
      path,
      message: "must be a number value or $outputs.<field> marker",
    });
  }
}

function requirePortNumberMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  requireNumberMappingValue(value, path, issues);
  if (typeof value === "number") {
    requirePortNumber(value, path, issues);
  }
}

function checkOptionalPortNumberMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  requirePortNumberMappingValue(value, path, issues);
}

function checkOptionalBooleanMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isBooleanMappingValue(value)) {
    issues.push({
      path,
      message: "must be a boolean value or $outputs.<field> marker",
    });
  }
}

function requireHttpUrlMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  requireStringMappingValue(value, path, issues);
  if (isLiteralStringMappingValue(value)) requireHttpUrl(value, path, issues);
}

function checkOptionalHttpUrlMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  requireHttpUrlMappingValue(value, path, issues);
}

function requireAbsoluteUriMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  requireStringMappingValue(value, path, issues);
  if (isLiteralStringMappingValue(value)) {
    requireAbsoluteUri(value, path, issues);
  }
}

function checkOptionalHttpSchemeMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  checkOptionalStringMappingValue(value, path, issues);
  if (isLiteralStringMappingValue(value)) {
    requireHttpScheme(value, path, issues);
  }
}

function checkOptionalEndpointVisibilityMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  checkOptionalStringMappingValue(value, path, issues);
  if (isLiteralStringMappingValue(value)) {
    requireEndpointVisibility(value, path, issues);
  }
}

function requirePathPrefixMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  requireStringMappingValue(value, path, issues);
  if (isLiteralStringMappingValue(value)) {
    requirePathPrefix(value, path, issues);
  }
}

function checkOptionalPathPrefixMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  requirePathPrefixMappingValue(value, path, issues);
}

function requireIdentifierMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  requireStringMappingValue(value, path, issues);
  if (isLiteralStringMappingValue(value)) {
    requireIdentifier(value, path, issues);
  }
}

function checkOptionalIdentifierMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  requireIdentifierMappingValue(value, path, issues);
}

function checkOptionalStringMappingArray(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (isOutputMappingMarker(value)) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array or output marker" });
    return;
  }
  for (const [index, entry] of value.entries()) {
    requireStringMappingValue(entry, `${path}[${index}]`, issues);
  }
}

function checkOptionalSecretReferenceMapping(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object with secretRef" });
    return;
  }
  checkNoUnknownKeys(value, path, issues, ["secretRef"]);
  requireStringMappingValue(value.secretRef, `${path}.secretRef`, issues);
}

function checkSecretReferenceRecordMapping(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object of secretRef objects" });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    checkOptionalSecretReferenceMapping(entry, `${path}.${key}`, issues);
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
  const hasHostPort = typeof value.host === "string" &&
    value.host.length > 0 && typeof value.port === "number";
  if (!hasUrl && !hasHostPort) {
    issues.push({
      path,
      message: "target requires url or host + port",
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
  if (!isSecretReference(value)) {
    issues.push({ path, message: "must be a secretRef object" });
  }
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
    requireSecretReference(entry, `${path}.${key}`, issues);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type JsonMaterialRecord = Readonly<
  Record<string, JsonValue | SecretReference>
>;
