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

function retiredRequest(path: string, token = "resource-token"): Request {
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

test("retired Resource Shape families are unconditional JSON 404s", async () => {
  for (const path of [
    "/v1/resources?space=workspace_a&limit=1",
    "/v1/target-pools?space=workspace_a&limit=1",
    "/v1/space-policies?space=workspace_a&limit=1",
  ]) {
    const response = await handlePlatformResourceShapeApiRequest(
      retiredRequest(path),
      platformEnv(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(timingNames(response)).toEqual([]);
  }
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
