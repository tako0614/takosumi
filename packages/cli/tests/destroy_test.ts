import assert from "node:assert/strict";
import { destroyCommand } from "../src/commands/destroy.ts";

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

async function runDestroyAgainstFakeKernel(
  args: string[],
): Promise<CapturedRequest> {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    let parsed: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    const auth = init?.headers
      ? new Headers(init.headers).get("authorization")
      : null;
    captured.push({
      url,
      method: init?.method ?? "GET",
      body: parsed,
      authorization: auth,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ status: "ok", outcome: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    await destroyCommand.parse(args);
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (captured.length !== 1) {
    throw new Error(
      `expected exactly one fetch call, got ${captured.length}`,
    );
  }
  return captured[0];
}

Deno.test(
  "destroy command POSTs to /v1/deployments with mode=destroy (Task 5 fix)",
  async () => {
    const manifestPath = await Deno.makeTempFile({ suffix: ".json" });
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        metadata: { name: "my-app" },
        resources: [
          {
            shape: "object-store@v1",
            name: "logs",
            provider: "@takos/selfhost-filesystem",
            spec: {},
          },
        ],
      }),
    );
    try {
      const captured = await runDestroyAgainstFakeKernel([
        manifestPath,
        "--remote",
        "https://kernel.example",
        "--token",
        "tk",
      ]);
      assert.equal(captured.method, "POST");
      // The pre-fix bug pointed at /v1/deployments/destroy. The kernel
      // expects /v1/deployments with mode=destroy in the body.
      assert.equal(captured.url, "https://kernel.example/v1/deployments");
      assert.equal(captured.authorization, "Bearer tk");
      const body = captured.body as Record<string, unknown>;
      assert.equal(body.mode, "destroy");
      assert.ok(
        body.manifest && typeof body.manifest === "object",
        "destroy must include the manifest in the body",
      );
    } finally {
      await Deno.remove(manifestPath);
    }
  },
);
