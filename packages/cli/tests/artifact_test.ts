import assert from "node:assert/strict";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(
  handler: (req: Request) => Promise<Response> | Response,
): () => void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return Promise.resolve(handler(req));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = ORIGINAL_FETCH;
  };
}

Deno.test("artifact push posts multipart with kind + body", async () => {
  let observed: { url: string; method: string; auth?: string; form?: FormData };
  observed = { url: "", method: "" };
  const restore = mockFetch(async (req) => {
    observed = {
      url: req.url,
      method: req.method,
      auth: req.headers.get("authorization") ?? undefined,
      form: await req.formData(),
    };
    return new Response(
      JSON.stringify({
        hash: "sha256:abc",
        kind: "js-bundle",
        size: 16,
        uploadedAt: "2026-05-02T00:00:00.000Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  try {
    const tmp = await Deno.makeTempFile({ suffix: ".js" });
    await Deno.writeTextFile(tmp, "console.log('x');");
    Deno.env.set("TAKOSUMI_KERNEL_URL", "http://example.test");
    Deno.env.set("TAKOSUMI_TOKEN", "T");
    const { artifactCommand } = await import(
      `../src/commands/artifact.ts?${crypto.randomUUID()}`
    );
    await artifactCommand.parse(["push", tmp, "--kind=js-bundle"]);
    assert.equal(observed.method, "POST");
    assert.equal(observed.url, "http://example.test/v1/artifacts");
    assert.equal(observed.auth, "Bearer T");
    assert.equal(observed.form!.get("kind"), "js-bundle");
    const file = observed.form!.get("body");
    assert.ok(file instanceof File);
  } finally {
    restore();
    Deno.env.delete("TAKOSUMI_KERNEL_URL");
    Deno.env.delete("TAKOSUMI_TOKEN");
  }
});

Deno.test("artifact list GETs /v1/artifacts with bearer token", async () => {
  let observed: { url: string; method: string; auth?: string };
  observed = { url: "", method: "" };
  const restore = mockFetch((req) => {
    observed = {
      url: req.url,
      method: req.method,
      auth: req.headers.get("authorization") ?? undefined,
    };
    return new Response(JSON.stringify({ artifacts: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    Deno.env.set("TAKOSUMI_KERNEL_URL", "http://example.test");
    Deno.env.set("TAKOSUMI_TOKEN", "T");
    const { artifactCommand } = await import(
      `../src/commands/artifact.ts?${crypto.randomUUID()}`
    );
    await artifactCommand.parse(["list"]);
    assert.equal(observed.method, "GET");
    assert.equal(observed.url, "http://example.test/v1/artifacts");
    assert.equal(observed.auth, "Bearer T");
  } finally {
    restore();
    Deno.env.delete("TAKOSUMI_KERNEL_URL");
    Deno.env.delete("TAKOSUMI_TOKEN");
  }
});

Deno.test("artifact rm DELETEs /v1/artifacts/:hash", async () => {
  let observed: { url: string; method: string };
  observed = { url: "", method: "" };
  const restore = mockFetch((req) => {
    observed = { url: req.url, method: req.method };
    return new Response(null, { status: 204 });
  });
  try {
    Deno.env.set("TAKOSUMI_KERNEL_URL", "http://example.test");
    Deno.env.set("TAKOSUMI_TOKEN", "T");
    const { artifactCommand } = await import(
      `../src/commands/artifact.ts?${crypto.randomUUID()}`
    );
    await artifactCommand.parse(["rm", "sha256:abc"]);
    assert.equal(observed.method, "DELETE");
    assert.equal(observed.url, "http://example.test/v1/artifacts/sha256%3Aabc");
  } finally {
    restore();
    Deno.env.delete("TAKOSUMI_KERNEL_URL");
    Deno.env.delete("TAKOSUMI_TOKEN");
  }
});
