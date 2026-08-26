import { expect, spyOn, test } from "bun:test";
import type {
  CapsuleStatus,
  InstallConfig,
} from "takosumi-contract/install-configs";
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
import { oidcClientActivationDigest } from "../../../../accounts/service/src/oidc-activation.ts";

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

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function liveGrantFixture() {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const state: {
    capsuleStatus: CapsuleStatus;
    memberStatus: WorkspaceMemberStatus;
    memberRoles: string[];
    executionAuthorityEpoch: number;
  } = {
    capsuleStatus: "active",
    memberStatus: "active",
    memberRoles: ["member"],
    executionAuthorityEpoch: 1,
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
    requiredInterfaces: undefined as InstallConfig["requiredInterfaces"],
    updatedAt: new Date(now).toISOString(),
  };
  const requiredInterfaceCalls: unknown[] = [];
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
      getCapsuleExecutionAuthorityEpoch: async () =>
        state.executionAuthorityEpoch,
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
    interfaces: {
      ensureCapsuleRequiredInterfaces: async (input: unknown) => {
        requiredInterfaceCalls.push(input);
      },
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
  store.saveOidcClient({
    ...client,
    activationDigest: await oidcClientActivationDigest({
      workspaceId,
      capsuleId,
      executionAuthorityEpoch: state.executionAuthorityEpoch,
      installConfig: installConfig as InstallConfig,
    }),
  });
  return {
    store,
    state,
    operations,
    installConfig,
    requiredInterfaceCalls,
  };
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
  const { store, state, operations } = await liveGrantFixture();
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

test("dynamic grant denies a legacy or stale activation digest without revoking its Apply-repairable client", async () => {
  const { store, state, operations } = await liveGrantFixture();
  const current = store.findOidcClient(clientId)!;
  store.saveOidcClient({ ...current, activationDigest: undefined });
  const legacy = authorizeRequest();
  expect((await handleAuthorize({
    ...legacy,
    flow,
    clients: new Map(),
    store,
    operations,
  })).status).toBe(400);
  expect(store.findOidcClient(clientId)).toBeDefined();

  store.saveOidcClient(current);
  state.executionAuthorityEpoch = 2;
  const stale = authorizeRequest();
  expect((await handleAuthorize({
    ...stale,
    flow,
    clients: new Map(),
    store,
    operations,
  })).status).toBe(400);
  expect(store.findOidcClient(clientId)?.activationDigest).toBe(
    current.activationDigest,
  );
});

test("dynamic grant denies current InstallConfig or OIDC profile drift", async () => {
  const { store, operations, installConfig } = await liveGrantFixture();
  installConfig.variableMapping.application_url =
    "https://changed.example.test";
  const changedConfig = authorizeRequest();
  expect((await handleAuthorize({
    ...changedConfig,
    flow,
    clients: new Map(),
    store,
    operations,
  })).status).toBe(400);
});

test("authorize materializes required Interfaces for the exact pairwise Principal", async () => {
  const {
    store,
    operations,
    installConfig,
    requiredInterfaceCalls,
  } = await liveGrantFixture();
  installConfig.requiredInterfaces = [
    {
      key: "ai",
      interface: { type: "takosumi.ai.gateway", version: "1" },
      permissions: ["ai.chat"],
      delivery: { type: "oauth2" },
    },
  ];
  const currentClient = store.findOidcClient(clientId)!;
  store.saveOidcClient({
    ...currentClient,
    activationDigest: await oidcClientActivationDigest({
      workspaceId,
      capsuleId,
      executionAuthorityEpoch: 1,
      installConfig: installConfig as InstallConfig,
    }),
  });
  const request = authorizeRequest();

  const response = await handleAuthorize({
    ...request,
    flow,
    clients: new Map(),
    store,
    operations,
  });

  expect(response.status).toBe(302);
  expect(requiredInterfaceCalls).toHaveLength(1);
  expect(requiredInterfaceCalls[0]).toMatchObject({
    workspaceId,
    capsuleId,
    requirements: installConfig.requiredInterfaces,
  });
  const principalId = (requiredInterfaceCalls[0] as { principalId: string })
    .principalId;
  expect(principalId).not.toBe(accountSubject);
  expect(principalId.length).toBeGreaterThan(20);
});

test("composition OIDC client may request one live Workspace-bound Principal token", async () => {
  const { store, operations } = await liveGrantFixture();
  const compositionClientId = "takosumi-platform-local";
  const compositionRedirectUri =
    "https://app.example.test/platform/callback";
  const compositionSecret = "composition-secret";
  const verifier = "composition-workspace-verifier";
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: compositionClientId,
    redirect_uri: compositionRedirectUri,
    scope: "openid capsules:read",
    workspace_id: workspaceId,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  const clients = new Map([
    [
      compositionClientId,
      {
        clientId: compositionClientId,
        redirectUris: [compositionRedirectUri],
        clientSecret: compositionSecret,
        tokenEndpointAuthMethod: "client_secret_post" as const,
        allowedScopes: ["openid", "capsules:read"],
      },
    ],
  ]);

  const authorization = await handleAuthorize({
    request: new Request(url, {
      headers: { "x-takosumi-account-session": "sess_live_grant" },
    }),
    url,
    flow,
    clients,
    store,
    operations,
  });
  expect(authorization.status).toBe(302);
  const code = new URL(authorization.headers.get("location")!).searchParams.get(
    "code",
  );
  expect(code).toBeTruthy();

  const tokenResponse = await handleToken({
    issuer,
    request: new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: compositionRedirectUri,
        client_id: compositionClientId,
        client_secret: compositionSecret,
        code_verifier: verifier,
      }),
    }),
    store,
    flow,
    clients,
    operations,
  });
  expect(tokenResponse.status).toBe(200);
  const token = (await tokenResponse.json()) as { access_token: string };
  expect(await store.findAccessToken(token.access_token)).toMatchObject({
    clientId: compositionClientId,
    subject: accountSubject,
    takosumiSubject: accountSubject,
    workspaceId,
    role: "member",
  });

  const deniedUrl = new URL(url);
  deniedUrl.searchParams.set("workspace_id", "ws_not_a_member");
  const denied = await handleAuthorize({
    request: new Request(deniedUrl, {
      headers: { "x-takosumi-account-session": "sess_live_grant" },
    }),
    url: deniedUrl,
    flow,
    clients,
    store,
    operations: {
      ...operations,
      workspaces: {
        ...operations.workspaces,
        getWorkspace: async () => {
          throw new Error("Workspace is unavailable to this account");
        },
      },
      members: {
        ...operations.members,
        listMembers: async () => [],
      },
    },
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: "access_denied" });
});

