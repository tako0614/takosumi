// OIDC client (per-installation downstream OAuth/OIDC client) storage.
// Free-function module preserving the upsert + lookup semantics of the
// original PostgresAccountsStore.

import type { OidcClientRecord } from "../store.ts";
import {
  oidcClientFromRow,
  type OidcClientRow,
  oidcClientSelect,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  toDate,
} from "./internal.ts";

export async function saveOidcClient(
  client: PostgresQueryClient,
  record: OidcClientRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO installation_v1.oidc_clients (
        client_id, installation_id, service_id, issuer_url, redirect_uris,
        allowed_scopes, subject_mode, token_endpoint_auth_method,
        client_secret_hash, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (client_id) DO UPDATE SET
        installation_id = EXCLUDED.installation_id,
        service_id = EXCLUDED.service_id,
        issuer_url = EXCLUDED.issuer_url,
        redirect_uris = EXCLUDED.redirect_uris,
        allowed_scopes = EXCLUDED.allowed_scopes,
        subject_mode = EXCLUDED.subject_mode,
        token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
        client_secret_hash = EXCLUDED.client_secret_hash,
        updated_at = EXCLUDED.updated_at`,
    [
      record.clientId,
      record.installationId,
      record.namespacePath,
      record.issuerUrl,
      [...record.redirectUris],
      [...record.allowedScopes],
      record.subjectMode,
      record.tokenEndpointAuthMethod,
      record.clientSecretHash ?? null,
      toDate(record.createdAt),
      toDate(record.updatedAt),
    ],
  );
}

export async function findOidcClient(
  client: PostgresQueryClient,
  clientId: string,
): Promise<OidcClientRecord | undefined> {
  const row = await runFirst<OidcClientRow>(
    client,
    oidcClientSelect("client_id = $1"),
    [clientId],
  );
  return row ? oidcClientFromRow(row) : undefined;
}

export async function findOidcClientForInstallation(
  client: PostgresQueryClient,
  installationId: string,
): Promise<OidcClientRecord | undefined> {
  const row = await runFirst<OidcClientRow>(
    client,
    oidcClientSelect("installation_id = $1"),
    [installationId],
  );
  return row ? oidcClientFromRow(row) : undefined;
}
