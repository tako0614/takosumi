import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStaticAssetResponder,
  resolveStaticAssetsDir,
} from "../../../../deploy/node-postgres/src/static-assets.ts";

async function buildFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-static-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>spa</title>");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "app.js"), "console.log('app')");
  return dir;
}

function get(path: string): Request {
  return new Request(`https://app.takosumi.test${path}`);
}

describe("createStaticAssetResponder", () => {
  test("serves index.html for root and extensionless deep links (SPA)", async () => {
    const dir = await buildFixture();
    try {
      const serve = createStaticAssetResponder(dir);
      for (const path of ["/", "/apps", "/services/capsule_example"]) {
        const res = await serve(get(path));
        expect(res?.status).toBe(200);
        expect(res?.headers.get("content-type")).toContain("text/html");
        expect(await res?.text()).toContain("spa");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serves a real static asset with its content type", async () => {
    const dir = await buildFixture();
    try {
      const serve = createStaticAssetResponder(dir);
      const res = await serve(get("/assets/app.js"));
      expect(res?.status).toBe(200);
      expect(res?.headers.get("content-type")).toContain("javascript");
      expect(await res?.text()).toContain("console.log");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("404s a missing file-like path instead of masking it with the SPA", async () => {
    const dir = await buildFixture();
    try {
      const serve = createStaticAssetResponder(dir);
      const res = await serve(get("/assets/missing.js"));
      expect(res?.status).toBe(404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The critical-risk guard: every API namespace the accounts/service handler
  // owns must fall through (undefined) so the SPA fallback never shadows it.
  test("falls through for every API namespace", async () => {
    const dir = await buildFixture();
    try {
      const serve = createStaticAssetResponder(dir);
      const apiPaths = [
        "/v1/account/session/me",
        "/v1/privacy/requests",
        "/v1/auth/upstream/callback",
        "/oauth/authorize",
        "/.well-known/openid-configuration",
        "/internal/v1/run-callback",
      ];
      for (const path of apiPaths) {
        expect(await serve(get(path))).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls through for non-GET/HEAD requests", async () => {
    const dir = await buildFixture();
    try {
      const serve = createStaticAssetResponder(dir);
      const res = await serve(
        new Request(`https://app.takosumi.test/`, { method: "POST" }),
      );
      expect(res).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses path traversal without escaping the assets dir", async () => {
    const dir = await buildFixture();
    try {
      const serve = createStaticAssetResponder(dir);
      // Encoded `..` segments decode to traversal; the responder must not read
      // outside `dir`. It safely falls back to the SPA index.
      const res = await serve(get("/..%2f..%2fetc%2fpasswd"));
      expect(res?.status).toBe(200);
      expect(await res?.text()).toContain("spa");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveStaticAssetsDir", () => {
  test("returns the override dir when it has an index.html", async () => {
    const dir = await buildFixture();
    try {
      const resolved = await resolveStaticAssetsDir({
        TAKOSUMI_ACCOUNTS_STATIC_DIR: dir,
      });
      expect(resolved).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined when the override dir has no SPA build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "takosumi-static-empty-"));
    try {
      const resolved = await resolveStaticAssetsDir({
        TAKOSUMI_ACCOUNTS_STATIC_DIR: dir,
      });
      expect(resolved).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
