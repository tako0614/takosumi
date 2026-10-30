import { expect, test } from "bun:test";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import {
  handleAuthenticatedControlRoute,
  handleControlRoute,
} from "../../../../accounts/service/src/control-routes.ts";
import {
  classifyLegacyWorkspaceControlRequest,
  interfaceApiRouteTemplate,
  isConcreteSuccessorPath,
  LEGACY_WORKSPACE_DEPRECATION,
  legacyWorkspaceClientFamily,
  legacyWorkspaceMetricTags,
  LegacyWorkspaceRouteCounter,
  legacyWorkspaceUseMetricTags,
  parseLegacyWorkspaceSunset,
  reportLegacyWorkspaceClaim,
  reportLegacyWorkspaceRoute,
  withLegacyWorkspaceDeprecation,
} from "../../../../accounts/service/src/legacy-workspace-telemetry.ts";
import { PUBLIC_SESSION_CONTROL_ENDPOINTS } from "../../../../accounts/service/src/control-route-inventory.ts";
import { sharedAccountWorkspaceRouteTemplate } from "../../../../accounts/service/src/shared-account-workspace.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { handleIntrospect } from "../../../../accounts/service/src/oidc-routes.ts";
import { handleCurrentPersonalAccessTokenAuthority } from "../../../../accounts/service/src/pat-routes.ts";
import { createEphemeralAccountsHandler } from "../../../../accounts/service/src/mod.ts";

const WORKSPACE_ID = "ws_telemetry_owner";
const SUBJECT = "tsub_telemetry_owner";
const workspace = {
  id: WORKSPACE_ID,
  handle: "owner",
  displayName: "Owner",
  type: "personal" as const,
  ownerUserId: SUBJECT,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function operations(): ControlPlaneOperations {
  return {
    workspaces: {
      getWorkspace: async (workspaceId: string) => {
        if (workspaceId !== WORKSPACE_ID) throw new Error("workspace not found");
        return workspace;
      },
      listWorkspacesForAccount: async () => [workspace],
      createWorkspace: async () => {
        throw new Error("not used");
      },
    },
    members: { listMembers: async () => [] },
  } as unknown as ControlPlaneOperations;
}

function classify(method: string, path: string) {
  const url = new URL(`https://app.example.test${path}`);
  return classifyLegacyWorkspaceControlRequest(
    method,
    url.pathname.slice("/api/v1".length).split("/").filter(Boolean),
    url.searchParams,
  );
}

async function captureInfo<T>(operation: () => Promise<T>): Promise<{
  readonly result: T;
  readonly lines: readonly string[];
}> {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await operation(), lines };
  } finally {
    console.info = original;
  }
}

function legacyEvents(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.event === "legacy_workspace_route");
}

