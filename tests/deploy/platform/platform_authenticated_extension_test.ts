import { expect, test } from "bun:test";
import {
  handlePlatformExtensionRouteRequest,
  type PlatformExtensionAuthenticatedContext,
} from "../../../deploy/platform/worker.ts";

const CONTEXT_ROUTE = {
  basePath: "/extensions/context",
  handlerKey: "CONTEXT_EXTENSION",
  authDelivery: "context" as const,
  workspaceContext: "query-required" as const,
  runCredential: {
    audience: "operator.example.provider.v1",
    requiredScopes: ["example.write"],
  },
};

const verifiedSession = async () => ({
  authenticated: true as const,
  authKind: "run-credential" as const,
  subject: "principal_installer",
  workspaceId: "workspace_verified",
  workspaceRole: "member" as const,
  scopes: ["example.read", "example.write"],
  capsuleId: "capsule_verified",
  runId: "run_verified",
  installingPrincipalId: "principal_installer",
  audience: "operator.example.provider.v1",
  phase: "apply" as const,
});

test("context delivery strips credentials and forged trusted headers, and freezes safe context", async () => {
  let forwardedRequest: Request | undefined;
  let forwardedContext: PlatformExtensionAuthenticatedContext | undefined;
  const response = await handlePlatformExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/extensions/context?workspaceId=workspace_verified",
      {
        method: "POST",
        headers: {
          AuThOrIzAtIoN: "Bearer raw-credential",
          CoOkIe: "takosumi_session=raw-cookie",
          "PrOxY-AuThOrIzAtIoN": "Basic raw",
          "X-AuTh-EmAiL": "forged@example.com",
          "x-auth-key": "raw-key",
          "x-auth-user-service-key": "raw-service-key",
          "x-takosumi-account-session": "raw-session",
          "X-TaKoSuMi-PlAtFoRm-AuThEnTiCaTeD": "1",
          "x-takosumi-platform-subject": "forged-subject",
          "x-takosumi-platform-auth-kind": "service-token",
          "x-takosumi-platform-scopes": "admin",
          "x-takosumi-platform-workspace-id": "workspace_attacker",
          "x-takosumi-platform-workspace-role": "owner",
          "x-takosumi-platform-capsule-id": "capsule_attacker",
          "x-takosumi-platform-audience": "https://attacker.example",
          "x-takosumi-platform-interface-id": "interface_attacker",
          "x-takosumi-platform-interface-binding-id": "binding_attacker",
          "x-takosumi-platform-interface-resolved-revision": "999",
          "x-takosumi-platform-forged-extension-context": "forged",
          "x-takosumi-resource-managed-by": "attacker.manager",
          "x-takosumi-internal-managed-provider-run-token":
            "forged-managed-token",
          "x-takosumi-internal-managed-provider-profile":
            "forged-profile",
          "x-takosumi-internal-managed-provider-forged": "forged",
          "x-takosumi-internal-forged": "forged",
          "x-takosumi-actor-context": "forged-actor",
          "x-takosumi-privacy-operations-token": "forged-privacy-token",
          "x-takosumi-caller": "forged-caller",
          "x-takosumi-audience": "forged-audience",
          "x-takosumi-capabilities": "forged-capabilities",
          "x-takosumi-body-digest": "forged-body-digest",
          "x-takosumi-nonce": "forged-nonce",
          "x-takosumi-request-id": "forged-request-id",
          "x-takosumi-future": "forged-future",
          "x-extension-safe": "retained",
        },
        body: JSON.stringify({ hello: "world" }),
      },
    ),
    {
      CONTEXT_EXTENSION: {
        fetchAuthenticated: async (
          request: Request,
          context: PlatformExtensionAuthenticatedContext,
        ) => {
          forwardedRequest = request;
          forwardedContext = context;
          return Response.json({ ok: true });
        },
      },
    } as never,
    CONTEXT_ROUTE,
    verifiedSession,
  );

  expect(response.status).toBe(200);
  expect(forwardedRequest).toBeDefined();
  for (const header of [
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-auth-email",
    "x-auth-key",
    "x-auth-user-service-key",
    "x-takosumi-account-session",
    "x-takosumi-platform-authenticated",
    "x-takosumi-platform-subject",
    "x-takosumi-platform-auth-kind",
    "x-takosumi-platform-scopes",
    "x-takosumi-platform-workspace-id",
    "x-takosumi-platform-workspace-role",
    "x-takosumi-platform-capsule-id",
    "x-takosumi-platform-audience",
    "x-takosumi-platform-interface-id",
    "x-takosumi-platform-interface-binding-id",
    "x-takosumi-platform-interface-resolved-revision",
    "x-takosumi-platform-forged-extension-context",
    "x-takosumi-resource-managed-by",
    "x-takosumi-internal-managed-provider-run-token",
    "x-takosumi-internal-managed-provider-profile",
    "x-takosumi-internal-managed-provider-forged",
    "x-takosumi-internal-forged",
    "x-takosumi-actor-context",
    "x-takosumi-privacy-operations-token",
    "x-takosumi-caller",
    "x-takosumi-audience",
    "x-takosumi-capabilities",
    "x-takosumi-body-digest",
    "x-takosumi-nonce",
    "x-takosumi-request-id",
    "x-takosumi-future",
  ]) {
    expect(forwardedRequest?.headers.get(header), header).toBeNull();
  }
  expect(forwardedRequest?.headers.get("x-extension-safe")).toBe("retained");
  expect(forwardedContext).toEqual({
    authKind: "run-credential",
    subject: "principal_installer",
    workspaceId: "workspace_verified",
    workspaceRole: "member",
    scopes: ["example.read", "example.write"],
    capsuleId: "capsule_verified",
    runId: "run_verified",
    installingPrincipalId: "principal_installer",
    audience: "operator.example.provider.v1",
    phase: "apply",
  });
  expect(forwardedContext).not.toHaveProperty("token");
  expect(Object.isFrozen(forwardedContext)).toBe(true);
  expect(Object.isFrozen(forwardedContext?.scopes)).toBe(true);
  expect(await forwardedRequest?.text()).toBe(
    JSON.stringify({ hello: "world" }),
  );
});

