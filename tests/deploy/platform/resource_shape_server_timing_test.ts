import { expect, test } from "bun:test";
import {
  appendPlatformResourceServerTiming,
  handlePlatformResourceShapeApiRequest,
} from "../../../deploy/platform/worker.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

function platformEnv() {
  return {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_RESOURCE_SHAPES: "ObjectBucket",
  } as never;
}

function readSession() {
  return {
    authenticated: true as const,
    authKind: "personal-access-token" as const,
    subject: "account_a",
    workspaceId: "workspace_a",
    workspaceRole: "member" as const,
    scopes: ["read"],
  };
}

function timingNames(response: Response): string[] {
  return (response.headers.get("server-timing") ?? "")
    .split(",")
    .map((entry) => entry.trim().split(";", 1)[0])
    .filter(Boolean);
}

test("bounded Resource reads expose honest platform phases", async () => {
  const response = await handlePlatformResourceShapeApiRequest(
    new Request(
      "https://app.takosumi.test/v1/resources?space=workspace_a&limit=1",
    ),
    platformEnv(),
    async () => readSession(),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ resources: [] });
  expect(timingNames(response)).toEqual([
    "session",
    "workspace-auth",
    "resource-dispatch",
  ]);
  expect(response.headers.get("server-timing")).toMatch(
    /session;dur=\d+(?:\.\d+)?, workspace-auth;dur=\d+(?:\.\d+)?, resource-dispatch;dur=\d+(?:\.\d+)?/u,
  );
});

test("bounded TargetPool and SpacePolicy reads use the same platform phases", async () => {
  const reads = [
    ["/v1/target-pools?space=workspace_a&limit=1", "targetPools"],
    ["/v1/space-policies?space=workspace_a&limit=1", "spacePolicies"],
  ] as const;

  for (const [path, collection] of reads) {
    const response = await handlePlatformResourceShapeApiRequest(
      new Request(`https://app.takosumi.test${path}`),
      platformEnv(),
      async () => readSession(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ [collection]: [] });
    expect(timingNames(response)).toEqual([
      "session",
      "workspace-auth",
      "resource-dispatch",
    ]);
  }
});

test("authorization failures retain timing without changing the denial body", async () => {
  const response = await handlePlatformResourceShapeApiRequest(
    new Request(
      "https://app.takosumi.test/v1/resources?space=workspace_victim",
    ),
    platformEnv(),
    async () => readSession(),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "access_denied",
    error_description: "workspace context is not authorized",
  });
  expect(timingNames(response)).toEqual(["session", "workspace-auth"]);
});

test("unauthenticated Resource reads retain session timing", async () => {
  const response = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.test/v1/resources?space=workspace_a"),
    platformEnv(),
    async () => ({ authenticated: false as const }),
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthenticated" });
  expect(timingNames(response)).toEqual(["session"]);
});

test("downstream Resource failures retain dispatch timing", async () => {
  const response = await handlePlatformResourceShapeApiRequest(
    new Request(
      "https://app.takosumi.test/v1/resources?space=workspace_a&limit=invalid",
      { headers: { authorization: "Bearer resource-token" } },
    ),
    platformEnv(),
  );

  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
  expect(timingNames(response)).toEqual(["resource-dispatch"]);
});

test("existing Server-Timing and response payload survive appending platform phases", async () => {
  const response = appendPlatformResourceServerTiming(
    new Response(JSON.stringify({ resources: [{ name: "assets" }] }), {
      status: 206,
      headers: {
        "content-type": "application/json",
        "server-timing": "existing;dur=1.2",
      },
    }),
    [{ name: "resource-dispatch", durationMs: 2.34 }],
  );

  expect(response.status).toBe(206);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("server-timing")).toBe(
    "existing;dur=1.2, resource-dispatch;dur=2.3",
  );
  expect(await response.json()).toEqual({
    resources: [{ name: "assets" }],
  });
});

test("WebSocket responses are returned untouched", () => {
  const response = new Response(null);
  Object.defineProperty(response, "webSocket", {
    configurable: true,
    value: {},
  });

  expect(
    appendPlatformResourceServerTiming(response, [
      { name: "resource-dispatch", durationMs: 1 },
    ]),
  ).toBe(response);
});