function sessionStore(token: string): InMemoryAccountsStore {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({ subject: SUBJECT, createdAt: now, updatedAt: now });
  store.saveAccountSession({
    sessionId: token,
    subject: SUBJECT,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return store;
}

async function control(input: {
  readonly store: InMemoryAccountsStore;
  readonly token: string;
  readonly path: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly legacyWorkspaceSunset?: string;
}): Promise<Response> {
  const url = new URL(`https://app.example.test${input.path}`);
  const response = await handleControlRoute({
    request: new Request(url, {
      method: input.method ?? "GET",
      headers: { ...input.headers, authorization: `Bearer ${input.token}` },
      ...(input.body !== undefined ? { body: input.body } : {}),
    }),
    url,
    store: input.store,
    operations: operations(),
    workspaceMutationsFrozen: false,
    ...(input.legacyWorkspaceSunset
      ? { legacyWorkspaceSunset: input.legacyWorkspaceSunset }
      : {}),
  });
  expect(response).toBeDefined();
  return response!;
}

test("every Workspace route in the inventory is classified with its own template", () => {
  const workspaceEndpoints = PUBLIC_SESSION_CONTROL_ENDPOINTS.filter((endpoint) =>
    endpoint.path.startsWith("/api/v1/workspaces") ||
    endpoint.path.startsWith("/api/v1/projects")
  );
  expect(workspaceEndpoints.length).toBeGreaterThan(20);
  for (const endpoint of workspaceEndpoints) {
    const concrete = endpoint.path
      .replaceAll("{workspaceId}", WORKSPACE_ID)
      .replace(/\{[A-Za-z]+\}/gu, "id_value_1");
    const use = classify(endpoint.method, concrete);
    expect(use, `${endpoint.method} ${endpoint.path}`).toMatchObject({
      surface: "workspace_route",
      route: endpoint.path,
    });
    expect(use!.route).not.toContain(WORKSPACE_ID);
    expect(use!.route).not.toContain("id_value_1");
  }
});

test("legacy and current control routes are told apart without reading ids", () => {
  const legacy: ReadonlyArray<readonly [string, string, string, string]> = [
    ["GET", "/api/v1/workspaces", "workspace_route", "/api/v1/workspaces"],
    ["GET", `/api/v1/workspaces/${WORKSPACE_ID}/unknown-leaf`, "workspace_route", "/api/v1/workspaces/*"],
    ["GET", "/api/v1/views/workspaces.v1", "workspace_route", "/api/v1/views/workspaces.v1"],
    ["GET", `/api/v1/connections?workspaceId=${WORKSPACE_ID}`, "workspace_query", "/api/v1/connections?workspaceId"],
    ["GET", `/api/v1/sources?workspaceId=${WORKSPACE_ID}`, "workspace_query", "/api/v1/sources?workspaceId"],
    ["GET", `/api/v1/capsule-configs?workspaceId=${WORKSPACE_ID}`, "workspace_query", "/api/v1/capsule-configs?workspaceId"],
    ["GET", `/api/v1/provider-connections?workspaceId=${WORKSPACE_ID}&projection=release-owned`, "workspace_query", "/api/v1/provider-connections?workspaceId"],
    ["GET", `/api/v1/dashboard/overview?workspaceId=${WORKSPACE_ID}`, "workspace_query", "/api/v1/dashboard/overview?workspaceId"],
    ["POST", "/api/v1/sources", "workspace_body", "/api/v1/sources#workspaceId"],
    ["GET", "/api/v1/dashboard/bootstrap?includeWorkspaces=true", "workspace_projection", "/api/v1/dashboard/bootstrap?includeWorkspaces"],
  ];
  for (const [method, path, surface, route] of legacy) {
    expect(classify(method, path), `${method} ${path}`).toMatchObject({ surface, route });
  }
  const current: ReadonlyArray<readonly [string, string]> = [
    ["GET", "/api/v1/apps"],
    ["GET", "/api/v1/connections"],
    ["POST", "/api/v1/connections"],
    ["GET", "/api/v1/connections?capsuleId=cap_1&projection=labels"],
    ["GET", "/api/v1/capsules/cap_1/runs"],
    ["POST", "/api/v1/install-plans"],
    ["GET", "/api/v1/usage"],
    ["GET", "/api/v1/dashboard/bootstrap?includeWorkspaces=false"],
    // The Workspace inventory is opt-in: the default bootstrap is not a use.
    ["GET", "/api/v1/dashboard/bootstrap"],
    ["GET", "/api/v1/dashboard/bootstrap?includeNotifications=true"],
    ["GET", "/api/v1/sources/src_1"],
  ];
  for (const [method, path] of current) {
    expect(classify(method, path), `${method} ${path}`).toBeUndefined();
  }
});

test("a session read of a Workspace route is reported value-free and marked deprecated", async () => {
  const token = "sess_legacy_workspace_route";
  const store = sessionStore(token);
  const { result: response, lines } = await captureInfo(() =>
    control({
      store,
      token,
      path: `/api/v1/workspaces/${WORKSPACE_ID}`,
      headers: { "takosumi-client": "takosumi-dashboard/1.2.3" },
    })
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ workspace });
  expect(response.headers.get("Deprecation")).toBe(LEGACY_WORKSPACE_DEPRECATION);
  expect(response.headers.get("Sunset")).toBeNull();
  expect(response.headers.get("Link")).toContain('rel="deprecation"');
  const events = legacyEvents(lines);
  expect(events).toEqual([{
    event: "legacy_workspace_route",
    surface: "workspace_route",
    route: "/api/v1/workspaces/{workspaceId}",
    method: "GET",
    status: 200,
    entry: "public",
    credential: "session",
    workspaceBound: false,
    appBound: false,
    clientFamily: "takosumi-dashboard",
  }]);
  const raw = lines.join("\n");
  for (const value of [WORKSPACE_ID, SUBJECT, token, "1.2.3"]) {
    expect(raw).not.toContain(value);
  }
});

test("a Workspace route with a successor links it and announces a configured Sunset", async () => {
  const token = "sess_legacy_workspace_list";
  const store = sessionStore(token);
  const sunset = parseLegacyWorkspaceSunset("2026-12-01")!;
  const { result: response, lines } = await captureInfo(() =>
    control({ store, token, path: "/api/v1/workspaces", legacyWorkspaceSunset: sunset })
  );
  expect(response.headers.get("Sunset")).toBe("Tue, 01 Dec 2026 00:00:00 GMT");
  expect(response.headers.get("Link")).toContain('</api/v1/apps>; rel="successor-version"');
  expect(legacyEvents(lines)).toHaveLength(1);
});

test("a refused Workspace-scoped credential is still counted, with its binding and client", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccessToken("oauth_workspace_scope", {
    clientId: "client_workspace_scope",
    scope: "capsules:read",
    subject: "client-local-subject",
    takosumiSubject: SUBJECT,
    workspaceId: WORKSPACE_ID,
    expiresAt: Date.now() + 60_000,
  });
  const { result: response, lines } = await captureInfo(() =>
    control({ store, token: "oauth_workspace_scope", path: "/api/v1/views/workspaces.v1" })
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("Deprecation")).toBe(LEGACY_WORKSPACE_DEPRECATION);
  expect(legacyEvents(lines)).toEqual([expect.objectContaining({
    route: "/api/v1/views/workspaces.v1",
    status: 403,
    credential: "oauth-access-token",
    workspaceBound: true,
    appBound: false,
    clientFamily: "ua:none",
    clientId: "client_workspace_scope",
  })]);
  expect(lines.join("\n")).not.toContain(WORKSPACE_ID);
});

