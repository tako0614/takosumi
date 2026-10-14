// A transport fixture, not an OIDC implementation. Actual RP token verification
// is tested by its owner. Opaque session state here belongs to a real workerd DO.
import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
export class Sessions extends DurableObject {
  async authenticate(request) {
    const record = await this.ctx.storage.get("session");
    if (record === "unavailable") return { kind: "unavailable" };
    if (record === "revoked" || request.headers.get("cookie") !==
      "__Host-takosumi_hosted_session=server-held-native-session") return { kind: "unauthenticated" };
    if (request.headers.get("authorization") || request.headers.get("x-takosumi-platform-subject") ||
      request.headers.get("x-takosumi-actor-context")) throw new Error("unsafe authentication headers");
    return { kind: "authenticated", accountId: record || "tsub_native" };
  }
  async change(value) { await this.ctx.storage.put("session", value); }
}
export class Authentication extends WorkerEntrypoint {
  sessions() { return this.env.SESSIONS.get(this.env.SESSIONS.idFromName("current")); }
  authenticateSharedAuth(request) { return this.sessions().authenticate(request); }
  async resolveSharedAuthWorkspace(request, workspaceId) {
    const auth = await this.authenticateSharedAuth(request);
    if (auth.kind === "unavailable") return auth;
    if (auth.kind !== "authenticated" || workspaceId !== "ws_native") return { kind: "forbidden" };
    return { kind: "authorized", accountId: auth.accountId, workspaceId, role: "viewer" };
  }
  async fetchSharedAuth(request) {
    if (new URL(request.url).pathname === "/auth/oidc/callback") {
      const headers = new Headers({ location: "https://hosted.staging.example.test/" });
      headers.append("set-cookie", "__Host-takosumi_hosted_session=server-held-native-session; Secure; HttpOnly; SameSite=Lax; Path=/");
      headers.append("set-cookie", "__Host-takosumi_oidc_attempt=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
      return new Response("callback", { status: 302, headers });
    }
    if (new URL(request.url).pathname === "/auth/oidc/logout") {
      await this.sessions().change("revoked");
      return new Response(null, { status: 204 });
    }
    return Response.json(await this.authenticateSharedAuth(request));
  }
}
export default { fetch() { return new Response(null, { status: 404 }); } };
