import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";

const ROOT = new URL("../../../", import.meta.url);

test("node-postgres image requires an offline reviewed provider context", async () => {
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
  expect(dockerfile).toContain(
    "COPY --from=reviewed_provider_assets / /reviewed-provider-assets/",
  );
  expect(dockerfile).toMatch(
    /RUN --network=none cd dashboard &&[\s\S]*bun run assemble:provider-mirror --[\s\S]*--asset-root \/reviewed-provider-assets[\s\S]*--allow-network-fetch false[\s\S]*verify-mirror/u,
  );
  expect(compose).toContain(
    "reviewed_provider_assets: \"${TAKOSUMI_REVIEWED_PROVIDER_ASSET_ROOT:?",
  );
  expect(compose.match(/build: \*node-postgres-build/gu)).toHaveLength(2);
  expect(dockerignore).toContain("**/node_modules");
  expect(dockerignore).toContain("dashboard/dist");
  expect(dockerignore).toContain("dashboard/public/opentofu/providers");
  expect(dashboardPackage.scripts.build).toBe("vite build");
  expect(dashboardPackage.scripts["assemble:provider-mirror"]).toBe(
    "bun ../scripts/provider-release.mjs materialize --output dist/opentofu/providers",
  );
});
