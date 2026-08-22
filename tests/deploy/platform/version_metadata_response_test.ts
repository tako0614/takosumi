import { expect, test } from "bun:test";

import { withPlatformWorkerVersion } from "../../../deploy/platform/version_metadata_response.ts";

const VERSION = "00000000-0000-4000-8000-000000000001";

test("platform responses carry the immutable Worker Version identity", async () => {
  const response = withPlatformWorkerVersion(
    new Response("ok", {
      headers: { "x-takosumi-version-id": "caller-authored" },
    }),
    { id: VERSION },
  );

  expect(response.headers.get("x-takosumi-version-id")).toBe(VERSION);
  expect(await response.text()).toBe("ok");
});

test("platform responses never synthesize malformed Version evidence", () => {
  const response = new Response("ok");
  expect(
    withPlatformWorkerVersion(response, undefined).headers.get(
      "x-takosumi-version-id",
    ),
  ).toBeNull();
  expect(
    withPlatformWorkerVersion(response, { id: "latest" }).headers.get(
      "x-takosumi-version-id",
    ),
  ).toBeNull();
});

test("platform response decoration never reconstructs a WebSocket response", () => {
  const response = Object.assign(new Response(null), {
    webSocket: { accept() {} },
  });
  expect(withPlatformWorkerVersion(response, { id: VERSION })).toBe(response);
});
