// Shared helpers, row types, and row converters used by per-domain Postgres
// operation modules. Behaviour-preserving: extracted verbatim from the
// monolithic `postgres-store.ts`.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { drizzle, type PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import type {
  AppBindingRecord,
  AppGrantRecord,
  InstallationEventRecord,
  InstallationRecord,
  LedgerAccountRecord,
  RuntimeBindingRecord,
  SpaceKind,
  SpaceRecord,
} from "../ledger.ts";
import { isAppGrantCapability } from "../ledger.ts";
import type {
  AccountSessionRecord,
  AuthorizationCodeRecord,
  BillingAccountRecord,
  BillingUsageRecord,
  BillingWebhookEventRecord,
  LaunchTokenRecord,
  OidcClientRecord,
  PasskeyCredentialRecord,
  PersonalAccessTokenRecord,
  TakosumiAccountRecord,
  TokenRecord,
  UpstreamIdentityRecord,
} from "../store.ts";

export interface PostgresQueryResult<T> {
  rows: T[];
}

export interface PostgresQueryClient {
  queryObject<T>(
    sql: string,
    args?: readonly unknown[],
  ): Promise<PostgresQueryResult<T>>;
}

export function postgresDrizzle<TSchema extends Record<string, unknown>>(
  client: PostgresQueryClient,
  schema: TSchema,
): PgRemoteDatabase<TSchema> {
  return drizzle(
    async (query, params, method) => {
      const result = await client.queryObject<Record<string, unknown>>(
        query,
        params,
      );
      if (method !== "all") return { rows: [...result.rows] };
      const columns = selectedDriverColumns(query);
      return {
        rows: result.rows.map((row) => columns.map((column) => row[column])),
      };
    },
    { schema },
  );
}

export async function runQuery<T = Record<string, unknown>>(
  client: PostgresQueryClient,
  sql: string,
  args: readonly unknown[] = [],
): Promise<PostgresQueryResult<T>> {
  return await client.queryObject<T>(sql, args);
}

export async function runRows<T>(
  client: PostgresQueryClient,
  sql: string,
  args: readonly unknown[] = [],
): Promise<T[]> {
  return (await runQuery<T>(client, sql, args)).rows;
}

export async function runFirst<T>(
  client: PostgresQueryClient,
  sql: string,
  args: readonly unknown[] = [],
): Promise<T | undefined> {
  return (await runRows<T>(client, sql, args))[0];
}

export type TimeValue = Date | string | number;

