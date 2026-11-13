import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("native login gateway consumes actual local RateLimit bindings and refuses their absence", async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/shared-auth-gateway-runtime.ts")],
    target: "browser", format: "esm", external: ["cloudflare:workers"],
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  const artifact = build.outputs[0];
  if (!artifact) throw new Error("shared login gateway bundle missing");
  for (const configured of [false, true]) {
    const runtime = new Miniflare({ workers: [
      { name: "gateway", compatibilityDate: "2026-07-17", compatibilityFlags: ["nodejs_compat"],
        modules: [{ type: "ESModule", path: "gateway.mjs", contents: await artifact.text() }],
        bindings: { TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account", TAKOSUMI_SHARED_AUTH_ORIGIN: "https://hosted.staging.example.test", TAKOSUMI_ENVIRONMENT: "staging" },
        serviceBindings: { HOSTED: { name: "rp", entrypoint: "Authentication" } },
        ratelimits: configured ? {
          HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER: { namespace_id: "1001", simple: { limit: 100, period: 60 } },
          HOSTED_OIDC_LOGIN_IP_RATE_LIMITER: { namespace_id: "1002", simple: { limit: 100, period: 60 } },
        } : undefined,
      },
      { name: "rp", compatibilityDate: "2026-07-17",
        modules: [{ type: "ESModule", path: "rp.mjs", contents: await readFile(resolve(import.meta.dir, "fixtures/shared-auth-rpc-runtime.mjs"), "utf8") }],
        durableObjects: { SESSIONS: "Sessions" },
      },
    ] });
    try {
      const gateway = await runtime.getWorker("gateway");
      const response = await gateway.fetch("https://hosted.staging.example.test/auth/oidc/login", { redirect: "manual" });
      expect(response.status).toBe(configured ? 200 : 503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      // RP identity is deliberately synthetic. Its response is not a real OIDC
      // login; this only exercises the real local binding transport/shape.
      if (configured) expect(await response.json()).toEqual({ kind: "unauthenticated" });
    } finally {
      await runtime.dispose();
    }
  }
}, 60_000);
