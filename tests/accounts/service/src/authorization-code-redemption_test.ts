import { expect, spyOn, test } from "bun:test";
import { base64UrlEncodeBytes } from "../../../../accounts/service/src/encoding.ts";
import { handleToken } from "../../../../accounts/service/src/oidc-routes.ts";
import {
  InMemoryAccountsStore,
  type AuthorizationCodeRecord,
  type FinalizeAuthorizationCodeRedemptionInput,
  type FinalizeAuthorizationCodeRedemptionResult,
  type TokenRecord,
} from "../../../../accounts/service/src/store.ts";
import type {
  OidcAuthorizationCodeFlow,
  OidcClientRegistration,
} from "../../../../accounts/service/src/mod.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";

const issuer = "https://accounts.example.test";
const redirectUri = "https://client.example.test/oauth/callback";
const client: OidcClientRegistration = {
  clientId: "authorization-code-client",
  redirectUris: [redirectUri],
  tokenEndpointAuthMethod: "none",
  allowedScopes: ["openid"],
};
const flow: OidcAuthorizationCodeFlow = {
  subject: "unused",
  issueIdToken: async () => "test-id-token",
};

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

function exchangeRequest(
  code: string,
  verifier: string,
  patch: Readonly<Record<string, string | undefined>> = {},
): Request {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: client.clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined) params.delete(name);
    else params.set(name, value);
  }
  return new Request(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
}

async function saveCode(
  store: InMemoryAccountsStore,
  code: string,
  verifier: string,
  patch: Partial<AuthorizationCodeRecord> = {},
): Promise<void> {
  await store.saveAuthorizationCode(code, {
    clientId: client.clientId,
    redirectUri,
    scope: "openid offline_access",
    subject: "tsub_authorization_code_owner",
    codeChallenge: await pkceChallenge(verifier),
    codeChallengeMethod: "S256",
    expiresAt: Date.now() + 60_000,
    ...patch,
  });
}

function tokenRecord(scope = "openid offline_access"): TokenRecord {
  return {
    clientId: client.clientId,
    scope,
    subject: "tsub_authorization_code_owner",
    expiresAt: Date.now() + 60_000,
  };
}

test("a failed PKCE attempt cannot burn a valid authorization code", async () => {
  const store = new InMemoryAccountsStore();
  const code = "authorization-code-single-use";
  const verifier = "correct-verifier-with-enough-entropy-for-this-test";
  await store.saveAuthorizationCode(code, {
    clientId: client.clientId,
    redirectUri,
    scope: "openid",
    subject: "tsub_authorization_code_owner",
    codeChallenge: await pkceChallenge(verifier),
    codeChallengeMethod: "S256",
    expiresAt: Date.now() + 60_000,
  });

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const attacker = await handleToken({
      issuer,
      request: exchangeRequest(code, "wrong-verifier"),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
    });
    expect(attacker.status).toBe(400);
    expect(await attacker.json()).toEqual({ error: "invalid_grant" });

    const owner = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
    });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({
      token_type: "Bearer",
      id_token: "test-id-token",
    });
  } finally {
    warn.mockRestore();
  }
});

test("a wrong client id cannot burn a valid authorization code", async () => {
  const store = new InMemoryAccountsStore();
  const code = "code-wrong-client-id";
  const verifier = "verifier-wrong-client-id";
  await saveCode(store, code, verifier, { scope: "openid" });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const denied = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier, {
        client_id: "attacker-client",
      }),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
    });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: "invalid_grant" });

    const accepted = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
    });
    expect(accepted.status).toBe(200);
  } finally {
    warn.mockRestore();
  }
});

test("a wrong client secret cannot burn a valid authorization code", async () => {
  const confidentialClient: OidcClientRegistration = {
    ...client,
    clientId: "confidential-authorization-code-client",
    clientSecret: "correct-client-secret",
    tokenEndpointAuthMethod: "client_secret_post",
  };
  const store = new InMemoryAccountsStore();
  const code = "code-wrong-client-secret";
  const verifier = "verifier-wrong-client-secret";
  await saveCode(store, code, verifier, {
    clientId: confidentialClient.clientId,
    scope: "openid",
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const denied = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier, {
        client_id: confidentialClient.clientId,
        client_secret: "wrong-client-secret",
      }),
      store,
      flow,
      clients: new Map([[confidentialClient.clientId, confidentialClient]]),
    });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "invalid_client" });

    const accepted = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier, {
        client_id: confidentialClient.clientId,
        client_secret: confidentialClient.clientSecret,
      }),
      store,
      flow,
      clients: new Map([[confidentialClient.clientId, confidentialClient]]),
    });
    expect(accepted.status).toBe(200);
  } finally {
    warn.mockRestore();
  }
});

