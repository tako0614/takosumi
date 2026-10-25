import { test } from "bun:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  apiExceptionResponse,
  registerApiErrorHandler,
} from "../../../core/api/errors.ts";

test("API error response preserves its request-ID envelope for unprintable values", async () => {
  const app = new Hono();
  app.get("/:kind", (context) => {
    const value = context.req.param("kind") === "null-prototype"
      ? Object.create(null)
      : {
      toString() {
        throw new Error("coercion must not replace the original failure");
      },
    };
    return apiExceptionResponse(context, value);
  });
  const requestId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  for (const path of ["/null-prototype", "/hostile-to-string"]) {
    const response = await app.request(path, {
      headers: { "x-request-id": requestId },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: {
        code: "internal_error",
        message: "Internal server error",
        requestId,
      },
    });
  }
});

test("Hono onError contains hostile properties on an actual Error", async () => {
  const app = new Hono();
  registerApiErrorHandler(app);
  app.get("/hostile-error", () => {
    const error = new Error("original failure");
    Object.defineProperty(error, "name", {
      get() {
        throw new Error("name accessor must not replace original");
      },
    });
    throw error;
  });

  const response = await app.request("/hostile-error", {
    headers: { "x-request-id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: {
      code: "internal_error",
      message: "Internal server error",
      requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
  });
});
