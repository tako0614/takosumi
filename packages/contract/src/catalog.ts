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

/** @deprecated Use `OFFICIAL_MATERIAL_KIND_NAMES`. */
export const OFFICIAL_OUTPUT_TYPE_NAMES = OFFICIAL_MATERIAL_KIND_NAMES;
/** @deprecated Use `OfficialMaterialKindName`. */
export type OfficialOutputTypeName = OfficialMaterialKindName;

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
/** @deprecated Use `OfficialMaterialByKind`. */
export type OfficialOutputMaterialByType = OfficialMaterialByKind;
/** @deprecated Use `OfficialMaterial`. */
export type OfficialOutputMaterial = OfficialMaterial;

export interface CatalogValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface OutputFieldTypeDefinition {
  readonly name: string;
  readonly type: OutputFieldTypeName;
  readonly required?: boolean;
}

const MATERIAL_KIND_SET = new Set<string>(OFFICIAL_MATERIAL_KIND_NAMES);
const OUTPUT_FIELD_TYPE_SET = new Set<string>(OUTPUT_FIELD_TYPE_NAMES);
const PROJECTION_FAMILY_SET = new Set<string>(PROJECTION_FAMILY_NAMES);
const ACCESS_MODE_SET = new Set<string>(ACCESS_MODES);
const OFFICIAL_SENSITIVITY_CLASS_SET = new Set<string>(
  OFFICIAL_SENSITIVITY_CLASSES,
);

export function isOfficialOutputTypeName(
  value: string,
): value is OfficialOutputTypeName {
  return isOfficialMaterialKindName(value);
}

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

export function allowedProjectionFamiliesForOutputType(
  type: OfficialOutputTypeName,
): readonly ProjectionFamilyName[] {
  return allowedProjectionFamiliesForMaterialKind(type);
}

export function allowedProjectionFamiliesForMaterialKind(
  kind: OfficialMaterialKindName,
): readonly ProjectionFamilyName[] {
  return kind === "http-endpoint"
    ? ["upstream", "env", "config-mount"]
    : ["secret-env", "config-mount"];
}

export function isProjectionAllowedForOutputType(
  type: OfficialOutputTypeName,
  projection: ProjectionFamilyName,
): boolean {
  return isProjectionAllowedForMaterialKind(type, projection);
}

