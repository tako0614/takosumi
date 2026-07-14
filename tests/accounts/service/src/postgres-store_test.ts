import { expect, test } from "bun:test";
import {
  PostgresAccountsStore,
  type PostgresQueryClient,
  type PostgresQueryResult,
} from "../../../../accounts/service/src/postgres-store.ts";

class RecordingPostgresClient implements PostgresQueryClient {
  calls: Array<{ sql: string; args: readonly unknown[] }> = [];
  queuedRows: unknown[][] = [];

  queryObject<T>(
    sql: string,
    args: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<T>> {
    this.calls.push({ sql, args });
    return Promise.resolve({ rows: (this.queuedRows.shift() ?? []) as T[] });
  }
}

test("PostgresAccountsStore hashes OAuth credentials before writing", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.saveAuthorizationCode("plain-code", {
    clientId: "client-1",
    redirectUri: "https://app.example.test/callback",
    scope: "openid profile",
    subject: "sub_pairwise",
    takosumiSubject: "tsub_owner",
    nonce: "nonce-1",
    expiresAt: 2_000,
  });

  expect(client.calls[0].sql).toContain('"accounts_v1"."authorization_codes"');
  expect(typeof client.calls[0].args[0]).toEqual("string");
  expect(String(client.calls[0].args[0])).toContain("sha256:");
  expect(client.calls[0].args[0]).not.toEqual("plain-code");
});

test("PostgresAccountsStore persists Interface OAuth evidence without the raw token", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);
  const expiresAt = Date.now() + 60_000;

  await store.saveAccessToken("taksrv_plain_secret", {
    clientId: "https://office.example.test/mcp",
    audience: "https://office.example.test/mcp",
    scope: "mcp.invoke",
    subject: "pairwise_pg_subject",
    takosumiSubject: "tsub_owner",
    capsuleId: "inst_office",
    workspaceId: "ws_owner",
    role: "interface-runtime",
    interfaceId: "if_office",
    interfaceBindingId: "ifb_office",
    interfaceResolvedRevision: 4,
    expiresAt,
  });

  expect(client.calls[0].sql).toContain('"accounts_v1"."oauth_access_tokens"');
  expect(client.calls[0].sql).toContain('"audience"');
  expect(client.calls[0].sql).toContain('"interface_id"');
  expect(client.calls[0].sql).toContain('"interface_binding_id"');
  expect(client.calls[0].sql).toContain('"interface_resolved_revision"');
  expect(client.calls[0].args).not.toContain("taksrv_plain_secret");
  expect(String(client.calls[0].args[0])).toStartWith("sha256:");

  client.queuedRows.push([
    {
      client_id: "https://office.example.test/mcp",
      audience: "https://office.example.test/mcp",
      scope: "mcp.invoke",
      subject: "pairwise_pg_subject",
      takosumi_subject: "tsub_owner",
      capsule_id: "inst_office",
      workspace_id: "ws_owner",
      role: "interface-runtime",
      interface_id: "if_office",
      interface_binding_id: "ifb_office",
      interface_resolved_revision: "4",
      expires_at: new Date(expiresAt),
    },
  ]);
  expect(await store.findAccessToken("taksrv_plain_secret")).toMatchObject({
    clientId: "https://office.example.test/mcp",
    audience: "https://office.example.test/mcp",
    scope: "mcp.invoke",
    subject: "pairwise_pg_subject",
    takosumiSubject: "tsub_owner",
    capsuleId: "inst_office",
    workspaceId: "ws_owner",
    role: "interface-runtime",
    interfaceId: "if_office",
    interfaceBindingId: "ifb_office",
    interfaceResolvedRevision: 4,
    expiresAt,
  });
});

test("PostgresAccountsStore hashes personal access tokens before writing", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.savePersonalAccessToken("takpat_plain", {
    tokenId: "pat_1",
    tokenPrefix: "takpat_pl",
    subject: "tsub_owner",
    name: "CLI",
    scopes: ["read", "write"],
    createdAt: 1_000,
  });

  expect(client.calls[0].sql).toContain(
    '"accounts_v1"."personal_access_tokens"',
  );
  expect(String(client.calls[0].args[1])).toContain("sha256:");
  expect(client.calls[0].args[1]).not.toEqual("takpat_plain");
});