test("a personal access token never reports a client id", async () => {
  const store = new InMemoryAccountsStore();
  store.savePersonalAccessToken("pat_legacy_workspace", {
    tokenId: "pat_legacy_workspace",
    tokenPrefix: "legacy",
    subject: SUBJECT,
    name: "legacy",
    scopes: ["read"],
    createdAt: Date.now(),
  });
  const { lines } = await captureInfo(() =>
    control({
      store,
      token: "pat_legacy_workspace",
      path: `/api/v1/workspaces/${WORKSPACE_ID}`,
      headers: { "user-agent": "curl/8.5.0" },
    })
  );
  const [event] = legacyEvents(lines);
  expect(event).toMatchObject({ credential: "personal-access-token", clientFamily: "ua:curl" });
  expect(event).not.toHaveProperty("clientId");
  expect(lines.join("\n")).not.toContain("pat_legacy_workspace");
});

test("a current route is neither reported nor marked", async () => {
  const token = "sess_current_route";
  const store = sessionStore(token);
  const { result: response, lines } = await captureInfo(() =>
    control({ store, token, path: "/api/v1/dashboard/bootstrap?includeWorkspaces=false&includeNotifications=false" })
  );
  expect(response.headers.get("Deprecation")).toBeNull();
  expect(legacyEvents(lines)).toEqual([]);
});

test("a Workspace named only in a connection body is reported as a body use", async () => {
  const token = "sess_connection_body";
  const store = sessionStore(token);
  const { result: response, lines } = await captureInfo(() =>
    control({
      store,
      token,
      method: "POST",
      path: "/api/v1/connections",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, provider: "cloudflare" }),
    })
  );
  expect(response.headers.get("Deprecation")).toBe(LEGACY_WORKSPACE_DEPRECATION);
  expect(legacyEvents(lines)).toEqual([expect.objectContaining({
    surface: "workspace_body",
    route: "/api/v1/connections#workspaceId",
    method: "POST",
  })]);
  expect(lines.join("\n")).not.toContain(WORKSPACE_ID);
});

test("a personal connection body is not a Workspace use", async () => {
  const token = "sess_connection_personal";
  const store = sessionStore(token);
  const { lines } = await captureInfo(() =>
    control({
      store,
      token,
      method: "POST",
      path: "/api/v1/connections",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare" }),
    })
  );
  expect(legacyEvents(lines)).toEqual([]);
});

