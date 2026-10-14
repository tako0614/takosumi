import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { ensureD1OpenTofuLedgerSchema, CloudflareD1OpenTofuControlStore } from "../../../worker/src/d1_opentofu_store.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";

const origin = "https://hosted.staging.example.test";
const cookie = "__Host-takosumi_hosted_session=server-held-native-session";

test("native service binding and DO transport preserves RP cookies and denies forged context, revoked sessions and suspended canonical owners", async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/shared-auth-gateway-runtime.ts")],
    target: "browser", format: "esm", external: ["cloudflare:workers"],
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  const artifact = build.outputs[0];
  if (!artifact) throw new Error("shared authentication runtime bundle missing");
  const runtime = new Miniflare({ workers: [
    { name: "gateway", compatibilityDate: "2026-07-17", compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "shared-auth-gateway.mjs", contents: await artifact.text() }],
      bindings: { TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account", TAKOSUMI_SHARED_AUTH_ORIGIN: origin, TAKOSUMI_ENVIRONMENT: "staging" },
      serviceBindings: { HOSTED: { name: "rp", entrypoint: "Authentication" } },
      d1Databases: { CONTROL: "shared-auth-control-native" },
    },
    { name: "rp", compatibilityDate: "2026-07-17",
      modules: [{ type: "ESModule", path: "shared-auth-rpc-runtime.mjs", contents: await readFile(resolve(import.meta.dir, "fixtures/shared-auth-rpc-runtime.mjs"), "utf8") }],
      durableObjects: { SESSIONS: "Sessions" },
    },
  ] });
  try {
    const native = await runtime.getD1Database("CONTROL", "gateway");
    const db = native as unknown as D1Database;
    await ensureD1OpenTofuLedgerSchema(db);
    const store = new CloudflareD1OpenTofuControlStore(db);
    const timestamp = "2026-10-14T00:00:00.000Z";
    await store.putWorkspace({ id: "ws_native", handle: "native", displayName: "Native", type: "personal", ownerUserId: "tsub_native", createdAt: timestamp, updatedAt: timestamp });
    const member = { id: "member_native", workspaceId: "ws_native", accountId: "tsub_native", status: "active" as const, roles: ["owner" as const], createdAt: timestamp, updatedAt: timestamp };
    await store.putWorkspaceMember(member);
    // getWorker reaches the real workerd Fetcher while preserving the incoming
    // HTTPS origin; Miniflare's HTTP proxy rewrites it to its local listener.
    const gateway = await runtime.getWorker("gateway");
    const fetch = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers ?? { cookie });
      const fixtureOrigin = headers.get("origin");
      if (fixtureOrigin !== null) {
        headers.delete("origin");
        headers.set("x-fixture-original-origin", fixtureOrigin);
      }
      return gateway.fetch(origin + path, { ...init, headers, redirect: "manual" });
    };
    const workspace = await fetch("/api/v1/workspaces/ws_native");
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({ workspace: { id: "ws_native", ownerUserId: "tsub_native" } });
    expect((await fetch("/api/v1/workspaces/ws_native", { headers: { cookie: "takosumi_session=sess_forged", "x-takosumi-platform-subject": "tsub_native" } })).status).toBe(401);
    const extension = await fetch("/extensions/native?workspaceId=ws_native", { headers: { cookie, "x-takosumi-platform-subject": "tsub_attacker", "x-takosumi-actor-context": "owner" } });
    expect(extension.status).toBe(200);
    expect(await extension.json()).toEqual({ context: { authKind: "session", subject: "tsub_native", workspaceId: "ws_native", workspaceRole: "viewer" }, cookie: null, actor: null });
    expect((await fetch("/extensions/native?workspaceId=ws_native", { method: "POST", headers: { cookie, origin: "https://evil.example.test" } })).status).toBe(403);
    expect((await fetch("/extensions/native?workspaceId=ws_native", { method: "POST", headers: { cookie, origin } })).status).toBe(403);
    const callback = await fetch("/auth/oidc/callback?code=server-bound&state=state");
    expect(callback.status).toBe(302);
    expect(callback.headers.getSetCookie()).toEqual([
      cookie + "; Secure; HttpOnly; SameSite=Lax; Path=/",
      "__Host-takosumi_oidc_attempt=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    ]);
    expect(callback.headers.get("cache-control")).toBe("no-store");
    await store.putWorkspaceMember({ ...member, status: "suspended" });
    expect((await fetch("/api/v1/workspaces/ws_native")).status).toBe(403);
    const sessions = await runtime.getDurableObjectNamespace("SESSIONS", "rp");
    const session = sessions.get(sessions.idFromName("current"));
    await session.change("unavailable");
    expect((await fetch("/extensions/native?workspaceId=ws_native")).status).toBe(503);
    await session.change("tsub_successor");
    expect((await fetch("/api/v1/workspaces/ws_native")).status).toBe(403);
    await session.change("tsub_native");
    expect((await fetch("/api/v1/account/session/me", { method: "DELETE", headers: { cookie, origin } })).status).toBe(204);
    expect((await fetch("/api/v1/workspaces/ws_native")).status).toBe(401);
  } finally {
    await runtime.dispose();
  }
}, 60_000);
