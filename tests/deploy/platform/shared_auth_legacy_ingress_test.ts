import { expect, test } from "bun:test";
import {
  handleSharedAuthAccountBoundaryRequest,
  sharedAuthRequestFailure,
  sharedStagingAppAuthorizeSessionResolver,
  type SharedAuthEnvironment,
} from "../../../worker/src/shared_auth_rpc.ts";
import {
  handlePlatformSharedAuthControlRequest,
  verifyPlatformExtensionBearerToken,
  verifyPlatformExtensionSession,
  type CloudflareWorkerEnv,
} from "../../../deploy/platform/worker.ts";

const origin = "https://hosted.staging.example.test";
const aliases = [origin, "https://gateway.example.workers.dev",
  "https://preview-gateway.example.workers.dev", "https://alias.example.test"];
const env = {
  TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
  TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
  TAKOSUMI_ENVIRONMENT: "staging",
  TAKOSUMI_DEPLOY_CONTROL_TOKEN: "fixture-independent-operator-token",
  HOSTED: {
    fetchSharedAuth: async () => new Response(null, { status: 204 }),
    authenticateSharedAuth: async () => ({ kind: "authenticated", accountId: "tsub_current" }),
    resolveSharedAuthWorkspace: async () => ({ kind: "forbidden" }),
  },
} as CloudflareWorkerEnv;

test("shared product rejects the complete legacy human entry surface on every URL origin", async () => {
  for (const alias of aliases) {
    for (const path of ["/api/v1/auth", "/api/v1/auth/providers",
      "/api/v1/auth/passkeys/register/options", "/api/v1/auth/passkeys/authenticate/complete",
      "/api/v1/account", "/api/v1/account/tokens", "/api/v1/account/session/global-logout",
      "/api/v1/account/identity-merges", "/api/v1/privacy/requests",
      "/oauth/upstream/authorize", "/oauth/upstream/callback", "/oauth/authorize"]) {
      const request = new Request(alias + path, { headers: {
        cookie: "takosumi_session=sess_legacy", host: new URL(origin).host,
        "x-forwarded-host": new URL(origin).host, "x-forwarded-proto": "https",
        "x-takosumi-platform-subject": "tsub_current",
      } });
      const response = await handleSharedAuthAccountBoundaryRequest(request, env);
      expect(response?.status, alias + path).toBe(404);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(await handleSharedAuthAccountBoundaryRequest(request, {})).toBeUndefined();
    }
    const signIn = await handleSharedAuthAccountBoundaryRequest(new Request(alias + "/sign-in"), env);
    expect(signIn?.status).toBe(alias === origin ? 302 : 404);
  }
  for (const path of ["/oauth/token", "/oauth/introspect", "/oauth/revoke", "/oauth/jwks", "/oauth/userinfo"]) {
    expect(await handleSharedAuthAccountBoundaryRequest(new Request(origin + path), env)).toBeUndefined();
  }
});

test("only the official staging authorize request can use the private Hosted app proof", async () => {
  const stageOrigin = "https://app-staging.takosumi.com";
  const proof = {
    kind: "authenticated" as const, subject: "tsub_current" as const,
    issuer: "https://auth-staging.takos.jp", clientId: "takosumi-hosted-staging-v1",
    sessionId: "hsid_current", identityGeneration: 3, expiresAt: Date.now() + 30_000,
  };
  let calls = 0;
  let reply = proof;
  const selected = {
    ...env, TAKOSUMI_SHARED_AUTH_ORIGIN: stageOrigin, TAKOSUMI_ACCOUNTS_ISSUER: stageOrigin,
    HOSTED: {
      ...(env.HOSTED as object),
      async authenticateAppAuthorization(request: Request) {
        calls++;
        expect(request.headers.get("cookie")).toBe("__Host-rp=fixture");
        expect(request.headers.get("x-takosumi-account-session")).toBeNull();
        expect(request.headers.get("x-takosumi-platform-subject")).toBeNull();
        return reply;
      },
    },
  };
  const route = "/oauth/authorize?client_id=toc_fixture";
  const request = new Request(stageOrigin + route, { headers: {
    cookie: "__Host-rp=fixture", "x-takosumi-account-session": "sess_conflicting",
    "x-takosumi-platform-subject": "tsub_untrusted",
  } });
  expect(await handleSharedAuthAccountBoundaryRequest(request, selected)).toBeUndefined();
  expect(calls).toBe(0);
  for (const rejected of [
    new Request(origin + route),
    new Request(stageOrigin + "/oauth/authorize"),
    new Request(stageOrigin + route, { method: "POST" }),
    new Request(stageOrigin + route, { headers: { authorization: "Bearer fixture" } }),
  ]) expect((await handleSharedAuthAccountBoundaryRequest(rejected, selected))?.status).toBe(404);
  expect((await handleSharedAuthAccountBoundaryRequest(request, {
    ...selected, TAKOSUMI_ACCOUNTS_ISSUER: proof.issuer,
  }))?.status).toBe(404);
  const resolver = sharedStagingAppAuthorizeSessionResolver(selected)!;
  expect(await resolver(request)).toEqual(proof);
  reply = { ...proof, clientId: "another-client" };
  expect(await resolver(request)).toEqual({ kind: "unavailable" });
  expect(await resolver(new Request(origin + route))).toEqual({ kind: "unauthenticated" });
  expect(calls).toBe(2);
});