test("the in-process operator MCP entry labels its reports", async () => {
  const request = new Request(`https://app.example.test/api/v1/workspaces/${WORKSPACE_ID}`);
  const { result: response, lines } = await captureInfo(() =>
    handleAuthenticatedControlRoute({
      request,
      url: new URL(request.url),
      store: new InMemoryAccountsStore(),
      operations: operations(),
      subject: SUBJECT,
      workspaceId: WORKSPACE_ID,
      entry: "operator_mcp",
    })
  );
  expect(response?.headers.get("Deprecation")).toBe(LEGACY_WORKSPACE_DEPRECATION);
  expect(legacyEvents(lines)).toEqual([expect.objectContaining({
    entry: "operator_mcp",
    credential: "unknown",
    workspaceBound: true,
  })]);
});

test("deprecation headers keep the status, body and existing links", async () => {
  const response = withLegacyWorkspaceDeprecation(
    new Response("payload", { status: 202, headers: { link: '</a>; rel="next"' } }),
    { surface: "workspace_route", route: "/api/v1/workspaces", successor: "/api/v1/apps" },
    { sunset: "Tue, 01 Dec 2026 00:00:00 GMT" },
  );
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("payload");
  expect(response.headers.get("Deprecation")).toBe("@1793145600");
  expect(response.headers.get("Sunset")).toBe("Tue, 01 Dec 2026 00:00:00 GMT");
  expect(response.headers.get("Link")).toBe(
    '</a>; rel="next", <https://takosumi.com/docs/reference/api#legacy-workspace-routes>; rel="deprecation"; type="text/html", </api/v1/apps>; rel="successor-version"',
  );
});

