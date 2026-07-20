import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../cli/src/main.ts";

test("Form Package CLI documents the sealed operator boundary", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await main(["form-packages", "--help"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("\n")).toContain("install --file");
  expect(stdout.join("\n")).toContain("host-internal deploy-control URL");
  expect(stdout.join("\n")).toContain("Do not put package bytes");
});

test("Form Package CLI sends only explicit install and retained identity requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-form-package-"));
  const installPath = join(directory, "install.json");
  const reverifyPath = join(directory, "reverify.json");
  const packageDigest = `sha256:${"a".repeat(64)}`;
  const identity = {
    formRef: {
      apiVersion: "forms.takoform.com/v1alpha1",
      kind: "ObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"b".repeat(64)}`,
    },
    packageDigest,
  };
  const install = {
    artifactRef: "r2:packages/object-bucket-v1.tgz",
    expectedPackageDigest: packageDigest,
  };
  await writeFile(installPath, JSON.stringify(install));
  await writeFile(reverifyPath, JSON.stringify(identity));

  const captured: { request: Request; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    captured.push({
      request,
      body: JSON.parse(await request.clone().text()),
    });
    return Response.json({
      verified: true,
      packageDigest,
      verifierId: "sigstore.v1",
      status: "installed",
      definitionRefs: [identity.formRef],
      installedAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      artifactRef: "r2:packages/DO-NOT-PRINT",
      trustPolicy: "DO-NOT-PRINT",
      ...(new URL(request.url).pathname.endsWith("/reverify")
        ? { identity }
        : {}),
    });
  }) as typeof fetch;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  };
  const common = [
    "--url",
    "https://service.takosumi.example.test",
    "--token",
    "operator-bearer",
  ];
  try {
    expect(
      await main(
        ["form-packages", "install", "--file", installPath, ...common],
        io,
      ),
    ).toBe(0);
    expect(
      await main(
        [
          "form-packages",
          "reverify",
          "--file",
          reverifyPath,
          "--json",
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
      ["POST", "/internal/v1/form-packages/install"],
      ["POST", "/internal/v1/form-packages/reverify"],
    ]);
    expect(captured[0]!.request.headers.get("authorization")).toBe(
      "Bearer operator-bearer",
    );
    expect(captured[0]!.body).toEqual(install);
    expect(captured[1]!.body).toEqual(identity);
    expect(stdout[0]).not.toContain(install.artifactRef);
    expect(stdout[1]).not.toContain(install.artifactRef);
    expect(stdout.join("\n")).not.toContain("DO-NOT-PRINT");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Form Package CLI rejects unsupported request fields before network I/O", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-form-package-"));
  const installPath = join(directory, "unsafe-install.json");
  await writeFile(
    installPath,
    JSON.stringify({
      artifactRef: "r2:packages/object-bucket-v1.tgz",
      expectedPackageDigest: `sha256:${"a".repeat(64)}`,
      packageBytes: "DO-NOT-SEND",
      trustPolicy: { secret: "DO-NOT-SEND" },
    }),
  );

  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("network must not be reached");
  }) as typeof fetch;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    expect(
      await main(
        [
          "form-packages",
          "install",
          "--file",
          installPath,
          "--url",
          "https://service.takosumi.example.test",
          "--token",
          "operator-bearer",
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      ),
    ).toBe(2);
    expect(fetches).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "install file must contain only a valid artifactRef and exact expectedPackageDigest",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Form Package CLI fails closed on an unverified 2xx response, including JSON mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-form-package-"));
  const installPath = join(directory, "install.json");
  await writeFile(
    installPath,
    JSON.stringify({
      artifactRef: "r2:packages/object-bucket-v1.tgz",
      expectedPackageDigest: `sha256:${"a".repeat(64)}`,
    }),
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      verified: false,
      packageDigest: `sha256:${"a".repeat(64)}`,
    })) as typeof fetch;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    expect(
      await main(
        [
          "form-packages",
          "install",
          "--file",
          installPath,
          "--url",
          "https://service.takosumi.example.test",
          "--token",
          "operator-bearer",
          "--json",
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      ),
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Takosumi returned an invalid Form Package verification",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