test("context delivery does not call an extension for unauthenticated or unsupported context", async () => {
  let calls = 0;
  const handler = {
    fetchAuthenticated: async () => {
      calls += 1;
      return Response.json({ ok: true });
    },
  };
  const unauthenticated = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/extensions/context"),
    { CONTEXT_EXTENSION: handler } as never,
    { ...CONTEXT_ROUTE, workspaceContext: undefined },
    async () => ({ authenticated: false }),
  );
  expect(unauthenticated.status).toBe(401);
  expect(calls).toBe(0);

  const unsupported = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/extensions/context"),
    {
      CONTEXT_EXTENSION: {
        fetch: async () => {
          calls += 1;
          return Response.json({ unsafe: true });
        },
      },
    } as never,
    { ...CONTEXT_ROUTE, workspaceContext: undefined },
    verifiedSession,
  );
  expect(unsupported.status).toBe(503);
  expect(calls).toBe(0);

  const unsupportedAuthKind = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/extensions/context"),
    { CONTEXT_EXTENSION: handler } as never,
    { ...CONTEXT_ROUTE, workspaceContext: undefined },
    async () => ({
      authenticated: true,
      authKind: "protocol-credential",
      subject: "protocol-subject",
    }),
  );
  expect(unsupportedAuthKind.status).toBe(401);
  expect(calls).toBe(0);
});

test("ambient session mutations require issuer Origin even with a bogus Authorization header", async () => {
  let calls = 0;
  const route = {
    basePath: "/extensions/csrf",
    handlerKey: "CSRF_EXTENSION",
  };
  const env = {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.example",
    CSRF_EXTENSION: {
      fetch: async () => {
        calls += 1;
        return Response.json({ ok: true });
      },
    },
  } as never;
  const ambientSession = async () => ({
    authenticated: true as const,
    authKind: "session" as const,
    subject: "session-subject",
  });

  const evilOrigin = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/extensions/csrf", {
      method: "POST",
      headers: {
        authorization: "Bearer bogus-token",
        origin: "https://evil.example",
      },
    }),
    env,
    route,
    ambientSession,
  );
  expect(evilOrigin.status).toBe(403);
  expect(calls).toBe(0);

  const issuerOrigin = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/extensions/csrf", {
      method: "POST",
      headers: {
        authorization: "Bearer bogus-token",
        origin: "https://accounts.example",
      },
    }),
    env,
    route,
    ambientSession,
  );
  expect(issuerOrigin.status).toBe(200);
  expect(calls).toBe(1);

  const tokenAuth = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/extensions/csrf", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        origin: "https://evil.example",
      },
    }),
    env,
    route,
    async () => ({
      authenticated: true,
      authKind: "personal-access-token" as const,
      subject: "token-subject",
      scopes: ["write"],
    }),
  );
  expect(tokenAuth.status).toBe(200);
  expect(calls).toBe(2);
});

test("legacy header delivery remains the default and byte-compatible", async () => {
  let forwarded: Record<string, string | null> | undefined;
  const response = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/extensions/legacy", {
      headers: {
        authorization: "Bearer raw-credential",
        cookie: "takosumi_session=raw-cookie",
      },
    }),
    {
      LEGACY_EXTENSION: {
        fetch: async (request: Request) => {
          forwarded = {
            authorization: request.headers.get("authorization"),
            cookie: request.headers.get("cookie"),
            authenticated: request.headers.get(
              "x-takosumi-platform-authenticated",
            ),
            subject: request.headers.get("x-takosumi-platform-subject"),
          };
          return Response.json({ ok: true });
        },
      },
    } as never,
    { basePath: "/extensions/legacy", handlerKey: "LEGACY_EXTENSION" },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "legacy-subject",
    }),
  );

  expect(response.status).toBe(200);
  expect(forwarded).toEqual({
    authorization: null,
    cookie: null,
    authenticated: "1",
    subject: "legacy-subject",
  });
});