test("client families come from a fixed vocabulary", () => {
  const family = (headers: Record<string, string>) =>
    legacyWorkspaceClientFamily(new Headers(headers));
  expect(family({ "takosumi-client": "takosumi-cli" })).toBe("takosumi-cli");
  expect(family({ "takosumi-client": "takos/2.5.0" })).toBe("takos");
  expect(family({ "takosumi-client": "someone-else/9" })).toBe("client:unknown");
  expect(family({})).toBe("ua:none");
  expect(family({ "user-agent": "Bun/1.4.3" })).toBe("ua:bun");
  expect(family({ "user-agent": "node" })).toBe("ua:node");
  expect(family({ "user-agent": "python-requests/2.32" })).toBe("ua:python");
  expect(family({ "user-agent": "Go-http-client/2.0" })).toBe("ua:go");
  expect(family({ "user-agent": "okhttp/4.12.0" })).toBe("ua:okhttp");
  expect(family({ "user-agent": "Takosumi/3 CFNetwork/1490 Darwin/23.0.0" })).toBe("ua:apple-native");
  expect(family({ "user-agent": "Mozilla/5.0 (iPhone) Mobile/15E148 Safari/604.1" })).toBe("ua:browser-mobile");
  expect(family({ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/130" })).toBe("ua:browser");
  expect(family({ "user-agent": "custom-agent tsub_secret" })).toBe("ua:other");
});

test("the Sunset setting accepts ISO and HTTP dates and refuses anything else", () => {
  expect(parseLegacyWorkspaceSunset(undefined)).toBeUndefined();
  expect(parseLegacyWorkspaceSunset("  ")).toBeUndefined();
  expect(parseLegacyWorkspaceSunset("2026-12-01T09:00:00Z")).toBe("Tue, 01 Dec 2026 09:00:00 GMT");
  expect(parseLegacyWorkspaceSunset("Tue, 01 Dec 2026 00:00:00 GMT")).toBe("Tue, 01 Dec 2026 00:00:00 GMT");
  expect(() => parseLegacyWorkspaceSunset("soon")).toThrow("TAKOSUMI_LEGACY_WORKSPACE_SUNSET");
});

test("route and claim reports drop unsafe client ids and never throw", () => {
  const lines: string[] = [];
  reportLegacyWorkspaceRoute({
    use: { surface: "workspace_route", route: "/api/v1/workspaces" },
    method: "get",
    status: 200,
    entry: "public",
    credential: "oauth-access-token",
    workspaceBound: false,
    appBound: true,
    clientFamily: "takos",
    clientId: "client with spaces",
  }, (line) => lines.push(line));
  reportLegacyWorkspaceClaim({
    surface: "id_token",
    clientId: "client_ok",
    capsuleBound: true,
    appRole: true,
    memberships: false,
  }, (line) => lines.push(line));
  reportLegacyWorkspaceClaim({
    surface: "userinfo",
    capsuleBound: false,
    appRole: false,
    memberships: true,
  }, () => {
    throw new Error("sink failure");
  });
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    {
      event: "legacy_workspace_route",
      surface: "workspace_route",
      route: "/api/v1/workspaces",
      method: "GET",
      status: 200,
      entry: "public",
      credential: "oauth-access-token",
      workspaceBound: false,
      appBound: true,
      clientFamily: "takos",
    },
    {
      event: "legacy_workspace_claim_emitted",
      surface: "id_token",
      clientId: "client_ok",
      capsuleBound: true,
      appRole: true,
      memberships: false,
    },
  ]);
});

test("platform-served templates and metric tags never carry ids", () => {
  expect(interfaceApiRouteTemplate("/api/v1/interfaces")).toBe("/api/v1/interfaces");
  expect(interfaceApiRouteTemplate("/api/v1/interfaces/iface_1/token")).toBe("/api/v1/interfaces/{interfaceId}/token");
  expect(interfaceApiRouteTemplate("/api/v1/interfaces/iface_1/bindings/bind_1")).toBe(
    "/api/v1/interfaces/{interfaceId}/bindings/{bindingId}",
  );
  expect(interfaceApiRouteTemplate("/api/v1/interfaces/iface_1/secret_leaf")).toBe("/api/v1/interfaces/{interfaceId}/*");
  expect(sharedAccountWorkspaceRouteTemplate("GET", "/api/v1/account/shared-workspaces")).toBe(
    "/api/v1/account/shared-workspaces",
  );
  expect(sharedAccountWorkspaceRouteTemplate("POST", "/api/v1/account/shared-workspaces/ws_1/select")).toBe(
    "/api/v1/account/shared-workspaces/{workspaceId}/select",
  );
  expect(sharedAccountWorkspaceRouteTemplate("GET", "/api/v1/account/shared-workspaces/ws_1/x")).toBe(
    "/api/v1/account/shared-workspaces/*",
  );

  const marked = (response: Response) =>
    withLegacyWorkspaceDeprecation(response, { surface: "workspace_route", route: "x" });
  const tags = (path: string, method = "GET") =>
    legacyWorkspaceMetricTags(new Request(`https://app.example.test${path}`, { method }), marked(new Response(null, { status: 200 })));
  expect(tags(`/api/v1/workspaces/${WORKSPACE_ID}/runs`)).toEqual({
    route: "/api/v1/workspaces/{workspaceId}/runs",
    method: "GET",
    status: "200",
  });
  expect(tags("/api/v1/connections", "POST")?.route).toBe("body");
  expect(tags(`/api/v1/interfaces/iface_1?workspaceId=${WORKSPACE_ID}`)?.route).toBe(
    "/api/v1/interfaces/{interfaceId}",
  );
  expect(tags(`/oauth/authorize?workspace_id=${WORKSPACE_ID}`)?.route).toBe("/oauth/authorize?workspace_id");
  expect(legacyWorkspaceMetricTags(new Request("https://app.example.test/api/v1/workspaces"), new Response(null))).toBeUndefined();
  // Platform-served uses tag themselves, selector included.
  expect(legacyWorkspaceUseMetricTags({
    surface: "interface_workspace",
    route: "/api/v1/interfaces/{interfaceId}/token",
    selector: "session",
  }, "post", 403)).toEqual({
    route: "/api/v1/interfaces/{interfaceId}/token",
    selector: "session",
    method: "POST",
    status: "403",
  });
});

test("a Link successor is sent only when it is a concrete URI, never a template", () => {
  const concrete = withLegacyWorkspaceDeprecation(new Response(null), {
    surface: "workspace_route",
    route: "/api/v1/workspaces",
    successor: "/api/v1/apps",
  });
  expect(concrete.headers.get("Link")).toBe(
    '<https://takosumi.com/docs/reference/api#legacy-workspace-routes>; rel="deprecation"; type="text/html", </api/v1/apps>; rel="successor-version"',
  );
  const templated = withLegacyWorkspaceDeprecation(new Response(null), {
    surface: "workspace_route",
    route: "/api/v1/workspaces/{workspaceId}/runs",
    successor: "/api/v1/capsules/{capsuleId}/runs",
  });
  // Only the deprecation relation: a strict client may drop the whole header
  // when one target is not a valid URI.
  expect(templated.headers.get("Link")).toBe(
    '<https://takosumi.com/docs/reference/api#legacy-workspace-routes>; rel="deprecation"; type="text/html"',
  );
  expect(isConcreteSuccessorPath("/api/v1/source-ref-resolutions")).toBe(true);
  expect(isConcreteSuccessorPath("/api/v1/capsules/{capsuleId}/plan")).toBe(false);
  expect(isConcreteSuccessorPath("api/v1/apps")).toBe(false);
  expect(isConcreteSuccessorPath("/api/v1/apps space")).toBe(false);
  expect(isConcreteSuccessorPath("/api/v1/apps%2")).toBe(false);
});

test("every Link sent for an inventory Workspace route is a valid URI reference", async () => {
  const workspaceEndpoints = PUBLIC_SESSION_CONTROL_ENDPOINTS.filter((endpoint) =>
    endpoint.path.startsWith("/api/v1/workspaces")
  );
  for (const endpoint of workspaceEndpoints) {
    const concrete = endpoint.path
      .replaceAll("{workspaceId}", WORKSPACE_ID)
      .replace(/\{[A-Za-z]+\}/gu, "id_value_1");
    const use = classify(endpoint.method, concrete)!;
    const link = withLegacyWorkspaceDeprecation(new Response(null), use).headers.get("Link")!;
    for (const target of link.matchAll(/<([^>]*)>/gu)) {
      expect(target[1], `${endpoint.method} ${endpoint.path}`).not.toMatch(/[{}]/u);
    }
  }
});

test("the counter writes the first use of a tag set at once and carries the rest", () => {
  const counter = new LegacyWorkspaceRouteCounter(60_000);
  const runs = { route: "/api/v1/workspaces/{workspaceId}/runs", method: "GET", status: "200" };
  const bootstrap = { route: "/api/v1/dashboard/bootstrap?includeWorkspaces", method: "GET", status: "200" };
  // Leading edge: the first use is never held back, so the gate cannot read 0.
  expect(counter.add(runs, 1_000)).toBe(1);
  expect(counter.add(runs, 2_000)).toBeUndefined();
  expect(counter.add(runs, 30_000)).toBeUndefined();
  // Another tag set (or the same one in another order) is independent.
  expect(counter.add(bootstrap, 30_000)).toBe(1);
  expect(counter.add({ status: "200", method: "GET", route: runs.route }, 59_999)).toBeUndefined();
  // After the interval the carried uses are written with the next one.
  expect(counter.add(runs, 61_000)).toBe(4);
  expect(counter.add(runs, 62_000)).toBeUndefined();
  expect(counter.add({ ...runs, status: "403" }, 62_000)).toBe(1);
});

test("the counter never holds back a use once its tag sets are exhausted", () => {
  const counter = new LegacyWorkspaceRouteCounter(60_000);
  for (let index = 0; index < 512; index++) {
    expect(counter.add({ route: `/r/${index}`, method: "GET", status: "200" }, 0)).toBe(1);
  }
  // A new tag set beyond the bound is written directly, every time.
  expect(counter.add({ route: "/r/overflow", method: "GET", status: "200" }, 1)).toBe(1);
  expect(counter.add({ route: "/r/overflow", method: "GET", status: "200" }, 2)).toBe(1);
  expect(counter.add({ route: "/r/0", method: "GET", status: "200" }, 3)).toBeUndefined();
});

function claimEvents(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.event === "legacy_workspace_claim_emitted");
}

