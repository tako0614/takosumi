import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  PostgresAccountsStore,
  type PostgresQueryClient,
  type PostgresQueryResult,
} from "../../../../accounts/service/src/postgres-store.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import { requireAccountsBearer } from "../../../../accounts/service/src/account-session.ts";

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

  transaction<T>(run: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
    return run(this);
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

  const legacyWrite = client.calls.find((call) =>
    call.sql.includes("INSERT INTO accounts_v1.authorization_codes"),
  );
  const lifecycleWrite = client.calls.find((call) =>
    call.sql.includes("INSERT INTO accounts_v1.authorization_code_redemptions"),
  );
  expect(legacyWrite).toBeDefined();
  expect(lifecycleWrite).toBeDefined();
  expect(String(legacyWrite?.args[0])).toStartWith("sha256:");
  expect(legacyWrite?.args).not.toContain("plain-code");
  expect(lifecycleWrite?.args).not.toContain("plain-code");
});

test("PostgresAccountsStore revokes a dynamic OIDC client by registration id", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.revokeOidcClient("toc_revoked");

  expect(client.calls[0].sql).toContain('"accounts_v1"."oidc_clients"');
  expect(client.calls[0].sql.toLowerCase()).toContain("delete");
  expect(client.calls[0].args).toContain("toc_revoked");
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

test("PostgresAccountsStore rotates sessions with one durable compare-and-replace statement", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);
  client.queuedRows.push([{ session_id: "stored-next-hash" }]);

  expect(
    await store.replaceAccountSession("plain-previous", {
      sessionId: "plain-next",
      subject: "tsub_rotation",
      createdAt: 1_000,
      expiresAt: 3_000,
    }),
  ).toBe(true);

  expect(client.calls).toHaveLength(1);
  expect(client.calls[0].sql.toLowerCase()).toContain("with removed as");
  expect(client.calls[0].sql.toLowerCase()).toContain(
    "delete from accounts_v1.account_sessions",
  );
  expect(client.calls[0].sql.toLowerCase()).toContain(
    "insert into accounts_v1.account_sessions",
  );
  expect(String(client.calls[0].args[0])).toStartWith("sha256:");
  expect(String(client.calls[0].args[1])).toStartWith("sha256:");
  expect(client.calls[0].args).not.toContain("plain-previous");
  expect(client.calls[0].args).not.toContain("plain-next");

  client.queuedRows.push([]);
  expect(
    await store.replaceAccountSession("plain-lost-race", {
      sessionId: "plain-unused",
      subject: "tsub_rotation",
      createdAt: 2_000,
      expiresAt: 4_000,
    }),
  ).toBe(false);
});

test("PostgresAccountsStore resolves all bearer candidates in one exact statement", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);
  const now = Date.now();
  client.queuedRows.push([
    {
      kind: "session",
      document: {
        session_id: "stored-session-hash",
        subject: "tsub_pg_bearer",
        created_at: new Date(now - 1_000),
        expires_at: new Date(now + 60_000),
      },
    },
    {
      kind: "session_account",
      document: {
        subject: "tsub_pg_bearer",
        email: null,
        email_verified: null,
        display_name: null,
        picture: null,
        terms_version: null,
        terms_accepted_at: null,
        terms_accepted_source: null,
        created_at: new Date(now - 1_000),
        updated_at: new Date(now - 1_000),
      },
    },
  ]);

  const result = await requireAccountsBearer({
    request: new Request("https://accounts.example.test/v1/control", {
      headers: { authorization: "Bearer opaque.pg.session" },
    }),
    store,
    scope: "read",
  });

  expect(result).toEqual({
    ok: true,
    auth: { subject: "tsub_pg_bearer", credential: "session" },
  });
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0].sql).toContain("presented_session");
  expect(client.calls[0].sql).toContain("presented_access_token");
  expect(client.calls[0].sql).toContain("presented_pat");
  expect(client.calls[0].args).toHaveLength(2);
  expect(client.calls[0].args).not.toContain("opaque.pg.session");
});

