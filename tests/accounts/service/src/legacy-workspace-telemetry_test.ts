import { expect, test } from "bun:test";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import {
  handleAuthenticatedControlRoute,
  handleControlRoute,
} from "../../../../accounts/service/src/control-routes.ts";
import {
  classifyLegacyWorkspaceControlRequest,
  interfaceApiRouteTemplate,
  LEGACY_WORKSPACE_DEPRECATION,
  legacyWorkspaceClientFamily,
  legacyWorkspaceMetricTags,
  parseLegacyWorkspaceSunset,
  reportLegacyWorkspaceClaim,
  reportLegacyWorkspaceRoute,
  withLegacyWorkspaceDeprecation,
} from "../../../../accounts/service/src/legacy-workspace-telemetry.ts";
import { PUBLIC_SESSION_CONTROL_ENDPOINTS } from "../../../../accounts/service/src/control-route-inventory.ts";
import { sharedAccountWorkspaceRouteTemplate } from "../../../../accounts/service/src/shared-account-workspace.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

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
    ["GET", "/api/v1/dashboard/bootstrap", "workspace_projection", "/api/v1/dashboard/bootstrap?includeWorkspaces"],
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
    "/api/v1/interfaces/{interfaceId}?workspaceId",
  );
  expect(tags(`/oauth/authorize?workspace_id=${WORKSPACE_ID}`)?.route).toBe("/oauth/authorize?workspace_id");
  expect(tags(`/extensions/hosted/things?workspaceId=${WORKSPACE_ID}`)?.route).toBe("platform-extension?workspaceId");
  expect(legacyWorkspaceMetricTags(new Request("https://app.example.test/api/v1/workspaces"), new Response(null))).toBeUndefined();
});