const RESOURCE_SERVER = "yurucommu-resource-server";
const resourceServerClients = new Map([
  [
    RESOURCE_SERVER,
    {
      clientId: RESOURCE_SERVER,
      redirectUris: ["https://resource.example.test/callback"],
      clientSecret: "resource-secret",
      tokenEndpointAuthMethod: "client_secret_post" as const,
    },
  ],
]);

function introspect(token: string): Request {
  return new Request("https://accounts.example.test/oauth/introspect", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      client_id: RESOURCE_SERVER,
      client_secret: "resource-secret",
    }),
  });
}

test("introspecting a Workspace-bound PAT reports the claim to the introspecting client", async () => {
  const store = new InMemoryAccountsStore();
  const patToken = "takpat_workspace_bound_secret";
  await store.savePersonalAccessToken(patToken, {
    tokenId: "pat_workspace_bound",
    tokenPrefix: "takpat_works",
    subject: SUBJECT,
    name: "never expires",
    scopes: ["read"],
    workspaceId: WORKSPACE_ID,
    createdAt: Date.now(),
  });
  const { result: response, lines } = await captureInfo(() =>
    handleIntrospect({
      issuer: "https://accounts.example.test",
      request: introspect(patToken),
      store,
      clients: resourceServerClients,
      operations: operations(),
    })
  );
  expect(await response.json()).toMatchObject({
    active: true,
    token_use: "personal_access",
    takosumi: { workspace_id: WORKSPACE_ID },
  });
  expect(claimEvents(lines)).toEqual([{
    event: "legacy_workspace_claim_emitted",
    surface: "personal_access_introspection",
    clientId: RESOURCE_SERVER,
    capsuleBound: false,
    appRole: false,
    memberships: false,
  }]);
  const raw = lines.join("\n");
  for (const value of [WORKSPACE_ID, SUBJECT, patToken, "pat_workspace_bound"]) {
    expect(raw).not.toContain(value);
  }
});

