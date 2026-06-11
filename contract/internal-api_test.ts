import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  canonicalInternalResponse,
  signInternalResponse,
  TAKOSUMI_INTERNAL_PATHS,
  TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_HEADER,
  TAKOSUMI_INTERNAL_TIMESTAMP_HEADER,
  verifySignedInternalResponseFromHeaders,
} from "./internal-api.ts";

test("signInternalResponse / verifySignedInternalResponseFromHeaders round trip", async () => {
  const body = '{"space":{"id":"space_42","name":"default"}}';
  const path = TAKOSUMI_INTERNAL_PATHS.spaces;
  const signed = await signInternalResponse({
    method: "POST",
    path,
    status: 201,
    body,
    timestamp: "2026-04-30T00:00:00.000Z",
    requestId: "req_response_round_trip",
    secret: "shared",
  });

  assert.match(
    signed.headers[TAKOSUMI_INTERNAL_SIGNATURE_HEADER],
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    signed.headers[TAKOSUMI_INTERNAL_REQUEST_ID_HEADER],
    "req_response_round_trip",
  );
  assert.equal(
    signed.headers[TAKOSUMI_INTERNAL_TIMESTAMP_HEADER],
    "2026-04-30T00:00:00.000Z",
  );

  assert.equal(
    await verifySignedInternalResponseFromHeaders({
      method: "POST",
      path,
      status: 201,
      body,
      secret: "shared",
      headers: new Headers(signed.headers),
      now: () => new Date("2026-04-30T00:00:30.000Z"),
    }),
    true,
  );

  const tamperedBody = body.replace("default", "tampered");
  assert.equal(
    await verifySignedInternalResponseFromHeaders({
      method: "POST",
      path,
      status: 201,
      body: tamperedBody,
      secret: "shared",
      headers: new Headers(signed.headers),
      now: () => new Date("2026-04-30T00:00:30.000Z"),
    }),
    false,
  );
});

test("canonicalInternalResponse binds method/path/status/body", () => {
  const path = TAKOSUMI_INTERNAL_PATHS.spaces;
  const canonical = canonicalInternalResponse({
    method: "post",
    path,
    status: 201,
    body: '{"ok":true}',
    timestamp: "2026-04-30T00:00:00.000Z",
    requestId: "req_canon",
  });
  assert.equal(
    canonical,
    [
      "takosumi-internal-response-v1",
      "POST",
      path,
      "201",
      "2026-04-30T00:00:00.000Z",
      "req_canon",
      '{"ok":true}',
    ].join("\n"),
  );
});
