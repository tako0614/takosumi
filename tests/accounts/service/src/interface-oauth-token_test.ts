import { expect, test } from "bun:test";
import {
  INTERFACE_OAUTH_ACCESS_TOKEN_MAX_TTL_SECONDS,
  issueInterfaceOAuthAccessToken,
} from "../../../../accounts/service/src/interface-oauth-token.ts";
import { findActiveAccessToken } from "../../../../accounts/service/src/access-token-activity.ts";
import {
  handleIntrospect,
  handleRevoke,
  handleUserInfo,
} from "../../../../accounts/service/src/oidc-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const audience = "https://office.example.test/mcp";
const confidentialClients = new Map([
  [
    "resource-server",
    {
      clientId: "resource-server",
      redirectUris: ["https://resource.example.test/callback"],
      clientSecret: "resource-secret",
      tokenEndpointAuthMethod: "client_secret_post" as const,
    },
  ],
]);

function introspectionRequest(
  token: string,
  options: { resource?: string; clientId?: string; clientSecret?: string } = {},
): Request {
  return new Request("https://accounts.example.test/oauth/introspect", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      client_id: options.clientId ?? "resource-server",
      client_secret: options.clientSecret ?? "resource-secret",
      ...(options.resource ? { resource: options.resource } : {}),
    }),
  });
}

