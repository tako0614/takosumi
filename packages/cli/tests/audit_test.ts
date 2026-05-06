import assert from "node:assert/strict";
import { auditCommand } from "../src/commands/audit.ts";

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

async function runAuditAgainstFakeKernel(
  args: string[],
  handler: (path: string) => { status: number; body: unknown },
): Promise<{
  readonly requests: readonly CapturedRequest[];
  readonly output: string;
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
    const parsed = new URL(url);
    const auth = init?.headers
      ? new Headers(init.headers).get("authorization")
      : null;
    captured.push({
      url,
      method: init?.method ?? "GET",
      authorization: auth,
    });
    const { status, body } = handler(parsed.pathname);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  console.log = (...parts: unknown[]) => {
    output.push(parts.map((p) => String(p)).join(" "));
  };
  try {
    await auditCommand.parse(args);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  return { requests: captured, output: output.join("\n") };
}

Deno.test("audit show fetches deployment audit by name and renders provenance chain", async () => {
  const { requests, output } = await runAuditAgainstFakeKernel(
    ["show", "my-app", "--remote", "https://kernel.example", "--token", "tk"],
    (path) => {
      assert.equal(path, "/v1/deployments/my-app/audit");
      return { status: 200, body: auditResponse() };
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(
    requests[0].url,
    "https://kernel.example/v1/deployments/my-app/audit",
  );
  assert.equal(requests[0].authorization, "Bearer tk");
  assert.match(output, /deployment my-app \(deployment:123\)/);
  assert.match(output, /workflowRunId=takosumi-git:run:abc/);
  assert.match(output, /commit=0123456789abcdef/);
  assert.match(output, /ghcr\.io\/acme\/demo@sha256:abc/);
  assert.match(output, /compensate-revoke-debt-enqueued/);
  assert.match(output, /revoke-debt:1/);
});

Deno.test("audit show resolves deployment id through status list", async () => {
  const { requests, output } = await runAuditAgainstFakeKernel(
    [
      "show",
      "deployment:123",
      "--remote",
      "https://kernel.example",
      "--token",
      "tk",
    ],
    (path) => {
      if (path === "/v1/deployments/deployment%3A123/audit") {
        return { status: 404, body: { error: { code: "not_found" } } };
      }
      if (path === "/v1/deployments") {
        return {
          status: 200,
          body: {
            deployments: [{ id: "deployment:123", name: "my-app" }],
          },
        };
      }
      assert.equal(path, "/v1/deployments/my-app/audit");
      return { status: 200, body: auditResponse() };
    },
  );
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      "/v1/deployments/deployment%3A123/audit",
      "/v1/deployments",
      "/v1/deployments/my-app/audit",
    ],
  );
  assert.match(output, /deployment my-app \(deployment:123\)/);
});

function auditResponse(): unknown {
  return {
    status: "ok",
    audit: {
      deployment: {
        id: "deployment:123",
        name: "my-app",
        status: "failed",
        tenantId: "takosumi-deploy",
        resources: [],
      },
      journal: {
        phase: "apply",
        latestStage: "abort",
        status: "failed",
        terminal: true,
        operationPlanDigest: "sha256:plan",
      },
      provenance: {
        workflowRunId: "takosumi-git:run:abc",
        git: {
          commitSha: "0123456789abcdef",
          ref: "refs/heads/main",
          repository: "acme/demo",
        },
        resourceArtifacts: [{
          resourceName: "web",
          artifactName: "image",
          artifactUri: "ghcr.io/acme/demo@sha256:abc",
        }],
      },
      causeChain: [
        {
          createdAt: "2026-05-07T00:00:00.000Z",
          phase: "apply",
          stage: "commit",
          status: "recorded",
          operationKind: "create",
          resourceName: "web",
          providerId: "@takos/selfhost-process",
        },
        {
          createdAt: "2026-05-07T00:00:01.000Z",
          phase: "apply",
          stage: "abort",
          status: "failed",
          operationKind: "create",
          resourceName: "web",
          providerId: "@takos/selfhost-process",
          reason: "compensate-revoke-debt-enqueued",
        },
      ],
      revokeDebts: [{
        id: "revoke-debt:1",
        reason: "activation-rollback",
        status: "open",
        resourceName: "web",
        providerId: "@takos/selfhost-process",
      }],
    },
  };
}