test("PostgresAccountsStore rejects a bearer collision from the same bounded resolver", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);
  const now = Date.now();
  client.queuedRows.push([
    {
      kind: "access_token",
      document: {
        client_id: "client_pg_collision",
        audience: null,
        scope: "capsules:read",
        subject: "principal_pg_collision",
        takosumi_subject: "tsub_pg_oauth",
        capsule_id: null,
        workspace_id: null,
        role: null,
        interface_id: null,
        interface_binding_id: null,
        interface_resolved_revision: null,
        expires_at: new Date(now + 60_000),
      },
    },
    {
      kind: "pat",
      document: {
        token_id: "pat_pg_collision",
        token_prefix: "display-only",
        subject: "tsub_pg_pat",
        name: "collision PAT",
        scopes: ["read"],
        workspace_id: null,
        created_at: new Date(now - 1_000),
        expires_at: null,
        revoked_at: null,
        last_used_at: null,
      },
    },
  ]);

  const result = await requireAccountsBearer({
    request: new Request("https://accounts.example.test/v1/control", {
      headers: { authorization: "Bearer opaque.pg.collision" },
    }),
    store,
    scope: "read",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(401);
  expect(client.calls).toHaveLength(1);
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

test("PostgresAccountsStore opens a versioned authorization-code snapshot under row lock", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push([
    {
      code_hash: "sha256:code-hash",
      record_version: "record-version-a",
      state: "active",
      claim_id: null,
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
      access_token_hash: null,
      refresh_token_hash: null,
      created_at: new Date(1_000),
      updated_at: new Date(1_000),
      claimed_at: null,
      issued_at: null,
      replayed_at: null,
      expires_at: new Date(2_000),
    },
  ]);
  const store = new PostgresAccountsStore(client);

  const opened = await store.openAuthorizationCodeRedemption("plain-code");

  expect(client.calls[0].sql).toContain(
    "FROM accounts_v1.authorization_code_redemptions",
  );
  expect(client.calls[0].sql).toContain("FOR UPDATE");
  expect(client.calls[0].args).not.toContain("plain-code");
  expect(opened).toEqual({
    status: "active",
    candidate: {
      redemptionId: "sha256:code-hash",
      recordVersion: "record-version-a",
      record: {
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
      },
    },
  });
});

test("PostgresAccountsStore fails closed when a pinned transaction is unavailable", async () => {
  let queries = 0;
  const store = new PostgresAccountsStore({
    queryObject<T>(): Promise<PostgresQueryResult<T>> {
      queries += 1;
      return Promise.resolve({ rows: [] });
    },
  });

  await expect(
    store.openAuthorizationCodeRedemption("plain-code"),
  ).rejects.toThrow(
    "Postgres authorization-code lifecycle requires a pinned transaction",
  );
  await expect(store.isRefreshRootRevoked("plain-refresh")).rejects.toThrow(
    "Postgres refresh-root replay fence requires a pinned transaction",
  );
  expect(queries).toBe(0);
});

test("PostgresAccountsStore refresh replay fence locks lifecycle authority before reading the marker", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push(
    [{ root_token_hash: "sha256:refresh-root" }],
    [{ state: "issued" }],
    [],
  );
  const store = new PostgresAccountsStore(client);

  expect(await store.isRefreshRootRevoked("plain-refresh")).toBe(false);
  expect(client.calls[0]?.sql).toContain("refresh_chain_links");
  expect(client.calls[1]?.sql).toContain(
    "accounts_v1.authorization_code_redemptions",
  );
  expect(client.calls[1]?.sql).toContain("auth_code_token_links");
  expect(client.calls[1]?.sql).toContain("FOR UPDATE");
  expect(client.calls[2]?.sql).toContain("revoked_refresh_roots");
});

