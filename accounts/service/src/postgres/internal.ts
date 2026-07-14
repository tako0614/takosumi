// Shared helpers, row types, and row converters used by per-domain Postgres
// operation modules. Behaviour-preserving: extracted verbatim from the
// monolithic `postgres-store.ts`.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { drizzle, type PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import type {
  AccountSessionRecord,
  AuthorizationCodeRecord,
  OidcClientRecord,
  PasskeyCredentialRecord,
  PersonalAccessTokenRecord,
  PrivacyRequestRecord,
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
  picture: string | null;
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

export interface PrivacyRequestRow {
  request_id: string;
  subject: TakosumiSubject;
  kind: PrivacyRequestRecord["kind"];
  status: PrivacyRequestRecord["status"];
  retention_record_id: string;
  policy_ref: string;
  request_summary: string | null;
  export_ref: string | null;
  completed_at: TimeValue | null;
  created_at: TimeValue;
  updated_at: TimeValue;
}

export interface AuthorizationCodeRow {
  client_id: string;
  redirect_uri: string;
  scope: string;
  subject: string;
  takosumi_subject: TakosumiSubject | null;
  capsule_id: string | null;
  workspace_id: string | null;
  role: string | null;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  expires_at: TimeValue;
}

export interface TokenRow {
  client_id: string;
  audience: string | null;
  scope: string;
  subject: string;
  takosumi_subject: TakosumiSubject | null;
  capsule_id: string | null;
  workspace_id: string | null;
  role: string | null;
  interface_id: string | null;
  interface_binding_id: string | null;
  interface_resolved_revision: number | string | null;
  expires_at: TimeValue;
}

export interface PersonalAccessTokenRow {
  token_id: string;
  token_prefix: string;
  subject: TakosumiSubject;
  name: string;
  scopes: PersonalAccessTokenRecord["scopes"];
  workspace_id: string | null;
  created_at: TimeValue;
  expires_at: TimeValue | null;
  revoked_at: TimeValue | null;
  last_used_at: TimeValue | null;
}

export interface OidcClientRow {
  client_id: string;
  capsule_id: string;
  namespace_path: string;
  issuer_url: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  subject_mode: "pairwise";
  token_endpoint_auth_method: OidcClientRecord["tokenEndpointAuthMethod"];
  client_secret_hash: string | null;
  created_at: TimeValue;
  updated_at: TimeValue;
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
    picture: optional(row.picture),
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

export function privacyRequestFromRow(
  row: PrivacyRequestRow,
): PrivacyRequestRecord {
  return {
    requestId: row.request_id,
    subject: row.subject,
    kind: row.kind,
    status: row.status,
    retentionRecordId: row.retention_record_id,
    policyRef: row.policy_ref,
    requestSummary: optional(row.request_summary),
    exportRef: optional(row.export_ref),
    completedAt: optionalMillis(row.completed_at),
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
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
    capsuleId: optional(row.capsule_id),
    workspaceId: optional(row.workspace_id),
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
    audience: optional(row.audience),
    scope: row.scope,
    subject: row.subject,
    takosumiSubject: optional(row.takosumi_subject),
    capsuleId: optional(row.capsule_id),
    workspaceId: optional(row.workspace_id),
    role: optional(row.role),
    interfaceId: optional(row.interface_id),
    interfaceBindingId: optional(row.interface_binding_id),
    interfaceResolvedRevision: optionalSafeInteger(
      row.interface_resolved_revision,
    ),
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
    workspaceId: row.workspace_id ?? undefined,
    createdAt: millis(row.created_at),
    expiresAt: row.expires_at === null ? undefined : millis(row.expires_at),
    revokedAt: row.revoked_at === null ? undefined : millis(row.revoked_at),
    lastUsedAt:
      row.last_used_at === null ? undefined : millis(row.last_used_at),
  };
}

export function oidcClientFromRow(row: OidcClientRow): OidcClientRecord {
  return {
    clientId: row.client_id,
    capsuleId: row.capsule_id,
    namespacePath: row.namespace_path,
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

function optionalSafeInteger(
  value: number | string | null | undefined,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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
