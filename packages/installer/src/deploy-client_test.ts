import assert from "node:assert/strict";
import { InstallerClient, InstallerHttpError } from "./deploy-client.ts";

function clientWith(fetchImpl: typeof fetch): InstallerClient {
  return new InstallerClient({
    endpoint: "https://installer.test",
    token: "t",
    fetch: fetchImpl,
  });
}

Deno.test("InstallerClient surfaces HTTP status for non-JSON error bodies", async () => {
  const client = clientWith(() =>
    Promise.resolve(
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/html" },
      }),
    )
  );
  const err = await client.installDryRun({} as never).then(
    () => null,
    (e) => e,
  );
  assert.ok(
    err instanceof InstallerHttpError,
    "should throw InstallerHttpError",
  );
  assert.equal(err.status, 502);
  assert.equal(err.envelope.error.code, "internal_error");
  assert.match(err.envelope.error.message, /HTTP 502/);
});

Deno.test("InstallerClient throws typed error for malformed JSON on a 200", async () => {
  const client = clientWith(() =>
    Promise.resolve(
      new Response("{ not json", { status: 200 }),
    )
  );
  const err = await client.installDryRun({} as never).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof InstallerHttpError);
  assert.equal(err.status, 200);
  assert.match(err.envelope.error.message, /not valid JSON/);
});

Deno.test("InstallerClient passes through a well-formed error envelope", async () => {
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
  const err = await client.installDryRun({} as never).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof InstallerHttpError);
  assert.equal(err.status, 409);
  assert.equal(err.envelope.error.code, "failed_precondition");
  assert.equal(err.envelope.error.requestId, "req-1");
});

Deno.test("InstallerClient returns parsed success bodies unchanged", async () => {
  const client = clientWith(() =>
    Promise.resolve(
      new Response(JSON.stringify({ installationId: "i-1" }), { status: 200 }),
    )
  );
  const result = await client.installDryRun({} as never) as unknown as {
    installationId: string;
  };
  assert.equal(result.installationId, "i-1");
});