test("introspecting an account PAT without a Workspace reports nothing", async () => {
  const store = new InMemoryAccountsStore();
  await store.savePersonalAccessToken("takpat_account_only", {
    tokenId: "pat_account_only",
    tokenPrefix: "takpat_accou",
    subject: SUBJECT,
    name: "account",
    scopes: ["read"],
    createdAt: Date.now(),
  });
  const { result: response, lines } = await captureInfo(() =>
    handleIntrospect({
      issuer: "https://accounts.example.test",
      request: introspect("takpat_account_only"),
      store,
      clients: resourceServerClients,
      operations: operations(),
    })
  );
  expect(await response.json()).toMatchObject({ active: true, token_use: "personal_access" });
  expect(claimEvents(lines)).toEqual([]);
});

test("a Workspace-bound PAT reading its own authority is reported as a claim use", async () => {
  const store = new InMemoryAccountsStore();
  const patToken = "takpat_authority_secret";
  await store.savePersonalAccessToken(patToken, {
    tokenId: "pat_authority",
    tokenPrefix: "takpat_autho",
    subject: SUBJECT,
    name: "automation",
    scopes: ["read"],
    workspaceId: WORKSPACE_ID,
    createdAt: Date.now(),
  });
  const { result: response, lines } = await captureInfo(() =>
    handleCurrentPersonalAccessTokenAuthority({
      request: new Request("https://accounts.example.test/api/v1/account/tokens/current", {
        headers: { authorization: `Bearer ${patToken}` },
      }),
      store,
      membershipReader: {
        getMember: async (workspaceId, subject) => ({
          workspaceId,
          accountId: subject,
          roles: ["owner"],
          status: "active",
        }),
      },
    })
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ workspace_id: WORKSPACE_ID });
  expect(claimEvents(lines)).toEqual([{
    event: "legacy_workspace_claim_emitted",
    surface: "personal_access_authority",
    capsuleBound: false,
    appRole: false,
    memberships: false,
  }]);
  expect(lines.join("\n")).not.toContain(WORKSPACE_ID);
});

