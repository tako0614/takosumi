import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyPlatformRequestDataAccess,
  DASHBOARD_DOCUMENT_ROUTES,
  DASHBOARD_PUBLIC_ASSET_PATHS,
  DASHBOARD_STATIC_ASSET_PREFIXES,
  isDashboardAssetRequestPath,
  isDashboardDocumentPath,
} from "../../../deploy/platform/request-data-access.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");

function request(path: string, method = "GET"): Request {
  return new Request(`https://app.example.test${path}`, { method });
}

function routingEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ASSETS: {
      fetch: async () => new Response("asset"),
    },
    ...overrides,
  };
}

describe("classifyPlatformRequestDataAccess", () => {
  test("admits only exact product discovery and presence probes", () => {
    expect(
      classifyPlatformRequestDataAccess(
        request("/.well-known/takosumi"),
        routingEnv(),
      ),
    ).toEqual({ kind: "data-free", surface: "product-discovery" });
    expect(
      classifyPlatformRequestDataAccess(
        request("/api/v1/capabilities", "HEAD"),
        routingEnv(),
      ),
    ).toEqual({ kind: "data-free", surface: "product-discovery" });
    for (const path of ["/healthz", "/healthz/", "/readyz", "/readyz/"]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({ kind: "data-free", surface: "presence-probe" });
    }
    for (const path of [
      "/.well-known/takosumi/",
      "/.well-known/takosumi/extra",
      "/api/v1/capabilities/",
      "/api/v1/capabilities/extra",
      "/livez",
    ]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({ kind: "stateful-or-unknown" });
    }
  });

  test("classifies Accounts-backed OIDC reads and the env-only provider route separately", () => {
    for (const path of [
      "/.well-known/openid-configuration",
      "/oauth/jwks",
    ]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({ kind: "stateful", targets: ["accounts"] });
    }
    expect(
      classifyPlatformRequestDataAccess(
        request("/api/v1/auth/providers"),
        routingEnv(),
      ),
    ).toEqual({ kind: "data-free", surface: "identity-discovery" });
    expect(
      classifyPlatformRequestDataAccess(
        request("/api/v1/account/session/me"),
        routingEnv(),
      ),
    ).toEqual({ kind: "stateful", targets: ["accounts"] });
    for (const path of [
      "/.well-known/openid-configuration/extra",
      "/oauth/jwks/extra",
      "/api/v1/auth/providers/extra",
      "/oauth/introspect",
      "/oauth/userinfo",
      "/api/v1/account/session/me/extra",
    ]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({ kind: "stateful-or-unknown" });
    }
  });

  test("admits exact public assets and Vite hashed assets only", () => {
    for (const path of [
      "/tako.png",
      "/favicon.ico",
      "/assets/theme-init.js",
      "/assets/index-JClLg-Vp.js",
      "/assets/index-DDkcrOWJ.css",
      "/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2",
    ]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({ kind: "data-free", surface: "dashboard-asset" });
    }
    for (const path of [
      "/assets/app.js",
      "/assets/missing-1234567.js",
      "/assets/missing-12345678.exe",
      "/assets/index-%2EClLg-Vp.js",
      "/assetsx/index-JClLg-Vp.js",
    ]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({ kind: "stateful-or-unknown" });
    }
  });

  test("admits the hosted documentation build as one static namespace", () => {
    for (const path of [
      "/docs",
      "/docs/",
      "/docs/index.html",
      "/docs/en/resources.html",
      "/docs/assets/chunks/framework.evJS25sr.js",
      "/docs/hashmap.json",
      "/docs/sitemap.xml",
    ]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({
        kind: "data-free",
        surface: "dashboard-asset",
      });
    }
    expect(DASHBOARD_STATIC_ASSET_PREFIXES).toEqual(["/docs/"]);
  });

  test("admits concrete SPA documents, never its wildcard or server routes", () => {
    for (const path of [
      "/",
      "/settings/manage",
      "/workloads/capsule_example",
      "/workloads/capsule_example/logs",
      "/advanced/workspace/members",
      "/legal/privacy",
    ]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({ kind: "data-free", surface: "dashboard-document" });
    }
    for (const path of [
      "/unknown",
      "/settings/not-a-route",
      "/oauth/authorize",
      "/oauth/anything/deep",
    ]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({ kind: "stateful-or-unknown" });
    }
  });

  test("reserved Core, Accounts, extension, compatibility, hook, metric, and operator routes win", () => {
    for (const path of [
      "/api/v1/workspaces",
      "/v1/resources",
      "/internal/v1/run-callback",
      "/compat/s3/v1/bucket",
      "/hooks/sources/source_1",
      "/metrics",
      "/capabilities",
      "/openapi.json",
      "/internal/platform/hardening-gates",
      "/__takosumi/platform/extensions",
    ]) {
      expect(
        classifyPlatformRequestDataAccess(request(path), routingEnv()),
      ).toEqual({ kind: "stateful-or-unknown" });
    }

    expect(
      classifyPlatformRequestDataAccess(
        request("/settings"),
        routingEnv({
          TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
            { basePath: "/settings", handlerKey: "settings-extension" },
          ]),
        }),
      ),
    ).toEqual({ kind: "stateful-or-unknown" });
  });

  test("account subscription extension is admitted before Accounts fallback", () => {
    const env = routingEnv({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/api/v1/account/subscription",
          handlerKey: "HOSTED",
        },
      ]),
    });
    expect(
      classifyPlatformRequestDataAccess(
        request("/api/v1/account/subscription"),
        env,
      ),
    ).toEqual({ kind: "stateful-or-unknown" });
    expect(
      classifyPlatformRequestDataAccess(
        request("/api/v1/account/subscription/resources"),
        env,
      ),
    ).toEqual({ kind: "stateful-or-unknown" });
    expect(
      classifyPlatformRequestDataAccess(
        request("/api/v1/hosted/subscription"),
        env,
      ),
    ).toEqual({ kind: "stateful-or-unknown" });
  });

  test("mutations, encoded ambiguity, malformed routing, and missing assets fail closed", () => {
    for (const input of [
      ["/", "POST"],
      ["/healthz", "POST"],
      ["/api/v1/capabilities", "OPTIONS"],
      ["/assets/index-%4AC1Lg-Vp.js", "GET"],
      ["/settings%2Fmanage", "GET"],
    ] as const) {
      expect(
        classifyPlatformRequestDataAccess(
          request(input[0], input[1]),
          routingEnv(),
        ),
      ).toEqual({ kind: "stateful-or-unknown" });
    }
    expect(
      classifyPlatformRequestDataAccess(
        request("/"),
        routingEnv({ TAKOSUMI_PLATFORM_EXTENSIONS: "{" }),
      ),
    ).toEqual({ kind: "stateful-or-unknown" });
    expect(classifyPlatformRequestDataAccess(request("/"), {})).toEqual({
      kind: "stateful-or-unknown",
    });
  });
});

