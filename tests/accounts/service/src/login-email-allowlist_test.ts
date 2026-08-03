import { expect, test } from "bun:test";
import type { LoginEmailAllowlist } from "../../../../accounts/service/src/login-email-allowlist.ts";
import { rejectDisallowedPresentedSession } from "../../../../accounts/service/src/login-email-allowlist.ts";
import { createEphemeralAccountsHandler } from "../../../../accounts/service/src/mod.ts";
import { handleToken } from "../../../../accounts/service/src/oidc-routes.ts";
import {
  InMemoryAccountsStore,
  type AccountsStore,
} from "../../../../accounts/service/src/store.ts";

const issuer = "http://localhost:8787";
const allowlist: LoginEmailAllowlist = {
  emails: ["kept@example.test"],
};

function gateRequest(credential: string): Request {
  return new Request(`${issuer}/api/v1/workspaces`, {
    headers: { authorization: `Bearer ${credential}` },
  });
}

function fixture(input: {
  readonly subject: `tsub_${string}`;
  readonly email: string;
}): InMemoryAccountsStore {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({
    subject: input.subject,
    email: input.email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

test("the deployment gate refuses a personal access token whose account left the allowlist", async () => {
  const subject = "tsub_pat_removed" as const;
  const store = fixture({ subject, email: "removed@example.test" });
  const now = Date.now();
  store.savePersonalAccessToken("takpat_removed_gate", {
    tokenId: "pat_removed_gate",
    tokenPrefix: "takpat_rem",
    subject,
    name: "automation",
    scopes: ["write"],
    createdAt: now,
  });

  const rejected = await rejectDisallowedPresentedSession({
    request: gateRequest("takpat_removed_gate"),
    store,
    credential: "takpat_removed_gate",
    allowlist,
    secureCookie: false,
  });

  expect(rejected?.status).toBe(403);
  expect(await rejected?.json()).toMatchObject({
    error: { code: "login_not_allowed" },
  });
  // A token credential carries no cookie, so none is cleared.
  expect(rejected?.headers.get("set-cookie")).toBeNull();
  // The token itself is refused, not destroyed: restoring the address to the
  // allowlist restores access without re-issuing credentials.
  const retained = store.findPersonalAccessToken("takpat_removed_gate");
  expect(retained?.tokenId).toBe("pat_removed_gate");
  expect(retained?.revokedAt).toBeUndefined();
});

test("the deployment gate keeps allowlisted token and session credentials working", async () => {
  const subject = "tsub_pat_kept" as const;
  const store = fixture({ subject, email: "kept@example.test" });
  const now = Date.now();
  store.savePersonalAccessToken("takpat_kept_gate", {
    tokenId: "pat_kept_gate",
    tokenPrefix: "takpat_kep",
    subject,
    name: "automation",
    scopes: ["read"],
    createdAt: now,
  });
  store.saveAccountSession({
    sessionId: "sess_kept_gate",
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });

  expect(
    await rejectDisallowedPresentedSession({
      request: gateRequest("takpat_kept_gate"),
      store,
      credential: "takpat_kept_gate",
      allowlist,
      secureCookie: false,
    }),
  ).toBeUndefined();
  expect(
    await rejectDisallowedPresentedSession({
      request: gateRequest("sess_kept_gate"),
      store,
      credential: "sess_kept_gate",
      allowlist,
      secureCookie: false,
    }),
  ).toBeUndefined();
  expect(store.findAccountSession("sess_kept_gate")).toBeDefined();
});

test("the deployment gate refuses an OAuth access token whose account left the allowlist", async () => {
  const subject = "tsub_oauth_removed" as const;
  const store = fixture({ subject, email: "removed@example.test" });
  store.saveAccessToken("takat_removed_gate", {
    clientId: "toc_capsule",
    scope: "capsules:write",
    subject: "pairwise-removed",
    takosumiSubject: subject,
    expiresAt: Date.now() + 60_000,
  });

  const rejected = await rejectDisallowedPresentedSession({
    request: gateRequest("takat_removed_gate"),
    store,
    credential: "takat_removed_gate",
    allowlist,
    secureCookie: false,
  });

  expect(rejected?.status).toBe(403);
  expect(await rejected?.json()).toMatchObject({
    error: { code: "login_not_allowed" },
  });
});

test("the deployment gate still revokes a browser session that left the allowlist", async () => {
  const subject = "tsub_session_removed" as const;
  const store = fixture({ subject, email: "removed@example.test" });
  const now = Date.now();
  store.saveAccountSession({
    sessionId: "sess_removed_gate",
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });

  const rejected = await rejectDisallowedPresentedSession({
    request: gateRequest("sess_removed_gate"),
    store,
    credential: "sess_removed_gate",
    allowlist,
    secureCookie: true,
  });

  expect(rejected?.status).toBe(403);
  expect(rejected?.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(store.findAccountSession("sess_removed_gate")).toBeUndefined();
});

test("the deployment gate leaves Interface runtime OAuth tokens to their own audience checks", async () => {
  const subject = "tsub_interface_removed" as const;
  const store = fixture({ subject, email: "removed@example.test" });
  store.saveAccessToken("takat_interface_gate", {
    clientId: "toc_interface",
    audience: "https://capsule.example.test/api",
    scope: "invoke",
    subject: "pairwise-interface",
    takosumiSubject: subject,
    workspaceId: "ws_interface",
    role: "interface-runtime",
    interfaceId: "iface_1",
    interfaceBindingId: "ibind_1",
    interfaceResolvedRevision: 1,
    expiresAt: Date.now() + 60_000,
  });

  expect(
    await rejectDisallowedPresentedSession({
      request: gateRequest("takat_interface_gate"),
      store,
      credential: "takat_interface_gate",
      allowlist,
      secureCookie: false,
    }),
  ).toBeUndefined();
});

test("the deployment gate reads no credential store when no allowlist is configured", async () => {
  const store = new Proxy({} as AccountsStore, {
    get(_target, property) {
      throw new Error(
        `allowlist gate must not touch the store: ${String(property)}`,
      );
    },
  });

  expect(
    await rejectDisallowedPresentedSession({
      request: gateRequest("takpat_unconfigured"),
      store,
      credential: "takpat_unconfigured",
      secureCookie: false,
    }),
  ).toBeUndefined();
});

test("a personal access token from a removed account cannot reach the control plane", async () => {
  const removed = "tsub_control_removed" as const;
  const kept = "tsub_control_kept" as const;
  const store = fixture({ subject: removed, email: "removed@example.test" });
  const now = Date.now();
  store.saveAccount({
    subject: kept,
    email: "kept@example.test",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  store.savePersonalAccessToken("takpat_control_removed", {
    tokenId: "pat_control_removed",
    tokenPrefix: "takpat_con",
    subject: removed,
    name: "automation",
    scopes: ["read"],
    createdAt: now,
  });
  store.savePersonalAccessToken("takpat_control_kept", {
    tokenId: "pat_control_kept",
    tokenPrefix: "takpat_con",
    subject: kept,
    name: "automation",
    scopes: ["read"],
    createdAt: now,
  });
  const handler = await createEphemeralAccountsHandler({
    issuer,
    subject: "tsub_local",
    store,
    loginEmailAllowlist: allowlist,
  });

  const denied = await handler(
    new Request(`${issuer}/api/v1/workspaces`, {
      headers: { authorization: "Bearer takpat_control_removed" },
    }),
  );
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({
    error: { code: "login_not_allowed" },
  });

  // The still-allowlisted token passes the gate and reaches the control plane
  // (503 here only because this handler has no control-plane operations).
  const allowed = await handler(
    new Request(`${issuer}/api/v1/workspaces`, {
      headers: { authorization: "Bearer takpat_control_kept" },
    }),
  );
  expect(allowed.status).toBe(503);
});

test("refresh-token rotation stops for an account that left the allowlist", async () => {
  const subject = "tsub_refresh_removed" as const;
  const store = fixture({ subject, email: "removed@example.test" });
  const clientId = "toc_refresh_allowlist";
  const now = Date.now();
  store.saveRefreshToken("takrt_refresh_removed", {
    clientId,
    scope: "openid profile offline_access",
    subject: "pairwise-refresh",
    takosumiSubject: subject,
    expiresAt: now + 60_000,
  });

  const refreshRequest = () =>
    new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "takrt_refresh_removed",
        client_id: clientId,
      }),
    });
  const tokenInput = {
    issuer,
    store,
    flow: {
      subject: "unused-static-subject",
      pairwiseSubjectSecret: "test-pairwise-secret",
      issueIdToken: async () => "test-id-token",
    },
    clients: new Map([
      [
        clientId,
        {
          clientId,
          redirectUris: ["https://app.example.test/auth/callback"],
          allowedScopes: ["openid", "profile", "offline_access"],
          tokenEndpointAuthMethod: "none" as const,
        },
      ],
    ]),
  };

  const denied = await handleToken({
    ...tokenInput,
    request: refreshRequest(),
    loginEmailAllowlist: allowlist,
  });
  expect(denied.status).toBe(400);
  expect(await denied.json()).toEqual({ error: "invalid_grant" });
  // Rotation is refused without consuming the grant, so restoring the address
  // restores the client without a new authorization-code flow.
  expect(store.findRefreshToken("takrt_refresh_removed")).toBeDefined();

  // The same grant still rotates on a deployment with no allowlist.
  const rotated = await handleToken({
    ...tokenInput,
    request: refreshRequest(),
  });
  expect(rotated.status).toBe(200);
});