test("a wrong redirect URI cannot burn a valid authorization code", async () => {
  const store = new InMemoryAccountsStore();
  const code = "code-wrong-redirect";
  const verifier = "verifier-wrong-redirect";
  await saveCode(store, code, verifier, { scope: "openid" });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const denied = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier, {
        redirect_uri: "https://attacker.example.test/callback",
      }),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
    });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: "invalid_grant" });

    const accepted = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
    });
    expect(accepted.status).toBe(200);
  } finally {
    warn.mockRestore();
  }
});

test("an inactive live grant cannot burn a code that later becomes valid", async () => {
  const store = new InMemoryAccountsStore();
  const code = "code-live-grant-recovery";
  const verifier = "verifier-live-grant-recovery";
  const subject = "tsub_live_grant_owner";
  const workspaceId = "workspace-live-grant";
  let active = false;
  const operations = {
    workspaces: {
      getWorkspace: async () => ({
        ownerUserId: active ? subject : "tsub_other_owner",
      }),
    },
    members: {
      listMembers: async () => [],
    },
  } as unknown as ControlPlaneOperations;
  await saveCode(store, code, verifier, {
    scope: "openid",
    subject,
    takosumiSubject: subject,
    workspaceId,
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const denied = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
      operations,
    });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: "invalid_grant" });

    active = true;
    const accepted = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
      operations,
    });
    expect(accepted.status).toBe(200);
  } finally {
    warn.mockRestore();
  }
});

test("two validated candidates linearize to one claim and one replay", async () => {
  const store = new InMemoryAccountsStore();
  await saveCode(store, "code-two-claimants", "verifier-two-claimants");
  const first =
    await store.openAuthorizationCodeRedemption("code-two-claimants");
  const second =
    await store.openAuthorizationCodeRedemption("code-two-claimants");
  expect(first.status).toBe("active");
  expect(second.status).toBe("active");
  if (first.status !== "active" || second.status !== "active") return;

  const winner = await store.claimValidatedAuthorizationCode(first.candidate);
  const loser = await store.claimValidatedAuthorizationCode(second.candidate);
  expect(winner.status).toBe("claimed");
  expect(loser).toEqual({ status: "replayed" });
  if (winner.status !== "claimed") return;
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code: "code-two-claimants",
      claimId: winner.claimId,
      accessToken: "access-must-not-survive",
      accessRecord: tokenRecord(),
    }),
  ).toEqual({ status: "replayed" });
  expect(store.findAccessToken("access-must-not-survive")).toBeUndefined();
});

test("a replay before finalize wins and persists no token", async () => {
  const store = new InMemoryAccountsStore();
  const code = "code-replay-before-finalize";
  await saveCode(store, code, "verifier-replay-before-finalize");
  const opened = await store.openAuthorizationCodeRedemption(code);
  expect(opened.status).toBe("active");
  if (opened.status !== "active") return;
  const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
  expect(claim.status).toBe("claimed");
  if (claim.status !== "claimed") return;

  expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
    status: "replayed",
  });
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code,
      claimId: claim.claimId,
      accessToken: "access-after-replay",
      accessRecord: tokenRecord(),
      refreshToken: "refresh-after-replay",
      refreshRecord: tokenRecord(),
    }),
  ).toEqual({ status: "replayed" });
  expect(store.findAccessToken("access-after-replay")).toBeUndefined();
  expect(store.findRefreshToken("refresh-after-replay")).toBeUndefined();
});

test("a replay after finalize revokes access, refresh, and rotated descendants", async () => {
  const store = new InMemoryAccountsStore();
  const code = "code-replay-after-finalize";
  await saveCode(store, code, "verifier-replay-after-finalize");
  const opened = await store.openAuthorizationCodeRedemption(code);
  if (opened.status !== "active") throw new Error("expected active code");
  const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
  if (claim.status !== "claimed") throw new Error("expected claim winner");
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code,
      claimId: claim.claimId,
      accessToken: "access-original",
      accessRecord: tokenRecord(),
      refreshToken: "refresh-root",
      refreshRecord: tokenRecord(),
    }),
  ).toEqual({ status: "issued" });
  expect(await store.addRefreshChainLink("refresh-root", "refresh-child")).toBe(
    true,
  );
  store.saveRefreshToken("refresh-child", tokenRecord());
  store.saveAccessToken("access-descendant", tokenRecord());
  store.linkAccessTokenToRefreshChain("refresh-child", "access-descendant");

  expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
    status: "replayed",
  });
  expect(store.findAccessToken("access-original")).toBeUndefined();
  expect(store.findAccessToken("access-descendant")).toBeUndefined();
  expect(store.findRefreshToken("refresh-root")).toBeUndefined();
  expect(store.findRefreshToken("refresh-child")).toBeUndefined();
});