export interface AccountRow {
  subject: TakosumiSubject;
  email: string | null;
  email_verified: boolean | null;
  display_name: string | null;
  terms_version: string | null;
  terms_accepted_at: TimeValue | null;
  terms_accepted_source: string | null;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface UpstreamIdentityRow {
  provider_id: string;
  upstream_issuer: string;
  upstream_subject: string;
  subject: TakosumiSubject;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface PasskeyCredentialRow {
  credential_id: string;
  subject: TakosumiSubject;
  public_key_jwk: unknown;
  sign_count: number;
  transports: string[] | null;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface AccountSessionRow {
  session_id: string;
  subject: TakosumiSubject;
  created_at: TimeValue;
  expires_at: TimeValue;
}

export interface BillingAccountRow {
  billing_account_id: string;
  subject: TakosumiSubject;
  provider: "stripe" | "manual";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  plan_code: string | null;
  current_period_end_unix: number | string | null;
  last_invoice_id: string | null;
  dunning_started_at: TimeValue | null;
  next_payment_attempt_unix: number | string | null;
  dunning_attempt_count: number | string | null;
  dunning_action: "retry_scheduled" | "marked_uncollectible" | null;
  dunning_exhausted_at: TimeValue | null;
  last_credit_event_id: string | null;
  last_credit_kind: "refund" | "credit_note" | null;
  last_credit_id: string | null;
  last_credit_amount: number | string | null;
  last_credit_currency: string | null;
  last_plan_transition_event_id: string | null;
  last_plan_from_code: string | null;
  last_plan_to_code: string | null;
  last_plan_transitioned_at: TimeValue | null;
  last_tax_event_id: string | null;
  tax_policy_ref: string | null;
  tax_jurisdiction: string | null;
  tax_automatic_status: string | null;
  status: BillingAccountRecord["status"];
  version: number | string | null;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface BillingWebhookEventRow {
  event_id: string;
  event_type: string;
  status: BillingWebhookEventRecord["status"];
  received_at: TimeValue;
  updated_at: TimeValue;
  error_message: string | null;
}

export interface BillingUsageRow {
  usage_report_id: string;
  installation_id: string;
  billing_account_id: string;
  meter: string;
  quantity: number | string;
  unit: string;
  period_start: TimeValue | null;
  period_end: TimeValue | null;
  idempotency_key: string | null;
  request_digest: string;
  metadata: unknown;
  reported_by_subject: TakosumiSubject | null;
  reported_at: TimeValue;
}

export interface AuthorizationCodeRow {
  client_id: string;
  redirect_uri: string;
  scope: string;
  subject: string;
  takosumi_subject: TakosumiSubject | null;
  installation_id: string | null;
  app_id: string | null;
  space_id: string | null;
  role: string | null;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  expires_at: TimeValue;
}

export interface TokenRow {
  client_id: string;
  scope: string;
  subject: string;
  takosumi_subject: TakosumiSubject | null;
  installation_id: string | null;
  app_id: string | null;
  space_id: string | null;
  role: string | null;
  expires_at: TimeValue;
}

export interface PersonalAccessTokenRow {
  token_id: string;
  token_prefix: string;
  subject: TakosumiSubject;
  name: string;
  scopes: PersonalAccessTokenRecord["scopes"];
  created_at: TimeValue;
  expires_at: TimeValue | null;
  revoked_at: TimeValue | null;
  last_used_at: TimeValue | null;
}

export interface LaunchTokenRow {
  token_hash: string;
  jti: string;
  installation_id: string;
  account_id: string;
  space_id: string;
  app_id: string;
  subject: TakosumiSubject;
  redirect_uri: string;
  scopes: string[];
  expires_at: TimeValue;
  created_at: TimeValue;
  used_at: TimeValue | null;
}

export interface OidcClientRow {
  client_id: string;
  installation_id: string;
  service_id: string;
  issuer_url: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  subject_mode: "pairwise";
  token_endpoint_auth_method: OidcClientRecord["tokenEndpointAuthMethod"];
  client_secret_hash: string | null;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface LedgerAccountRow {
  account_id: string;
  legal_owner_subject: TakosumiSubject;
  billing_account_id: string | null;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface SpaceRow {
  space_id: string;
  account_id: string;
  kind: SpaceKind;
  display_name: string | null;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface AppInstallationRow {
  installation_id: string;
  account_id: string;
  space_id: string;
  app_id: string;
  source_git_url: string;
  source_ref: string;
  source_commit: string;
  plan_digest: string;
  artifact_digest: string | null;
  mode: InstallationRecord["mode"];
  // Wave 6 dropped the `runtime_binding_id` column. The select clause in
  // `appInstallationSelect()` no longer reads it; `runtimeBindingId` on
  // the decoded `InstallationRecord` is always `undefined`.
  billing_account_id: string | null;
  status: InstallationRecord["status"];
  created_by_subject: TakosumiSubject;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface RuntimeBindingRow {
  runtime_binding_id: string;
  installation_id: string;
  mode: RuntimeBindingRecord["mode"];
  target_type: RuntimeBindingRecord["targetType"];
  target_id: string;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface AppBindingRow {
  binding_id: string;
  installation_id: string;
  name: string;
  kind: AppBindingRecord["kind"];
  config_ref: string;
  secret_refs: string[];
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface AppGrantRow {
  grant_id: string;
  installation_id: string;
  capability: string;
  scope: unknown;
  granted_at: TimeValue;
  revoked_at: TimeValue | null;
}

export interface InstallationEventRow {
  event_id: string;
  installation_id: string;
  event_type: string;
  payload: unknown;
  previous_event_hash: string | null;
  event_hash: string;
  created_at: TimeValue;
}

export function accountFromRow(row: AccountRow): TakosumiAccountRecord {
  return {
    subject: row.subject,
    email: optional(row.email),
    // Map SQL NULL -> undefined (unknown), preserving the tri-state. A stored
    // `false` is a genuine "not verified" assertion and must NOT collapse to
    // undefined.
    emailVerified: optional(row.email_verified),
    displayName: optional(row.display_name),
    termsVersion: optional(row.terms_version),
    termsAcceptedAt: optionalMillis(row.terms_accepted_at),
    termsAcceptedSource: optional(row.terms_accepted_source),
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function upstreamIdentityFromRow(
  row: UpstreamIdentityRow,
): UpstreamIdentityRecord {
  return {
    providerId: row.provider_id,
    upstreamIssuer: row.upstream_issuer,
    upstreamSubject: row.upstream_subject,
    subject: row.subject,
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function passkeyCredentialFromRow(
  row: PasskeyCredentialRow,
): PasskeyCredentialRecord {
  return {
    credentialId: row.credential_id,
    subject: row.subject,
    publicKeyJwk: objectJson(row.public_key_jwk) as JsonWebKey,
    signCount: Number(row.sign_count),
    transports: row.transports ?? [],
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function accountSessionFromRow(
  row: AccountSessionRow,
): AccountSessionRecord {
  return {
    sessionId: row.session_id,
    subject: row.subject,
    createdAt: millis(row.created_at),
    expiresAt: millis(row.expires_at),
  };
}

export function billingAccountFromRow(
  row: BillingAccountRow,
): BillingAccountRecord {
  return {
    billingAccountId: row.billing_account_id,
    subject: row.subject,
    provider: row.provider,
    stripeCustomerId: optional(row.stripe_customer_id),
    stripeSubscriptionId: optional(row.stripe_subscription_id),
    stripePriceId: optional(row.stripe_price_id),
    planCode: optional(row.plan_code),
    currentPeriodEndUnix:
      row.current_period_end_unix === null
        ? undefined
        : Number(row.current_period_end_unix),
    lastInvoiceId: optional(row.last_invoice_id),
    dunningStartedAt: optionalMillis(row.dunning_started_at),
    nextPaymentAttemptUnix:
      row.next_payment_attempt_unix === null
        ? undefined
        : Number(row.next_payment_attempt_unix),
    dunningAttemptCount:
      row.dunning_attempt_count === null
        ? undefined
        : Number(row.dunning_attempt_count),
    dunningAction: optional(row.dunning_action),
    dunningExhaustedAt: optionalMillis(row.dunning_exhausted_at),
    lastCreditEventId: optional(row.last_credit_event_id),
    lastCreditKind: optional(row.last_credit_kind),
    lastCreditId: optional(row.last_credit_id),
    lastCreditAmount:
      row.last_credit_amount === null
        ? undefined
        : Number(row.last_credit_amount),
    lastCreditCurrency: optional(row.last_credit_currency),
    lastPlanTransitionEventId: optional(row.last_plan_transition_event_id),
    lastPlanFromCode: optional(row.last_plan_from_code),
    lastPlanToCode: optional(row.last_plan_to_code),
    lastPlanTransitionedAt: optionalMillis(row.last_plan_transitioned_at),
    lastTaxEventId: optional(row.last_tax_event_id),
    taxPolicyRef: optional(row.tax_policy_ref),
    taxJurisdiction: optional(row.tax_jurisdiction),
    taxAutomaticStatus: optional(row.tax_automatic_status),
    status: row.status,
    version: row.version === null ? undefined : Number(row.version),
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function billingWebhookEventFromRow(
  row: BillingWebhookEventRow,
): BillingWebhookEventRecord {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    status: row.status,
    receivedAt: millis(row.received_at),
    updatedAt: millis(row.updated_at),
    errorMessage: optional(row.error_message),
  };
}

export function billingUsageFromRow(row: BillingUsageRow): BillingUsageRecord {
  return {
    usageReportId: row.usage_report_id,
    installationId: row.installation_id,
    billingAccountId: row.billing_account_id,
    meter: row.meter,
    quantity: Number(row.quantity),
    unit: row.unit,
    periodStart:
      row.period_start === null ? undefined : millis(row.period_start),
    periodEnd: row.period_end === null ? undefined : millis(row.period_end),
    idempotencyKey: optional(row.idempotency_key),
    requestDigest: row.request_digest,
    metadata: objectJson(row.metadata),
    reportedBySubject: row.reported_by_subject ?? undefined,
    reportedAt: millis(row.reported_at),
  };
}

export function authorizationCodeFromRow(
  row: AuthorizationCodeRow,
): AuthorizationCodeRecord {
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    subject: row.subject,
    takosumiSubject: optional(row.takosumi_subject),
    installationId: optional(row.installation_id),
    appId: optional(row.app_id),
    spaceId: optional(row.space_id),
    role: optional(row.role),
    nonce: optional(row.nonce),
    codeChallenge: optional(row.code_challenge),
    codeChallengeMethod: optional(row.code_challenge_method),
    expiresAt: millis(row.expires_at),
  };
}

export function tokenFromRow(row: TokenRow): TokenRecord {
  return {
    clientId: row.client_id,
    scope: row.scope,
    subject: row.subject,
    takosumiSubject: optional(row.takosumi_subject),
    installationId: optional(row.installation_id),
    appId: optional(row.app_id),
    spaceId: optional(row.space_id),
    role: optional(row.role),
    expiresAt: millis(row.expires_at),
  };
}

export function personalAccessTokenFromRow(
  row: PersonalAccessTokenRow,
): PersonalAccessTokenRecord {
  return {
    tokenId: row.token_id,
    tokenPrefix: row.token_prefix,
    subject: row.subject,
    name: row.name,
    scopes: row.scopes,
    createdAt: millis(row.created_at),
    expiresAt: row.expires_at === null ? undefined : millis(row.expires_at),
    revokedAt: row.revoked_at === null ? undefined : millis(row.revoked_at),
    lastUsedAt:
      row.last_used_at === null ? undefined : millis(row.last_used_at),
  };
}

export function launchTokenFromRow(row: LaunchTokenRow): LaunchTokenRecord {
  return {
    tokenHash: row.token_hash,
    jti: row.jti,
    installationId: row.installation_id,
    accountId: row.account_id,
    spaceId: row.space_id,
    appId: row.app_id,
    subject: row.subject,
    redirectUri: row.redirect_uri,
    scope: row.scopes,
    expiresAt: millis(row.expires_at),
    createdAt: millis(row.created_at),
    usedAt: row.used_at === null ? undefined : millis(row.used_at),
  };
}

export function oidcClientFromRow(row: OidcClientRow): OidcClientRecord {
  return {
    clientId: row.client_id,
    installationId: row.installation_id,
    namespacePath: row.service_id,
    issuerUrl: row.issuer_url,
    redirectUris: row.redirect_uris,
    allowedScopes: row.allowed_scopes,
    subjectMode: row.subject_mode,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    clientSecretHash: optional(row.client_secret_hash),
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function ledgerAccountFromRow(
  row: LedgerAccountRow,
): LedgerAccountRecord {
  return {
    accountId: row.account_id,
    legalOwnerSubject: row.legal_owner_subject,
    billingAccountId: optional(row.billing_account_id),
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function spaceFromRow(row: SpaceRow): SpaceRecord {
  return {
    spaceId: row.space_id,
    accountId: row.account_id,
    kind: row.kind,
    displayName: optional(row.display_name),
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function appInstallationFromRow(
  row: AppInstallationRow,
): InstallationRecord {
  return {
    installationId: row.installation_id,
    accountId: row.account_id,
    spaceId: row.space_id,
    appId: row.app_id,
    sourceGitUrl: row.source_git_url,
    sourceRef: row.source_ref,
    sourceCommit: row.source_commit,
    planDigest: row.plan_digest,
    artifactDigest: optional(row.artifact_digest),
    mode: row.mode,
    // Wave 6 dropped `runtime_binding_id`; we no longer read it.
    // `InstallationRecord.runtimeBindingId` stays optional for the
    // in-memory store, but the postgres-backed read path always
    // yields `undefined` here.
    billingAccountId: optional(row.billing_account_id),
    status: row.status,
    createdBySubject: row.created_by_subject,
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function runtimeBindingFromRow(
  row: RuntimeBindingRow,
): RuntimeBindingRecord {
  return {
    runtimeBindingId: row.runtime_binding_id,
    installationId: row.installation_id,
    mode: row.mode,
    targetType: row.target_type,
    targetId: row.target_id,
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function appBindingFromRow(row: AppBindingRow): AppBindingRecord {
  return {
    bindingId: row.binding_id,
    installationId: row.installation_id,
    name: row.name,
    kind: row.kind,
    configRef: row.config_ref,
    secretRefs: row.secret_refs,
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

export function appGrantFromRow(row: AppGrantRow): AppGrantRecord {
  if (!isAppGrantCapability(row.capability)) {
    throw new TypeError(
      `invalid AppGrant capability in database: ${row.capability}`,
    );
  }
  return {
    grantId: row.grant_id,
    installationId: row.installation_id,
    capability: row.capability,
    scope: objectJson<Record<string, unknown>>(row.scope),
    grantedAt: millis(row.granted_at),
    revokedAt: row.revoked_at === null ? undefined : millis(row.revoked_at),
  };
}

export function installationEventFromRow(
  row: InstallationEventRow,
): InstallationEventRecord {
  return {
    eventId: row.event_id,
    installationId: row.installation_id,
    eventType: row.event_type,
    payload: objectJson<Record<string, unknown>>(row.payload),
    previousEventHash: optional(row.previous_event_hash),
    eventHash: row.event_hash,
    createdAt: millis(row.created_at),
  };
}

// `appGrantSelect()` removed: Wave 6 dropped `installation_v1.app_grants`
// and Phase I converted all readers to no-op shims. The query builder
// became unreachable dead code (Phase K audit K5).

export function toDate(ms: number): Date {
  return new Date(ms);
}

export function millis(value: TimeValue): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

export function optionalMillis(
  value: TimeValue | null | undefined,
): number | undefined {
  return value === null || value === undefined ? undefined : millis(value);
}

export function optional<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

function selectedDriverColumns(query: string): readonly string[] {
  const lower = query.toLowerCase();
  const select = lower.match(/^select\s+([\s\S]+?)\s+from\s/);
  const returning = lower.match(/\sreturning\s+([\s\S]+)$/);
  const list = select?.[1] ?? returning?.[1];
  if (!list) return [];
  return list.split(",").map((part) => {
    const alias = /\s+as\s+"?([a-z_][a-z0-9_]*)"?\s*$/.exec(part);
    if (alias) return alias[1];
    const identifiers = [...part.matchAll(/"?([a-z_][a-z0-9_]*)"?/g)];
    return identifiers.at(-1)?.[1] ?? part.trim().replaceAll('"', "");
  });
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function objectJson<T = Record<string, unknown>>(value: unknown): T {
  const parsed = parseJson(value);
  return isRecord(parsed) ? (parsed as T) : ({} as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// hashSecret is the canonical sha256:<base64url> hasher (encoding.ts
// sha256Text); re-exported under this name so the per-domain Postgres modules
// keep importing `hashSecret` from internal.ts.
export { sha256Text as hashSecret } from "../encoding.ts";