test("Workspace-bound composition tokens project Workspace claims without a Capsule", async () => {
  const { store, state, operations } = await liveGrantFixture();
  const compositionClientId = "takosumi-platform-workspace-claims";
  const compositionRedirectUri =
    "https://app.example.test/platform/workspace-callback";
  const compositionSecret = "composition-workspace-claims-secret";
  const verifier = "composition-workspace-claims-verifier";
  const clients = new Map([
    [
      compositionClientId,
      {
        clientId: compositionClientId,
        redirectUris: [compositionRedirectUri],
        clientSecret: compositionSecret,
        tokenEndpointAuthMethod: "client_secret_post" as const,
        allowedScopes: ["openid", "profile", "offline_access"],
      },
    ],
  ]);
  let idTokenClaims: Record<string, unknown> | undefined;
  const claimFlow = {
    ...flow,
    issueIdToken: async (claims: Record<string, unknown>) => {
      idTokenClaims = claims;
      return "workspace-claims-id-token";
    },
  };
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: compositionClientId,
    redirect_uri: compositionRedirectUri,
    scope: "openid profile offline_access",
    workspace_id: workspaceId,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();

  const authorization = await handleAuthorize({
    request: new Request(url, {
      headers: { "x-takosumi-account-session": "sess_live_grant" },
    }),
    url,
    flow: claimFlow,
    clients,
    store,
    operations,
  });
  expect(authorization.status).toBe(302);
  const code = new URL(authorization.headers.get("location")!).searchParams.get(
    "code",
  );
  expect(code).toBeTruthy();

  const tokenResponse = await handleToken({
    issuer,
    request: new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: compositionRedirectUri,
        client_id: compositionClientId,
        client_secret: compositionSecret,
        code_verifier: verifier,
      }),
    }),
    store,
    flow: claimFlow,
    clients,
    operations,
  });
  expect(tokenResponse.status).toBe(200);
  const token = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
  };

  expect(idTokenClaims).toMatchObject({
    takosumi: { workspace_id: workspaceId, role: "member" },
  });
  expect((idTokenClaims?.takosumi as Record<string, unknown>).capsule_id).toBe(
    undefined,
  );

  const userInfo = await handleUserInfo({
    request: new Request(`${issuer}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    }),
    store,
    clients,
    operations,
  });
  expect(userInfo.status).toBe(200);
  const userInfoBody = (await userInfo.json()) as Record<string, unknown>;
  expect(userInfoBody).toMatchObject({
    takosumi: { workspace_id: workspaceId, role: "member" },
    workspace_memberships: [workspaceId],
  });
  expect(
    (userInfoBody.takosumi as Record<string, unknown>).capsule_id,
  ).toBeUndefined();
  expect(userInfoBody.workspace_memberships).toEqual([workspaceId]);

  state.memberStatus = "suspended";
  const staleUserInfo = await handleUserInfo({
    request: new Request(`${issuer}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    }),
    store,
    clients,
    operations,
  });
  expect(staleUserInfo.status).toBe(401);

  const refreshed = await handleToken({
    issuer,
    request: new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: compositionClientId,
        client_secret: compositionSecret,
      }),
    }),
    store,
    flow: claimFlow,
    clients,
    operations,
  });
  expect(refreshed.status).toBe(400);
  expect(await refreshed.json()).toEqual({ error: "invalid_grant" });
});

test("authorization-code denial logs only its closed diagnostic stage", async () => {
  const { store, operations } = await liveGrantFixture();
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
  const { store, state, operations } = await liveGrantFixture();
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
