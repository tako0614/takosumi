import type { JsonObject, JsonValue } from "./types.ts";

export const SERVICE_GRAPH_CAPABILITIES = [
  "protocol.mcp.server",
  "protocol.http.api",
  "protocol.grpc.api",
  "protocol.websocket.api",
  "interface.ui.surface",
  "interface.file.handler",
  "storage.object",
  "storage.filesystem",
  "storage.key_value",
  "storage.sql",
  "storage.vector",
  "storage.search_index",
  "source.repository",
  "source.git.smart_http",
  "compute.job_runner",
  "compute.sandbox",
  "automation.agent_runtime",
  "automation.tool_provider",
  "ai.model",
  "ai.embedding_model",
  "identity.oidc",
  "identity.oauth.client",
  "auth.bootstrap_token",
  "auth.token_exchange",
  "auth.webhook_signing",
  "messaging.queue",
  "messaging.pubsub",
  "events.webhook",
  "events.subscription",
  "observability.logs",
  "observability.metrics",
  "observability.traces",
  "billing.usage",
  "deployment.outputs",
  "control.api",
  "governance.policy",
  "governance.approval",
] as const;

export type StandardServiceGraphCapability =
  (typeof SERVICE_GRAPH_CAPABILITIES)[number];

export type ServiceGraphCapability =
  | StandardServiceGraphCapability
  | `${string}.${string}`;

export type ServiceExportVisibility = "private" | "space" | "public" | "shared";

export type ServiceBindingStatus =
  | "pending"
  | "bound"
  | "blocked"
  | "stale"
  | "revoked";

export type ServiceGrantStatus =
  | "active"
  | "expired"
  | "revoked"
  | "superseded";

export type ServiceExportStatus = "ready" | "unavailable" | "revoked" | "stale";

export type ServiceGraphAuthScheme =
  | "none"
  | "bearer"
  | "oidc"
  | "signed_webhook";

export type ServiceBindingDependencyMode =
  | "variable_injection"
  | "remote_state"
  | "published_output";

export type ServiceBindingTargetKind =
  | "generated_root"
  | "workload"
  | "runtime";

export type ServiceGrantDeliveryMetadata = Readonly<Record<string, JsonValue>>;

export interface ServiceGraphEndpoint {
  readonly name?: string;
  readonly url?: string;
  readonly protocol?: string;
  readonly host?: string;
  readonly port?: number;
  readonly pathPrefix?: string;
}

