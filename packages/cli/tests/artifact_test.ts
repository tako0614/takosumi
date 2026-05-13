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
    Deno.env.set("TAKOSUMI_REMOTE_URL", "http://example.test");
    Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", "T");
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
    Deno.env.delete("TAKOSUMI_REMOTE_URL");
    Deno.env.delete("TAKOSUMI_DEPLOY_TOKEN");
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
    Deno.env.set("TAKOSUMI_REMOTE_URL", "http://example.test");
    Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", "T");
    const { artifactCommand } = await import(
      `../src/commands/artifact.ts?${crypto.randomUUID()}`
    );
    await artifactCommand.parse(["list"]);
    assert.equal(observed.method, "GET");
    // CLI now appends `limit=...` for pagination; assert the path + query.
    const url = new URL(observed.url);
    assert.equal(url.origin + url.pathname, "http://example.test/v1/artifacts");
    assert.ok(url.searchParams.has("limit"));
    assert.equal(observed.auth, "Bearer T");
  } finally {
    restore();
    Deno.env.delete("TAKOSUMI_REMOTE_URL");
    Deno.env.delete("TAKOSUMI_DEPLOY_TOKEN");
  }
});

Deno.test("artifact list follows pagination cursor automatically", async () => {
  // Two-page response: first page has nextCursor, second is final.
  const calls: Array<{ url: string }> = [];
  const restore = mockFetch((req) => {
    calls.push({ url: req.url });
    const url = new URL(req.url);
    if (url.searchParams.get("cursor") === "page-2") {
      return new Response(
        JSON.stringify({
          artifacts: [{ hash: "sha256:b" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        artifacts: [{ hash: "sha256:a" }],
        nextCursor: "page-2",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  try {
    Deno.env.set("TAKOSUMI_REMOTE_URL", "http://example.test");
    Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", "T");
    const { artifactCommand } = await import(
      `../src/commands/artifact.ts?${crypto.randomUUID()}`
    );
    await artifactCommand.parse(["list"]);
    assert.equal(
      calls.length,
      2,
      "CLI must follow the cursor through both pages",
    );
    assert.ok(!calls[0].url.includes("cursor="), "first call has no cursor");
    assert.ok(calls[1].url.includes("cursor=page-2"));
  } finally {
    restore();
    Deno.env.delete("TAKOSUMI_REMOTE_URL");
    Deno.env.delete("TAKOSUMI_DEPLOY_TOKEN");
  }
});

Deno.test("artifact gc POSTs /v1/artifacts/gc", async () => {
  let observed: { url: string; method: string; auth?: string };
  observed = { url: "", method: "" };
  const restore = mockFetch((req) => {
    observed = {
      url: req.url,
      method: req.method,
      auth: req.headers.get("authorization") ?? undefined,
    };
    return new Response(
      JSON.stringify({ deleted: [], retained: 0, dryRun: false }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  try {
    Deno.env.set("TAKOSUMI_REMOTE_URL", "http://example.test");
    Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", "T");
    const { artifactCommand } = await import(
      `../src/commands/artifact.ts?${crypto.randomUUID()}`
    );
    await artifactCommand.parse(["gc"]);
    assert.equal(observed.method, "POST");
    assert.equal(observed.url, "http://example.test/v1/artifacts/gc");
    assert.equal(observed.auth, "Bearer T");
  } finally {
    restore();
    Deno.env.delete("TAKOSUMI_REMOTE_URL");
    Deno.env.delete("TAKOSUMI_DEPLOY_TOKEN");
  }
});

Deno.test("artifact gc --dry-run sets dryRun query param", async () => {
  let observed: { url: string };
  observed = { url: "" };
  const restore = mockFetch((req) => {
    observed = { url: req.url };
    return new Response(
      JSON.stringify({ deleted: [], retained: 0, dryRun: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  try {
    Deno.env.set("TAKOSUMI_REMOTE_URL", "http://example.test");
    Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", "T");
    const { artifactCommand } = await import(
      `../src/commands/artifact.ts?${crypto.randomUUID()}`
    );
    await artifactCommand.parse(["gc", "--dry-run"]);
    const url = new URL(observed.url);
    assert.equal(url.pathname, "/v1/artifacts/gc");
    assert.equal(url.searchParams.get("dryRun"), "1");
  } finally {
    restore();
    Deno.env.delete("TAKOSUMI_REMOTE_URL");
    Deno.env.delete("TAKOSUMI_DEPLOY_TOKEN");
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
    Deno.env.set("TAKOSUMI_REMOTE_URL", "http://example.test");
    Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", "T");
    const { artifactCommand } = await import(
      `../src/commands/artifact.ts?${crypto.randomUUID()}`
    );
    await artifactCommand.parse(["rm", "sha256:abc"]);
    assert.equal(observed.method, "DELETE");
    assert.equal(observed.url, "http://example.test/v1/artifacts/sha256%3Aabc");
  } finally {
    restore();
    Deno.env.delete("TAKOSUMI_REMOTE_URL");
    Deno.env.delete("TAKOSUMI_DEPLOY_TOKEN");
  }
});