test("PostgresAccountsStore claims the exact record version before deleting legacy authority", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push([
    {
      code_hash: "sha256:code-read",
      record_version: "record-version-read",
      state: "active",
      claim_id: null,
      client_id: "client-read",
      redirect_uri: "https://app.example.test/callback",
      scope: "openid",
      subject: "sub_pairwise",
      takosumi_subject: "tsub_owner",
      capsule_id: null,
      workspace_id: null,
      role: null,
      nonce: null,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      access_token_hash: null,
      refresh_token_hash: null,
      created_at: new Date(1_000),
      updated_at: new Date(1_000),
      claimed_at: null,
      issued_at: null,
      replayed_at: null,
      expires_at: new Date(2_000),
    },
  ]);
  const store = new PostgresAccountsStore(client);

  const result = await store.claimValidatedAuthorizationCode({
    redemptionId: "sha256:code-read",
    recordVersion: "record-version-read",
    record: {
      clientId: "client-read",
      redirectUri: "https://app.example.test/callback",
      scope: "openid",
      subject: "sub_pairwise",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      expiresAt: 2_000,
    },
  });

  expect(result).toMatchObject({ status: "claimed" });
  expect(client.calls[0].sql).toContain("FOR UPDATE");
  expect(client.calls[1].sql).toContain("state = 'issuing'");
  expect(client.calls[1].args).toContain("record-version-read");
  expect(client.calls[2].sql).toContain(
    "DELETE FROM accounts_v1.authorization_codes",
  );
});

