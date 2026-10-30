import { expect, test } from "bun:test";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  handlePlatformExtensionRouteRequest,
  handlePlatformInterfaceApiRequest,
  type PlatformExtensionSessionContext,
} from "../../../deploy/platform/worker.ts";
import { LEGACY_WORKSPACE_DEPRECATION } from "../../../accounts/service/src/legacy-workspace-telemetry.ts";

// TASK-0118 Phase 9: every way a platform-served request selects a Workspace
// is counted once its credential is authenticated, never before.

const WORKSPACE_ID = "space_telemetry";
const SUBJECT = "tsub_platform_telemetry";
const ORIGIN = "https://app.takosumi.com";

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

function interfaceEnv(): never {
  return {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-token",
  } as never;
}

const browserSession = async (): Promise<PlatformExtensionSessionContext> => ({
  authenticated: true,
  authKind: "session",
  subject: SUBJECT,
});

const workspaceBoundOAuth = (
  scopes: readonly string[] = ["openid", "capsules:read"],
) =>
async (): Promise<PlatformExtensionSessionContext> => ({
  authenticated: true,
  authKind: "oauth-access-token",
  subject: SUBJECT,
  workspaceId: WORKSPACE_ID,
  workspaceRole: "viewer",
  scopes,
});

const ownerAccess = async () => "owner" as const;

function expectNoIds(lines: readonly string[], ...values: string[]): void {
  const raw = lines.join("\n");
  for (const value of [WORKSPACE_ID, SUBJECT, ...values]) {
    expect(raw).not.toContain(value);
  }
}

test("Interface API: a Workspace chosen by query, header or body is counted with its selector", async () => {
  const cases: ReadonlyArray<{
    readonly selector: string;
    readonly route: string;
    readonly request: () => Request;
  }> = [
    {
      selector: "query",
      route: "/api/v1/interfaces",
      request: () =>
        new Request(`${ORIGIN}/api/v1/interfaces?workspaceId=${WORKSPACE_ID}`, {
          headers: { cookie: "takosumi_session=browser" },
        }),
    },
    {
      selector: "header",
      route: "/api/v1/interfaces/{interfaceId}",
      request: () =>
        new Request(`${ORIGIN}/api/v1/interfaces/if_missing`, {
          headers: {
            cookie: "takosumi_session=browser",
            "x-takosumi-platform-workspace-id": WORKSPACE_ID,
          },
        }),
    },
    {
      selector: "body",
      route: "/api/v1/interfaces",
      request: () =>
        new Request(`${ORIGIN}/api/v1/interfaces`, {
          method: "POST",
          headers: {
            cookie: "takosumi_session=browser",
            "content-type": "application/json",
            origin: ORIGIN,
          },
          body: JSON.stringify({ workspaceId: WORKSPACE_ID }),
        }),
    },
  ];
  for (const testCase of cases) {
    const request = testCase.request();
    const { result: response, lines } = await captureInfo(() =>
      handlePlatformInterfaceApiRequest(
        request,
        interfaceEnv(),
        browserSession,
        ownerAccess,
      )
    );
    expect(response.headers.get("Deprecation"), testCase.selector).toBe(
      LEGACY_WORKSPACE_DEPRECATION,
    );
    expect(legacyEvents(lines), testCase.selector).toEqual([{
      event: "legacy_workspace_route",
      surface: "interface_workspace",
      route: testCase.route,
      selector: testCase.selector,
      method: request.method,
      status: response.status,
      entry: "platform",
      credential: "session",
      workspaceBound: false,
      appBound: false,
      clientFamily: "ua:none",
    }]);
    expectNoIds(lines, "if_missing");
  }
});

test("Interface API: a Workspace taken implicitly from the credential is counted as a session selection", async () => {
  const { result: response, lines } = await captureInfo(() =>
    handlePlatformInterfaceApiRequest(
      new Request(`${ORIGIN}/api/v1/interfaces/if_missing/bindings`, {
        headers: {
          authorization: "Bearer takat_workspace_bound",
          "takosumi-client": "takos/2.5.0",
        },
      }),
      interfaceEnv(),
      workspaceBoundOAuth(),
    )
  );
  expect(response.headers.get("Deprecation")).toBe(LEGACY_WORKSPACE_DEPRECATION);
  expect(legacyEvents(lines)).toEqual([expect.objectContaining({
    surface: "interface_workspace",
    route: "/api/v1/interfaces/{interfaceId}/bindings",
    selector: "session",
    credential: "oauth-access-token",
    workspaceBound: true,
    clientFamily: "takos",
  })]);
  expectNoIds(lines, "takat_workspace_bound", "if_missing");
});

test("Interface API: an authenticated but refused Workspace selection is still counted", async () => {
  const { result: response, lines } = await captureInfo(() =>
    handlePlatformInterfaceApiRequest(
      new Request(
        `${ORIGIN}/api/v1/interfaces?workspaceId=${WORKSPACE_ID}&permission=mcp.invoke`,
        { headers: { authorization: "Bearer takat_no_scope" } },
      ),
      interfaceEnv(),
      workspaceBoundOAuth(["openid", "profile"]),
    )
  );
  expect(response.status).toBe(403);
  expect(legacyEvents(lines)).toEqual([expect.objectContaining({
    selector: "query",
    status: 403,
    credential: "oauth-access-token",
  })]);
});

test("Interface API: a request refused before authentication is not counted", async () => {
  const { result: response, lines } = await captureInfo(() =>
    handlePlatformInterfaceApiRequest(
      new Request(`${ORIGIN}/api/v1/interfaces?workspaceId=${WORKSPACE_ID}`),
      interfaceEnv(),
      async () => ({ authenticated: false }),
    )
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("Deprecation")).toBeNull();
  expect(legacyEvents(lines)).toEqual([]);
});