export interface ServiceGraphAuth {
  readonly scheme: ServiceGraphAuthScheme;
  readonly audience?: readonly string[];
  readonly scopes?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ServiceExport {
  readonly id: string;
  readonly workspaceId: string;
  readonly producerCapsuleId: string;
  readonly outputId?: string;
  readonly outputGeneration?: number;
  readonly stateVersionId?: string;
  readonly applyRunId?: string;
  readonly name: string;
  readonly capabilities: readonly ServiceGraphCapability[];
  readonly visibility: ServiceExportVisibility;
  readonly status: ServiceExportStatus;
  readonly endpoints?: readonly ServiceGraphEndpoint[];
  readonly auth?: readonly ServiceGraphAuth[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly metadata?: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}

export interface ServiceBindingSelector {
  readonly capabilities: readonly ServiceGraphCapability[];
  readonly producerCapsuleId?: string;
  readonly serviceExportId?: string;
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ServiceBindingTarget {
  readonly kind: ServiceBindingTargetKind;
  readonly name?: string;
  readonly metadata?: JsonObject;
}

export interface ServiceGrantRequest {
  readonly scopes: readonly string[];
  readonly audience?: readonly string[];
  readonly env?: readonly string[];
  readonly ttlSeconds?: number;
  readonly metadata?: JsonObject;
}

export interface ServiceBinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly consumerCapsuleId: string;
  readonly target: ServiceBindingTarget;
  readonly selector: ServiceBindingSelector;
  readonly selectedServiceExportId?: string;
  readonly dependencySnapshotId?: string;
  readonly dependencyMode: ServiceBindingDependencyMode;
  readonly grantRequest: ServiceGrantRequest;
  readonly status: ServiceBindingStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}

export interface ServiceGrant {
  readonly id: string;
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly serviceExportId: string;
  readonly consumerCapsuleId: string;
  readonly scopes: readonly string[];
  readonly audience: readonly string[];
  readonly material: ServiceGrantDeliveryMetadata;
  readonly secretRef?: string;
  readonly status: ServiceGrantStatus;
  readonly createdAt: string;
  readonly rotatedAt?: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export type PublicServiceGrant = Omit<ServiceGrant, "secretRef">;

export function isStandardServiceGraphCapability(
  value: string,
): value is StandardServiceGraphCapability {
  return (SERVICE_GRAPH_CAPABILITIES as readonly string[]).includes(value);
}

export function isServiceGraphCapability(
  value: string,
): value is ServiceGraphCapability {
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value);
}

export const SERVICE_EXPORT_VISIBILITIES = [
  "private",
  "space",
  "public",
  "shared",
] as const satisfies readonly ServiceExportVisibility[];

export const SERVICE_EXPORT_STATUSES = [
  "ready",
  "unavailable",
  "revoked",
  "stale",
] as const satisfies readonly ServiceExportStatus[];

export const SERVICE_BINDING_STATUSES = [
  "pending",
  "bound",
  "blocked",
  "stale",
  "revoked",
] as const satisfies readonly ServiceBindingStatus[];

export const SERVICE_GRANT_STATUSES = [
  "active",
  "expired",
  "revoked",
  "superseded",
] as const satisfies readonly ServiceGrantStatus[];

export const SERVICE_GRAPH_AUTH_SCHEMES = [
  "none",
  "bearer",
  "oidc",
  "signed_webhook",
] as const satisfies readonly ServiceGraphAuthScheme[];

export const SERVICE_BINDING_DEPENDENCY_MODES = [
  "variable_injection",
  "remote_state",
  "published_output",
] as const satisfies readonly ServiceBindingDependencyMode[];

export const SERVICE_BINDING_TARGET_KINDS = [
  "generated_root",
  "workload",
  "runtime",
] as const satisfies readonly ServiceBindingTargetKind[];

export function isServiceExportVisibility(
  value: unknown,
): value is ServiceExportVisibility {
  return includesString(SERVICE_EXPORT_VISIBILITIES, value);
}

export function isServiceExportStatus(
  value: unknown,
): value is ServiceExportStatus {
  return includesString(SERVICE_EXPORT_STATUSES, value);
}

export function isServiceBindingStatus(
  value: unknown,
): value is ServiceBindingStatus {
  return includesString(SERVICE_BINDING_STATUSES, value);
}

export function isServiceGrantStatus(
  value: unknown,
): value is ServiceGrantStatus {
  return includesString(SERVICE_GRANT_STATUSES, value);
}

export function isServiceGraphAuthScheme(
  value: unknown,
): value is ServiceGraphAuthScheme {
  return includesString(SERVICE_GRAPH_AUTH_SCHEMES, value);
}

export function isServiceBindingDependencyMode(
  value: unknown,
): value is ServiceBindingDependencyMode {
  return includesString(SERVICE_BINDING_DEPENDENCY_MODES, value);
}

export function isServiceBindingTargetKind(
  value: unknown,
): value is ServiceBindingTargetKind {
  return includesString(SERVICE_BINDING_TARGET_KINDS, value);
}

export function validateServiceExport(
  record: ServiceExport,
): readonly string[] {
  const issues: string[] = [];
  requireString(record.id, "id", issues);
  requireString(record.workspaceId, "workspaceId", issues);
  requireString(record.producerCapsuleId, "producerCapsuleId", issues);
  requireString(record.name, "name", issues);
  requireCapabilities(record.capabilities, "capabilities", issues);
  if (!isServiceExportVisibility(record.visibility)) {
    issues.push("visibility must be private, space, public, or shared");
  }
  if (!isServiceExportStatus(record.status)) {
    issues.push("status must be ready, unavailable, revoked, or stale");
  }
  validateEndpoints(record.endpoints, "endpoints", issues);
  validateAuth(record.auth, "auth", issues);
  validateStringRecord(record.labels, "labels", issues);
  requireString(record.createdAt, "createdAt", issues);
  requireString(record.updatedAt, "updatedAt", issues);
  optionalString(record.revokedAt, "revokedAt", issues);
  return issues;
}

export function assertValidServiceExport(record: ServiceExport): void {
  const issues = validateServiceExport(record);
  if (issues.length > 0) {
    throw new TypeError(`invalid ServiceExport: ${issues.join("; ")}`);
  }
}

export function validateServiceBinding(
  record: ServiceBinding,
): readonly string[] {
  const issues: string[] = [];
  requireString(record.id, "id", issues);
  requireString(record.workspaceId, "workspaceId", issues);
  requireString(record.consumerCapsuleId, "consumerCapsuleId", issues);
  validateBindingTarget(record.target, "target", issues);
  validateBindingSelector(record.selector, "selector", issues);
  optionalString(
    record.selectedServiceExportId,
    "selectedServiceExportId",
    issues,
  );
  optionalString(record.dependencySnapshotId, "dependencySnapshotId", issues);
  if (!isServiceBindingDependencyMode(record.dependencyMode)) {
    issues.push(
      "dependencyMode must be variable_injection, remote_state, or published_output",
    );
  }
  validateGrantRequest(record.grantRequest, "grantRequest", issues);
  if (!isServiceBindingStatus(record.status)) {
    issues.push("status must be pending, bound, blocked, stale, or revoked");
  }
  requireString(record.createdAt, "createdAt", issues);
  requireString(record.updatedAt, "updatedAt", issues);
  optionalString(record.revokedAt, "revokedAt", issues);
  return issues;
}

export function assertValidServiceBinding(record: ServiceBinding): void {
  const issues = validateServiceBinding(record);
  if (issues.length > 0) {
    throw new TypeError(`invalid ServiceBinding: ${issues.join("; ")}`);
  }
}

export function validateServiceGrant(record: ServiceGrant): readonly string[] {
  const issues: string[] = [];
  requireString(record.id, "id", issues);
  requireString(record.workspaceId, "workspaceId", issues);
  requireString(record.bindingId, "bindingId", issues);
  requireString(record.serviceExportId, "serviceExportId", issues);
  requireString(record.consumerCapsuleId, "consumerCapsuleId", issues);
  requireStringArray(record.scopes, "scopes", issues);
  requireStringArray(record.audience, "audience", issues);
  if (!isRecord(record.material)) {
    issues.push("material must be an object");
  }
  optionalString(record.secretRef, "secretRef", issues);
  if (!isServiceGrantStatus(record.status)) {
    issues.push("status must be active, expired, revoked, or superseded");
  }
  requireString(record.createdAt, "createdAt", issues);
  optionalString(record.rotatedAt, "rotatedAt", issues);
  optionalString(record.expiresAt, "expiresAt", issues);
  optionalString(record.revokedAt, "revokedAt", issues);
  return issues;
}

export function assertValidServiceGrant(record: ServiceGrant): void {
  const issues = validateServiceGrant(record);
  if (issues.length > 0) {
    throw new TypeError(`invalid ServiceGrant: ${issues.join("; ")}`);
  }
}

function includesString<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function requireString(value: unknown, field: string, issues: string[]): void {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${field} must be a non-empty string`);
  }
}

function optionalString(value: unknown, field: string, issues: string[]): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length === 0)
  ) {
    issues.push(`${field} must be a non-empty string when present`);
  }
}

function requireCapabilities(
  values: readonly string[] | undefined,
  field: string,
  issues: string[],
): void {
  if (!Array.isArray(values) || values.length === 0) {
    issues.push(`${field} must contain at least one capability`);
    return;
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || !isServiceGraphCapability(value)) {
      issues.push(`${field}[${index}] must be a dotted capability token`);
    }
  }
}

function requireStringArray(
  values: unknown,
  field: string,
  issues: string[],
): void {
  if (!Array.isArray(values)) {
    issues.push(`${field} must be an array`);
    return;
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      issues.push(`${field}[${index}] must be a non-empty string`);
    }
  }
}

function validateOptionalStringArray(
  values: unknown,
  field: string,
  issues: string[],
): void {
  if (values === undefined) return;
  requireStringArray(values, field, issues);
}

function validateStringRecord(
  value: Readonly<Record<string, string>> | undefined,
  field: string,
  issues: string[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || typeof item !== "string") {
      issues.push(`${field} entries must be string:string`);
    }
  }
}

function validateEndpoints(
  endpoints: readonly ServiceGraphEndpoint[] | undefined,
  field: string,
  issues: string[],
): void {
  if (endpoints === undefined) return;
  if (!Array.isArray(endpoints)) {
    issues.push(`${field} must be an array when present`);
    return;
  }
  for (const [index, endpoint] of endpoints.entries()) {
    if (!isRecord(endpoint)) {
      issues.push(`${field}[${index}] must be an object`);
      continue;
    }
    optionalString(endpoint.name, `${field}[${index}].name`, issues);
    optionalString(endpoint.url, `${field}[${index}].url`, issues);
    optionalString(endpoint.protocol, `${field}[${index}].protocol`, issues);
    optionalString(endpoint.host, `${field}[${index}].host`, issues);
    optionalString(
      endpoint.pathPrefix,
      `${field}[${index}].pathPrefix`,
      issues,
    );
    const port = endpoint.port;
    if (
      port !== undefined &&
      (typeof port !== "number" || !Number.isInteger(port) || port <= 0)
    ) {
      issues.push(`${field}[${index}].port must be a positive integer`);
    }
  }
}

function validateAuth(
  auth: readonly ServiceGraphAuth[] | undefined,
  field: string,
  issues: string[],
): void {
  if (auth === undefined) return;
  if (!Array.isArray(auth)) {
    issues.push(`${field} must be an array when present`);
    return;
  }
  for (const [index, entry] of auth.entries()) {
    if (!isRecord(entry)) {
      issues.push(`${field}[${index}] must be an object`);
      continue;
    }
    if (!isServiceGraphAuthScheme(entry.scheme)) {
      issues.push(`${field}[${index}].scheme is not supported`);
    }
    validateOptionalStringArray(
      entry.audience,
      `${field}[${index}].audience`,
      issues,
    );
    validateOptionalStringArray(
      entry.scopes,
      `${field}[${index}].scopes`,
      issues,
    );
  }
}

function validateBindingSelector(
  selector: ServiceBindingSelector | undefined,
  field: string,
  issues: string[],
): void {
  if (!isRecord(selector)) {
    issues.push(`${field} must be an object`);
    return;
  }
  requireCapabilities(selector.capabilities, `${field}.capabilities`, issues);
  optionalString(
    selector.producerCapsuleId,
    `${field}.producerCapsuleId`,
    issues,
  );
  optionalString(selector.serviceExportId, `${field}.serviceExportId`, issues);
  optionalString(selector.name, `${field}.name`, issues);
  validateStringRecord(selector.labels, `${field}.labels`, issues);
}

function validateBindingTarget(
  target: ServiceBindingTarget | undefined,
  field: string,
  issues: string[],
): void {
  if (!isRecord(target)) {
    issues.push(`${field} must be an object`);
    return;
  }
  if (!isServiceBindingTargetKind(target.kind)) {
    issues.push(`${field}.kind is not supported`);
  }
  optionalString(target.name, `${field}.name`, issues);
}

function validateGrantRequest(
  request: ServiceGrantRequest | undefined,
  field: string,
  issues: string[],
): void {
  if (!isRecord(request)) {
    issues.push(`${field} must be an object`);
    return;
  }
  requireStringArray(request.scopes, `${field}.scopes`, issues);
  validateOptionalStringArray(request.audience, `${field}.audience`, issues);
  validateOptionalStringArray(request.env, `${field}.env`, issues);
  if (
    request.ttlSeconds !== undefined &&
    (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds <= 0)
  ) {
    issues.push(`${field}.ttlSeconds must be a positive integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
