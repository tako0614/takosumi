import assert from "node:assert/strict";
import { runtimeAgentCommand } from "../src/commands/runtime_agent.ts";

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | undefined;
}

interface RunResult {
  readonly request: CapturedRequest;
  readonly output: readonly string[];
  readonly errors: readonly string[];
  readonly exitCode: number | undefined;
}

async function runVerifyAgainstFakeAgent(
  args: string[],
  fakeBody: unknown,
  fakeStatus = 200,
): Promise<RunResult> {
  const captured: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalErr = console.error;
  const originalExit = Deno.exit;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const auth = init?.headers
      ? new Headers(init.headers).get("authorization")
      : null;
    let body: string | undefined;
    if (typeof init?.body === "string") body = init.body;
    captured.push({
      url,
      method: init?.method ?? "GET",
      authorization: auth,
      body,
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
  console.error = (...parts: unknown[]) => {
    errors.push(parts.map((p) => String(p)).join(" "));
  };
  // Stop the action from terminating the test process when the CLI tries to
  // exit on a non-zero verify result.
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (code?: number): never => {
    exitCode = code;
    throw new Error(`__test_exit__:${code ?? 0}`);
  };
  try {
    await runtimeAgentCommand.parse(args);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("__test_exit__:")
    ) throw error;
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalErr;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = originalExit;
  }
  if (captured.length !== 1) {
    throw new Error(
      `expected exactly one fetch call, got ${captured.length}`,
    );
  }
  return { request: captured[0], output, errors, exitCode };
}

Deno.test(
  "runtime-agent verify POSTs to /v1/lifecycle/verify and renders an ok row",
  async () => {
    const fakeResponse = {
      results: [
        {
          shape: "object-store@v1",
          provider: "aws-s3",
          ok: true,
          note: "credentials valid",
        },
      ],
    };
    const { request, output, exitCode } = await runVerifyAgainstFakeAgent(
      [
        "verify",
        "--url",
        "https://agent.example",
        "--token",
        "tk",
      ],
      fakeResponse,
    );
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://agent.example/v1/lifecycle/verify");
    assert.equal(request.authorization, "Bearer tk");
    assert.equal(request.body, "{}");
    const dump = output.join("\n");
    assert.match(dump, /object-store@v1\/aws-s3/);
    assert.match(dump, /ok/);
    assert.match(dump, /credentials valid/);
    assert.equal(exitCode, undefined);
  },
);

Deno.test(
  "runtime-agent verify exits non-zero and renders FAIL when any connector fails",
  async () => {
    const fakeResponse = {
      results: [
        {
          shape: "object-store@v1",
          provider: "aws-s3",
          ok: true,
          note: "credentials valid",
        },
        {
          shape: "web-service@v1",
          provider: "cloud-run",
          ok: false,
          code: "auth_failed",
          note: "401 Unauthorized",
        },
      ],
    };
    const { output, exitCode } = await runVerifyAgainstFakeAgent(
      [
        "verify",
        "--url",
        "https://agent.example",
        "--token",
        "tk",
      ],
      fakeResponse,
    );
    const dump = output.join("\n");
    assert.match(dump, /aws-s3/);
    assert.match(dump, /cloud-run/);
    assert.match(dump, /FAIL/);
    assert.match(dump, /\[auth_failed\]/);
    assert.equal(exitCode, 2);
  },
);

Deno.test(
  "runtime-agent verify forwards --shape / --provider as filter body",
  async () => {
    const fakeResponse = { results: [] };
    const { request } = await runVerifyAgainstFakeAgent(
      [
        "verify",
        "--url",
        "https://agent.example",
        "--token",
        "tk",
        "--shape",
        "web-service@v1",
        "--provider",
        "cloud-run",
      ],
      fakeResponse,
    );
    assert.equal(
      request.body,
      JSON.stringify({ shape: "web-service@v1", provider: "cloud-run" }),
    );
  },
);