describe("dashboard admission registries", () => {
  test("every concrete dashboard Route has an explicit admission decision", () => {
    const source = readFileSync(
      resolve(repositoryRoot, "dashboard/src/index.tsx"),
      "utf8",
    );
    const sourceRoutes = [
      ...source.matchAll(/<Route\s+path=["']([^"']+)["']/gu),
    ]
      .map((match) => match[1]!)
      .filter((path) => path !== "*" && !path.startsWith("/oauth"));
    expect(sourceRoutes.length).toBeGreaterThan(0);
    for (const path of sourceRoutes) {
      expect(DASHBOARD_DOCUMENT_ROUTES).toContain(path);
    }
  });

  test("all dashboard/public files are covered by exact public asset metadata", () => {
    const publicRoot = resolve(repositoryRoot, "dashboard/public");
    const files: string[] = [];
    const walk = (directory: string, relative = ""): void => {
      for (const entry of readdirSync(directory)) {
        const absolute = resolve(directory, entry);
        const child = relative ? `${relative}/${entry}` : entry;
        if (statSync(absolute).isDirectory()) walk(absolute, child);
        else files.push(`/${child}`);
      }
    };
    walk(publicRoot);
    for (const path of files) {
      expect(DASHBOARD_PUBLIC_ASSET_PATHS).toContain(path);
      expect(isDashboardAssetRequestPath(path)).toBe(true);
    }
  });

  test("registry helpers do not broaden route ownership", () => {
    expect(isDashboardDocumentPath("/workloads/workspace_1")).toBe(true);
    expect(isDashboardDocumentPath("/workloads/workspace_1/extra/tab")).toBe(
      false,
    );
    expect(isDashboardDocumentPath("/unknown")).toBe(false);
    expect(isDashboardAssetRequestPath("/assets/app.js")).toBe(false);
  });
});
