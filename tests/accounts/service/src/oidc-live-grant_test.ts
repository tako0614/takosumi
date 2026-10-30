import { expect, spyOn, test } from "bun:test";
import type {
  CapsuleStatus,
  InstallConfig,
} from "takosumi-contract/install-configs";
import type { WorkspaceMemberStatus } from "takosumi-contract/workspaces";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import type { AppRole } from "../../../../contract/app-access.ts";
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
    appRole: AppRole | undefined;
    ownerAccountId: string | undefined;
  } = {
    capsuleStatus: "active",
    memberStatus: "active",
    memberRoles: ["member"],
    executionAuthorityEpoch: 1,
    appRole: "member",
    ownerAccountId: undefined,
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
        ownerAccountId: state.ownerAccountId,
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
    appOwnership: { getOwnership: async () => state.ownerAccountId ? {
      capsuleId, ownerAccountId: state.ownerAccountId, ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsuleId}`,
    } : undefined },
    appAccess: {
      resolveAppAccess: async (_subject: string, requestedCapsuleId: string) =>
        requestedCapsuleId === capsuleId && state.appRole
          ? { capsuleId, role: state.appRole, ownerAccountId: "tsub_other_owner", ownershipEpoch: 0 }
          : undefined,
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
      scopeRef: workspaceId,
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

test("a nonmember can sign in to an installed app without management or Workspace claims", async () => {
  const { store, state, operations, installConfig, requiredInterfaceCalls } = await liveGrantFixture();
  state.memberStatus = "suspended";
  state.appRole = undefined;
  installConfig.requiredInterfaces = [{
    key: "ai",
    interface: { type: "takosumi.ai.gateway", version: "1" },
    permissions: ["ai.chat"],
    delivery: { type: "oauth2" },
  }];
  store.saveOidcClient({
    ...store.findOidcClient(clientId)!,
    activationDigest: await oidcClientActivationDigest({
      scopeRef: workspaceId, capsuleId, executionAuthorityEpoch: 1,
      installConfig: installConfig as InstallConfig,
    }),
  });
  const verifier = "nonmember-app-sign-in-verifier";
  const { url } = authorizeRequest();
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  let idClaims: Record<string, unknown> | undefined;
  const claimFlow = {
    ...flow,
    issueIdToken: async (claims: Record<string, unknown>) => {
      idClaims = claims;
      return "nonmember-id-token";
    },
  };
  const authorized = await handleAuthorize({
    url,
    request: new Request(url, { headers: { "x-takosumi-account-session": "sess_live_grant" } }),
    flow: claimFlow,
    clients: new Map(),
    store,
    operations,
  });
  expect(authorized.status).toBe(302);
  expect(requiredInterfaceCalls).toHaveLength(0);
  const code = new URL(authorized.headers.get("location")!).searchParams.get("code");
  const tokenResponse = await handleToken({
    issuer,
    request: new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: code!, redirect_uri: redirectUri,
        client_id: clientId, code_verifier: verifier,
      }),
    }),
    store,
    flow: claimFlow,
    clients: new Map(),
    operations,
  });
  expect(tokenResponse.status).toBe(200);
  expect(idClaims?.takosumi).toEqual({ capsule_id: capsuleId });
  const token = await tokenResponse.json() as { access_token: string };
  const userInfo = await handleUserInfo({
    request: new Request(`${issuer}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    }),
    store,
    clients: new Map(),
    operations,
  });
  expect(userInfo.status).toBe(200);
  const body = await userInfo.json() as Record<string, unknown>;
  expect(body.takosumi).toEqual({ capsule_id: capsuleId });
  expect(body.workspace_memberships).toBeUndefined();
});

test("owned app exposes the Workspace compatibility role only with live app access", async () => {
  const { store, state, operations } = await liveGrantFixture();
  state.ownerAccountId = "tsub_other_owner";
  state.appRole = undefined;
  state.memberRoles = ["owner"];
  store.saveAccessToken("takat_migrated_workspace_member", {
    clientId, scope: "openid profile", subject: "pairwise-member",
    takosumiSubject: accountSubject, capsuleId, workspaceId, role: "owner",
    expiresAt: Date.now() + 60_000,
  });
  const request = new Request(`${issuer}/oauth/userinfo`, {
    headers: { authorization: "Bearer takat_migrated_workspace_member" },
  });
  const withoutAppAccess = await handleUserInfo({ request, store, clients: new Map(), operations });
  expect(withoutAppAccess.status).toBe(200);
  expect((await withoutAppAccess.json() as { takosumi: unknown }).takosumi).toEqual({ capsule_id: capsuleId });

  state.appRole = "member";
  const withAppAccess = await handleUserInfo({ request, store, clients: new Map(), operations });
  expect(withAppAccess.status).toBe(200);
  expect((await withAppAccess.json() as { takosumi: unknown }).takosumi).toEqual({
    capsule_id: capsuleId, workspace_id: workspaceId, role: "owner", app_role: "member",
  });

  state.memberRoles = ["admin"];
  const withAdminWorkspaceRole = await handleUserInfo({ request, store, clients: new Map(), operations });
  expect((await withAdminWorkspaceRole.json() as { takosumi: unknown }).takosumi).toEqual({
    capsule_id: capsuleId, workspace_id: workspaceId, role: "admin", app_role: "member",
  });
});