test("the shared Workspace directory is counted only after authentication", async () => {
  const issuer = "https://accounts.example.test";
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({ subject: SUBJECT, createdAt: now, updatedAt: now });
  store.saveAccountSession({
    sessionId: "sess_shared_directory",
    subject: SUBJECT,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const handler = await createEphemeralAccountsHandler({
    issuer,
    store,
    hostedSessionPolicy: true,
    allowEphemeralKeyOnHttpsIssuer: true,
    sharedAccountWorkspaceDirectory: {
      menu: async () => ({ workspaces: [], nextCursor: null }),
    } as never,
  });
  const directory = (token: string) =>
    handler(new Request(`${issuer}/api/v1/account/shared-workspaces`, {
      headers: { authorization: `Bearer ${token}` },
    }));

  const anonymous = await captureInfo(() => directory("not-a-credential"));
  expect(anonymous.result.status).toBe(401);
  expect(anonymous.result.headers.get("Deprecation")).toBeNull();
  expect(legacyEvents(anonymous.lines)).toEqual([]);

  const signedIn = await captureInfo(() => directory("sess_shared_directory"));
  expect(signedIn.result.status).toBe(200);
  expect(signedIn.result.headers.get("Deprecation")).toBe(LEGACY_WORKSPACE_DEPRECATION);
  expect(legacyEvents(signedIn.lines)).toEqual([expect.objectContaining({
    surface: "shared_workspace",
    route: "/api/v1/account/shared-workspaces",
    status: 200,
    credential: "session",
  })]);
  expect(signedIn.lines.join("\n")).not.toContain("sess_shared_directory");
});

test("a Workspace-only PAT used directly is reported on a successor route, once per request", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({ subject: SUBJECT, createdAt: now, updatedAt: now });
  const patToken = "takpat_bearer_workspace_secret";
  store.savePersonalAccessToken(patToken, {
    tokenId: "pat_bearer_workspace",
    tokenPrefix: "takpat_beare",
    subject: SUBJECT,
    name: "cli",
    scopes: ["read"],
    workspaceId: WORKSPACE_ID,
    createdAt: now,
  });
  const { lines } = await captureInfo(() =>
    control({ store, token: patToken, path: "/api/v1/apps" })
  );
  // `/api/v1/apps` is a successor route, so no route line is written; the
  // binding itself is what stage 9.4 removes.
  expect(legacyEvents(lines)).toEqual([]);
  expect(claimEvents(lines)).toEqual([{
    event: "legacy_workspace_claim_emitted",
    surface: "personal_access_bearer",
    capsuleBound: false,
    appRole: false,
    memberships: false,
  }]);
  const raw = lines.join("\n");
  for (const value of [WORKSPACE_ID, SUBJECT, patToken, "pat_bearer_workspace"]) {
    expect(raw).not.toContain(value);
  }
});

test("an account PAT or an app-bound PAT used directly is not a Workspace binding", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({ subject: SUBJECT, createdAt: now, updatedAt: now });
  store.savePersonalAccessToken("takpat_bearer_account", {
    tokenId: "pat_bearer_account",
    tokenPrefix: "takpat_accnt",
    subject: SUBJECT,
    name: "account",
    scopes: ["read"],
    createdAt: now,
  });
  store.savePersonalAccessToken("takpat_bearer_apps", {
    tokenId: "pat_bearer_apps",
    tokenPrefix: "takpat_appsx",
    subject: SUBJECT,
    name: "apps",
    scopes: ["read"],
    workspaceId: WORKSPACE_ID,
    appIds: ["cap_bearer_app"],
    createdAt: now,
  });
  for (const token of ["takpat_bearer_account", "takpat_bearer_apps"]) {
    const { lines } = await captureInfo(() =>
      control({ store, token, path: "/api/v1/apps" })
    );
    expect(claimEvents(lines), token).toEqual([]);
  }
});

test("a failed counter write is handed back and retried by the next use", () => {
  const counter = new LegacyWorkspaceRouteCounter(60_000);
  const tags = { route: "/api/v1/workspaces", method: "GET", status: "200" };
  expect(counter.add(tags, 1_000)).toBe(1);
  expect(counter.add(tags, 2_000)).toBeUndefined();
  // The leading-edge write of 1 failed: the next use writes at once, with it.
  counter.restore(tags, 1);
  expect(counter.add(tags, 3_000)).toBe(3);
  expect(counter.add(tags, 4_000)).toBeUndefined();
  // A failure for a tag set the counter never tracked is still carried.
  counter.restore({ route: "/r/untracked", method: "GET", status: "200" }, 2);
  expect(counter.add({ route: "/r/untracked", method: "GET", status: "200" }, 5_000)).toBe(3);
});
