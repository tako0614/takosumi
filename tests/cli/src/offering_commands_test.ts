import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../cli/src/main.ts";

test("Offering CLI exposes the provider-neutral operator boundary", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await main(["offering-catalogs", "--help"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("\n")).toContain("Any namespaced subject");
  expect(stdout.join("\n")).toContain("no price, SKU, billing, capacity");
});

test("Offering CLI maps exact catalog and resolver operations to the operator API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-offering-cli-"));
  const catalogPath = join(directory, "catalog.json");
  const availabilityPath = join(directory, "availability.json");
  const selectionPath = join(directory, "selection.json");
  const catalog = {
    id: "public-services",
    version: "2026-07-20",
    effectiveAt: "2026-07-20T00:00:00.000Z",
    offerings: [
      {
        id: "ai-gateway",
        version: "v1",
        subject: {
          type: "services.example.test/v1/Endpoint",
          ref: "endpoint/ai-gateway",
          version: "v1",
          digest: `sha256:${"a".repeat(64)}`,
        },
        requirements: [],
        profile: "global",
        region: "global",
        maturity: "stable",
        audience: { public: true },
        status: "active",
      },
    ],
  };
  const availabilityQuery = {
    catalogId: catalog.id,
    catalogVersion: catalog.version,
  };
  const selectionQuery = {
    reference: {
      catalogId: catalog.id,
      catalogVersion: catalog.version,
      offeringId: "ai-gateway",
      offeringVersion: "v1",
    },
  };
  await writeFile(catalogPath, JSON.stringify(catalog));
  await writeFile(availabilityPath, JSON.stringify(availabilityQuery));
  await writeFile(selectionPath, JSON.stringify(selectionQuery));

  const captured: { request: Request; body: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    captured.push({ request, body: await request.clone().text() });
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/offering-availability/query") {
      return Response.json({
        availability: [
          {
            reference: selectionQuery.reference,
            subject: catalog.offerings[0]!.subject,
            profile: "global",
            region: "global",
            maturity: "stable",
            availableToPrincipal: true,
          },
        ],
      });
    }
    if (pathname === "/v1/offering-selections/resolve") {
      return Response.json({
        reference: selectionQuery.reference,
        subject: catalog.offerings[0]!.subject,
        requirements: [],
        profile: "global",
        region: "global",
        maturity: "stable",
        resolverId: "endpoint-host",
        resolutionFingerprint: `sha256:${"b".repeat(64)}`,
        resolvedAt: "2026-07-20T00:00:01.000Z",
      });
    }
    return Response.json(
      request.method === "GET" && pathname === "/v1/offering-catalogs"
        ? { catalogs: [catalog], nextCursor: "next" }
        : catalog,
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
      await main(["offering-catalogs", "list", "--limit", "1", ...common], io),
    ).toBe(0);
    expect(
      await main(
        [
          "offering-catalogs",
          "get",
          "public-services",
          "2026-07-20",
          ...common,
        ],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        ["offering-catalogs", "publish", "--file", catalogPath, ...common],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        [
          "offering-catalogs",
          "availability",
          "--file",
          availabilityPath,
          ...common,
        ],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        ["offering-catalogs", "resolve", "--file", selectionPath, ...common],
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
      ["GET", "/v1/offering-catalogs"],
      ["GET", "/v1/offering-catalogs/public-services/versions/2026-07-20"],
      ["POST", "/v1/offering-catalogs"],
      ["POST", "/v1/offering-availability/query"],
      ["POST", "/v1/offering-selections/resolve"],
    ]);
    expect(captured[0]!.request.headers.get("authorization")).toBe(
      "Bearer operator-bearer",
    );
    expect(JSON.parse(captured[2]!.body)).toEqual(catalog);
    expect(JSON.parse(captured[3]!.body)).toEqual(availabilityQuery);
    expect(JSON.parse(captured[4]!.body)).toEqual(selectionQuery);
    expect(stdout.join("\n")).toContain("services.example.test/v1/Endpoint");
    expect(stdout.join("\n")).toContain("resolver=endpoint-host");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