test("a stale validation snapshot cannot consume a replacement record", async () => {
  const store = new InMemoryAccountsStore();
  const code = "code-record-substitution";
  await saveCode(store, code, "verifier-record-a", { subject: "record-a" });
  const recordA = await store.openAuthorizationCodeRedemption(code);
  if (recordA.status !== "active") throw new Error("expected record A");
  await saveCode(store, code, "verifier-record-b", { subject: "record-b" });

  expect(
    await store.claimValidatedAuthorizationCode(recordA.candidate),
  ).toEqual({ status: "stale" });
  const recordB = await store.openAuthorizationCodeRedemption(code);
  expect(recordB.status).toBe("active");
  if (recordB.status !== "active") return;
  expect(recordB.candidate.record.subject).toBe("record-b");
  expect(
    await store.claimValidatedAuthorizationCode(recordB.candidate),
  ).toMatchObject({ status: "claimed" });
});

test("a signing failure burns the claim and never returns credentials", async () => {
  const store = new InMemoryAccountsStore();
  const code = "code-signing-failure";
  const verifier = "verifier-signing-failure";
  await saveCode(store, code, verifier, { scope: "openid" });
  const signingFailure: OidcAuthorizationCodeFlow = {
    subject: "unused",
    issueIdToken: async () => {
      throw new Error("injected signer outage");
    },
  };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const failed = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier),
      store,
      flow: signingFailure,
      clients: new Map([[client.clientId, client]]),
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "server_error" });

    const retried = await handleToken({
      issuer,
      request: exchangeRequest(code, verifier),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
    });
    expect(retried.status).toBe(400);
    expect(await retried.json()).toEqual({ error: "invalid_grant" });
  } finally {
    warn.mockRestore();
  }
});

class FinalizeBarrierStore extends InMemoryAccountsStore {
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  #release!: () => void;
  readonly #released: Promise<void>;
  attemptedAccessToken?: string;

  constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  override async finalizeAuthorizationCodeRedemption(
    input: FinalizeAuthorizationCodeRedemptionInput,
  ): Promise<FinalizeAuthorizationCodeRedemptionResult> {
    this.attemptedAccessToken = input.accessToken;
    this.#markEntered();
    await this.#released;
    return super.finalizeAuthorizationCodeRedemption(input);
  }
}

test("the token route returns no live token when replay wins at the finalize barrier", async () => {
  const store = new FinalizeBarrierStore();
  const code = "code-route-finalize-barrier";
  const verifier = "verifier-route-finalize-barrier";
  await saveCode(store, code, verifier, { scope: "openid" });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const exchange = handleToken({
      issuer,
      request: exchangeRequest(code, verifier),
      store,
      flow,
      clients: new Map([[client.clientId, client]]),
    });
    await store.entered;
    expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
      status: "replayed",
    });
    store.release();

    const response = await exchange;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
    expect(store.attemptedAccessToken).toBeDefined();
    expect(store.findAccessToken(store.attemptedAccessToken!)).toBeUndefined();
  } finally {
    warn.mockRestore();
  }
});

