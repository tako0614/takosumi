import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../cli/src/main.ts";

interface CapturedRequest {
  readonly request: Request;
  readonly body: string;
}

async function jsonFile(value: unknown): Promise<{
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-resource-cli-"));
  const path = join(directory, "request.json");
  await writeFile(path, JSON.stringify(value));
  return {
    path,
    cleanup: async () => await rm(directory, { recursive: true, force: true }),
  };
}

test("Resource Shape CLI help exposes lifecycle and declaration surfaces", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await main(["--help"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("\n")).toContain("resources");
  expect(stdout.join("\n")).toContain("target-pools");
  expect(stdout.join("\n")).toContain("space-policies");

  stdout.length = 0;
  expect(
    await main(["resources", "--help"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(0);
  expect(stdout.join("\n")).toContain("observe <kind> <name>");
  expect(stdout.join("\n")).toContain("events <kind> <name>");
  expect(stdout.join("\n")).toContain("--force");
  expect(stdout.join("\n")).toContain("--yes");
});

test("Resource Shape CLI maps preview, apply, import, get, observe, and refresh to public routes", async () => {
  const requestFile = await jsonFile({
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "EdgeWorker",
    metadata: { name: "api", space: "space_1" },
    spec: {
      name: "api",
      source: { artifactUrl: "https://assets.example.test/worker.js" },
    },
    nativeId: "provider-native-id",
  });
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    captured.push({ request, body: await request.clone().text() });
    const resource = {
      id: "tkrn:space_1:EdgeWorker:api",
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "EdgeWorker",
      metadata: { name: "api", space: "space_1", managedBy: "cli" },
      spec: { name: "api", source: {} },
      status: { phase: "Ready", observedGeneration: 1 },
    };
    return Response.json(
      request.url.endsWith("/preview")
        ? {
            resource,
            selectedImplementation: "operator.edge.v1",
            selectedTarget: "edge-main",
            portability: "portable",
            nativeResourcePlan: [],
            riskNotes: [],
            summary: "ready",
            planDigest: "sha256:plan",
            specDigest: "sha256:spec",
            resolutionFingerprint: "sha256:resolution",
            quote: {
              quoteId: "quote_1",
              quoteDigest: "sha256:quote",
              estimatedTotalUsdMicros: 250000,
              currency: "USD",
              expiresAt: "2026-07-14T01:00:00Z",
            },
          }
        : resource,
    );
  }) as typeof fetch;

  const io = { stdout: () => {}, stderr: () => {} };
  const common = [
    "--url",
    "https://takosumi.example.test",
    "--token",
    "resource-bearer",
  ];
  try {
    expect(
      await main(
        ["resources", "preview", "--file", requestFile.path, ...common],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        [
          "resources",
          "apply",
          "EdgeWorker",
          "api",
          "--file",
          requestFile.path,
          "--yes",
          ...common,
        ],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        [
          "resources",
          "import",
          "EdgeWorker",
          "api",
          "--file",
          requestFile.path,
          ...common,
        ],
        io,
      ),
    ).toBe(0);
    for (const action of ["get", "observe", "refresh"] as const) {
      expect(
        await main(
          [
            "resources",
            action,
            "EdgeWorker",
            "api",
            "--space",
            "space_1",
            ...common,
          ],
          io,
        ),
      ).toBe(0);
    }

    expect(
      captured.map(({ request }) => [
        request.method,
        new URL(request.url).pathname,
      ]),
    ).toEqual([
      ["POST", "/v1/resources/preview"],
      ["POST", "/v1/resources/preview"],
      ["PUT", "/v1/resources/EdgeWorker/api"],
      ["POST", "/v1/resources/EdgeWorker/api/import"],
      ["GET", "/v1/resources/EdgeWorker/api"],
      ["POST", "/v1/resources/EdgeWorker/api/observe"],
      ["POST", "/v1/resources/EdgeWorker/api/refresh"],
    ]);
    expect(captured[0]?.request.headers.get("authorization")).toBe(
      "Bearer resource-bearer",
    );
    expect(JSON.parse(captured[2]!.body)).toMatchObject({
      kind: "EdgeWorker",
      metadata: { space: "space_1" },
      review: {
        planDigest: "sha256:plan",
        quoteId: "quote_1",
        quoteDigest: "sha256:quote",
      },
    });
    expect(new URL(captured[4]!.request.url).searchParams.get("space")).toBe(
      "space_1",
    );
    expect(captured[4]!.body).toBe("");
  } finally {
    globalThis.fetch = originalFetch;
    await requestFile.cleanup();
  }
});

test("Resource Shape CLI pages Resources and events and handles an empty delete response", async () => {
  const captured: Request[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    captured.push(request);
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (new URL(request.url).pathname.endsWith("/events")) {
      return Response.json({
        events: [
          {
            id: "event_1",
            space: "space_1",
            resourceId: "tkrn:space_1:EdgeWorker:api",
            action: "resource.observe.succeeded",
            runId: "run_1",
            metadata: { phase: "Ready" },
            createdAt: "2026-07-14T00:00:00.000Z",
          },
        ],
        nextCursor: "event-cursor",
      });
    }
    return Response.json({
      resources: [
        {
          kind: "EdgeWorker",
          metadata: { name: "api" },
          status: { phase: "Ready" },
        },
      ],
      nextCursor: "resource-cursor",
    });
  }) as typeof fetch;

  const io = {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  };
  const base = ["--url", "https://takosumi.example.test"];
  try {
    expect(
      await main(
        [
          "resources",
          "list",
          "--space",
          "space_1",
          "--limit",
          "2",
          "--cursor",
          "resource cursor/+",
          ...base,
        ],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        [
          "resources",
          "events",
          "EdgeWorker",
          "api",
          "--space",
          "space_1",
          "--cursor",
          "event cursor/+",
          ...base,
        ],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        [
          "resources",
          "delete",
          "EdgeWorker",
          "api",
          "--space",
          "space_1",
          "--force",
          "--managed-by",
          "cli",
          ...base,
        ],
        io,
      ),
    ).toBe(0);

    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("EdgeWorker/api  Ready");
    expect(stdout.join("\n")).toContain("resource.observe.succeeded");
    expect(stdout.join("\n")).toContain("Resource EdgeWorker/api deleted");
    expect(new URL(captured[0]!.url).searchParams.get("cursor")).toBe(
      "resource cursor/+",
    );
    expect(new URL(captured[0]!.url).searchParams.get("limit")).toBe("2");
    expect(new URL(captured[1]!.url).searchParams.get("cursor")).toBe(
      "event cursor/+",
    );
    expect(new URL(captured[2]!.url).searchParams.get("force")).toBe("true");
    expect(new URL(captured[2]!.url).searchParams.get("managedBy")).toBe("cli");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TargetPool and SpacePolicy CLI cover every published declaration route", async () => {
  const poolFile = await jsonFile({
    space: "space_1",
    spec: { targets: [] },
  });
  const policyFile = await jsonFile({
    space: "space_1",
    spec: { allowedTargets: ["edge-main"] },
  });
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    captured.push({ request, body: await request.clone().text() });
    const path = new URL(request.url).pathname;
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/v1/target-pools") {
      return Response.json({ targetPools: [], nextCursor: undefined });
    }
    if (path === "/v1/space-policies") {
      return Response.json({ spacePolicies: [], nextCursor: undefined });
    }
    return Response.json({
      id: path.includes("space-policies") ? "policy_1" : "pool_1",
      spaceId: "space_1",
      name: "default",
      spec: {},
    });
  }) as typeof fetch;
  const io = { stdout: () => {}, stderr: () => {} };
  const base = ["--url", "https://takosumi.example.test"];

  try {
    expect(
      await main(["target-pools", "list", "--space", "space_1", ...base], io),
    ).toBe(0);
    expect(
      await main(
        ["target-pools", "get", "default", "--space", "space_1", ...base],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        ["target-pools", "put", "default", "--file", poolFile.path, ...base],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        ["target-pools", "delete", "default", "--space", "space_1", ...base],
        io,
      ),
    ).toBe(0);
    expect(
      await main(["space-policies", "list", "--space", "space_1", ...base], io),
    ).toBe(0);
    expect(
      await main(
        ["space-policies", "get", "default", "--space", "space_1", ...base],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        [
          "space-policies",
          "put",
          "default",
          "--file",
          policyFile.path,
          ...base,
        ],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        ["space-policies", "delete", "default", "--space", "space_1", ...base],
        io,
      ),
    ).toBe(0);

    expect(
      captured.map(({ request }) => [
        request.method,
        new URL(request.url).pathname,
      ]),
    ).toEqual([
      ["GET", "/v1/target-pools"],
      ["GET", "/v1/target-pools/default"],
      ["PUT", "/v1/target-pools/default"],
      ["DELETE", "/v1/target-pools/default"],
      ["GET", "/v1/space-policies"],
      ["GET", "/v1/space-policies/default"],
      ["PUT", "/v1/space-policies/default"],
      ["DELETE", "/v1/space-policies/default"],
    ]);
    expect(JSON.parse(captured[2]!.body)).toEqual({
      space: "space_1",
      spec: { targets: [] },
    });
    expect(JSON.parse(captured[6]!.body)).toEqual({
      space: "space_1",
      spec: { allowedTargets: ["edge-main"] },
    });
  } finally {
    globalThis.fetch = originalFetch;
    await poolFile.cleanup();
    await policyFile.cleanup();
  }
});

test("Resource Shape CLI rejects missing scope and malformed request files before fetch", async () => {
  const malformed = await jsonFile(["not", "an", "object"]);
  const stderr: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  const io = {
    stdout: () => {},
    stderr: (line: string) => stderr.push(line),
  };
  try {
    expect(await main(["resources", "list"], io)).toBe(2);
    expect(stderr.pop()).toBe("--space is required");
    expect(
      await main(
        [
          "resources",
          "apply",
          "EdgeWorker",
          "api",
          "--file",
          malformed.path,
          "--url",
          "https://takosumi.example.test",
        ],
        io,
      ),
    ).toBe(2);
    expect(stderr.pop()).toBe("--file must contain a JSON object");
  } finally {
    globalThis.fetch = originalFetch;
    await malformed.cleanup();
  }
});
