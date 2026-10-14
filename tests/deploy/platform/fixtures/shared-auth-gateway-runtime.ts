import {
  handlePlatformExtensionRouteRequest,
  handlePlatformSharedAuthControlRequest,
  handlePlatformSharedAuthSessionRequest,
  type CloudflareWorkerEnv,
} from "../../../../deploy/platform/worker.ts";
import { handleSharedAuthRouteRequest } from "../../../../worker/src/shared_auth_rpc.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import type { D1Database } from "../../../../worker/src/bindings.ts";

export default {
  async fetch(request: Request, env: CloudflareWorkerEnv & { CONTROL: D1Database }) {
    // Miniflare's Node-side RPC proxy rejects non-local Origin headers before
    // reaching workerd. This test-only driver reconstructs that header inside
    // workerd; the production gateway never accepts this fixture header.
    const fixtureOrigin = request.headers.get("x-fixture-original-origin");
    if (fixtureOrigin !== null) {
      const headers = new Headers(request.headers);
      headers.delete("x-fixture-original-origin");
      headers.set("origin", fixtureOrigin);
      request = new Request(request, { headers });
    }
    const route = await handleSharedAuthRouteRequest(request, env);
    if (route) return route;
    const mirror = await handlePlatformSharedAuthSessionRequest(request, env);
    if (mirror) return mirror;
    if (new URL(request.url).pathname.startsWith("/extensions/native")) {
      const composed = {
        ...env,
        NATIVE: { fetchAuthenticated: async (forwarded: Request, context: unknown) =>
          Response.json({ context, cookie: forwarded.headers.get("cookie"),
            actor: forwarded.headers.get("x-takosumi-actor-context") }) },
      };
      return await handlePlatformExtensionRouteRequest(request, composed, {
        basePath: "/extensions/native", handlerKey: "NATIVE", authDelivery: "context",
        workspaceContext: "query-required",
      });
    }
    const store = new CloudflareD1OpenTofuControlStore(env.CONTROL);
    const operations = {
      workspaces: { getWorkspace: (id: string) => store.getWorkspace(id) },
      members: { getMember: (workspaceId: string, accountId: string) => store.getWorkspaceMember(workspaceId, accountId) },
    } as unknown as ControlPlaneOperations;
    return await handlePlatformSharedAuthControlRequest(request, env, {
      store: new InMemoryAccountsStore(), resolveOperations: async () => operations,
    }) ?? new Response(null, { status: 404 });
  },
};