test("alternate URL Control requests and invalid shared composition never fall through to legacy Accounts", async () => {
  let operations = 0;
  for (const alias of aliases.slice(1)) {
    const response = await handlePlatformSharedAuthControlRequest(new Request(alias + "/api/v1/workspaces", {
      headers: { cookie: "takosumi_session=sess_legacy", "x-forwarded-host": new URL(origin).host },
    }), env, { resolveOperations: async () => { operations++; throw new Error("legacy fallback"); } });
    expect(response?.status).toBe(401);
  }
  for (const change of [{ HOSTED: undefined }, { TAKOSUMI_SHARED_AUTH_PROFILE: "invalid" },
    { TAKOSUMI_SHARED_AUTH_ORIGIN: undefined }, { TAKOSUMI_ENVIRONMENT: "production" }]) {
    const invalid = { ...env, ...change } as CloudflareWorkerEnv;
    const request = new Request(origin + "/extensions/test", { headers: { authorization: "Bearer fixture-independent-operator-token" } });
    expect(sharedAuthRequestFailure(request, invalid)?.status).toBe(503);
    expect(await verifyPlatformExtensionSession(request, invalid)).toEqual({ authenticated: false, unavailable: true });
  }
  expect(operations).toBe(0);
});

test("only the verified independent operator survives; human OAuth, PAT and Principal Interface grants cannot become machine authority", async () => {
  let introspections = 0;
  for (const alias of aliases) {
    for (const tokenUse of ["oauth_access", "personal_access", "interface_oauth"]) {
      const request = new Request(alias + "/extensions/test", { headers: {
        authorization: "Bearer arbitrary-human-token", "x-takosumi-platform-auth-kind": "service-token",
        "x-takosumi-platform-subject": "operator", "x-takosumi-platform-scopes": "admin",
      } });
      expect(await verifyPlatformExtensionSession(request, env)).toEqual({ authenticated: false });
      const result = await verifyPlatformExtensionBearerToken(request, env, "arbitrary-human-token", undefined, async () => {
        introspections++;
        return Response.json({ active: true, token_use: tokenUse, sub: "tsub_legacy", scope: "admin" });
      });
      expect(result).toEqual({ authenticated: false });
    }
    const operator = new Request(alias + "/extensions/test", { headers: {
      authorization: "Bearer fixture-independent-operator-token",
      "x-takosumi-platform-subject": "forged",
    } });
    expect(await verifyPlatformExtensionSession(operator, env)).toEqual({ authenticated: true,
      authKind: "service-token", subject: "takosumi:deploy-control", scopes: ["admin"] });
    expect(await verifyPlatformExtensionSession(new Request(operator, { headers: {
      authorization: operator.headers.get("authorization")!, cookie: "__Host-rp=real-cookie",
    } }), env)).toEqual({ authenticated: false });
  }
  expect(introspections).toBe(0);
  // Stock OSS still resolves its existing opaque human grant through Accounts.
  const stock = await verifyPlatformExtensionBearerToken(new Request(origin), {
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "fixture-client", TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "fixture-secret",
  } as CloudflareWorkerEnv, "human-token", undefined, async () => Response.json({
    active: true, token_use: "oauth_access", sub: "tsub_legacy", scope: "admin",
  }));
  expect(stock).toMatchObject({ authenticated: true, authKind: "oauth-access-token" });
});

test("stock OSS composition ignores unrelated HOSTED and has no global credential ambiguity policy", () => {
  expect(sharedAuthRequestFailure(new Request(origin, { headers: {
    authorization: "Bearer fixture-independent-operator-token", cookie: "takosumi_session=legacy",
  } }), { HOSTED: env.HOSTED } as SharedAuthEnvironment)).toBeUndefined();
});

test("only the exact operator-owned privacy completion POST reaches its existing verifier", async () => {
  const path = "/api/v1/privacy/requests/prq_" + "a".repeat(20) + "/complete";
  expect(await handleSharedAuthAccountBoundaryRequest(new Request(origin + path, { method: "POST" }), env)).toBeUndefined();
  for (const [pathname, method] of [[path, "GET"], [path + "/", "POST"], [path + "/extra", "POST"],
    [path.replace("prq_", "other_"), "POST"], ["/api/v1/privacy/requests", "POST"]]) {
    expect((await handleSharedAuthAccountBoundaryRequest(new Request(origin + pathname, { method }), env))?.status).toBe(404);
  }
});
