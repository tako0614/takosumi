import { exchangeUpstreamAuthorizationCode, oidcOAuthProvider } from "../../../../accounts/service/src/upstream.ts";
import { verifiedSocialOAuthProvider } from "../../../../accounts/service/src/upstream-verification.ts";

/** Test-only transport maps pinned upstream origins onto real local HTTP. */
export default {
  async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { mode: "google" | "github" | "generic"; origin: string };
    const origin = new URL(input.origin);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("fixture requires loopback HTTP");
    const routes = new Map([
      ["https://oauth2.googleapis.com/token", "/google/token"],
      ["https://www.googleapis.com/oauth2/v3/certs", "/google/jwks"],
      ["https://openidconnect.googleapis.com/v1/userinfo", "/google/userinfo"],
      ["https://github.com/login/oauth/access_token", "/github/token"],
      ["https://api.github.com/user", "/github/user"],
      ["https://api.github.com/user/emails", "/github/emails"],
    ]);
    const transport = (async (url, init) => {
      const upstream = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const path = routes.get(upstream.origin + upstream.pathname);
      if (!path) throw new Error("fixture received an unknown upstream origin");
      return await fetch(new URL(path + upstream.search, origin), init);
    }) as typeof fetch;
    const provider = input.mode === "generic"
      ? oidcOAuthProvider({ id: "legacy", issuer: "https://legacy.example.test", authorizationEndpoint: origin.href + "legacy/authorize", tokenEndpoint: origin.href + "legacy/token", userInfoEndpoint: origin.href + "legacy/userinfo" })
      : verifiedSocialOAuthProvider({ id: input.mode, profile: input.mode === "google" ? "google-oidc" : "github-oauth" });
    try {
      const result = await exchangeUpstreamAuthorizationCode({
        provider,
        clientId: "network-client",
        clientSecret: "fixture-network-client-secret",
        redirectUri: "https://issuer.example.test/oauth/upstream/callback",
        code: "fixture-network-code",
        codeVerifier: "v".repeat(43),
        nonce: "network-nonce",
        subjectSecret: "fixture-network-subject-secret",
        fetch: input.mode === "generic" ? fetch : transport,
      });
      return Response.json({ ok: true, providerId: result.providerId, upstreamSubject: result.upstreamSubject, emailVerified: result.profile?.emailVerified });
    } catch {
      return Response.json({ ok: false, error: "upstream_rejected" }, { status: 502 });
    }
  },
};