test("an uninstalled Capsule pauses sign-in without revoking its client", async () => {
  const { store, state, operations } = await liveGrantFixture();
  state.capsuleStatus = "uninstalled";
  const paused = await handleAuthorize({
    ...authorizeRequest(),
    flow,
    clients: new Map(),
    store,
    operations,
  });
  expect(paused.status).toBe(400);
  expect(await paused.json()).toMatchObject({ error: "unauthorized_client" });
  // Cancelling the uninstall must be able to resume the same client.
  expect(store.findOidcClient(clientId)).toBeDefined();

  state.capsuleStatus = "active";
  const resumed = await handleAuthorize({
    ...authorizeRequest(),
    flow,
    clients: new Map(),
    store,
    operations,
  });
  expect(resumed.status).toBe(302);
});

test("repository-materialized OIDC keeps its live grant without a static client id mapping", async () => {
  const { store, operations, installConfig } = await liveGrantFixture();
  const generic = installConfig as unknown as InstallConfig & {
    internal: NonNullable<InstallConfig["internal"]>;
  };
  generic.internal = {
    reason: "per_install_overrides",
    sourceSnapshotId: "snap_live_grant",
    repositoryInstallUxDigest: `sha256:${"a".repeat(64)}`,
  };
  generic.variableMapping = {
    public_url: "https://app.example.test",
  };
  generic.installExperience = {
    projections: [
      { kind: "public_endpoint", variables: { url: "public_url" } },
      {
        kind: "oidc_client",
        variables: {
          accountsUrl: "takosumi_accounts_url",
          issuerUrl: "takosumi_accounts_issuer_url",
          clientId: "takosumi_accounts_client_id",
          redirectUri: "takosumi_accounts_redirect_uri",
        },
        callbackPath: "/auth/callback",
        scopes: ["openid", "profile", "offline_access"],
      },
    ],
    repositoryInstallUx: { status: "accepted" },
  };
  generic.policy = {
    repositoryInstallUx: {
      allowedInterfacePermissions: [],
      allowedOidcScopes: ["openid", "profile", "offline_access"],
    },
  };
  const current = store.findOidcClient(clientId)!;
  store.saveOidcClient({
    ...current,
    activationDigest: await oidcClientActivationDigest({
      scopeRef: workspaceId,
      capsuleId,
      executionAuthorityEpoch: 1,
      installConfig: generic,
    }),
  });

  const response = await handleAuthorize({
    ...authorizeRequest(),
    flow,
    clients: new Map(),
    store,
    operations,
  });

  expect(response.status).toBe(302);
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
      scopeRef: workspaceId,
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

test("app member outside the Workspace still materializes required Interfaces", async () => {
  const { store, state, operations, installConfig, requiredInterfaceCalls } = await liveGrantFixture();
  state.ownerAccountId = "tsub_other_owner";
  state.memberStatus = "suspended";
  installConfig.requiredInterfaces = [{
    key: "ai", interface: { type: "takosumi.ai.gateway", version: "1" },
    permissions: ["ai.chat"], delivery: { type: "oauth2" },
  }];
  store.saveOidcClient({
    ...store.findOidcClient(clientId)!,
    activationDigest: await oidcClientActivationDigest({
      scopeRef: workspaceId, capsuleId, executionAuthorityEpoch: 1,
      installConfig: installConfig as InstallConfig,
    }),
  });
  const response = await handleAuthorize({ ...authorizeRequest(), flow, clients: new Map(), store, operations });
  expect(response.status).toBe(302);
  expect(requiredInterfaceCalls).toHaveLength(1);
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

test("UserInfo uses current app and Workspace roles; Workspace loss does not revoke app sign-in", async () => {
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
      app_role: "member",
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
  expect(refreshed.status).toBe(200);
  const refreshedBody = await refreshed.json() as { access_token: string };

  const staleUserInfo = await handleUserInfo({
    request: new Request(`${issuer}/oauth/userinfo`, {
      headers: { authorization: "Bearer takat_live_grant" },
    }),
    store,
    clients: new Map(),
    operations,
  });
  expect(staleUserInfo.status).toBe(200);
  const staleBody = await staleUserInfo.json() as Record<string, unknown>;
  expect(staleBody.takosumi).toEqual({ capsule_id: capsuleId, app_role: "member" });
  expect(staleBody.workspace_memberships).toBeUndefined();
  const refreshedUserInfo = await handleUserInfo({
    request: new Request(`${issuer}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${refreshedBody.access_token}` },
    }),
    store,
    clients: new Map(),
    operations,
  });
  expect((await refreshedUserInfo.json() as { takosumi: unknown }).takosumi).toEqual({
    capsule_id: capsuleId, app_role: "member",
  });
  expect(store.findOidcClient(clientId)).toBeDefined();
});

test("required Interface domain unavailability permits sign-in while infrastructure failure returns 503", async () => {
  const { InterfaceServiceError } = await import("../../../../core/domains/interfaces/service.ts");
  for (const [failure, status] of [[new InterfaceServiceError("failed_precondition", "provider unavailable"), 302], [new InterfaceServiceError("not_found", "link missing"), 302], [new Error("Interface store unavailable"), 503]] as const) {
    const { store, operations, installConfig } = await liveGrantFixture();
    installConfig.requiredInterfaces = [{ key: "ai", interface: { type: "takosumi.ai.gateway", version: "1" }, permissions: ["ai.chat"], delivery: { type: "oauth2" } }];
    const currentClient = store.findOidcClient(clientId)!;
    store.saveOidcClient({ ...currentClient, activationDigest: await oidcClientActivationDigest({ scopeRef: workspaceId, capsuleId, executionAuthorityEpoch: 1, installConfig: installConfig as InstallConfig }) });
    operations.interfaces!.ensureCapsuleRequiredInterfaces = async () => { throw failure; };
    const response = await handleAuthorize({ ...authorizeRequest(), flow, clients: new Map(), store, operations });
    expect(response.status).toBe(status);
  }
});

test("v75 D1 without interface_links permits OIDC sign-in and Capsule retirement", async () => {
  const { InterfaceService, createD1InterfaceStores } = await import("../../../../core/domains/interfaces/mod.ts");
  const { ensureD1OpenTofuLedgerSchema } = await import("../../../../worker/src/d1_opentofu_store.ts");
  const { SqliteFakeD1 } = await import("../../../helpers/deploy-control/sqlite_fake_d1.ts");
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 75 });
  const stores = createD1InterfaceStores(db);
  const service = new InterfaceService({ stores });
  const requiredInterface = { key: "ai", interface: { type: "takosumi.ai.gateway", version: "1" }, permissions: ["ai.chat"], delivery: { type: "oauth2" } } as const;
  expect(await stores.interfaces.create({
    apiVersion: "takosumi/v1alpha1",
    kind: "Interface",
    metadata: { id: "if_v75_candidate", workspaceId, ownerRef: { kind: "Capsule", id: "provider" }, name: "provider", generation: 1, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z" },
    spec: { type: requiredInterface.interface.type, version: requiredInterface.interface.version, document: {}, access: { visibility: "workspace" } },
    status: { phase: "Resolved", observedGeneration: 1, resolvedRevision: 1 },
  })).toBe(true);
  expect(await service.listInterfaceLinkCandidates({ workspaceId, capsuleId, requirement: requiredInterface })).toEqual([]);
  await expect(service.ensureCapsuleInterfaceLinks({
    workspaceId,
    capsuleId,
    requirements: [requiredInterface],
    selections: [{ requirementKey: "ai", interfaceId: "if_unavailable", selection: "auto_single" }],
  })).rejects.toMatchObject({ code: "failed_precondition" });
  const { store, operations, installConfig } = await liveGrantFixture();
  installConfig.requiredInterfaces = [requiredInterface];
  const currentClient = store.findOidcClient(clientId)!;
  store.saveOidcClient({ ...currentClient, activationDigest: await oidcClientActivationDigest({ scopeRef: workspaceId, capsuleId, executionAuthorityEpoch: 1, installConfig: installConfig as InstallConfig }) });
  operations.interfaces!.ensureCapsuleRequiredInterfaces = service.ensureCapsuleRequiredInterfaces.bind(service);
  const response = await handleAuthorize({ ...authorizeRequest(), flow, clients: new Map(), store, operations });
  expect(response.status).toBe(302);
  expect(await db.prepare("select name from sqlite_master where name='interface_links'").first()).toBeNull();
  await expect(service.retireCapsule(workspaceId, capsuleId)).resolves.toBeUndefined();
});
