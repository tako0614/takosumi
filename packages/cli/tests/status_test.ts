import assert from "node:assert/strict";
import { statusCommand } from "../src/commands/status.ts";

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

async function runStatusAgainstFakeKernel(
  args: string[],
  fakeBody: unknown,
  fakeStatus = 200,
): Promise<{
  request: CapturedRequest;
  output: readonly string[];
}> {
  const captured: CapturedRequest[] = [];
  const output: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const auth = init?.headers
      ? new Headers(init.headers).get("authorization")
      : null;
    captured.push({
      url,
      method: init?.method ?? "GET",
      authorization: auth,
    });
    return Promise.resolve(
      new Response(JSON.stringify(fakeBody), {
        status: fakeStatus,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  console.log = (...parts: unknown[]) => {
    output.push(parts.map((p) => String(p)).join(" "));
  };
  try {
    await statusCommand.parse(args);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  if (captured.length !== 1) {
    throw new Error(
      `expected exactly one fetch call, got ${captured.length}`,
    );
  }
  return { request: captured[0], output };
}

Deno.test(
  "status (no name) issues GET /v1/deployments and renders rows from response",
  async () => {
    const fakeResponse = {
      deployments: [
        {
          name: "my-app",
          status: "applied",
          appliedAt: "2026-05-02T00:00:00.000Z",
          journal: {
            phase: "apply",
            latestStage: "finalize",
            status: "succeeded",
          },
          resources: [
            {
              name: "bucket",
              shape: "object-store@v1",
              provider: "@takos/aws-s3",
              status: "applied",
              outputs: { region: "us-east-1" },
            },
          ],
        },
      ],
    };
    const { request, output } = await runStatusAgainstFakeKernel(
      ["--remote", "https://kernel.example", "--token", "tk"],
      fakeResponse,
    );
    assert.equal(request.method, "GET");
    assert.equal(request.url, "https://kernel.example/v1/deployments");
    assert.equal(request.authorization, "Bearer tk");
    const dump = output.join("\n");
    assert.match(dump, /my-app/);
    assert.match(dump, /bucket/);
    assert.match(dump, /object-store@v1/);
    assert.match(dump, /aws-s3/);
    assert.match(dump, /applied/);
    assert.match(dump, /apply:finalize\/succeeded/);
  },
);

Deno.test(
  "status with name issues GET /v1/deployments/:name",
  async () => {
    const fakeResponse = {
      name: "single",
      status: "applied",
      appliedAt: "2026-05-02T00:00:00.000Z",
      resources: [
        {
          name: "bucket",
          shape: "object-store@v1",
          provider: "@takos/aws-s3",
          status: "applied",
          outputs: {},
        },
      ],
    };
    const { request, output } = await runStatusAgainstFakeKernel(
      ["single", "--remote", "https://kernel.example", "--token", "tk"],
      fakeResponse,
    );
    assert.equal(request.method, "GET");
    assert.equal(request.url, "https://kernel.example/v1/deployments/single");
    const dump = output.join("\n");
    assert.match(dump, /single/);
    assert.match(dump, /bucket/);
  },
);

Deno.test(
  "status renders an empty deployment as a single row with deployment-level status",
  async () => {
    const fakeResponse = {
      deployments: [
        {
          name: "destroyed-app",
          status: "destroyed",
          appliedAt: "2026-05-02T00:00:00.000Z",
          resources: [],
        },
      ],
    };
    const { output } = await runStatusAgainstFakeKernel(
      ["--remote", "https://kernel.example"],
      fakeResponse,
    );
    const dump = output.join("\n");
    assert.match(dump, /destroyed-app/);
    assert.match(dump, /destroyed/);
  },
);
