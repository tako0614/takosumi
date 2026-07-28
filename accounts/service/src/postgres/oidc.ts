// Capsule OIDC client registration storage owned by the Accounts schema.
// Free-function module preserving the upsert + lookup semantics of the
// original PostgresAccountsStore.

import type { OidcClientRecord } from "../store.ts";
import { eq } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import {
  oidcClientFromRow,
  type OidcClientRow,
  postgresDrizzle,
  type PostgresQueryClient,
  toDate,
} from "./internal.ts";

const accountsV1 = pgSchema("accounts_v1");

const oidcClients = accountsV1.table("oidc_clients", {
  clientId: text("client_id").primaryKey(),
  capsuleId: text("capsule_id").notNull(),
  serviceId: text("namespace_path").notNull(),
  issuerUrl: text("issuer_url").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  allowedScopes: text("allowed_scopes").array().notNull(),
  subjectMode: text("subject_mode").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),
  clientSecretHash: text("client_secret_hash"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

const oidcSchema = { oidcClients };

export async function saveOidcClient(
  client: PostgresQueryClient,
  record: OidcClientRecord,
): Promise<void> {
  const values = oidcClientValues(record);
  await postgresDrizzle(client, oidcSchema)
    .insert(oidcClients)
    .values(values)
    .onConflictDoUpdate({
      target: oidcClients.clientId,
      set: {
        serviceId: values.serviceId,
        issuerUrl: values.issuerUrl,
        redirectUris: values.redirectUris,
        allowedScopes: values.allowedScopes,
        subjectMode: values.subjectMode,
        tokenEndpointAuthMethod: values.tokenEndpointAuthMethod,
        clientSecretHash: values.clientSecretHash,
        updatedAt: values.updatedAt,
      },
      // A client id is a stable security-principal binding. Never let an
      // upsert transfer it to another Capsule, including under a concurrent
      // provisioning race.
      setWhere: eq(oidcClients.capsuleId, record.capsuleId),
    });
}

export async function findOidcClient(
  client: PostgresQueryClient,
  clientId: string,
): Promise<OidcClientRecord | undefined> {
  const row = await postgresDrizzle(client, oidcSchema)
    .select(oidcClientColumns)
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1)
    .then((rows) => rows[0] as OidcClientRow | undefined);
  return row ? oidcClientFromRow(row) : undefined;
}

export async function findOidcClientForCapsule(
  client: PostgresQueryClient,
  capsuleId: string,
): Promise<OidcClientRecord | undefined> {
  const row = await postgresDrizzle(client, oidcSchema)
    .select(oidcClientColumns)
    .from(oidcClients)
    .where(eq(oidcClients.capsuleId, capsuleId))
    .limit(1)
    .then((rows) => rows[0] as OidcClientRow | undefined);
  return row ? oidcClientFromRow(row) : undefined;
}

export async function revokeOidcClient(
  client: PostgresQueryClient,
  clientId: string,
): Promise<void> {
  await postgresDrizzle(client, oidcSchema)
    .delete(oidcClients)
    .where(eq(oidcClients.clientId, clientId));
}

const oidcClientColumns = {
  client_id: oidcClients.clientId,
  capsule_id: oidcClients.capsuleId,
  namespace_path: oidcClients.serviceId,
  issuer_url: oidcClients.issuerUrl,
  redirect_uris: oidcClients.redirectUris,
  allowed_scopes: oidcClients.allowedScopes,
  subject_mode: oidcClients.subjectMode,
  token_endpoint_auth_method: oidcClients.tokenEndpointAuthMethod,
  client_secret_hash: oidcClients.clientSecretHash,
  created_at: oidcClients.createdAt,
  updated_at: oidcClients.updatedAt,
};

function oidcClientValues(record: OidcClientRecord) {
  return {
    clientId: record.clientId,
    capsuleId: record.capsuleId,
    serviceId: record.namespacePath,
    issuerUrl: record.issuerUrl,
    redirectUris: [...record.redirectUris],
    allowedScopes: [...record.allowedScopes],
    subjectMode: record.subjectMode,
    tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
    clientSecretHash: record.clientSecretHash ?? null,
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
  };
}