test("PostgresAccountsStore maps account terms acceptance", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.saveAccount({
    subject: "tsub_owner",
    email: "owner@example.test",
    displayName: "Owner",
    picture: "https://accounts.example.test/owner.png",
    termsVersion: "terms-2026-05-13",
    termsAcceptedAt: 1_500,
    termsAcceptedSource: "account-terms",
    createdAt: 1_000,
    updatedAt: 2_000,
  });

  expect(client.calls[0].sql).toContain("email_verified");
  expect(client.calls[0].sql).toContain("picture");
  expect(client.calls[0].sql).toContain("terms_version");
  expect(client.calls[0].sql).toContain("terms_accepted_at");
  // `email_verified` is bound as $3 (no upstream assertion here -> null), and
  // the optional picture occupies the next profile slot before terms.
  expect(client.calls[0].args[2]).toEqual(null);
  expect(client.calls[0].args[4]).toEqual(
    "https://accounts.example.test/owner.png",
  );
  expect(client.calls[0].args[5]).toEqual("terms-2026-05-13");
  expect(client.calls[0].args[6]).toEqual("1970-01-01T00:00:01.500Z");
  expect(client.calls[0].args[7]).toEqual("account-terms");

  client.queuedRows.push([
    {
      subject: "tsub_owner",
      email: "owner@example.test",
      email_verified: true,
      display_name: "Owner",
      picture: "https://accounts.example.test/owner.png",
      terms_version: "terms-2026-05-13",
      terms_accepted_at: new Date(1_500),
      terms_accepted_source: "account-terms",
      created_at: new Date(1_000),
      updated_at: new Date(2_000),
    },
  ]);

  const record = await store.findAccount("tsub_owner");

  // The SELECT must read `email_verified` and `findAccount` must surface it as
  // `emailVerified` so the value survives the re-read at OIDC token issuance.
  expect(client.calls[1].sql).toContain("email_verified");
  expect(record).toEqual({
    subject: "tsub_owner",
    email: "owner@example.test",
    emailVerified: true,
    displayName: "Owner",
    picture: "https://accounts.example.test/owner.png",
    termsVersion: "terms-2026-05-13",
    termsAcceptedAt: 1_500,
    termsAcceptedSource: "account-terms",
    createdAt: 1_000,
    updatedAt: 2_000,
  });

  client.queuedRows.push([
    {
      subject: "tsub_member",
      email: "member@example.test",
      email_verified: true,
      display_name: "Member",
      picture: null,
      terms_version: null,
      terms_accepted_at: null,
      terms_accepted_source: null,
      created_at: new Date(3_000),
      updated_at: new Date(4_000),
    },
  ]);
  const member = await store.findAccountByVerifiedEmail(
    " MEMBER@example.test ",
  );
  expect(client.calls[2].sql).toContain("email_verified");
  expect(client.calls[2].sql).toContain("lower");
  expect(client.calls[2].args).toContain("member@example.test");
  expect(member?.subject).toEqual("tsub_member");
});

test("PostgresAccountsStore maps upstream identities through Drizzle", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.linkUpstreamIdentity({
    providerId: "oidc-main",
    upstreamIssuer: "https://issuer.example.test",
    upstreamSubject: "upstream-sub",
    subject: "tsub_owner",
    createdAt: 1_000,
    updatedAt: 2_000,
  });

  expect(client.calls[0].sql).toContain('"accounts_v1"."upstream_identities"');
  expect(client.calls[0].sql).toContain("on conflict");

  client.queuedRows.push([
    {
      provider_id: "oidc-main",
      upstream_issuer: "https://issuer.example.test",
      upstream_subject: "upstream-sub",
      subject: "tsub_owner",
      created_at: new Date(1_000),
      updated_at: new Date(2_000),
    },
  ]);

  const record = await store.findUpstreamIdentity({
    providerId: "oidc-main",
    upstreamIssuer: "https://issuer.example.test",
    upstreamSubject: "upstream-sub",
  });

  expect(client.calls[1].sql).toContain('"accounts_v1"."upstream_identities"');
  expect(record).toEqual({
    providerId: "oidc-main",
    upstreamIssuer: "https://issuer.example.test",
    upstreamSubject: "upstream-sub",
    subject: "tsub_owner",
    createdAt: 1_000,
    updatedAt: 2_000,
  });
});

