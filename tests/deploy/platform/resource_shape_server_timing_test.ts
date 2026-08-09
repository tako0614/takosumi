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
    TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED: "1",
  } as never;
}

function drainRequest(path: string, token = "resource-token"): Request {
  return new Request(`https://app.takosumi.test${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function timingNames(response: Response): string[] {
  return (response.headers.get("server-timing") ?? "")
    .split(",")
    .map((entry) => entry.trim().split(";", 1)[0])
    .filter(Boolean);
}

test("bounded Resource reads expose honest platform phases", async () => {
  const response = await handlePlatformResourceShapeApiRequest(
    drainRequest("/v1/resources?space=workspace_a&limit=1"),
    platformEnv(),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ resources: [] });
  expect(timingNames(response)).toEqual(["resource-dispatch"]);
  expect(response.headers.get("server-timing")).toMatch(
    /resource-dispatch;dur=\d+(?:\.\d+)?/u,
  );
});

test("bounded TargetPool and SpacePolicy reads use the same platform phases", async () => {
  const reads = [
    ["/v1/target-pools?space=workspace_a&limit=1", "targetPools"],
    ["/v1/space-policies?space=workspace_a&limit=1", "spacePolicies"],
  ] as const;

  for (const [path, collection] of reads) {
    const response = await handlePlatformResourceShapeApiRequest(
      drainRequest(path),
      platformEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ [collection]: [] });
    expect(timingNames(response)).toEqual(["resource-dispatch"]);
  }
});

test("a wrong operator bearer fails before dispatch without leaking timing", async () => {
  const response = await handlePlatformResourceShapeApiRequest(
    drainRequest("/v1/resources?space=workspace_a", "wrong-token"),
    platformEnv(),
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthenticated" });
  expect(timingNames(response)).toEqual([]);
});

test("a missing operator bearer never invokes Workspace session auth", async () => {
  let sessionVerified = false;
  const response = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.test/v1/resources?space=workspace_a"),
    platformEnv(),
    async () => {
      sessionVerified = true;
      return { authenticated: false as const };
    },
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthenticated" });
  expect(sessionVerified).toBe(false);
  expect(timingNames(response)).toEqual([]);
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
