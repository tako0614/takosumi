import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../cli/src/main.ts";

test("FormActivation CLI exposes operator lifecycle help", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await main(["form-activations", "--help"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("\n")).toContain("create --file");
  expect(stdout.join("\n")).toContain(
    "no price, SKU, billing, capacity, or SLA",
  );
});

test("FormActivation CLI maps list/get/create/update to the operator API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-form-activation-"));
  const createPath = join(directory, "create.json");
  const updatePath = join(directory, "update.json");
  const identity = {
    formRef: {
      apiVersion: "takoform.dev/v1alpha1",
      kind: "ObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    packageDigest: `sha256:${"b".repeat(64)}`,
  };
  await writeFile(
    createPath,
    JSON.stringify({
      id: "activation_bucket",
      identity,
      scope: { type: "operator" },
    }),
  );
  await writeFile(
    updatePath,
    JSON.stringify({ expectedRevision: 1, status: "active" }),
  );

  const captured: { request: Request; body: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    captured.push({ request, body: await request.clone().text() });
    const activation = {
      id: "activation_bucket",
      identity,
      scope: { type: "operator" },
      audience: {},
      policy: {},
      eligibleTargetPoolClasses: [],
      status: request.method === "PATCH" ? "active" : "inactive",
      revision: request.method === "PATCH" ? 2 : 1,
      createdAt: "2026-07-16T00:00:00.000Z",
      createdBy: "operator",
      updatedAt: "2026-07-16T00:00:00.000Z",
      updatedBy: "operator",
    };
    return Response.json(
      request.method === "GET" &&
        new URL(request.url).pathname === "/v1/form-activations"
        ? { activations: [activation], nextCursor: "next" }
        : activation,
      { status: request.method === "POST" ? 201 : 200 },
    );
  }) as typeof fetch;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  };
  const common = [
    "--url",
    "https://takosumi.example.test",
    "--token",
    "operator-bearer",
  ];
  try {
    expect(
      await main(["form-activations", "list", "--limit", "1", ...common], io),
    ).toBe(0);
    expect(
      await main(
        ["form-activations", "get", "activation_bucket", ...common],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        ["form-activations", "create", "--file", createPath, ...common],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        [
          "form-activations",
          "update",
          "activation_bucket",
          "--file",
          updatePath,
          ...common,
        ],
        io,
      ),
    ).toBe(0);

    expect(stderr).toEqual([]);
    expect(
      captured.map(({ request }) => [
        request.method,
        new URL(request.url).pathname,
      ]),
    ).toEqual([
      ["GET", "/v1/form-activations"],
      ["GET", "/v1/form-activations/activation_bucket"],
      ["POST", "/v1/form-activations"],
      ["PATCH", "/v1/form-activations/activation_bucket"],
    ]);
    expect(new URL(captured[0]!.request.url).searchParams.get("limit")).toBe(
      "1",
    );
    expect(captured[0]!.request.headers.get("authorization")).toBe(
      "Bearer operator-bearer",
    );
    expect(JSON.parse(captured[2]!.body)).toMatchObject({
      id: "activation_bucket",
      identity,
    });
    expect(JSON.parse(captured[3]!.body)).toEqual({
      expectedRevision: 1,
      status: "active",
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
