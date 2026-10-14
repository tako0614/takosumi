import platform from "../../../../deploy/platform/entry-worker.ts";
import type { CloudflareWorkerEnv } from "../../../../deploy/platform/worker.ts";

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

// An independent handler really verifies its own signed service credential.
// The platform's unknown-local-token result alone never grants an actor.
async function protocol(request: Request, secret: string): Promise<Response> {
  const headers = { "x-fixture-protocol-handler": "reached" };
  try {
    const parts = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u);
    if (!parts) return Response.json({ error: "invalid_protocol_credential" }, { status: 401, headers });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const verified = await crypto.subtle.verify("HMAC", key, decode(parts[2]!), new TextEncoder().encode(parts[1]!));
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1]!)));
    if (!verified || claims.kind !== "service" || claims.sub !== "independent-native-service" ||
      claims.aud !== "fixture-native-protocol" || !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now()) {
      return Response.json({ error: "invalid_protocol_credential" }, { status: 401, headers });
    }
    return Response.json({ actor: { kind: "service", subject: claims.sub },
      cookie: request.headers.get("cookie"), trustedSubject: request.headers.get("x-takosumi-platform-subject") }, { headers });
  } catch {
    return Response.json({ error: "invalid_protocol_credential" }, { status: 401, headers });
  }
}

// This driver supplies only a local extension handler. All routing and
// credential classification run through the actual platform fetch entrypoint.
export default {
  fetch(request: Request, env: CloudflareWorkerEnv & { FIXTURE_PROTOCOL_KEY: string }, context: never) {
    const headers = new Headers(request.headers);
    const originalOrigin = headers.get("x-fixture-original-origin");
    headers.delete("x-fixture-original-origin");
    if (originalOrigin !== null) headers.set("origin", originalOrigin);
    const originalHost = headers.get("x-fixture-original-host");
    headers.delete("x-fixture-original-host");
    if (originalHost !== null) headers.set("host", originalHost);
    const composed = {
      ...env,
      LEGACY_TEST_EXTENSION: {
        fetchAuthenticated: async (forwarded: Request, actor: unknown) =>
          Response.json({ actor, cookie: forwarded.headers.get("cookie"),
            authorization: forwarded.headers.get("authorization"),
            forgedSubject: forwarded.headers.get("x-takosumi-platform-subject") }),
      },
      PROTOCOL_TEST_EXTENSION: { fetch: (forwarded: Request) => protocol(forwarded, env.FIXTURE_PROTOCOL_KEY) },
    };
    return platform.fetch(new Request(request, { headers }), composed, context);
  },
};
