import type {
  TakosumiAppInstallationMode,
  TakosumiAppInstallationStatus,
  TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";

/**
 * Internal binding kind catalog. The v1 contract reset (Wave 6) removed
 * AppBinding from the public surface. These kinds remain only as internal
 * implementation details of the AppInstallation ledger so existing import
 * data and stored records continue to load; new public APIs use
 * RunnerProfile decisions, PlanRun/ApplyRun evidence, and DeploymentOutput projections.
 */
const APP_BINDING_KINDS = [
  "identity.oidc@v1",
  "database.postgres@v1",
  "object-store.s3-compatible@v1",
  "domain.http@v1",
  "install-launch-token@v1",
] as const;

/** Internal-only union of account-plane binding kinds; not part of the v1 contract. */
export type AppBindingKind = typeof APP_BINDING_KINDS[number];

/**
 * Internal grant capability catalog. The v1 contract reset (Wave 6) removed
 * AppGrant from the public surface. Retained here for backward
 * compatibility of stored grant rows and access-token scope checks.
 */
const APP_GRANT_CAPABILITIES = [
  "app.profile.write",
  "app.memory.write",
  "deploy.intent.write",
  "logs.read.own",
  "billing.usage.report",
  "spaces:read",
  "spaces:write",
  "files:read",
  "files:write",
  "memories:read",
  "memories:write",
  "threads:read",
  "threads:write",
  "runs:read",
  "runs:write",
  "agents:execute",
  "repos:read",
  "repos:write",
  "mcp:invoke",
  "events:subscribe",
] as const;

/** Internal-only union of account-plane grant capabilities; not part of the v1 contract. */
export type AppGrantCapability = typeof APP_GRANT_CAPABILITIES[number];

export type AppInstallationStatus = TakosumiAppInstallationStatus;
export type AppInstallationMode = TakosumiAppInstallationMode;
export type SpaceKind = "personal" | "team" | "org";

export interface LedgerAccountRecord {
  accountId: string;
  legalOwnerSubject: TakosumiSubject;
  billingAccountId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SpaceRecord {
  spaceId: string;
  accountId: string;
  kind: SpaceKind;
  displayName?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Installation record for the account-plane projection of the Takosumi v1
 * Installation / Deployment vocabulary.
 */
export interface InstallationRecord {
  installationId: string;
  accountId: string;
  spaceId: string;
  appId: string;
  sourceGitUrl: string;
  sourceRef: string;
  sourceCommit: string;
  planDigest: string;
  artifactDigest?: string;
  mode: AppInstallationMode;
  runtimeBindingId?: string;
  billingAccountId?: string;
  status: AppInstallationStatus;
  createdBySubject: TakosumiSubject;
  createdAt: number;
  updatedAt: number;
}

/**
 * @internal v1 contract reset (Wave 6): RuntimeBinding is no longer a public
 * concept. Retained for internal ledger storage so existing AppInstallation
 * rows continue to materialize. New code must not introduce this type to
 * the public Installation / Deployment surface.
 */
export interface RuntimeBindingRecord {
  runtimeBindingId: string;
  installationId: string;
  mode: AppInstallationMode;
  targetType: "shared-cell" | "dedicated" | "self-hosted";
  targetId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * @internal v1 contract reset (Wave 6): AppBinding is no longer a public
 * concept. Workload platform service binding selections replace it. Retained for
 * internal storage.
 */
export interface AppBindingRecord {
  bindingId: string;
  installationId: string;
  name: string;
  kind: AppBindingKind;
  configRef: string;
  secretRefs: readonly string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * @internal v1 contract reset (Wave 6): AppGrant is no longer a public
 * concept. Retained for internal storage and scope-check helpers.
 */
export interface AppGrantRecord {
  grantId: string;
  installationId: string;
  capability: AppGrantCapability;
  scope: Record<string, unknown>;
  grantedAt: number;
  revokedAt?: number;
}

/**
 * @internal v1 contract reset (Wave 6): event records are an internal
 * ledger detail; the public surface exposes events via the
 * `/v1/app-installations/{id}/events` view envelope, not this row shape.
 */
export interface InstallationEventRecord {
  eventId: string;
  installationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  previousEventHash?: string;
  eventHash: string;
  createdAt: number;
}

export interface AppInstallationLedgerStore {
  saveLedgerAccount(record: LedgerAccountRecord): void | Promise<void>;
  findLedgerAccount(
    accountId: string,
  ):
    | LedgerAccountRecord
    | undefined
    | Promise<LedgerAccountRecord | undefined>;
  saveSpace(record: SpaceRecord): void | Promise<void>;
  findSpace(
    spaceId: string,
  ): SpaceRecord | undefined | Promise<SpaceRecord | undefined>;
  listSpacesForAccount(
    accountId: string,
  ): readonly SpaceRecord[] | Promise<readonly SpaceRecord[]>;
  /**
   * Lists the Spaces whose owning ledger account is legally owned by `subject`
   * (i.e. `LedgerAccountRecord.legalOwnerSubject === subject`). Used by the
   * dashboard session `GET /api/v1/spaces` to scope the legal-owner branch of
   * Space visibility without scanning every Space.
   */
  listSpacesForOwner(
    subject: TakosumiSubject,
  ): readonly SpaceRecord[] | Promise<readonly SpaceRecord[]>;
  saveAppInstallation(
    record: InstallationRecord,
  ): void | Promise<void>;
  findAppInstallation(
    installationId: string,
  ):
    | InstallationRecord
    | undefined
    | Promise<InstallationRecord | undefined>;
  listAppInstallationsForSpace(
    spaceId: string,
  ):
    | readonly InstallationRecord[]
    | Promise<readonly InstallationRecord[]>;
  listAppInstallationsForBillingAccount(
    billingAccountId: string,
  ):
    | readonly InstallationRecord[]
    | Promise<readonly InstallationRecord[]>;
  saveRuntimeBinding(record: RuntimeBindingRecord): void | Promise<void>;
  findRuntimeBinding(
    runtimeBindingId: string,
  ):
    | RuntimeBindingRecord
    | undefined
    | Promise<RuntimeBindingRecord | undefined>;
  saveAppBinding(record: AppBindingRecord): void | Promise<void>;
  listAppBindingsForInstallation(
    installationId: string,
  ): readonly AppBindingRecord[] | Promise<readonly AppBindingRecord[]>;
  saveAppGrant(record: AppGrantRecord): void | Promise<void>;
  findAppGrant(
    grantId: string,
  ): AppGrantRecord | undefined | Promise<AppGrantRecord | undefined>;
  listAppGrantsForInstallation(
    installationId: string,
  ): readonly AppGrantRecord[] | Promise<readonly AppGrantRecord[]>;
  appendInstallationEvent(
    record: InstallationEventRecord,
  ): void | Promise<void>;
  listInstallationEvents(
    installationId: string,
  ):
    | readonly InstallationEventRecord[]
    | Promise<readonly InstallationEventRecord[]>;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export const APP_INSTALLATION_STATUS_TRANSITIONS: Record<
  AppInstallationStatus,
  readonly AppInstallationStatus[]
> = {
  installing: ["ready", "failed", "suspended"],
  ready: ["suspended", "exported", "failed"],
  failed: ["installing", "exported"],
  suspended: ["ready", "exported", "failed"],
  exported: [],
};

const bindingNamePattern = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;
const pathPattern = /^\/.{0,199}$/;
const postgresPlans = new Set(["nano", "small", "medium", "large", "xlarge"]);
const postgresVersions = new Set(["15", "16", "17"]);
const postgresExtensions = new Set([
  "pgvector",
  "pgcrypto",
  "uuid-ossp",
  "pg_stat_statements",
  "pg_trgm",
]);
const objectStorePlans = new Set(["standard", "infrequent-access", "archive"]);
const tlsModes = new Set(["auto", "managed", "byo"]);
const oidcAuthMethods = new Set([
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
]);

export function isAppBindingKind(value: unknown): value is AppBindingKind {
  return typeof value === "string" &&
    (APP_BINDING_KINDS as readonly string[]).includes(value);
}

export function isAppGrantCapability(
  value: unknown,
): value is AppGrantCapability {
  return typeof value === "string" &&
    (APP_GRANT_CAPABILITIES as readonly string[]).includes(value);
}

export function isValidBindingName(value: string): boolean {
  return bindingNamePattern.test(value);
}

export function validateAppBindingRecord(
  record: AppBindingRecord,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isValidBindingName(record.name)) {
    issues.push({
      path: "name",
      message: "binding name must match ^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$",
    });
  }
  if (!isAppBindingKind(record.kind)) {
    issues.push({ path: "kind", message: "binding kind is not in catalog v1" });
  }
  if (!record.configRef) {
    issues.push({ path: "configRef", message: "configRef is required" });
  }
  if (!Array.isArray(record.secretRefs)) {
    issues.push({ path: "secretRefs", message: "secretRefs must be an array" });
  } else if (
    record.secretRefs.some((secretRef) =>
      typeof secretRef !== "string" || secretRef.length === 0
    )
  ) {
    issues.push({
      path: "secretRefs",
      message: "secretRefs must contain non-empty string references",
    });
  }
  if (
    record.kind === "install-launch-token@v1" && record.secretRefs.length > 0
  ) {
    issues.push({
      path: "secretRefs",
      message: `${record.kind} must not store secret references`,
    });
  }
  return issues;
}

export function assertValidAppBindingRecord(record: AppBindingRecord): void {
  const issues = validateAppBindingRecord(record);
  if (issues.length > 0) {
    throw new TypeError(validationMessage("invalid AppBinding", issues));
  }
}

export function validateAppGrantRecord(
  record: AppGrantRecord,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isAppGrantCapability(record.capability)) {
    issues.push({
      path: "capability",
      message: "grant capability is not in catalog v1",
    });
  }
  if (
    !record.scope || typeof record.scope !== "object" ||
    Array.isArray(record.scope)
  ) {
    issues.push({ path: "scope", message: "scope must be an object" });
  }
  return issues;
}

export function assertValidAppGrantRecord(record: AppGrantRecord): void {
  const issues = validateAppGrantRecord(record);
  if (issues.length > 0) {
    throw new TypeError(validationMessage("invalid AppGrant", issues));
  }
}

export function validateAppBindingDeclaration(
  name: string,
  declaration: Record<string, unknown>,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isValidBindingName(name)) {
    issues.push({
      path: `bindings.${name}`,
      message: "binding name must match ^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$",
    });
  }
  const type = declaration.type;
  if (!isAppBindingKind(type)) {
    issues.push({
      path: `bindings.${name}.type`,
      message: "binding type must be one of the v1 catalog identifiers",
    });
    return issues;
  }
  if (typeof declaration.required !== "boolean") {
    issues.push({
      path: `bindings.${name}.required`,
      message: "required must be a boolean",
    });
  }

  if (type === "identity.oidc@v1") {
    validateOidcBinding(name, declaration, issues);
  } else if (type === "database.postgres@v1") {
    validatePostgresBinding(name, declaration, issues);
  } else if (type === "object-store.s3-compatible@v1") {
    validateObjectStoreBinding(name, declaration, issues);
  } else if (type === "domain.http@v1") {
    validateDomainBinding(name, declaration, issues);
  } else if (type === "install-launch-token@v1") {
    validateLaunchTokenBinding(name, declaration, issues);
  }

  return issues;
}

export function assertValidAppBindingDeclaration(
  name: string,
  declaration: Record<string, unknown>,
): void {
  const issues = validateAppBindingDeclaration(name, declaration);
  if (issues.length > 0) {
    throw new TypeError(
      validationMessage("invalid binding declaration", issues),
    );
  }
}

export function canTransitionAppInstallationStatus(
  from: AppInstallationStatus,
  to: AppInstallationStatus,
): boolean {
  return from === to || APP_INSTALLATION_STATUS_TRANSITIONS[from].includes(to);
}

export function transitionAppInstallationStatus(
  installation: InstallationRecord,
  status: AppInstallationStatus,
  now: number = Date.now(),
): InstallationRecord {
  if (!canTransitionAppInstallationStatus(installation.status, status)) {
    throw new TypeError(
      `invalid AppInstallation status transition: ${installation.status} -> ${status}`,
    );
  }
  if (installation.status === status) return installation;
  return {
    ...installation,
    status,
    updatedAt: now,
  };
}

export async function buildInstallationEvent(input: {
  eventId?: string;
  installationId: string;
  eventType: string;
  payload?: Record<string, unknown>;
  previousEventHash?: string;
  createdAt?: number;
}): Promise<InstallationEventRecord> {
  const record = {
    eventId: input.eventId ?? `evt_${crypto.randomUUID()}`,
    installationId: input.installationId,
    eventType: input.eventType,
    payload: input.payload ?? {},
    previousEventHash: input.previousEventHash,
    createdAt: input.createdAt ?? Date.now(),
  };
  return {
    ...record,
    eventHash: await installationEventHash(record),
  };
}

export async function verifyInstallationEventHashChain(
  events: readonly InstallationEventRecord[],
): Promise<boolean> {
  let previousEventHash: string | undefined;
  for (const event of events) {
    if (event.previousEventHash !== previousEventHash) return false;
    const expected = await installationEventHash({
      eventId: event.eventId,
      installationId: event.installationId,
      eventType: event.eventType,
      payload: event.payload,
      previousEventHash: event.previousEventHash,
      createdAt: event.createdAt,
    });
    if (event.eventHash !== expected) return false;
    previousEventHash = event.eventHash;
  }
  return true;
}

function validateOidcBinding(
  name: string,
  declaration: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  const redirectPaths = declaration.redirectPaths;
  if (
    !Array.isArray(redirectPaths) ||
    redirectPaths.length < 1 ||
    redirectPaths.length > 10 ||
    redirectPaths.some((path) =>
      typeof path !== "string" ||
      !pathPattern.test(path)
    )
  ) {
    issues.push({
      path: `bindings.${name}.redirectPaths`,
      message: "redirectPaths must contain 1-10 slash-prefixed paths",
    });
  }
  const subjectMode = declaration.subjectMode;
  if (subjectMode !== undefined && subjectMode !== "pairwise") {
    issues.push({
      path: `bindings.${name}.subjectMode`,
      message: "subjectMode must be pairwise",
    });
  }
  const method = declaration.tokenEndpointAuthMethod;
  if (method !== undefined && !oidcAuthMethods.has(String(method))) {
    issues.push({
      path: `bindings.${name}.tokenEndpointAuthMethod`,
      message: "unsupported token endpoint auth method",
    });
  }
  const scopes = declaration.allowedScopes;
  if (
    scopes !== undefined &&
    (!Array.isArray(scopes) ||
      scopes.some((scope) => typeof scope !== "string" || scope.length === 0))
  ) {
    issues.push({
      path: `bindings.${name}.allowedScopes`,
      message: "allowedScopes must be non-empty strings",
    });
  }
}

function validatePostgresBinding(
  name: string,
  declaration: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  if (!postgresPlans.has(String(declaration.plan))) {
    issues.push({
      path: `bindings.${name}.plan`,
      message: "plan must be nano, small, medium, large, or xlarge",
    });
  }
  const version = declaration.version;
  if (version !== undefined && !postgresVersions.has(String(version))) {
    issues.push({
      path: `bindings.${name}.version`,
      message: "version must be 15, 16, or 17",
    });
  }
  const extensions = declaration.extensions;
  if (
    extensions !== undefined &&
    (!Array.isArray(extensions) ||
      extensions.some((extension) =>
        !postgresExtensions.has(String(extension))
      ))
  ) {
    issues.push({
      path: `bindings.${name}.extensions`,
      message: "extensions must be from the Postgres extension allowlist",
    });
  }
  const backupRetentionDays = declaration.backupRetentionDays;
  if (
    backupRetentionDays !== undefined &&
    (!Number.isInteger(backupRetentionDays) ||
      Number(backupRetentionDays) < 1 ||
      Number(backupRetentionDays) > 35)
  ) {
    issues.push({
      path: `bindings.${name}.backupRetentionDays`,
      message: "backupRetentionDays must be an integer from 1 to 35",
    });
  }
}

function validateObjectStoreBinding(
  name: string,
  declaration: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  if (!objectStorePlans.has(String(declaration.plan))) {
    issues.push({
      path: `bindings.${name}.plan`,
      message: "plan must be standard, infrequent-access, or archive",
    });
  }
  const encryption = declaration.encryption;
  if (encryption !== undefined) {
    if (!isRecord(encryption)) {
      issues.push({
        path: `bindings.${name}.encryption`,
        message: "encryption must be an object",
      });
    } else if (
      encryption.mode !== "sse-s3" && encryption.mode !== "sse-kms"
    ) {
      issues.push({
        path: `bindings.${name}.encryption.mode`,
        message: "encryption.mode must be sse-s3 or sse-kms",
      });
    } else if (
      encryption.mode === "sse-kms" &&
      typeof encryption.kmsKeyRef !== "string"
    ) {
      issues.push({
        path: `bindings.${name}.encryption.kmsKeyRef`,
        message: "kmsKeyRef is required for sse-kms encryption",
      });
    }
  }
  const lifecycleDays = declaration.lifecycleDays;
  if (
    lifecycleDays !== undefined &&
    (!Number.isInteger(lifecycleDays) || Number(lifecycleDays) < 0)
  ) {
    issues.push({
      path: `bindings.${name}.lifecycleDays`,
      message: "lifecycleDays must be a non-negative integer",
    });
  }
}

function validateDomainBinding(
  name: string,
  declaration: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  const hostname = declaration.hostname;
  if (
    hostname !== "auto" &&
    !(isRecord(hostname) && typeof hostname.custom === "string" &&
      hostname.custom.length > 0)
  ) {
    issues.push({
      path: `bindings.${name}.hostname`,
      message: "hostname must be auto or { custom: string }",
    });
  }
  const tlsMode = declaration.tlsMode;
  if (tlsMode !== undefined && !tlsModes.has(String(tlsMode))) {
    issues.push({
      path: `bindings.${name}.tlsMode`,
      message: "tlsMode must be auto, managed, or byo",
    });
  }
  if (tlsMode === "byo" && typeof declaration.tlsCertRef !== "string") {
    issues.push({
      path: `bindings.${name}.tlsCertRef`,
      message: "tlsCertRef is required when tlsMode is byo",
    });
  }
}

function validateLaunchTokenBinding(
  name: string,
  declaration: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  const consumePath = declaration.consumePath;
  if (
    consumePath !== undefined && (
      typeof consumePath !== "string" || !pathPattern.test(consumePath)
    )
  ) {
    issues.push({
      path: `bindings.${name}.consumePath`,
      message: "consumePath must be a slash-prefixed path",
    });
  }
  const maxLifetimeSeconds = declaration.maxLifetimeSeconds;
  if (
    maxLifetimeSeconds !== undefined &&
    (!Number.isInteger(maxLifetimeSeconds) ||
      Number(maxLifetimeSeconds) < 30 ||
      Number(maxLifetimeSeconds) > 300)
  ) {
    issues.push({
      path: `bindings.${name}.maxLifetimeSeconds`,
      message: "maxLifetimeSeconds must be an integer from 30 to 300",
    });
  }
}

async function installationEventHash(input: {
  eventId: string;
  installationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  previousEventHash?: string;
  createdAt: number;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableJson(input)),
  );
  return `sha256:${hex(new Uint8Array(digest))}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(value[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validationMessage(
  prefix: string,
  issues: readonly ValidationIssue[],
): string {
  return `${prefix}: ${
    issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
  }`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
