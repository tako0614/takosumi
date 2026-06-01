// Takosumi accounts and upstream identity links. Free-function module
// preserving the SQL upserts from the original PostgresAccountsStore.

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  TakosumiAccountRecord,
  UpstreamIdentityRecord,
} from "../store.ts";
import {
  accountFromRow,
  type AccountRow,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  toDate,
  upstreamIdentityFromRow,
  type UpstreamIdentityRow,
} from "./internal.ts";

export async function saveAccount(
  client: PostgresQueryClient,
  record: TakosumiAccountRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.accounts (
        subject, email, email_verified, display_name, terms_version,
        terms_accepted_at, terms_accepted_source, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (subject) DO UPDATE SET
        email = EXCLUDED.email,
        email_verified = COALESCE(EXCLUDED.email_verified, accounts_v1.accounts.email_verified),
        display_name = EXCLUDED.display_name,
        terms_version = COALESCE(EXCLUDED.terms_version, accounts_v1.accounts.terms_version),
        terms_accepted_at = COALESCE(EXCLUDED.terms_accepted_at, accounts_v1.accounts.terms_accepted_at),
        terms_accepted_source = COALESCE(EXCLUDED.terms_accepted_source, accounts_v1.accounts.terms_accepted_source),
        updated_at = EXCLUDED.updated_at`,
    [
      record.subject,
      record.email ?? null,
      // Tri-state: persist NULL when genuinely unknown so a re-read returns
      // `undefined`, never a coerced `false`. The COALESCE on update keeps a
      // previously-asserted value when a later save omits the claim.
      record.emailVerified ?? null,
      record.displayName ?? null,
      record.termsVersion ?? null,
      record.termsAcceptedAt ? toDate(record.termsAcceptedAt) : null,
      record.termsAcceptedSource ?? null,
      toDate(record.createdAt),
      toDate(record.updatedAt),
    ],
  );
}

export async function findAccount(
  client: PostgresQueryClient,
  subject: TakosumiSubject,
): Promise<TakosumiAccountRecord | undefined> {
  const row = await runFirst<AccountRow>(
    client,
    `SELECT subject, email, email_verified, display_name, terms_version,
              terms_accepted_at, terms_accepted_source, created_at, updated_at
       FROM accounts_v1.accounts
       WHERE subject = $1`,
    [subject],
  );
  return row ? accountFromRow(row) : undefined;
}

export async function linkUpstreamIdentity(
  client: PostgresQueryClient,
  record: UpstreamIdentityRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO accounts_v1.upstream_identities (
        provider_id, upstream_issuer, upstream_subject, subject, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (provider_id, upstream_issuer, upstream_subject) DO UPDATE SET
        subject = EXCLUDED.subject,
        updated_at = EXCLUDED.updated_at`,
    [
      record.providerId,
      record.upstreamIssuer,
      record.upstreamSubject,
      record.subject,
      toDate(record.createdAt),
      toDate(record.updatedAt),
    ],
  );
}

export async function findUpstreamIdentity(
  client: PostgresQueryClient,
  input: {
    providerId: string;
    upstreamIssuer: string;
    upstreamSubject: string;
  },
): Promise<UpstreamIdentityRecord | undefined> {
  const row = await runFirst<UpstreamIdentityRow>(
    client,
    `SELECT provider_id, upstream_issuer, upstream_subject, subject, created_at, updated_at
       FROM accounts_v1.upstream_identities
       WHERE provider_id = $1 AND upstream_issuer = $2 AND upstream_subject = $3`,
    [input.providerId, input.upstreamIssuer, input.upstreamSubject],
  );
  return row ? upstreamIdentityFromRow(row) : undefined;
}
