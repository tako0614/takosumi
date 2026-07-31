import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResourceMigrationRequest,
  parseResourceMigrationManifest,
  resourceMigrationEndpoint,
  submitResourceMigration,
  type ResourceMigrationAction,
} from "../../scripts/operator-release-activator-migrations.ts";

const SQL = "CREATE TABLE actors (id TEXT PRIMARY KEY);\n";
const SQL_DIGEST = `sha256:${createHash("sha256").update(SQL).digest("hex")}`;

function manifestText(): string {
  return JSON.stringify({
    apiVersion: "takosumi.resource-migrations/v1",
    engine: "sqlite",
    source: {
      kind: "npm",
      package: "@takosjp/example",
      version: "1.0.0",
      path: "migrations",
    },
    entries: [{ name: "0001_init.sql", sha256: SQL_DIGEST, sizeBytes: SQL.length }],
  });
}

async function bundleRoot(
  manifest: string,
  path = "deploy/takoform/migrations/manifest.json",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "migration-bundle-"));
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, manifest);
  return root;
}

function action(digest: string): ResourceMigrationAction {
  return {
    kind: "resource_migration",
    id: "example-schema",
    target: { resourceAddress: "takoform_relational_database.database" },
    bundle: {
      format: "takosumi.resource-migrations/v1",
      manifestPath: "deploy/takoform/migrations/manifest.json",
      digest,
    },
  };
}

function digestOf(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("operator resource migration bundles", () => {
  it("carries the manifest verbatim and one body per named entry", async () => {
    const manifest = manifestText();
    const sourceRoot = await bundleRoot(manifest);

    const request = await buildResourceMigrationRequest({
      action: action(digestOf(manifest)),
      sourceRoot,
      readPackageFile: async () => SQL,
    });

    expect(request.actionId).toBe("example-schema");
    // Byte identity, not a re-serialization: the pin is over these exact bytes.
    expect(request.manifest).toBe(manifest);
    expect(request.entries).toEqual([{ name: "0001_init.sql", sql: SQL }]);
  });

  it("refuses a manifest that does not match the Plan-pinned digest", async () => {
    const sourceRoot = await bundleRoot(manifestText());

    await expect(
      buildResourceMigrationRequest({
        action: action(`sha256:${"0".repeat(64)}`),
        sourceRoot,
        readPackageFile: async () => SQL,
      }),
    ).rejects.toThrow(/does not match the Plan-pinned digest/u);
  });

  it("refuses a manifest path that escapes the source snapshot", async () => {
    const manifest = manifestText();
    const sourceRoot = await bundleRoot(manifest);
    const escaping = {
      ...action(digestOf(manifest)),
      bundle: {
        ...action(digestOf(manifest)).bundle,
        manifestPath: "../outside/manifest.json",
      },
    };

    await expect(
      buildResourceMigrationRequest({
        action: escaping,
        sourceRoot,
        readPackageFile: async () => SQL,
      }),
    ).rejects.toThrow(/escapes the source snapshot/u);
  });

  it("rejects a bundle source kind it cannot fetch", () => {
    expect(() =>
      parseResourceMigrationManifest(
        JSON.stringify({
          apiVersion: "takosumi.resource-migrations/v1",
          source: { kind: "git", package: "x", version: "1", path: "m" },
          entries: [{ name: "0001.sql" }],
        }),
      ),
    ).toThrow(/source git is unsupported/u);
  });

  it("submits to the Capsule's internal migration route", async () => {
    const seen: { url?: string; body?: unknown; auth?: string } = {};
    const result = await submitResourceMigration({
      apiBase: "https://api.example.test",
      token: "operator-token",
      capsuleId: "cap_abc",
      request: { actionId: "a", manifest: "{}", entries: [] },
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.url = String(url);
        seen.auth = new Headers(init.headers).get("authorization") ?? undefined;
        seen.body = JSON.parse(String(init.body));
        return Response.json({ applied: ["0001.sql"], skipped: [] });
      }) as unknown as typeof fetch,
    });

    expect(seen.url).toBe(
      resourceMigrationEndpoint("https://api.example.test", "cap_abc"),
    );
    expect(seen.url).toContain("/internal/v1/capsules/cap_abc/resource-migrations");
    expect(seen.auth).toBe("Bearer operator-token");
    expect(result.applied).toEqual(["0001.sql"]);
  });

  it("fails loudly when the server rejects the migration", async () => {
    await expect(
      submitResourceMigration({
        apiBase: "https://api.example.test",
        token: "operator-token",
        capsuleId: "cap_abc",
        request: { actionId: "a", manifest: "{}", entries: [] },
        fetchImpl: (async () =>
          Response.json(
            { message: "entry does not match its pinned digest" },
            { status: 412 },
          )) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/failed with 412: entry does not match its pinned digest/u);
  });
});