test("Interface OAuth issuer mints a short-lived opaque token with exact UserInfo evidence", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();

  const issued = await issueInterfaceOAuthAccessToken({
    store,
    subject: "pairwise_takos_subject",
    takosumiSubject: "tsub_owner",
    workspaceId: "ws_owner",
    capsuleId: "inst_office",
    audience,
    permission: "mcp.invoke",
    interfaceId: "if_office_mcp",
    bindingId: "ifb_takos_office",
    interfaceRevision: 7,
    ttlSeconds: 45,
    now,
  });

  expect(issued.accessToken).toStartWith("taksrv_");
  expect(issued.accessToken).not.toContain("pairwise_takos_subject");
  expect(issued).toMatchObject({
    tokenType: "Bearer",
    expiresIn: 45,
    expiresAt: now + 45_000,
    scope: "mcp.invoke",
  });
  expect("refreshToken" in issued).toBe(false);
  expect(await store.findRefreshToken(issued.accessToken)).toBeUndefined();

  const response = await handleUserInfo({
    request: new Request("https://accounts.example.test/oauth/userinfo", {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    }),
    store,
    expectedAudience: audience,
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(await response.json()).toEqual({
    sub: "pairwise_takos_subject",
    aud: audience,
    scope: "mcp.invoke",
    token_use: "interface_oauth",
    takosumi: {
      workspace_id: "ws_owner",
      capsule_id: "inst_office",
      interface_id: "if_office_mcp",
      interface_binding_id: "ifb_takos_office",
      interface_resolved_revision: 7,
    },
  });
});

test("ordinary OAuth UserInfo returns the subject account profile", async () => {
  const store = new InMemoryAccountsStore();
  await store.saveAccount({
    subject: "tsub_mobile_owner",
    email: "mobile@example.test",
    emailVerified: true,
    displayName: "Mobile Owner",
    picture: "https://accounts.example.test/mobile-owner.png",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await store.saveAccessToken("takat_mobile_access", {
    clientId: "takos-mobile",
    scope: "openid profile email threads:read",
    subject: "pairwise_mobile_subject",
    takosumiSubject: "tsub_mobile_owner",
    expiresAt: Date.now() + 60_000,
  });

  const response = await handleUserInfo({
    request: new Request("https://accounts.example.test/oauth/userinfo", {
      headers: { authorization: "Bearer takat_mobile_access" },
    }),
    store,
    expectedAudience: "takos-mobile",
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    sub: "pairwise_mobile_subject",
    aud: "takos-mobile",
    scope: "openid profile email threads:read",
    email: "mobile@example.test",
    email_verified: true,
    name: "Mobile Owner",
    picture: "https://accounts.example.test/mobile-owner.png",
  });

  for (const [token, scope, expectedClaims] of [
    [
      "takat_email_only",
      "openid email",
      { email: "mobile@example.test", email_verified: true },
    ],
    [
      "takat_profile_only",
      "openid profile",
      {
        name: "Mobile Owner",
        picture: "https://accounts.example.test/mobile-owner.png",
      },
    ],
    ["takat_openid_only", "openid", {}],
  ] as const) {
    await store.saveAccessToken(token, {
      clientId: "takos-mobile",
      scope,
      subject: "pairwise_mobile_subject",
      takosumiSubject: "tsub_mobile_owner",
      expiresAt: Date.now() + 60_000,
    });
    const scoped = await handleUserInfo({
      request: new Request("https://accounts.example.test/oauth/userinfo", {
        headers: { authorization: `Bearer ${token}` },
      }),
      store,
      expectedAudience: "takos-mobile",
    });
    expect(await scoped.json()).toEqual({
      sub: "pairwise_mobile_subject",
      aud: "takos-mobile",
      scope,
      ...expectedClaims,
    });
  }
});

test("Interface OAuth introspection requires confidential client auth and the exact resource audience", async () => {
  const store = new InMemoryAccountsStore();
  const issued = await issueInterfaceOAuthAccessToken({
    store,
    subject: "pairwise_takos_subject",
    takosumiSubject: "tsub_owner",
    workspaceId: "ws_owner",
    capsuleId: "capsule_office",
    audience,
    permission: "mcp.invoke",
    interfaceId: "if_office_mcp",
    bindingId: "ifb_takos_office",
    interfaceRevision: 7,
  });

  const valid = await handleIntrospect({
    issuer: "https://accounts.example.test",
    request: introspectionRequest(issued.accessToken, { resource: audience }),
    store,
    clients: confidentialClients,
  });
  expect(valid.status).toBe(200);
  expect(await valid.json()).toMatchObject({
    active: true,
    token_use: "interface_oauth",
    aud: audience,
    scope: "mcp.invoke",
    sub: "pairwise_takos_subject",
    takosumi: {
      workspace_id: "ws_owner",
      capsule_id: "capsule_office",
      interface_id: "if_office_mcp",
      interface_binding_id: "ifb_takos_office",
      interface_resolved_revision: 7,
    },
  });

  for (const resource of [undefined, "https://other.example.test/mcp"]) {
    const denied = await handleIntrospect({
      issuer: "https://accounts.example.test",
      request: introspectionRequest(issued.accessToken, { resource }),
      store,
      clients: confidentialClients,
    });
    expect(await denied.json()).toEqual({ active: false });
  }

  const unauthenticated = await handleIntrospect({
    issuer: "https://accounts.example.test",
    request: new Request("https://accounts.example.test/oauth/introspect", {
      method: "POST",
      body: new URLSearchParams({
        token: issued.accessToken,
        resource: audience,
      }),
    }),
    store,
    clients: confidentialClients,
  });
  expect(unauthenticated.status).toBe(401);
  expect(await unauthenticated.json()).toEqual({ error: "invalid_client" });

  const publicClient = new Map([
    [
      "public-client",
      {
        clientId: "public-client",
        redirectUris: ["https://public.example.test/callback"],
        tokenEndpointAuthMethod: "none" as const,
      },
    ],
  ]);
  const publicDenied = await handleIntrospect({
    issuer: "https://accounts.example.test",
    request: introspectionRequest(issued.accessToken, {
      resource: audience,
      clientId: "public-client",
      clientSecret: "",
    }),
    store,
    clients: publicClient,
  });
  expect(publicDenied.status).toBe(401);
});

test("introspection identifies ordinary OAuth and PAT credentials with explicit token_use claims", async () => {
  const store = new InMemoryAccountsStore();
  const expiresAt = Date.now() + 60_000;
  await store.saveAccessToken("opaque-oauth-token", {
    clientId: "resource-server",
    scope: "openid capsules:read",
    subject: "pairwise_oauth_subject",
    workspaceId: "ws_owner",
    expiresAt,
  });
  await store.savePersonalAccessToken("opaque-personal-token", {
    tokenId: "pat_1",
    tokenPrefix: "opaque-personal",
    subject: "tsub_owner",
    name: "automation",
    scopes: ["read"],
    workspaceId: "ws_owner",
    createdAt: Date.now(),
    expiresAt,
  });

  const oauth = await handleIntrospect({
    issuer: "https://accounts.example.test",
    request: introspectionRequest("opaque-oauth-token"),
    store,
    clients: confidentialClients,
  });
  expect(await oauth.json()).toMatchObject({
    active: true,
    token_use: "oauth_access",
    aud: "resource-server",
    sub: "pairwise_oauth_subject",
  });

  const pat = await handleIntrospect({
    issuer: "https://accounts.example.test",
    request: introspectionRequest("opaque-personal-token"),
    store,
    clients: confidentialClients,
  });
  expect(await pat.json()).toMatchObject({
    active: true,
    token_use: "personal_access",
    sub: "tsub_owner",
    takosumi: { workspace_id: "ws_owner" },
  });
});

test("OIDC revocation has no anonymous degraded mode", async () => {
  const store = new InMemoryAccountsStore();
  await store.saveAccessToken("opaque-revocation-token", {
    clientId: "resource-server",
    scope: "openid",
    subject: "pairwise_oauth_subject",
    expiresAt: Date.now() + 60_000,
  });

  const anonymous = await handleRevoke({
    request: new Request("https://accounts.example.test/oauth/revoke", {
      method: "POST",
      body: new URLSearchParams({ token: "opaque-revocation-token" }),
    }),
    store,
    clients: confidentialClients,
  });
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toEqual({ error: "invalid_client" });
  expect(await store.findAccessToken("opaque-revocation-token")).toBeDefined();

  const authenticated = await handleRevoke({
    request: new Request("https://accounts.example.test/oauth/revoke", {
      method: "POST",
      body: new URLSearchParams({
        token: "opaque-revocation-token",
        client_id: "resource-server",
        client_secret: "resource-secret",
      }),
    }),
    store,
    clients: confidentialClients,
  });
  expect(authenticated.status).toBe(200);
  expect(
    await store.findAccessToken("opaque-revocation-token"),
  ).toBeUndefined();
});

test("Interface OAuth UserInfo supports Workspace-owned Interfaces and rejects a wrong audience", async () => {
  const store = new InMemoryAccountsStore();
  const issued = await issueInterfaceOAuthAccessToken({
    store,
    subject: "pairwise_workspace_subject",
    workspaceId: "ws_owner",
    audience,
    permission: "mcp.invoke",
    interfaceId: "if_workspace_mcp",
    bindingId: "ifb_workspace_mcp",
    interfaceRevision: 1,
  });

  const wrongAudience = await handleUserInfo({
    request: new Request("https://accounts.example.test/oauth/userinfo", {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    }),
    store,
    expectedAudience: "https://other.example.test/mcp",
  });
  expect(wrongAudience.status).toBe(401);

  const valid = await handleUserInfo({
    request: new Request("https://accounts.example.test/oauth/userinfo", {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    }),
    store,
    expectedAudience: audience,
  });
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({
    sub: "pairwise_workspace_subject",
    aud: audience,
    scope: "mcp.invoke",
    token_use: "interface_oauth",
    takosumi: {
      workspace_id: "ws_owner",
      interface_id: "if_workspace_mcp",
      interface_binding_id: "ifb_workspace_mcp",
      interface_resolved_revision: 1,
    },
  });
});

test("Interface OAuth tokens expire without refresh and cannot exceed 60 seconds", async () => {
  const store = new InMemoryAccountsStore();
  const expired = await issueInterfaceOAuthAccessToken({
    store,
    subject: "pairwise_expired_subject",
    workspaceId: "ws_owner",
    audience,
    permission: "mcp.invoke",
    interfaceId: "if_expired",
    bindingId: "ifb_expired",
    interfaceRevision: 1,
    now: Date.now() - 61_000,
  });
  const response = await handleUserInfo({
    request: new Request("https://accounts.example.test/oauth/userinfo", {
      headers: { authorization: `Bearer ${expired.accessToken}` },
    }),
    store,
    expectedAudience: audience,
  });
  expect(response.status).toBe(401);
  expect(await store.findAccessToken(expired.accessToken)).toBeUndefined();

  await expect(
    issueInterfaceOAuthAccessToken({
      store,
      subject: "pairwise_subject",
      workspaceId: "ws_owner",
      audience,
      permission: "mcp.invoke",
      interfaceId: "if_too_long",
      bindingId: "ifb_too_long",
      interfaceRevision: 1,
      ttlSeconds: INTERFACE_OAUTH_ACCESS_TOKEN_MAX_TTL_SECONDS + 1,
    }),
  ).rejects.toThrow("ttlSeconds must be at most 60");

  const boundaryNow = Date.now();
  const boundary = await issueInterfaceOAuthAccessToken({
    store,
    subject: "pairwise_boundary_subject",
    workspaceId: "ws_owner",
    audience,
    permission: "mcp.invoke",
    interfaceId: "if_boundary",
    bindingId: "ifb_boundary",
    interfaceRevision: 1,
    ttlSeconds: 1,
    now: boundaryNow,
  });
  expect(
    await findActiveAccessToken({
      store,
      token: boundary.accessToken,
      now: boundary.expiresAt,
    }),
  ).toBeUndefined();
});

test("Interface OAuth issuer accepts only canonical credential-free HTTPS audiences", async () => {
  const store = new InMemoryAccountsStore();
  const base = {
    store,
    subject: "pairwise_subject",
    workspaceId: "ws_owner",
    permission: "mcp.invoke",
    interfaceId: "if_resource",
    bindingId: "ifb_resource",
    interfaceRevision: 1,
  } as const;

  for (const invalidAudience of [
    "http://office.example.test/mcp",
    "ftp://office.example.test/mcp",
    "https://user:password@office.example.test/mcp",
    "https://office.example.test/mcp?token=secret",
    "https://office.example.test/mcp#fragment",
  ]) {
    await expect(
      issueInterfaceOAuthAccessToken({
        ...base,
        audience: invalidAudience,
      }),
    ).rejects.toThrow("canonical credential-free HTTPS resource URI");
  }
});

test("Interface OAuth issuer uses the shared permission token grammar", async () => {
  const store = new InMemoryAccountsStore();
  const base = {
    store,
    subject: "pairwise_subject",
    workspaceId: "ws_owner",
    audience,
    interfaceId: "if_resource",
    bindingId: "ifb_resource",
    interfaceRevision: 1,
  } as const;

  const issued = await issueInterfaceOAuthAccessToken({
    ...base,
    permission: "mcp@invoke",
  });
  expect(issued.scope).toBe("mcp@invoke");

  await expect(
    issueInterfaceOAuthAccessToken({
      ...base,
      permission: "mcp invoke",
    }),
  ).rejects.toThrow("RFC 6749 Interface scope token");
  await expect(
    issueInterfaceOAuthAccessToken({
      ...base,
      permission: "mcp.実行",
    }),
  ).rejects.toThrow("RFC 6749 Interface scope token");
});