test("PostgresAccountsStore linearizes claim, replay, finalize, and descendant revocation on PGlite", async () => {
  const fixture = await createPostgresLifecycleFixture();
  try {
    const { store } = fixture;
    const record = postgresAuthorizationCodeRecord("pg-race-owner");
    const code = "pg-code-race";
    await store.saveAuthorizationCode(code, record);
    const first = await store.openAuthorizationCodeRedemption(code);
    const second = await store.openAuthorizationCodeRedemption(code);
    if (first.status !== "active" || second.status !== "active") {
      throw new Error("expected two active validation snapshots");
    }
    const winner = await store.claimValidatedAuthorizationCode(first.candidate);
    const loser = await store.claimValidatedAuthorizationCode(second.candidate);
    expect(winner.status).toBe("claimed");
    expect(loser).toEqual({ status: "replayed" });
    if (winner.status !== "claimed") return;
    expect(
      await store.finalizeAuthorizationCodeRedemption({
        code,
        claimId: winner.claimId,
        accessToken: "pg-access-after-replay",
        accessRecord: postgresTokenRecord(record),
      }),
    ).toEqual({ status: "replayed" });
    expect(
      await store.findAccessToken("pg-access-after-replay"),
    ).toBeUndefined();

    const issuedCode = "pg-code-issued";
    await store.saveAuthorizationCode(issuedCode, record);
    const issuedOpen = await store.openAuthorizationCodeRedemption(issuedCode);
    if (issuedOpen.status !== "active") throw new Error("expected active code");
    const issuedClaim = await store.claimValidatedAuthorizationCode(
      issuedOpen.candidate,
    );
    if (issuedClaim.status !== "claimed") throw new Error("expected claim");
    expect(
      await store.finalizeAuthorizationCodeRedemption({
        code: issuedCode,
        claimId: issuedClaim.claimId,
        accessToken: "pg-access-root",
        accessRecord: postgresTokenRecord(record),
        refreshToken: "pg-refresh-root",
        refreshRecord: postgresTokenRecord(record),
      }),
    ).toEqual({ status: "issued" });
    expect(await store.isRefreshRootRevoked("pg-refresh-root")).toBe(false);
    expect(
      await store.addRefreshChainLink("pg-refresh-root", "pg-refresh-child"),
    ).toBe(true);
    await store.saveRefreshToken(
      "pg-refresh-child",
      postgresTokenRecord(record),
    );
    await store.saveAccessToken(
      "pg-access-descendant",
      postgresTokenRecord(record),
    );
    await store.linkAccessTokenToRefreshChain(
      "pg-refresh-child",
      "pg-access-descendant",
    );
    expect(await store.openAuthorizationCodeRedemption(issuedCode)).toEqual({
      status: "replayed",
    });
    expect(await store.isRefreshRootRevoked("pg-refresh-root")).toBe(true);
    expect(await store.findAccessToken("pg-access-root")).toBeUndefined();
    expect(await store.findAccessToken("pg-access-descendant")).toBeUndefined();
    expect(await store.findRefreshToken("pg-refresh-root")).toBeUndefined();
    expect(await store.findRefreshToken("pg-refresh-child")).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test("PostgresAccountsStore replay revokes every preserved legacy token link", async () => {
  const fixture = await createPostgresLifecycleFixture();
  try {
    const { store, client } = fixture;
    const code = "pg-code-multi-link-replay";
    const record = postgresAuthorizationCodeRecord("pg-multi-link-replay");
    await store.saveAuthorizationCode(code, record);
    const opened = await store.openAuthorizationCodeRedemption(code);
    if (opened.status !== "active") throw new Error("expected active code");
    const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
    if (claim.status !== "claimed") throw new Error("expected claim winner");
    expect(
      await store.finalizeAuthorizationCodeRedemption({
        code,
        claimId: claim.claimId,
        accessToken: "pg-multi-access-a",
        accessRecord: postgresTokenRecord(record),
        refreshToken: "pg-multi-refresh-a",
        refreshRecord: postgresTokenRecord(record),
      }),
    ).toEqual({ status: "issued" });

    const secondAccess = "pg-multi-access-b";
    const secondRefresh = "pg-multi-refresh-b";
    const secondChild = "pg-multi-refresh-b-child";
    const secondDescendant = "pg-multi-access-b-descendant";
    await store.saveAccessToken(secondAccess, postgresTokenRecord(record));
    await store.saveRefreshToken(secondRefresh, postgresTokenRecord(record));
    expect(await store.addRefreshChainLink(secondRefresh, secondChild)).toBe(
      true,
    );
    await store.saveRefreshToken(secondChild, postgresTokenRecord(record));
    await store.saveAccessToken(secondDescendant, postgresTokenRecord(record));
    await store.linkAccessTokenToRefreshChain(secondChild, secondDescendant);
    const [codeHash, accessHash, refreshHash] = await Promise.all([
      sha256Text(code),
      sha256Text(secondAccess),
      sha256Text(secondRefresh),
    ]);
    await client.queryObject(
      `INSERT INTO accounts_v1.auth_code_token_links (
         code_hash, access_token_hash, refresh_root_hash, created_at
       ) VALUES ($1, $2, $3, $4)`,
      [codeHash, accessHash, refreshHash, new Date()],
    );

    expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
      status: "replayed",
    });
    expect(await store.findAccessToken("pg-multi-access-a")).toBeUndefined();
    expect(await store.findRefreshToken("pg-multi-refresh-a")).toBeUndefined();
    expect(await store.findAccessToken(secondAccess)).toBeUndefined();
    expect(await store.findRefreshToken(secondRefresh)).toBeUndefined();
    expect(await store.findRefreshToken(secondChild)).toBeUndefined();
    expect(await store.findAccessToken(secondDescendant)).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test("PostgresAccountsStore keeps a replacement claimable and rolls back failed finalize", async () => {
  const fixture = await createPostgresLifecycleFixture();
  try {
    const { store, client } = fixture;
    const code = "pg-code-substitution";
    await store.saveAuthorizationCode(
      code,
      postgresAuthorizationCodeRecord("pg-record-a"),
    );
    const recordA = await store.openAuthorizationCodeRedemption(code);
    if (recordA.status !== "active") throw new Error("expected record A");
    await store.saveAuthorizationCode(
      code,
      postgresAuthorizationCodeRecord("pg-record-b"),
    );
    expect(
      await store.claimValidatedAuthorizationCode(recordA.candidate),
    ).toEqual({ status: "stale" });
    const recordB = await store.openAuthorizationCodeRedemption(code);
    if (recordB.status !== "active") throw new Error("expected record B");
    expect(recordB.candidate.record.subject).toBe("pg-record-b");
    const claim = await store.claimValidatedAuthorizationCode(
      recordB.candidate,
    );
    if (claim.status !== "claimed") throw new Error("expected B claim");

    client.failNextTransactionAt(3);
    await expect(
      store.finalizeAuthorizationCodeRedemption({
        code,
        claimId: claim.claimId,
        accessToken: "pg-access-partial",
        accessRecord: postgresTokenRecord(recordB.candidate.record),
        refreshToken: "pg-refresh-partial",
        refreshRecord: postgresTokenRecord(recordB.candidate.record),
      }),
    ).rejects.toThrow("injected Postgres lifecycle transaction failure");
    expect(await store.findAccessToken("pg-access-partial")).toBeUndefined();
    expect(await store.findRefreshToken("pg-refresh-partial")).toBeUndefined();
    expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
      status: "replayed",
    });
  } finally {
    await fixture.close();
  }
});

function postgresAuthorizationCodeRecord(subject: string) {
  return {
    clientId: "pg-lifecycle-client",
    redirectUri: "https://app.example.test/callback",
    scope: "openid offline_access",
    subject,
    codeChallenge: "challenge",
    codeChallengeMethod: "S256" as const,
    expiresAt: Date.now() + 60_000,
  };
}

function postgresTokenRecord(
  record: ReturnType<typeof postgresAuthorizationCodeRecord>,
) {
  return {
    clientId: record.clientId,
    scope: record.scope,
    subject: record.subject,
    expiresAt: Date.now() + 60_000,
  };
}

class PGlitePostgresClient implements PostgresQueryClient {
  #failTransactionAt?: number;

  constructor(private readonly db: PGlite) {}

  async queryObject<T>(
    sql: string,
    args: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<T>> {
    const result = await this.db.query(sql, [...args]);
    return { rows: result.rows as T[] };
  }

  async transaction<T>(
    run: (client: PostgresQueryClient) => Promise<T>,
  ): Promise<T> {
    const failAt = this.#failTransactionAt;
    this.#failTransactionAt = undefined;
    const result = await this.db.transaction(async (transaction) => {
      let queryIndex = 0;
      const handle: PostgresQueryClient = {
        queryObject: async <Row>(
          sql: string,
          args: readonly unknown[] = [],
        ): Promise<PostgresQueryResult<Row>> => {
          if (queryIndex++ === failAt) {
            throw new Error("injected Postgres lifecycle transaction failure");
          }
          const query = await transaction.query(sql, [...args]);
          return { rows: query.rows as Row[] };
        },
        transaction: async (nested) => await nested(handle),
      };
      return await run(handle);
    });
    return result as T;
  }

  failNextTransactionAt(queryIndex: number): void {
    this.#failTransactionAt = queryIndex;
  }
}

async function createPostgresLifecycleFixture(): Promise<{
  readonly store: PostgresAccountsStore;
  readonly client: PGlitePostgresClient;
  readonly close: () => Promise<void>;
}> {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA accounts_v1;
    CREATE TABLE accounts_v1.authorization_codes (
      code_hash text PRIMARY KEY,
      client_id text NOT NULL,
      redirect_uri text NOT NULL,
      scope text NOT NULL,
      subject text NOT NULL,
      takosumi_subject text,
      capsule_id text,
      workspace_id text,
      role text,
      nonce text,
      code_challenge text,
      code_challenge_method text,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE accounts_v1.oauth_access_tokens (
      token_hash text PRIMARY KEY,
      client_id text NOT NULL,
      audience text,
      scope text NOT NULL,
      subject text NOT NULL,
      takosumi_subject text,
      capsule_id text,
      workspace_id text,
      role text,
      interface_id text,
      interface_binding_id text,
      interface_resolved_revision bigint,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE accounts_v1.oauth_refresh_tokens (
      LIKE accounts_v1.oauth_access_tokens INCLUDING ALL
    );
    CREATE TABLE accounts_v1.refresh_chain_links (
      parent_token_hash text PRIMARY KEY,
      child_token_hash text NOT NULL,
      root_token_hash text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (child_token_hash)
    );
    CREATE TABLE accounts_v1.refresh_chain_access_tokens (
      root_token_hash text NOT NULL,
      access_token_hash text NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (root_token_hash, access_token_hash)
    );
    CREATE TABLE accounts_v1.revoked_refresh_roots (
      root_token_hash text PRIMARY KEY,
      revoked_at timestamptz NOT NULL
    );
    CREATE TABLE accounts_v1.consumed_authorization_codes (
      code_hash text PRIMARY KEY,
      consumed_at timestamptz NOT NULL
    );
    CREATE TABLE accounts_v1.auth_code_token_links (
      code_hash text NOT NULL,
      access_token_hash text NOT NULL,
      refresh_root_hash text NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (code_hash, access_token_hash, refresh_root_hash)
    );
  `);
  const migration = await Bun.file(
    new URL(
      "../../../../accounts/service/migrations/037_authorization_code_redemptions.sql",
      import.meta.url,
    ),
  ).text();
  await db.exec(migration);
  const client = new PGlitePostgresClient(db);
  return {
    client,
    store: new PostgresAccountsStore(client),
    close: () => db.close(),
  };
}
