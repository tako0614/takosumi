import { test } from "bun:test";
import assert from "node:assert/strict";
import { DeployControlClient, DeployControlHttpError } from "./deploy-client.ts";

function clientWith(fetchImpl: typeof fetch): DeployControlClient {
  return new DeployControlClient({
    endpoint: "https://deploy-control.test",
    token: "t",
    fetch: fetchImpl,
  });
}

test("DeployControlClient surfaces HTTP status for non-JSON error bodies", async () => {
  const client = clientWith(() =>
    Promise.resolve(
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/html" },
      }),
    )
  );
  const err = await client.createPlanRun({} as never).then(
    () => null,
    (e) => e,
  );
  assert.ok(
    err instanceof DeployControlHttpError,
    "should throw DeployControlHttpError",
  );
  assert.equal(err.status, 502);
  assert.equal(err.envelope.error.code, "internal_error");
  assert.match(err.envelope.error.message, /HTTP 502/);
});

test("DeployControlClient throws typed error for malformed JSON on a 200", async () => {
  const client = clientWith(() =>
    Promise.resolve(
      new Response("{ not json", { status: 200 }),
    )
  );
  const err = await client.createPlanRun({} as never).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof DeployControlHttpError);
  assert.equal(err.status, 200);
  assert.match(err.envelope.error.message, /not valid JSON/);
});

test("DeployControlClient passes through a well-formed error envelope", async () => {
  const client = clientWith(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: "failed_precondition",
            message: "pin mismatch",
            requestId: "req-1",
          },
        }),
        { status: 409 },
      ),
    )
  );
  const err = await client.createPlanRun({} as never).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof DeployControlHttpError);
  assert.equal(err.status, 409);
  assert.equal(err.envelope.error.code, "failed_precondition");
  assert.equal(err.envelope.error.requestId, "req-1");
});

test("DeployControlClient returns parsed success bodies unchanged", async () => {
  const client = clientWith(() =>
    Promise.resolve(
      new Response(JSON.stringify({ installationId: "i-1" }), { status: 200 }),
    )
  );
  const result = await client.createPlanRun({} as never) as unknown as {
    installationId: string;
  };
  assert.equal(result.installationId, "i-1");
});
