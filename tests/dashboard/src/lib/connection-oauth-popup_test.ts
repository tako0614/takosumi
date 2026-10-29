import { expect, test } from "bun:test";
import { connectProviderWithPopup } from "../../../../dashboard/src/lib/connection-oauth-popup.ts";
import { resetAppOwnershipCache } from "../../../../dashboard/src/lib/control-api.ts";

test("OAuth popup accepts a personal result with a stale selector and follows an explicit legacy fallback", async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const channelDescriptor = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
  let completion: ((event: { data: unknown }) => void) | undefined;
  let channelClosed = false;
  class Channel {
    set onmessage(listener: (event: { data: unknown }) => void) { completion = listener; }
    close() { channelClosed = true; }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://dashboard.example.test" } } });
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: Channel });
  globalThis.setTimeout = ((callback: TimerHandler, _milliseconds?: number, ...args: unknown[]) => realTimeout(callback, 0, ...args)) as typeof setTimeout;
  try {
    for (const legacy of [false, true]) {
      resetAppOwnershipCache();
      channelClosed = false;
      let navigated = false;
      let personalStarts = 0;
      let legacyReads = 0;
      const connection = {
        id: "new-connection", scope: legacy ? "workspace" : "personal",
        ...(legacy ? { workspaceId: "stale" } : {}),
        status: "verified", credentialRecipe: { id: "recipe", authMode: "oauth" },
      };
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/v1/apps") return Response.json({ apps: [] });
        if (path === "/api/v1/connections") return Response.json({ connections: navigated ? [connection] : [] });
        if (path === "/api/v1/provider-connections?workspaceId=stale") {
          legacyReads += 1;
          return Response.json({ providerConnections: [connection] });
        }
        if (path.endsWith("/oauth/helper/start")) {
          const body = JSON.parse(String(init?.body)) as { workspaceId?: string };
          if (!body.workspaceId) {
            personalStarts += 1;
            if (legacy) return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
          }
          return Response.json({ authorizationUrl: "https://provider.example.test/authorize", state: "flow" });
        }
        throw new Error(`unexpected ${path}`);
      }) as typeof fetch;
      const popup = {
        opener: {},
        location: { href: "https://provider.example.test/authorize", replace: () => {
          navigated = true;
          completion?.({ data: { kind: "connection-oauth", error: false, connectionId: connection.id, connectionStatus: "verified" } });
        } },
      };
      const result = await connectProviderWithPopup({
        helper: { id: "helper", providerSource: "p", credentialRecipe: { id: "recipe", authMode: "oauth" } },
        workspaceId: "stale", signal: new AbortController().signal, popup: popup as unknown as Window,
      });
      expect(result.id).toBe(connection.id);
      expect(personalStarts).toBe(1);
      expect(legacyReads).toBe(legacy ? 1 : 0);
      expect(popup.opener).toBeNull();
      expect(channelClosed).toBe(true);
    }
  } finally {
    resetAppOwnershipCache();
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realTimeout;
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (channelDescriptor) Object.defineProperty(globalThis, "BroadcastChannel", channelDescriptor);
    else Reflect.deleteProperty(globalThis, "BroadcastChannel");
  }
});
