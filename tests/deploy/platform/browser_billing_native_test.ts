import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";

const origin = "https://hosted.staging.example.test";
const root = "/api/v1/billing";
test("native actual platform fetch crosses the narrow Worker RPC with one bounded original body and canonical assertion", async () => {
  const bundle = async (file: string) => {
    // An isolated in-process build reported an unresolved existing module.
    // Build in a cold child; its bytes match independent Bun.build inventory.
    const child = Bun.spawn([process.execPath, "build", "--target", "browser", "--format", "esm",
      "--external", "cloudflare:workers", resolve(import.meta.dir, "fixtures", file)], {
      cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [exit, source, errors] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exit, errors).toBe(0);
      expect(source.length).toBeGreaterThan(0);
      return source;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  };
  const gatewaySource = await bundle("browser-billing-gateway-runtime.ts");
  const receiverSource = await bundle("browser-billing-rpc-runtime.ts");
  const createRuntime = () => new Miniflare({ workers: [
    { name: "gateway", compatibilityDate: "2026-07-17", compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "browser-billing-gateway.mjs", contents: gatewaySource }],
      bindings: { TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account", TAKOSUMI_SHARED_AUTH_ORIGIN: origin, TAKOSUMI_ENVIRONMENT: "staging",
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([{ basePath: root, handlerKey: "HOSTED", authDelivery: "context", workspaceContext: "query-required", ownsPathSubtree: true,
          contributions: [{ id: "shared-billing", slot: "workspace.billing", href: root, label: "Workspace billing", presentation: "link" }] }]) },
      serviceBindings: { HOSTED: { name: "receiver", entrypoint: "BrowserBillingReceiver" } },
    },
    { name: "receiver", compatibilityDate: "2026-07-17", compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "browser-billing-receiver.mjs", contents: receiverSource }] },
  ] });
  const runtime = createRuntime();
  try {
    const gateway = await runtime.getWorker("gateway");
    const receiver = await runtime.getWorker("receiver");
    const call = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has("cookie")) headers.set("cookie", "__Host-takosumi_hosted_session=native_A");
      const originalOrigin = headers.get("origin");
      if (originalOrigin !== null) {
        headers.delete("origin"); headers.set("x-fixture-original-origin", originalOrigin);
      }
      return gateway.fetch(origin + path, { ...init, headers, redirect: "manual" });
    };
    const first = await call(root + "?workspaceId=ws_not_in_menu&format=json", {
      headers: { accept: "application/json", "sec-fetch-site": "same-origin", "x-untrusted-extra": "strip" },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.json()).toEqual({ syntheticTransportProof: true,
      session: { authKind: "session", subject: "tsub_A" },
      url: origin + root + "?workspaceId=ws_not_in_menu&format=json", method: "GET", cookieSeen: true,
      headerNames: ["accept", "cookie", "sec-fetch-site"], body: "" });
    const form = "workspaceId=ws_A&operationKey=topup_original&amountUsd=10.01&checkoutConsent=interactive-checkout";
    const purchase = await call(root + "/top-up?workspaceId=ws_A", { method: "POST", body: form,
      headers: { origin, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" } });
    expect(purchase.status).toBe(200);
    expect(await purchase.json()).toEqual({ syntheticTransportProof: true,
      session: { authKind: "session", subject: "tsub_A" }, url: origin + root + "/top-up?workspaceId=ws_A", method: "POST", cookieSeen: true,
      headerNames: ["accept", "content-type", "cookie", "origin", "sec-fetch-site"], body: form });
    // The explicit link descriptor uses the actual published 3 GET / 4 POST
    // transport contract. Synthetic receiver success is not financial admission.
    for (const path of [root, root + "/subscription", root + "/top-up"]) {
      const response = await call(path + "?workspaceId=ws_A");
      expect(response.status).toBe(200);
      expect((await response.json()).url).toBe(origin + path + "?workspaceId=ws_A");
    }
    for (const [path, action] of [
      ["/subscription", { operationKey: "start_original", planKey: "prepaid_10", consent: "subscription-checkout" }],
      ["/subscription/cancel", { operationKey: "cancel_original", consent: "cancel-subscription" }],
      ["/subscription/plan", { operationKey: "plan_original", planKey: "prepaid_50", consent: "change-subscription-plan" }],
      ["/top-up", { operationKey: "topup_original", amountMinor: 1000, checkoutConsent: "interactive-checkout" }],
    ] as const) {
      const body = JSON.stringify({ workspaceId: "ws_A", ...action });
      const response = await call(root + path + "?workspaceId=ws_A", { method: "POST", body,
        headers: { origin, "content-type": "application/json" } });
      expect(response.status).toBe(200);
      expect((await response.json()).body).toBe(body);
    }
    for (const path of ["config", "summary", "transactions", "checkout", "auto-recharge", "portal"]) {
      expect((await call(root + "/" + path + "?workspaceId=ws_A")).status).toBe(404);
    }
    expect((await call(root + "?workspaceId=ws_A&embed=1")).status).toBe(400);
    const concurrent = await Promise.all(["A", "B"].map(async (which) => {
      const result = await call(root + "/subscription?workspaceId=ws_" + which,
        { headers: { cookie: "__Host-takosumi_hosted_session=native_" + which } });
      expect(result.status).toBe(200);
      return await result.json();
    }));
    expect(concurrent.map((value) => value.session.subject)).toEqual(["tsub_A", "tsub_B"]);
    expect(concurrent.map((value) => value.url)).toEqual([origin + root + "/subscription?workspaceId=ws_A", origin + root + "/subscription?workspaceId=ws_B"]);
    expect((await call(root + "?workspaceId=ws_A", { headers: { cookie: "__Host-takosumi_hosted_session=forged" } })).status).toBe(401);
    expect((await call(root + "?workspaceId=ws_A", { headers: { cookie: "__Host-takosumi_hosted_session=revoked_at_receiver" } })).status).toBe(401);
    expect((await call(root + "?workspaceId=ws_A", { headers: { "x-takosumi-platform-subject": "tsub_forged" } })).status).toBe(401);
    expect((await call(root + "/top-up?workspaceId=ws_B", { method: "POST", body: form,
      headers: { origin, "content-type": "application/x-www-form-urlencoded" } })).status).toBe(400);
    expect((await call(root + "/top-up?workspaceId=ws_A", { method: "POST", body: form + "&workspaceId=ws_A",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" } })).status).toBe(400);
    expect((await call(root + "/top-up?workspaceId=ws_A", { method: "POST", body: form,
      headers: { origin: "https://evil.example.test", "content-type": "application/x-www-form-urlencoded" } })).status).toBe(403);
    // Fresh local HTTP uses the SAME emitted bundles and a separate owned port.
    // The mixed Node getWorker/RPC driver reset on this case, while an isolated
    // HTTP probe passed. Keep that harness state separate; do not reconstruct
    // a synthetic body inside workerd or change the production cancellation.
    const httpRuntime = createRuntime();
    try {
      const ready = await httpRuntime.ready;
      expect(ready.hostname).toBe("127.0.0.1");
      const oversized = await fetch(new URL(root + "/top-up?workspaceId=ws_A", ready), { method: "POST",
        headers: { origin, cookie: "__Host-takosumi_hosted_session=native_A", "content-type": "application/json" },
        body: new ReadableStream({ type: "bytes", start(controller) {
          controller.enqueue(new Uint8Array(4097).fill(32)); controller.close();
        } }), duplex: "half", signal: AbortSignal.timeout(8_000) });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({ error: "billing_body_too_large" });
      expect(oversized.headers.get("x-fixture-incoming-content-length")).toBe("null");
      expect(oversized.headers.get("x-fixture-incoming-transfer-encoding")).toBe("chunked");
    } finally {
      await httpRuntime.dispose();
    }
    expect((await call("/v1/hosted/workspaces/billing?workspaceId=ws_A")).status).toBe(404);
    expect((await call("/api/v1/account/shared-workspaces/bootstrap")).status).toBe(404);
    // The RP's actual public fetch cannot dispatch the private dashboard method.
    expect((await receiver.fetch(origin + root + "?workspaceId=ws_A")).status).toBe(404);
  } finally {
    await runtime.dispose();
  }
}, 60_000);