export function isProjectionAllowedForMaterialKind(
  kind: OfficialMaterialKindName,
  projection: ProjectionFamilyName,
): boolean {
  return allowedProjectionFamiliesForMaterialKind(kind).includes(projection);
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

export function validateOfficialMaterial(
  kind: OfficialMaterialKindName,
  value: unknown,
): readonly CatalogValidationIssue[] {
  return validateOfficialOutputMaterial(kind, value);
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
      checkOptionalStringMappingValue(value.service, "$.service", issues);
      checkOptionalStringMappingValue(value.host, "$.host", issues);
      checkOptionalPortNumberMappingValue(value.port, "$.port", issues);
      checkOptionalStringMappingValue(value.database, "$.database", issues);
      checkOptionalStringMappingValue(value.username, "$.username", issues);
      checkOptionalStringMappingValue(
        value.connectionUrl,
        "$.connectionUrl",
        issues,
      );
      checkOptionalAbsoluteUriMappingValue(
        value.connectionUrl,
        "$.connectionUrl",
        issues,
      );
      checkOptionalCredentialFreeConnectionUrlMappingValue(
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
      checkServiceBindingMappingAddress(value, issues);
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
      requireCredentialFreeUriMappingValue(
        value.endpoint,
        "$.endpoint",
        issues,
      );
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
      checkObjectStoreCredentialRefMapping(value, "$", issues);
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
      checkOptionalAbsoluteUriMappingValue(
        value.endpoint,
        "$.endpoint",
        issues,
      );
      checkOptionalCredentialFreeUriMappingValue(
        value.endpoint,
        "$.endpoint",
        issues,
      );
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
    case "mcp-server@v1":
      checkNoUnknownKeys(value, "$", issues, [
        "endpointUrl",
        "transport",
        "protocolVersion",
        "serverName",
        "description",
        "tokenRef",
      ]);
      requireHttpUrlMappingValue(value.endpointUrl, "$.endpointUrl", issues);
      requireStringMappingValue(value.transport, "$.transport", issues);
      if (isLiteralStringMappingValue(value.transport)) {
        requireMcpTransport(value.transport, "$.transport", issues);
      }
      checkOptionalStringMappingValue(
        value.protocolVersion,
        "$.protocolVersion",
        issues,
      );
      checkOptionalStringMappingValue(value.serverName, "$.serverName", issues);
      checkOptionalStringMappingValue(
        value.description,
        "$.description",
        issues,
      );
      checkOptionalSecretReferenceMapping(value.tokenRef, "$.tokenRef", issues);
      break;
  }
  return issues;
}

export function validateOfficialMaterialMapping(
  kind: OfficialMaterialKindName,
  value: unknown,
): readonly CatalogValidationIssue[] {
  return validateOfficialOutputMaterialMapping(kind, value);
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
  if (type === "http-endpoint") {
    checkHttpEndpointMappingRequiredAlternatives(
      value,
      outputDefinitions,
      issues,
    );
  } else if (type === "billing.port@v1") {
    checkBillingPortMappingRequiredAlternatives(
      value,
      outputDefinitions,
      issues,
    );
  } else if (type === "service-binding") {
    checkServiceBindingMappingRequiredAlternatives(
      value,
      outputDefinitions,
      issues,
    );
  }
  return issues;
}

export function validateOfficialMaterialMappingOutputFields(
  kind: OfficialMaterialKindName,
  value: unknown,
  outputs: readonly OutputFieldTypeDefinition[],
): readonly CatalogValidationIssue[] {
  return validateOfficialOutputMaterialMappingOutputTypes(kind, value, outputs);
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
    if (
      definition.required !== true &&
      isRequiredOutputMarkerPath(outputType, path)
    ) {
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
    case "mcp-server@v1":
      return expectedMcpServerMarkerType(path);
  }
}

function isRequiredOutputMarkerPath(
  outputType: OfficialOutputTypeName,
  path: string,
): boolean {
  switch (outputType) {
    case "http-endpoint":
      return path === "$.targets" ||
        path === "$.endpoints" ||
        path === "$.endpoints[].url" ||
        path === "$.endpoints[].routes[].pathPrefix" ||
        path === "$.endpoints[].routes[].to";
    case "service-binding":
      return path === "$.protocol";
    case "object-store":
      return path === "$.bucket" || path === "$.endpoint";
    case "event-channel":
      return path === "$.channel" || path === "$.protocol";
    case "identity.oidc@v1":
      return path === "$.issuerUrl" || path === "$.clientId";
    case "billing.port@v1":
      return path === "$.billingSubjectRef";
    case "mcp-server@v1":
      return path === "$.endpointUrl" || path === "$.transport";
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

function expectedMcpServerMarkerType(
  path: string,
): ExpectedOutputMarkerType | undefined {
  if (
    MCP_SERVER_STRING_MARKER_PATHS.has(path) ||
    path === "$.tokenRef.secretRef"
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

const MCP_SERVER_STRING_MARKER_PATHS = new Set([
  "$.endpointUrl",
  "$.transport",
  "$.protocolVersion",
  "$.serverName",
  "$.description",
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
    if (
      entry.url === undefined ||
      (entry.host !== undefined || entry.port !== undefined)
    ) {
      const hasUrl = entry.url !== undefined;
      const hasHostPort = entry.host !== undefined && entry.port !== undefined;
      if (!hasUrl && !hasHostPort) {
        issues.push({
          path: itemPath,
          message: "target must map url or host + port",
        });
      } else if (entry.host !== undefined && entry.port === undefined) {
        issues.push({
          path: itemPath,
          message: "target host mapping also requires port",
        });
      } else if (entry.host === undefined && entry.port !== undefined) {
        issues.push({
          path: itemPath,
          message: "target port mapping also requires host",
        });
      }
    }
    if (
      (entry.protocol !== undefined || entry.basePath !== undefined) &&
      !(entry.host !== undefined && entry.port !== undefined)
    ) {
      issues.push({
        path: itemPath,
        message: "target protocol/basePath mapping requires host + port",
      });
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
    crossCheckHttpEndpointMappingUrl(entry, itemPath, issues);
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

function checkOptionalCredentialFreeConnectionUrlMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  if (isLiteralStringMappingValue(value)) {
    requireCredentialFreeConnectionUrl(value, path, issues);
  }
}

function requireCredentialFreeUriMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (isLiteralStringMappingValue(value)) {
    requireCredentialFreeUri(value, path, issues);
  }
}

function checkOptionalCredentialFreeUriMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  requireCredentialFreeUriMappingValue(value, path, issues);
}

function checkOptionalAbsoluteUriMappingValue(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value === undefined) return;
  requireAbsoluteUriMappingValue(value, path, issues);
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

function crossCheckHttpEndpointMappingUrl(
  value: Record<string, unknown>,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (!isLiteralStringMappingValue(value.url)) return;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return;
  }
  if (isLiteralStringMappingValue(value.scheme)) {
    const scheme = url.protocol.replace(/:$/, "");
    if (value.scheme !== scheme) {
      issues.push({
        path: `${path}.scheme`,
        message: "must match the scheme in url",
      });
    }
  }
  if (isLiteralStringMappingValue(value.host) && value.host.length > 0) {
    if (value.host !== url.hostname) {
      issues.push({
        path: `${path}.host`,
        message: "must match the host in url",
      });
    }
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
    requireIdentifier(key, `${path}.${key}`, issues);
    checkOptionalSecretReferenceMapping(entry, `${path}.${key}`, issues);
  }
}

function checkObjectStoreCredentialRefMapping(
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

function checkServiceBindingMappingAddress(
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
      message: "service-binding host and port mappings must appear together",
    });
  }
  if (!hasService && !hasConnectionUrl && !hasHost && !hasPort) {
    issues.push({
      path: "$",
      message:
        "service-binding mapping requires service, connectionUrl, or host + port",
    });
  }
}

function checkHttpEndpointMappingRequiredAlternatives(
  value: unknown,
  outputDefinitions: ReadonlyMap<string, OutputFieldTypeDefinition>,
  issues: CatalogValidationIssue[],
): void {
  if (!isRecord(value)) return;
  const targets = value.targets;
  if (targets === undefined || isOutputMappingMarker(targets)) return;
  if (!Array.isArray(targets)) return;
  for (const [index, target] of targets.entries()) {
    if (!isRecord(target)) continue;
    const itemPath = `$.targets[${index}]`;
    const urlAlwaysPresent = mappingValueAlwaysPresent(
      target.url,
      outputDefinitions,
    );
    const hostAlwaysPresent = mappingValueAlwaysPresent(
      target.host,
      outputDefinitions,
    );
    const portAlwaysPresent = mappingValueAlwaysPresent(
      target.port,
      outputDefinitions,
    );
    if (urlAlwaysPresent || (hostAlwaysPresent && portAlwaysPresent)) {
      continue;
    }
    if (target.url !== undefined && isOutputMappingMarker(target.url)) {
      issues.push({
        path: `${itemPath}.url`,
        message:
          `${target.url} must reference a required output when target has no required host + port fallback`,
      });
    }
    if (
      target.url === undefined || target.host !== undefined ||
      target.port !== undefined
    ) {
      if (target.host !== undefined && isOutputMappingMarker(target.host)) {
        if (!hostAlwaysPresent) {
          issues.push({
            path: `${itemPath}.host`,
            message:
              `${target.host} must reference a required output when used as target host`,
          });
        }
      }
      if (target.port !== undefined && isOutputMappingMarker(target.port)) {
        if (!portAlwaysPresent) {
          issues.push({
            path: `${itemPath}.port`,
            message:
              `${target.port} must reference a required output when used as target port`,
          });
        }
      }
    }
  }
}

function checkServiceBindingMappingRequiredAlternatives(
  value: unknown,
  outputDefinitions: ReadonlyMap<string, OutputFieldTypeDefinition>,
  issues: CatalogValidationIssue[],
): void {
  if (!isRecord(value)) return;
  const serviceAlwaysPresent = mappingValueAlwaysPresent(
    value.service,
    outputDefinitions,
  );
  const connectionUrlAlwaysPresent = mappingValueAlwaysPresent(
    value.connectionUrl,
    outputDefinitions,
  );
  const hostAlwaysPresent = mappingValueAlwaysPresent(
    value.host,
    outputDefinitions,
  );
  const portAlwaysPresent = mappingValueAlwaysPresent(
    value.port,
    outputDefinitions,
  );
  if (
    serviceAlwaysPresent || connectionUrlAlwaysPresent ||
    (hostAlwaysPresent && portAlwaysPresent)
  ) {
    return;
  }
  if (value.service !== undefined && isOutputMappingMarker(value.service)) {
    issues.push({
      path: "$.service",
      message:
        `${value.service} must reference a required output when service-binding mapping has no required connectionUrl or host + port fallback`,
    });
  }
  if (
    value.connectionUrl !== undefined &&
    isOutputMappingMarker(value.connectionUrl)
  ) {
    issues.push({
      path: "$.connectionUrl",
      message:
        `${value.connectionUrl} must reference a required output when service-binding mapping has no required service or host + port fallback`,
    });
  }
  if (value.host !== undefined && isOutputMappingMarker(value.host)) {
    issues.push({
      path: "$.host",
      message:
        `${value.host} must reference a required output when service-binding mapping has no required service or connectionUrl fallback`,
    });
  }
  if (value.port !== undefined && isOutputMappingMarker(value.port)) {
    issues.push({
      path: "$.port",
      message:
        `${value.port} must reference a required output when service-binding mapping has no required service or connectionUrl fallback`,
    });
  }
}

function checkBillingPortMappingRequiredAlternatives(
  value: unknown,
  outputDefinitions: ReadonlyMap<string, OutputFieldTypeDefinition>,
  issues: CatalogValidationIssue[],
): void {
  if (!isRecord(value)) return;
  const portalAlwaysPresent = mappingValueAlwaysPresent(
    value.portalUrl,
    outputDefinitions,
  );
  const usageAlwaysPresent = mappingValueAlwaysPresent(
    value.usageReportEndpoint,
    outputDefinitions,
  );
  if (portalAlwaysPresent || usageAlwaysPresent) return;
  if (value.portalUrl !== undefined && isOutputMappingMarker(value.portalUrl)) {
    issues.push({
      path: "$.portalUrl",
      message:
        `${value.portalUrl} must reference a required output when billing mapping has no required usageReportEndpoint fallback`,
    });
  }
  if (
    value.usageReportEndpoint !== undefined &&
    isOutputMappingMarker(value.usageReportEndpoint)
  ) {
    issues.push({
      path: "$.usageReportEndpoint",
      message:
        `${value.usageReportEndpoint} must reference a required output when billing mapping has no required portalUrl fallback`,
    });
  }
}

function mappingValueAlwaysPresent(
  value: unknown,
  outputDefinitions: ReadonlyMap<string, OutputFieldTypeDefinition>,
): boolean {
  if (isOutputMappingMarker(value)) {
    const name = value.slice("$outputs.".length);
    return outputDefinitions.get(name)?.required === true;
  }
  return isOutputMaterialMappingValue(value);
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