test("Interface API: the operator deploy-control token is counted by query or body selection", async () => {
  const query = await captureInfo(() =>
    handlePlatformInterfaceApiRequest(
      new Request(`${ORIGIN}/api/v1/interfaces?workspaceId=${WORKSPACE_ID}`, {
        headers: { authorization: "Bearer deploy-control-token" },
      }),
      interfaceEnv(),
    )
  );
  expect(legacyEvents(query.lines)).toEqual([expect.objectContaining({
    route: "/api/v1/interfaces",
    selector: "query",
    credential: "deploy-control",
  })]);

  const body = JSON.stringify({ workspaceId: WORKSPACE_ID, name: "telemetry" });
  const posted = await captureInfo(() =>
    handlePlatformInterfaceApiRequest(
      new Request(`${ORIGIN}/api/v1/interfaces`, {
        method: "POST",
        headers: {
          authorization: "Bearer deploy-control-token",
          "content-type": "application/json",
        },
        body,
      }),
      interfaceEnv(),
    )
  );
  // The body is read from a clone: Core still receives it, accepts its
  // Workspace and only then refuses the incomplete Interface.
  expect(posted.result.status).toBe(400);
  expect(await posted.result.json()).toMatchObject({
    error: { message: "ownerRef must be an object" },
  });
  expect(legacyEvents(posted.lines)).toEqual([expect.objectContaining({
    route: "/api/v1/interfaces",
    selector: "body",
    credential: "deploy-control",
  })]);

  const unselected = await captureInfo(() =>
    handlePlatformInterfaceApiRequest(
      new Request(`${ORIGIN}/api/v1/interfaces/if_missing`, {
        headers: { authorization: "Bearer deploy-control-token" },
      }),
      interfaceEnv(),
    )
  );
  expect(unselected.result.headers.get("Deprecation")).toBeNull();
  expect(legacyEvents(unselected.lines)).toEqual([]);
  expectNoIds([...query.lines, ...posted.lines], "deploy-control-token");
});

const telemetryRoute = {
  basePath: "/extensions/telemetry",
  handlerKey: "TELEMETRY_EXTENSION",
  workspaceContext: "query-optional" as const,
};

function extensionEnv(seen: (string | null)[]): never {
  return {
    TELEMETRY_EXTENSION: {
      fetch: async (request: Request) => {
        seen.push(request.headers.get("x-takosumi-platform-workspace-id"));
        return Response.json({ ok: true });
      },
    },
  } as never;
}

test("platform extension: a query Workspace and a credential's own Workspace are both counted", async () => {
  const seen: (string | null)[] = [];
  const query = await captureInfo(() =>
    handlePlatformExtensionRouteRequest(
      new Request(`${ORIGIN}/extensions/telemetry/items?workspaceId=${WORKSPACE_ID}`),
      extensionEnv(seen),
      telemetryRoute,
      browserSession,
      async () => "member",
    )
  );
  expect(query.result.status).toBe(200);
  expect(legacyEvents(query.lines)).toEqual([{
    event: "legacy_workspace_route",
    surface: "platform_extension_workspace",
    route: "/extensions/telemetry/*",
    selector: "query",
    method: "GET",
    status: 200,
    entry: "platform",
    credential: "session",
    workspaceBound: false,
    appBound: false,
    clientFamily: "ua:none",
  }]);

  const implicit = await captureInfo(() =>
    handlePlatformExtensionRouteRequest(
      new Request(`${ORIGIN}/extensions/telemetry/items`),
      extensionEnv(seen),
      { basePath: "/extensions/telemetry", handlerKey: "TELEMETRY_EXTENSION" },
      async () => ({
        authenticated: true,
        authKind: "run-credential",
        subject: SUBJECT,
        workspaceId: WORKSPACE_ID,
        capsuleId: "cap_telemetry",
      }),
    )
  );
  expect(implicit.result.status).toBe(200);
  expect(implicit.result.headers.get("Deprecation")).toBe(LEGACY_WORKSPACE_DEPRECATION);
  expect(legacyEvents(implicit.lines)).toEqual([expect.objectContaining({
    surface: "platform_extension_workspace",
    route: "/extensions/telemetry/*",
    selector: "session",
    credential: "run-credential",
    workspaceBound: true,
    appBound: true,
  })]);
  // Both Workspaces reached the extension, which is what stage 9B removes.
  expect(seen).toEqual([WORKSPACE_ID, WORKSPACE_ID]);
  expectNoIds([...query.lines, ...implicit.lines], "cap_telemetry");
});

test("platform extension: no Workspace, or no authentication, is not counted", async () => {
  const seen: (string | null)[] = [];
  const unscoped = await captureInfo(() =>
    handlePlatformExtensionRouteRequest(
      new Request(`${ORIGIN}/extensions/telemetry/items`),
      extensionEnv(seen),
      telemetryRoute,
      browserSession,
    )
  );
  expect(unscoped.result.status).toBe(200);
  expect(unscoped.result.headers.get("Deprecation")).toBeNull();
  expect(legacyEvents(unscoped.lines)).toEqual([]);

  const anonymous = await captureInfo(() =>
    handlePlatformExtensionRouteRequest(
      new Request(`${ORIGIN}/extensions/telemetry/items?workspaceId=${WORKSPACE_ID}`),
      extensionEnv(seen),
      telemetryRoute,
      async () => ({ authenticated: false }),
    )
  );
  expect(anonymous.result.status).toBe(401);
  expect(anonymous.result.headers.get("Deprecation")).toBeNull();
  expect(legacyEvents(anonymous.lines)).toEqual([]);
  expect(seen).toEqual([null]);
});