test("PostgresAccountsStore maps passkeys and single-shot challenges through Drizzle", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.savePasskeyCredential({
    credentialId: "cred_1",
    subject: "tsub_owner",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    signCount: 7,
    transports: ["internal"],
    createdAt: 1_000,
    updatedAt: 2_000,
  });

  expect(client.calls[0].sql).toContain('"accounts_v1"."passkey_credentials"');
  expect(client.calls[0].sql).toContain("on conflict");

  client.queuedRows.push([
    {
      credential_id: "cred_1",
      subject: "tsub_owner",
      public_key_jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      sign_count: 7,
      transports: ["internal"],
      created_at: new Date(1_000),
      updated_at: new Date(2_000),
    },
  ]);

  expect(await store.findPasskeyCredential("cred_1")).toEqual({
    credentialId: "cred_1",
    subject: "tsub_owner",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    signCount: 7,
    transports: ["internal"],
    createdAt: 1_000,
    updatedAt: 2_000,
  });

  client.queuedRows.push([
    {
      credential_id: "cred_1",
      subject: "tsub_owner",
      public_key_jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      sign_count: 7,
      transports: ["internal"],
      created_at: new Date(1_000),
      updated_at: new Date(2_000),
    },
  ]);

  expect(await store.listPasskeyCredentialsForSubject("tsub_owner")).toEqual([
    {
      credentialId: "cred_1",
      subject: "tsub_owner",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      signCount: 7,
      transports: ["internal"],
      createdAt: 1_000,
      updatedAt: 2_000,
    },
  ]);
  expect(client.calls[2].sql).toContain("order by");

  await store.savePasskeyChallenge("challenge-key", "challenge", 3_000);
  expect(client.calls[3].sql).toContain('"accounts_v1"."passkey_challenges"');

  client.queuedRows.push([
    { challenge: "challenge", expires_at: new Date(3_000) },
  ]);
  expect(await store.consumePasskeyChallenge("challenge-key", 2_000)).toEqual(
    "challenge",
  );
  expect(client.calls[4].sql).toContain("delete from");
  expect(client.calls[4].sql).toContain("returning");
});

test("PostgresAccountsStore maps hashed sessions through Drizzle", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.saveAccountSession({
    sessionId: "plain-session",
    subject: "tsub_owner",
    createdAt: 1_000,
    expiresAt: 3_000,
  });

  expect(client.calls[0].sql).toContain('"accounts_v1"."account_sessions"');
  expect(String(client.calls[0].args[0])).toContain("sha256:");
  expect(client.calls[0].args[0]).not.toEqual("plain-session");

  client.queuedRows.push([
    {
      session_id: client.calls[0].args[0],
      subject: "tsub_owner",
      created_at: new Date(1_000),
      expires_at: new Date(3_000),
    },
  ]);

  expect(await store.findAccountSession("plain-session")).toEqual({
    sessionId: "plain-session",
    subject: "tsub_owner",
    createdAt: 1_000,
    expiresAt: 3_000,
  });

  await store.deleteAccountSession("plain-session");
  expect(client.calls[2].sql).toContain("delete from");
  expect(client.calls[2].sql).toContain('"accounts_v1"."account_sessions"');
  expect(client.calls[2].args[0]).toEqual(client.calls[0].args[0]);
});

test("PostgresAccountsStore maps personal access token records", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push([
    {
      token_id: "pat_1",
      token_prefix: "takpat_ab",
      subject: "tsub_owner",
      name: "CLI",
      scopes: ["read", "admin"],
      created_at: new Date(1_000),
      expires_at: null,
      revoked_at: null,
      last_used_at: new Date(1_500),
    },
  ]);
  const store = new PostgresAccountsStore(client);

  const record = await store.findPersonalAccessToken("takpat_plain");

  expect(client.calls[0].sql).toContain('"token_hash" = $1');
  expect(record).toEqual({
    tokenId: "pat_1",
    tokenPrefix: "takpat_ab",
    subject: "tsub_owner",
    name: "CLI",
    scopes: ["read", "admin"],
    createdAt: 1_000,
    expiresAt: undefined,
    revokedAt: undefined,
    lastUsedAt: 1_500,
  });
});

test("PostgresAccountsStore consumes authorization codes with DELETE RETURNING mapping", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push([
    {
      client_id: "client-1",
      redirect_uri: "https://app.example.test/callback",
      scope: "openid",
      subject: "sub_pairwise",
      takosumi_subject: "tsub_owner",
      capsule_id: "inst_1",
      workspace_id: "space_1",
      role: "owner",
      nonce: "nonce-1",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      expires_at: new Date(2_000),
    },
  ]);
  const store = new PostgresAccountsStore(client);

  const record = await store.consumeAuthorizationCode("plain-code");

  expect(client.calls[0].sql).toContain(
    'delete from "accounts_v1"."authorization_codes"',
  );
  expect(client.calls[0].sql).toContain("returning");
  expect(record).toEqual({
    clientId: "client-1",
    redirectUri: "https://app.example.test/callback",
    scope: "openid",
    subject: "sub_pairwise",
    takosumiSubject: "tsub_owner",
    capsuleId: "inst_1",
    workspaceId: "space_1",
    role: "owner",
    nonce: "nonce-1",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    expiresAt: 2_000,
  });
});
