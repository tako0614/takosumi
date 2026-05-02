import assert from "node:assert/strict";
import { DomainError } from "../shared/errors.ts";
import {
  apiErrorCodeForError,
  apiHttpStatusForError,
  createPublicApiErrorResponse,
  httpStatusForDomainErrorCode,
  readRequestId,
  redactApiErrorDetails,
} from "./error_envelope.ts";

Deno.test("error envelope maps DomainError code, status, message, request id, and redacted details", () => {
  const error = new DomainError("invalid_argument", "spaceId is required", {
    field: "spaceId",
    nested: {
      authToken: "secret-token",
      safe: "kept",
    },
  });

  const response = createPublicApiErrorResponse(error, {
    requestId: "req_123",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "invalid_argument",
      message: "spaceId is required",
      requestId: "req_123",
      details: {
        field: "spaceId",
        nested: {
          authToken: "[redacted]",
          safe: "kept",
        },
      },
    },
  });
});

Deno.test("error envelope maps every DomainError code to HTTP status", () => {
  assert.equal(httpStatusForDomainErrorCode("invalid_argument"), 400);
  assert.equal(httpStatusForDomainErrorCode("not_found"), 404);
  assert.equal(httpStatusForDomainErrorCode("conflict"), 409);
  assert.equal(httpStatusForDomainErrorCode("permission_denied"), 403);
  assert.equal(httpStatusForDomainErrorCode("not_implemented"), 501);
});

Deno.test("error envelope maps provider failure reasons to gateway/provider statuses", () => {
  const cases = [
    ["provider_timeout", 504],
    ["provider_unavailable", 503],
    ["provider_conflict", 409],
    ["provider_rejected", 422],
    ["unknown", 502],
  ] as const;

  for (const [reason, status] of cases) {
    const response = createPublicApiErrorResponse({
      failureReason: reason,
      message: `provider failed: ${reason}`,
      failure: {
        reason,
        retryable: reason !== "provider_rejected",
        providerSecret: "do-not-leak",
      },
    });
    assert.equal(response.status, status);
    assert.equal(response.body.error.code, reason);
    assert.equal(
      (response.body.error.details as { providerSecret: string })
        .providerSecret,
      "[redacted]",
    );
  }
});

Deno.test("error envelope classifies named provider errors by message", () => {
  const error = new Error("request timed out while applying manifest");
  error.name = "ProviderOperationError";

  assert.equal(apiHttpStatusForError(error), 504);
  assert.equal(apiErrorCodeForError(error), "provider_timeout");

  const response = createPublicApiErrorResponse(error);
  assert.equal(response.status, 504);
  assert.equal(response.body.error.code, "provider_timeout");
  assert.equal(
    response.body.error.message,
    "request timed out while applying manifest",
  );
});

Deno.test("error envelope keeps unknown errors generic", () => {
  const response = createPublicApiErrorResponse(new Error("database password"));

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    error: {
      code: "internal_error",
      message: "Internal server error",
    },
  });
});

Deno.test("redactApiErrorDetails recursively redacts sensitive keys and coerces non-json values", () => {
  const redacted = redactApiErrorDetails({
    authorization: "Bearer x",
    api_key: "key",
    privateKey: "pem",
    child: {
      cookie: "session",
      count: 1,
      at: new Date("2026-04-26T00:00:00.000Z"),
      error: new Error("safe diagnostic"),
    },
  });

  assert.deepEqual(redacted, {
    authorization: "[redacted]",
    api_key: "[redacted]",
    privateKey: "[redacted]",
    child: {
      cookie: "[redacted]",
      count: 1,
      at: "2026-04-26T00:00:00.000Z",
      error: { name: "Error", message: "safe diagnostic" },
    },
  });
});

Deno.test("readRequestId reads request and correlation headers with fallback", () => {
  assert.equal(
    readRequestId(
      new Request("https://example.test", {
        headers: { "x-request-id": "req_header" },
      }),
    ),
    "req_header",
  );
  assert.equal(
    readRequestId(
      new Request("https://example.test", {
        headers: { "x-correlation-id": "corr_header" },
      }),
    ),
    "corr_header",
  );
  assert.equal(
    readRequestId(new Request("https://example.test"), "req_fallback"),
    "req_fallback",
  );
});
