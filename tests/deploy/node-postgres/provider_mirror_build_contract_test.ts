import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";

const ROOT = new URL("../../../", import.meta.url);

test("node-postgres image has no retired provider release build input", async () => {
  const [dockerfile, compose, dockerignore, dashboardPackage] =
    await Promise.all([
      readFile(new URL("deploy/node-postgres/Dockerfile", ROOT), "utf8"),
      readFile(new URL("deploy/node-postgres/docker-compose.yml", ROOT), "utf8"),
      readFile(new URL(".dockerignore", ROOT), "utf8"),
      readFile(new URL("dashboard/package.json", ROOT), "utf8").then(
        (source) =>
          JSON.parse(source) as {
            scripts: Record<string, string>;
          },
      ),
    ]);

  expect(dockerfile.startsWith("# syntax=docker/dockerfile:1.7\n")).toBe(true);
  expect(dockerfile.match(/^FROM oven\/bun:1\.3\.14(?: AS \S+)?$/gmu)).toHaveLength(
    3,
  );
  expect(dockerfile).toContain(
    "FROM node:26.1.0-bookworm-slim AS app-docs",
  );
  expect(dockerfile).not.toContain("reviewed_provider_assets");
  expect(dockerfile).not.toContain("assemble:provider-mirror");
  expect(compose).not.toContain("reviewed_provider_assets");
  expect(compose).not.toContain("TAKOSUMI_REVIEWED_PROVIDER_ASSET_ROOT");
  expect(compose.match(/build: \*node-postgres-build/gu)).toHaveLength(2);
  expect(dockerignore).toContain("**/node_modules");
  expect(dockerignore).toContain("dashboard/dist");
  expect(dashboardPackage.scripts.build).toBe("vite build");
  expect(dashboardPackage.scripts["assemble:provider-mirror"]).toBeUndefined();
});