test("a lost successful response retry revokes every issued descendant", async () => {
  const offlineClient: OidcClientRegistration = {
    ...client,
    clientId: "offline-authorization-code-client",
    allowedScopes: ["openid", "offline_access"],
  };
  const store = new InMemoryAccountsStore();
  const code = "code-lost-response";
  const verifier = "verifier-lost-response";
  await saveCode(store, code, verifier, {
    clientId: offlineClient.clientId,
    scope: "openid offline_access",
  });
  const request = () =>
    exchangeRequest(code, verifier, { client_id: offlineClient.clientId });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const first = await handleToken({
      issuer,
      request: request(),
      store,
      flow,
      clients: new Map([[offlineClient.clientId, offlineClient]]),
    });
    expect(first.status).toBe(200);
    const issued = (await first.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(typeof issued.access_token).toBe("string");
    expect(typeof issued.refresh_token).toBe("string");
    expect(
      await store.addRefreshChainLink(
        issued.refresh_token,
        "lost-response-refresh-child",
      ),
    ).toBe(true);
    store.saveRefreshToken("lost-response-refresh-child", tokenRecord());
    store.saveAccessToken("lost-response-access-child", tokenRecord());
    store.linkAccessTokenToRefreshChain(
      "lost-response-refresh-child",
      "lost-response-access-child",
    );

    const retried = await handleToken({
      issuer,
      request: request(),
      store,
      flow,
      clients: new Map([[offlineClient.clientId, offlineClient]]),
    });
    expect(retried.status).toBe(400);
    expect(await retried.json()).toEqual({ error: "invalid_grant" });
    expect(store.findAccessToken(issued.access_token)).toBeUndefined();
    expect(store.findRefreshToken(issued.refresh_token)).toBeUndefined();
    expect(store.findAccessToken("lost-response-access-child")).toBeUndefined();
    expect(
      store.findRefreshToken("lost-response-refresh-child"),
    ).toBeUndefined();
  } finally {
    warn.mockRestore();
  }
});

class RefreshPostIssueBarrierStore extends InMemoryAccountsStore {
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  #release!: () => void;
  readonly #released: Promise<void>;
  attemptedAccessToken?: string;
  attemptedRefreshToken?: string;
  attemptedRefreshExpiresAt?: number;

  constructor(private readonly parentRefreshToken: string) {
    super();
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  override saveAccessToken(token: string, record: TokenRecord): void {
    this.attemptedAccessToken = token;
    super.saveAccessToken(token, record);
  }

  override saveRefreshToken(token: string, record: TokenRecord): void {
    if (token !== this.parentRefreshToken) {
      this.attemptedRefreshToken = token;
      this.attemptedRefreshExpiresAt = record.expiresAt;
    }
    super.saveRefreshToken(token, record);
  }

  override async isRefreshRootRevoked(token: string): Promise<boolean> {
    if (token !== this.parentRefreshToken) {
      this.#markEntered();
      await this.#released;
    }
    return await super.isRefreshRootRevoked(token);
  }
}

test("authorization-code replay erases an in-flight refresh rotation before its response", async () => {
  const offlineClient: OidcClientRegistration = {
    ...client,
    clientId: "refresh-race-authorization-code-client",
    allowedScopes: ["openid", "offline_access"],
  };
  const code = "code-refresh-rotation-race";
  const parentRefreshToken = "refresh-rotation-race-root";
  const store = new RefreshPostIssueBarrierStore(parentRefreshToken);
  await saveCode(store, code, "verifier-refresh-rotation-race", {
    clientId: offlineClient.clientId,
    scope: "openid offline_access",
  });
  const opened = await store.openAuthorizationCodeRedemption(code);
  if (opened.status !== "active") throw new Error("expected active code");
  const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
  if (claim.status !== "claimed") throw new Error("expected claim winner");
  const issuedRecord: TokenRecord = {
    clientId: offlineClient.clientId,
    scope: "openid offline_access",
    subject: "tsub_authorization_code_owner",
    expiresAt: Date.now() + 60_000,
  };
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code,
      claimId: claim.claimId,
      accessToken: "refresh-rotation-race-initial-access",
      accessRecord: issuedRecord,
      refreshToken: parentRefreshToken,
      refreshRecord: issuedRecord,
    }),
  ).toEqual({ status: "issued" });

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: parentRefreshToken,
    client_id: offlineClient.clientId,
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const rotation = handleToken({
      issuer,
      request: new Request(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params,
      }),
      store,
      flow,
      clients: new Map([[offlineClient.clientId, offlineClient]]),
    });
    // The child refresh/access records and their root link are durable when
    // this final revocation fence pauses. Replay must erase those late writes.
    await store.entered;
    expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
      status: "replayed",
    });
    store.release();

    const response = await rotation;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
    expect(store.attemptedAccessToken).toBeDefined();
    expect(store.attemptedRefreshToken).toBeDefined();
    expect(store.attemptedRefreshExpiresAt).toBe(issuedRecord.expiresAt);
    expect(store.findAccessToken(store.attemptedAccessToken!)).toBeUndefined();
    expect(
      store.findRefreshToken(store.attemptedRefreshToken!),
    ).toBeUndefined();
  } finally {
    store.release();
    warn.mockRestore();
  }
});
