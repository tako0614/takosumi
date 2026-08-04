import { expect, spyOn, test } from "bun:test";
import type { CapsuleStatus } from "takosumi-contract/install-configs";
import type { WorkspaceMemberStatus } from "takosumi-contract/workspaces";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import {
  handleAuthorize,
  handleToken,
  handleUserInfo,
} from "../../../../accounts/service/src/oidc-routes.ts";
import {
  InMemoryAccountsStore,
  type OidcClientRecord,
} from "../../../../accounts/service/src/store.ts";

const issuer = "https://accounts.example.test";
const clientId = "toc_live_grant";
const capsuleId = "cap_live_grant";
const workspaceId = "ws_live_grant";
const accountSubject = "tsub_live_member";
const redirectUri = "https://app.example.test/auth/callback";
const flow = {
  subject: "unused-static-subject",
  pairwiseSubjectSecret: "test-pairwise-secret",
  issueIdToken: async () => "test-id-token",
};

function liveGrantFixture() {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const state: {
    capsuleStatus: CapsuleStatus;
    memberStatus: WorkspaceMemberStatus;
    memberRoles: string[];
  } = {
    capsuleStatus: "active",
    memberStatus: "active",
    memberRoles: ["member"],
  };
  const client: OidcClientRecord = {
    clientId,
    capsuleId,
    namespacePath: "identity.oidc",
    issuerUrl: issuer,
    redirectUris: [redirectUri],
    allowedScopes: ["openid", "profile", "offline_access"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    createdAt: now,
    updatedAt: now,
  };
  const installConfig = {
    id: "cfg_live_grant",
    variableMapping: {
      application_url: "https://app.example.test",
      oidc_client_id: clientId,
    },
    installExperience: {
      projections: [
        {
          kind: "oidc_client",
          variables: { clientId: "oidc_client_id" },
          callbackPath: "/auth/callback",
          scopes: ["openid", "profile", "offline_access"],
        },
      ],
    },
    updatedAt: new Date(now).toISOString(),
  };
  const operations = {
    capsules: {
      getCapsule: async () => ({
        id: capsuleId,
        workspaceId,
        installConfigId: installConfig.id,
        name: "live-app",
        status: state.capsuleStatus,
      }),
      getInstallConfig: async () => installConfig,
    },
    workspaces: {
      getWorkspace: async () => ({
        id: workspaceId,
        ownerUserId: "tsub_other_owner",
      }),
    },
    members: {
      listMembers: async () => [
        {
          workspaceId,
          accountId: accountSubject,
          status: state.memberStatus,
          roles: state.memberRoles,
        },
      ],
    },
  } as unknown as ControlPlaneOperations;

  store.saveAccount({
    subject: accountSubject,
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: "sess_live_grant",
    subject: accountSubject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  store.saveOidcClient(client);
  return { store, state, operations };
}

function authorizeRequest(): { request: Request; url: URL } {
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile offline_access",
    code_challenge: "test-s256-challenge",
    code_challenge_method: "S256",
  }).toString();
  return {
    url,
    request: new Request(url, {
      headers: { "x-takosumi-account-session": "sess_live_grant" },
    }),
  };
}

test("authorize resolves a current Capsule grant and terminal status revokes its client", async () => {
  const { store, state, operations } = liveGrantFixture();
  const first = authorizeRequest();
  const allowed = await handleAuthorize({
    ...first,
    flow,
    clients: new Map(),
    store,
    operations,
  });
  expect(allowed.status).toBe(302);

  state.capsuleStatus = "destroyed";
  const second = authorizeRequest();
  const denied = await handleAuthorize({
    ...second,
    flow,
    clients: new Map(),
    store,
    operations,
  });
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({ error: "unauthorized_client" });
  expect(store.findOidcClient(clientId)).toBeUndefined();
  expect(store.findOidcClientForCapsule(capsuleId)).toBeUndefined();
});

test("authorization-code denial logs only its closed diagnostic stage", async () => {
  const { store, operations } = liveGrantFixture();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await handleToken({
      issuer,
      request: new Request(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "secret-client-id-must-not-be-logged",
        }),
      }),
      store,
      flow,
      clients: new Map(),
      operations,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toEqual({
      event: "oidc_token_denied",
      stage: "authorization_code_missing",
    });
    expect(logged).not.toContain("secret-client-id");
  } finally {
    warn.mockRestore();
  }
});

test("UserInfo uses the current role and refresh revokes the chain after membership loss", async () => {
  const { store, state, operations } = liveGrantFixture();
  state.memberRoles = ["viewer"];
  store.saveAccessToken("takat_live_grant", {
    clientId,
    scope: "openid profile",
    subject: "pairwise-live-member",
    takosumiSubject: accountSubject,
    capsuleId,
    workspaceId,
    role: "member",
    expiresAt: Date.now() + 60_000,
  });
  store.saveRefreshToken("takrt_live_grant", {
    clientId,
    scope: "openid profile offline_access",
    subject: "pairwise-live-member",
    takosumiSubject: accountSubject,
    capsuleId,
    workspaceId,
    role: "member",
    expiresAt: Date.now() + 60_000,
  });

  const current = await handleUserInfo({
    request: new Request(`${issuer}/oauth/userinfo`, {
      headers: { authorization: "Bearer takat_live_grant" },
    }),
    store,
    clients: new Map(),
    operations,
  });
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({
    takosumi: {
      capsule_id: capsuleId,
      workspace_id: workspaceId,
      role: "viewer",
    },
  });

  state.memberStatus = "suspended";
  const refreshed = await handleToken({
    issuer,
    request: new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "takrt_live_grant",
        client_id: clientId,
      }),
    }),
    store,
    flow,
    clients: new Map(),
    operations,
  });
  expect(refreshed.status).toBe(400);
  expect(await refreshed.json()).toEqual({ error: "invalid_grant" });
  expect(store.findRefreshToken("takrt_live_grant")).toBeUndefined();

  const staleUserInfo = await handleUserInfo({
    request: new Request(`${issuer}/oauth/userinfo`, {
      headers: { authorization: "Bearer takat_live_grant" },
    }),
    store,
    clients: new Map(),
    operations,
  });
  expect(staleUserInfo.status).toBe(401);
  // Membership loss is user-specific, so the shared client grant remains for
  // other active Workspace members.
  expect(store.findOidcClient(clientId)).toBeDefined();
});
