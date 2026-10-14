import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";
import { base64UrlEncodeBytes, base64UrlEncodeJson } from "../../../../accounts/service/src/encoding.ts";
import { fetchUpstreamJson } from "../../../../accounts/service/src/upstream-http.ts";

interface NativeRequestRecord {
  path: string;
  method: string;
  authorization: string | null;
  body: string;
}

async function runtimeFixture() {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../fixtures/social-upstream-network-runtime.ts")], target: "browser", format: "esm", minify: true });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("upstream native network fixture bundle is missing");
  const runtime = new Miniflare({ compatibilityDate: "2026-07-17", modules: [{ type: "ESModule", path: "social-upstream-network-runtime.mjs", contents: await output.text() }] });
  const requests: NativeRequestRecord[] = [];
  const sinkRequests: NativeRequestRecord[] = [];
  let redirectPath: string | undefined;
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), alg: "RS256", kid: "native-network-key", use: "sig" };
  const sink = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    sinkRequests.push({ path: new URL(request.url).pathname, method: request.method, authorization: request.headers.get("authorization"), body: await request.text() });
    return Response.json({ sub: "redirect-should-never-arrive" });
  } });
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ path, method: request.method, authorization: request.headers.get("authorization"), body: await request.text() });
    if (path === redirectPath) return new Response("redirect body must be canceled", { status: 307, headers: { location: sink.url.href + "credential-sink" } });
    if (path === "/google/token") {
      const now = Math.floor(Date.now() / 1000);
      const input = `${base64UrlEncodeJson({ alg: "RS256", kid: "native-network-key" })}.${base64UrlEncodeJson({ iss: "https://accounts.google.com", aud: "network-client", sub: "native-google-subject", nonce: "network-nonce", iat: now, exp: now + 300, email: "native@gmail.com", email_verified: true })}`;
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input));
      return Response.json({ access_token: "fixture-google-access", token_type: "Bearer", id_token: `${input}.${base64UrlEncodeBytes(new Uint8Array(signature))}` });
    }
    if (path === "/google/jwks") return Response.json({ keys: [jwk] });
    if (path === "/google/userinfo") return Response.json({ sub: "native-google-subject" });
    if (path === "/github/token") return Response.json({ access_token: "fixture-github-access", token_type: "Bearer" });
    if (path === "/github/user") return Response.json({ id: 44444, login: "native-fixture", email: "untrusted-public@example.test" });
    if (path === "/github/emails") return Response.json([{ email: "native@gmail.com", primary: true, verified: true, visibility: null }]);
    if (path === "/legacy/token") return Response.json({ access_token: "fixture-legacy-access" });
    if (path === "/legacy/userinfo") return Response.json({ sub: "native-legacy-subject" });
    return new Response(null, { status: 404 });
  } });
  return {
    requests,
    sinkRequests,
    setRedirect(path: string | undefined) { redirectPath = path; },
    async exchange(mode: "google" | "github" | "generic") {
      return await runtime.dispatchFetch("https://runtime.example.test/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, origin: origin.url.href }) });
    },
    async close() { await runtime.dispose(); origin.stop(true); sink.stop(true); },
  };
}

test("native workerd upstream Google token/JWKS/UserInfo and GitHub private email requests reach HTTP origins", async () => {
  const f = await runtimeFixture();
  try {
    const google = await f.exchange("google");
    expect(google.status).toBe(200);
    expect(await google.json()).toEqual({ ok: true, providerId: "google", upstreamSubject: "native-google-subject", emailVerified: true });
    expect(f.requests.map(request => request.path)).toEqual(["/google/token", "/google/jwks", "/google/userinfo"]);
    expect(f.requests[0]!.method).toBe("POST");
    const tokenBody = new URLSearchParams(f.requests[0]!.body);
    expect(tokenBody.get("code_verifier")).toBe("v".repeat(43));
    expect(tokenBody.get("client_secret")).toBe("fixture-network-client-secret");
    expect(f.requests[1]!.authorization).toBeNull();
    expect(f.requests[2]!.authorization).toBe("Bearer fixture-google-access");
    f.requests.length = 0;
    const github = await f.exchange("github");
    expect(github.status).toBe(200);
    expect(await github.json()).toEqual({ ok: true, providerId: "github", upstreamSubject: "44444", emailVerified: true });
    expect(f.requests.map(request => request.path)).toEqual(["/github/token", "/github/user", "/github/emails"]);
    expect(f.requests[1]!.authorization).toBe("Bearer fixture-github-access");
    expect(f.requests[2]!.authorization).toBe("Bearer fixture-github-access");
    expect(f.sinkRequests).toHaveLength(0);
  } finally { await f.close(); }
}, 20_000);

test("native workerd rejects every upstream 307 before following credentials to a different origin", async () => {
  const f = await runtimeFixture();
  try {
    for (const [mode, stages] of [["google", ["/google/token", "/google/jwks", "/google/userinfo"]], ["github", ["/github/token", "/github/user", "/github/emails"]]] as const) {
      for (let index = 0; index < stages.length; index++) {
        f.requests.length = 0;
        f.setRedirect(stages[index]);
        const rejected = await f.exchange(mode);
        expect(rejected.status).toBe(502);
        expect(await rejected.json()).toEqual({ ok: false, error: "upstream_rejected" });
        expect(f.requests.map(request => request.path)).toEqual(stages.slice(0, index + 1));
        expect(f.sinkRequests).toHaveLength(0);
      }
    }
  } finally { await f.close(); }
}, 20_000);

test("native workerd legacy self-host upstream remains usable and refuses redirects with the same transport", async () => {
  const f = await runtimeFixture();
  try {
    const success = await f.exchange("generic");
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ ok: true, providerId: "legacy", upstreamSubject: "native-legacy-subject" });
    expect(f.requests.map(request => request.path)).toEqual(["/legacy/token", "/legacy/userinfo"]);
    f.requests.length = 0;
    f.setRedirect("/legacy/userinfo");
    expect((await f.exchange("generic")).status).toBe(502);
    expect(f.requests.map(request => request.path)).toEqual(["/legacy/token", "/legacy/userinfo"]);
    expect(f.sinkRequests).toHaveLength(0);
  } finally { await f.close(); }
}, 20_000);

test("upstream manual transport cancels redirect bodies and never retries", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let canceled = 0;
    let calls = 0;
    const transport = (async (_input, init) => {
      calls++;
      expect(init?.redirect).toBe("manual");
      return new Response(new ReadableStream({ cancel() { canceled++; } }), { status, headers: { location: "https://other.example.test/credential-sink" } });
    }) as typeof fetch;
    await expect(fetchUpstreamJson(transport, "https://upstream.example.test", { headers: { authorization: "Bearer fixture-access" } })).rejects.toThrow("upstream request failed");
    expect(canceled).toBe(1);
    expect(calls).toBe(1);
  }
});
