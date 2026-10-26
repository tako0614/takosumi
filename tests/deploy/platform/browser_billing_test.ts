import { expect, test } from "bun:test";
import platformWorker, { type CloudflareWorkerEnv } from "../../../deploy/platform/worker.ts";
import { handlePlatformBrowserBillingRequest } from "../../../deploy/platform/browser-billing.ts";
import type { PlatformExtensionRoute } from "../../../deploy/platform/platform_extensions.ts";
import type { SharedAuthIdentity } from "../../../worker/src/shared_auth_rpc.ts";

const origin = "https://hosted.staging.example.test";
const cookie = "__Host-takosumi_hosted_session=synthetic-browser-session";
const root = "/api/v1/billing";
const start = { workspaceId: "ws_selected", operationKey: "intent_original", planKey: "prepaid_10", consent: "subscription-checkout" };
const topUp = { workspaceId: "ws_selected", operationKey: "topup_original", amountMinor: 1000, checkoutConsent: "interactive-checkout" };
const cancel = { workspaceId: "ws_selected", operationKey: "cancel_original", consent: "cancel-subscription" };
const plan = { workspaceId: "ws_selected", operationKey: "plan_original", planKey: "prepaid_50", consent: "change-subscription-plan" };
function request(path = root + "?workspaceId=ws_selected", init: RequestInit = {}) {
  return new Request(origin + path, { ...init, headers: { cookie, ...Object.fromEntries(new Headers(init.headers)) } });
}
function post(path = root + "/subscription", body: unknown = start, headers: Record<string, string> = {}) {
  return request(path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body) });
}
function fixture() {
  const seen: { auth: Request[]; dashboard: { request: Request; session: unknown }[]; generic: Request[]; selected: number } = {
    auth: [], dashboard: [], generic: [], selected: 0,
  };
  const route: PlatformExtensionRoute = { basePath: root, handlerKey: "HOSTED", authDelivery: "context", workspaceContext: "query-required", ownsPathSubtree: true,
    contributions: [{ id: "shared-billing", slot: "workspace.billing", href: root, label: "Workspace billing", presentation: "link" }] };
  const rpc = {
    fetchSharedAuth: async () => new Response(null, { status: 204 }),
    authenticateSharedAuth: async function(value: Request): Promise<SharedAuthIdentity> {
      expect(this).toBe(rpc);
      seen.auth.push(value);
      return { kind: "authenticated", accountId: "tsub_canonical" };
    },
    resolveSharedAuthWorkspace: async () => { seen.selected++; return { kind: "forbidden" as const }; },
    fetchWorkspaceDashboard: async function(value: Request, session: unknown) {
      expect(this).toBe(rpc);
      seen.dashboard.push({ request: value, session });
      return new Response("synthetic private dashboard", { headers: { "cache-control": "public", "x-test-owner-response": "retained" } });
    },
    fetchAuthenticated: async (value: Request) => { seen.generic.push(value); return new Response("ordinary extension"); },
  };
  const env = {
    TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
    TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([route]),
    HOSTED: rpc,
  };
  return { route, rpc, env, seen };
}
async function fetch(value: Request, env: ReturnType<typeof fixture>["env"]) {
  return await platformWorker.fetch(value, env as CloudflareWorkerEnv);
}

test("actual platform fetch captures RP cookie before generic stripping and sends the exact private session assertion", async () => {
  const f = fixture();
  const value = request(root + "?workspaceId=ws_outside_bounded_menu&format=json", { headers: {
    origin, "sec-fetch-site": "same-origin", accept: "application/json", "x-untrusted-extra": "strip-me",
  } });
  const result = await fetch(value, f.env);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("x-test-owner-response")).toBe("retained");
  expect(f.seen.auth).toHaveLength(1);
  expect(f.seen.dashboard).toHaveLength(1);
  expect(f.seen.selected).toBe(0); // Reading billing must not invoke chooseWorkspace's POST.
  expect(f.seen.generic).toHaveLength(0);
  const forwarded = f.seen.dashboard[0]!;
  expect(forwarded.session).toEqual({ authKind: "session", subject: "tsub_canonical" });
  expect(Object.isFrozen(forwarded.session)).toBe(true);
  expect(forwarded.request.url).toBe(value.url);
  expect(forwarded.request.method).toBe("GET");
  expect([...forwarded.request.headers.keys()].sort()).toEqual(["accept", "cookie", "origin", "sec-fetch-site"]);
  expect(forwarded.request.headers.get("cookie")).toBe(cookie);
  expect(forwarded.request.headers.get("x-untrusted-extra")).toBeNull();
  expect(value.bodyUsed).toBe(false);
});

test("exact staging billing base views generate a private auth trace, never forwarding a browser trace", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    expect((await fetch(request(), f.env)).status).toBe(200);
  }
  const traces = f.seen.auth.map((value) => value.headers.get("x-takosumi-internal-billing-trace"));
  expect(traces).toHaveLength(2);
  for (const trace of traces) expect(trace).toMatch(/^brpc_[0-9a-f]{32}$/u);
  expect(traces[0]).not.toBe(traces[1]);
  expect(f.seen.dashboard[0]!.request.headers.has("x-takosumi-internal-billing-trace")).toBe(false);
  expect((await fetch(post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected" }), f.env)).status).toBe(200);
  expect(f.seen.auth[2]!.headers.get("x-takosumi-internal-billing-trace")).toMatch(/^brpc_[0-9a-f]{32}$/u);
  expect(f.seen.dashboard[2]!.request.headers.has("x-takosumi-internal-billing-trace")).toBe(false);

  const forged = request(undefined, { headers: { "x-takosumi-internal-billing-trace": traces[0]! } });
  expect((await fetch(forged, f.env)).status).toBe(401);
  expect(f.seen.auth).toHaveLength(3);
});

test("base POST forwards only an exact selected Workspace view request with its original Cookie", async () => {
  const f = fixture();
  for (const [body, contentType] of [
    [JSON.stringify({ workspaceId: "ws_selected" }), "application/json"],
    ["workspaceId=ws_selected", "application/x-www-form-urlencoded"],
  ] as const) {
    const value = post(root + "?workspaceId=ws_selected", body, {
      "content-type": contentType, "sec-fetch-site": "same-origin",
    });
    const result = await fetch(value, f.env);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    const forwarded = f.seen.dashboard.at(-1)!;
    expect(forwarded.request.url).toBe(value.url);
    expect(forwarded.request.method).toBe("POST");
    expect(forwarded.request.headers.get("cookie")).toBe(cookie);
    expect(forwarded.request.headers.get("origin")).toBe(origin);
    expect(await forwarded.request.text()).toBe(body);
    expect(forwarded.session).toEqual({ authKind: "session", subject: "tsub_canonical" });
  }
  expect(f.seen.auth).toHaveLength(2);
  expect(f.seen.selected).toBe(0);
  expect(f.seen.generic).toHaveLength(0);
});

test("base POST rejects absent, mismatched or extra Workspace selectors before authentication", async () => {
  const f = fixture();
  const invalid = [
    post(root, { workspaceId: "ws_selected" }),
    post(root + "?workspaceId=ws_selected", { workspaceId: "ws_other" }),
    post(root + "?workspaceId=ws_selected&workspaceId=ws_selected", { workspaceId: "ws_selected" }),
    post(root + "?workspaceId=ws_selected&format=json", { workspaceId: "ws_selected" }),
    post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected", operationKey: "forged" }),
    post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected", principal: "forged" }),
    post(root + "?workspaceId=ws_selected", '{"workspaceId":"ws_selected","workspaceId":"ws_selected"}'),
    post(root + "?workspaceId=ws_selected", "workspaceId=ws_selected&workspaceId=ws_selected", {
      "content-type": "application/x-www-form-urlencoded",
    }),
    post(root + "?workspaceId=ws_selected", "workspaceId=ws_selected&consent=forged", {
      "content-type": "application/x-www-form-urlencoded",
    }),
    post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected\n" }),
    post(root + "?workspaceId=ws_selected%0A", { workspaceId: "ws_selected\n" }),
  ];
  for (const value of invalid) {
    expect((await fetch(value, f.env)).status, value.url).toBe(400);
  }
  expect((await fetch(post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected" }, {
    origin: "https://evil.example.test",
  }), f.env)).status).toBe(403);
  expect((await fetch(post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected" }, {
    authorization: "Bearer forged",
  }), f.env)).status).toBe(401);
  expect(f.seen.auth).toHaveLength(0);
  expect(f.seen.dashboard).toHaveLength(0);
  expect(f.seen.generic).toHaveLength(0);
});

test("only three published GET views and the four dedicated original-command actions dispatch", async () => {
  const f = fixture();
  const contributions = await fetch(request("/__takosumi/platform/contributions"), f.env);
  expect(contributions.status).toBe(200);
  expect((await contributions.json()).contributions).toEqual(f.route.contributions);
  for (const path of [root, root + "/subscription", root + "/top-up"]) {
    expect((await fetch(request(path + "?workspaceId=ws_selected"), f.env)).status).toBe(200);
  }
  for (const [path, body] of [["/subscription", start], ["/subscription/cancel", cancel], ["/subscription/plan", plan], ["/top-up", topUp]] as const) {
    const value = post(root + path + "?workspaceId=ws_selected", body);
    expect((await fetch(value, f.env)).status).toBe(200);
    expect(value.bodyUsed).toBe(true);
    const auth = f.seen.auth.at(-1)!;
    expect(auth.method).toBe("POST");
    expect(auth.body).toBeNull();
    const forwarded = f.seen.dashboard.at(-1)!.request;
    expect(forwarded.bodyUsed).toBe(false);
    expect(await forwarded.text()).toBe(JSON.stringify(body));
    await expect(forwarded.text()).rejects.toThrow();
  }
  expect(f.seen.selected).toBe(0);
  expect(f.seen.generic).toHaveLength(0);
  // Actual Hosted financial authority, guarded stores and Customer admission
  // are deliberately not synthesized by a successful transport fixture.
});

test("URLencoded exact cash and retained-action consent remain byte-for-byte unmodified", async () => {
  const f = fixture();
  const form = new URLSearchParams({ workspaceId: "ws_selected", operationKey: "topup_next", expectedOperationKey: "topup_original",
    amountUsd: "10.01", checkoutConsent: "interactive-checkout" }).toString();
  const result = await fetch(post(root + "/top-up?workspaceId=ws_selected", form, { "content-type": "application/x-www-form-urlencoded" }), f.env);
  expect(result.status).toBe(200);
  expect(await f.seen.dashboard[0]!.request.text()).toBe(form);
  const next = { ...start, expectedOperationKey: "intent_original_A", reconcileOriginalConsent: "check-original-subscription" };
  expect((await fetch(post(undefined, next), f.env)).status).toBe(200);
  expect(await f.seen.dashboard[1]!.request.json()).toEqual(next);
});

test("invalid public paths, methods and selectors reject before authentication or financial RPC", async () => {
  const f = fixture();
  const invalid: [Request, number][] = [
    ...["config", "transactions", "checkout", "auto-recharge", "portal"].map((path): [Request, number] =>
      [request(root + "/" + path + "?workspaceId=ws_selected"), 404]),
    [request(root + "/summary?workspaceId=ws_selected"), 404],
    [request(root + "?workspaceId=ws_selected&embed=1"), 400],
    [request(root + "/subscription/extra?workspaceId=ws_selected"), 404],
    [request(root + "/?workspaceId=ws_selected"), 404],
    [request(root + "/subscription/cancel?workspaceId=ws_selected"), 405],
    [request(undefined, { method: "HEAD" }), 405],
    [request(undefined, { method: "OPTIONS" }), 405],
    [request(undefined, { method: "DELETE" }), 405],
    [post(root), 400],
    [request(root), 400],
    [request(root + "?workspaceId=ws_selected&workspaceId=ws_other"), 400],
    [request(root + "?workspaceId=ws_selected&workspace%49d=ws_selected"), 400],
    [request(root + "?workspaceId=ws_selected&organizationId=org_chosen"), 400],
    [request(root + "?workspaceId=ws_selected&cursor=opaque"), 400],
    [request(root + "?workspaceId=ws_selected&format=html"), 400],
    [request(root + "?workspaceId=ws_selected&format=json&format=json"), 400],
    [request(root + "?workspaceId="), 400],
    [request(root + "?workspaceId=unsafe%2Fworkspace"), 400],
    [post(root + "/subscription?workspaceId=ws_other"), 400],
    [post(root + "/subscription?workspaceId=ws_selected&format=json"), 400],
    [post(root + "/subscription?workspaceId=ws_selected&workspaceId=ws_selected"), 400],
  ];
  for (const [value, expected] of invalid) {
    const result = await fetch(value, f.env);
    expect(result.status, value.method + " " + value.url).toBe(expected);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(f.seen.auth).toHaveLength(0);
  expect(f.seen.dashboard).toHaveLength(0);
  expect(f.seen.generic).toHaveLength(0);
});

test("duplicate JSON keys, escaped duplicates, unknown fields and invalid action DTOs never reach an RP", async () => {
  const f = fixture();
  const bad = [
    '{"workspaceId":"ws_selected","workspaceId":"ws_other","operationKey":"intent_original","planKey":"prepaid_10","consent":"subscription-checkout"}',
    '{"workspaceId":"ws_selected","workspace\\u0049d":"ws_selected","operationKey":"intent_original","planKey":"prepaid_10","consent":"subscription-checkout"}',
    JSON.stringify(start).replace('"intent_original"', '"intent_original","operationKey":"intent_replacement"'),
    JSON.stringify({ ...start, organizationId: "org_other" }),
    JSON.stringify({ ...start, workspaceRef: "opaque_other" }),
    JSON.stringify({ ...start, principal: "owner" }),
    JSON.stringify({ ...start, sourceEpoch: "current" }),
    JSON.stringify({ ...start, cursor: "backend-cursor" }),
    JSON.stringify({ ...start, workspaceId: "ws/unsafe" }),
    JSON.stringify({ ...start, operationKey: "unsafe key" }),
    JSON.stringify({ ...start, planKey: "unsafe/plan" }),
    JSON.stringify({ workspaceId: "ws_selected", operationKey: "intent_original", planKey: "prepaid_10" }),
    JSON.stringify({ ...start, consent: true }),
    JSON.stringify({ ...start, expectedOperationKey: "original" }),
    JSON.stringify({ ...start, reconcileOriginalConsent: "check-original-subscription" }),
    JSON.stringify({ ...start, expectedOperationKey: "original", reconcileOriginalConsent: "browser-says-terminated" }),
    JSON.stringify({ ...start, nested: { workspaceId: "ws_other" } }),
    '[{"workspaceId":"ws_selected"}]', '{}', 'null', JSON.stringify(start) + ' true',
    JSON.stringify(start).replace('"ws_selected"', '"ws_selected",'),
  ];
  for (const body of bad) expect((await fetch(post(undefined, body), f.env)).status, body).toBe(400);
  for (const body of [
    { ...topUp, amountMinor: "1000" }, { ...topUp, amountMinor: 1.5 }, { ...topUp, amountMinor: 0 },
    { ...topUp, amountMinor: Number.MAX_SAFE_INTEGER + 1 }, { ...topUp, amountUsd: "10" },
  ]) expect((await fetch(post(root + "/top-up", body), f.env)).status).toBe(400);
  for (const body of [{ ...cancel, planKey: "prepaid_10" }, { ...plan, consent: "cancel-subscription" }]) {
    expect((await fetch(post(root + ("planKey" in body && body.consent !== "cancel-subscription" ? "/subscription/plan" : "/subscription/cancel"), body), f.env)).status).toBe(400);
  }
  const form = "workspaceId=ws_selected&operationKey=topup_original&amountUsd=10&checkoutConsent=interactive-checkout";
  for (const suffix of ["&workspaceId=ws_selected", "&workspace%49d=ws_other", "&amountUsd=20", "&organizationId=org_forged"]) {
    expect((await fetch(post(root + "/top-up", form + suffix, { "content-type": "application/x-www-form-urlencoded" }), f.env)).status).toBe(400);
  }
  expect(f.seen.auth).toHaveLength(0);
  expect(f.seen.dashboard).toHaveLength(0);
});

test("Origin, fetch-site and explicit credentials/context cannot authorize billing", async () => {
  const f = fixture();
  for (const headers of [
    { origin: "https://evil.example.test" }, { origin: "" }, { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" }, { authorization: "Bearer forged" }, { "proxy-authorization": "Basic forged" },
    { "x-takosumi-platform-subject": "tsub_attacker" }, { "x-takosumi-account-session": "sess_forged" },
    { "x-takosumi-caller": "trusted-gateway" }, { "x-auth-user-service-key": "forged" },
    { "x-financial-principal": "owner" }, { "x-payer": "owner" }, { "x-source-epoch": "current" },
  ]) {
    expect([401, 403]).toContain((await fetch(post(undefined, start, headers), f.env)).status);
  }
  const noOrigin = post(); noOrigin.headers.delete("origin");
  expect((await fetch(noOrigin, f.env)).status).toBe(403);
  expect((await fetch(request(undefined, { headers: { origin: "https://evil.example.test" } }), f.env)).status).toBe(403);
  expect(f.seen.auth).toHaveLength(0);
  expect(f.seen.dashboard).toHaveLength(0);
});

test("4096-byte exact body accepted; oversized chunked or misleading Content-Length bodies are bounded and cancelled", async () => {
  const f = fixture();
  const exact = JSON.stringify(start).padEnd(4096, " ");
  expect((await fetch(post(undefined, exact), f.env)).status).toBe(200);
  expect(await f.seen.dashboard[0]!.request.text()).toBe(exact);
  for (const headers of [{}, { "content-length": "1" }]) {
    const value = post(undefined, exact + " ", headers);
    expect((await fetch(value, f.env)).status).toBe(413);
  }
  let reads = 0; let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(2048).fill(32)); },
    cancel() { cancelled = true; },
  });
  expect((await fetch(request(root + "/subscription", { method: "POST", headers: { origin, "content-type": "application/json" }, body: stream }), f.env)).status).toBe(413);
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThanOrEqual(4);
  const declared = post(undefined, start, { "content-length": "4097" });
  expect((await fetch(declared, f.env)).status).toBe(413);
  expect(declared.bodyUsed).toBe(false);
  expect(f.seen.auth).toHaveLength(1);
  expect(f.seen.dashboard).toHaveLength(1);
});

test("never-settling unauthenticated body and underlying cancel are bounded without any RPC", async () => {
  const f = fixture();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => {}); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  });
  const began = performance.now();
  const result = await fetch(request(root + "/subscription", { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: stream }), f.env);
  expect(result.status).toBe(408);
  expect(performance.now() - began).toBeGreaterThanOrEqual(4_900);
  expect(performance.now() - began).toBeLessThan(6_500);
  expect(cancelled).toBe(true);
  expect(f.seen.auth).toHaveLength(0);
  expect(f.seen.dashboard).toHaveLength(0);
}, 10_000);

test("aborting a pending body cancels its reader before any authentication or financial RPC", async () => {
  const f = fixture();
  const controller = new AbortController();
  let cancelled = false;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    pull() { entered(); return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }); // Entered means an actual reader, not eager stream prefill.
  const pending = fetch(request(root + "/subscription", { method: "POST", signal: controller.signal,
    headers: { origin, "content-type": "application/json" }, body: stream }), f.env);
  await started;
  controller.abort();
  expect((await pending).status).toBe(400);
  expect(cancelled).toBe(true);
  expect(f.seen.auth).toHaveLength(0);
  expect(f.seen.dashboard).toHaveLength(0);
});

test("already-aborted GET and buffered POST never dispatch identity or dashboard RPC", async () => {
  for (const method of ["GET", "POST"]) {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    const value = method === "GET" ? request(undefined, { signal: controller.signal }) :
      request(root + "/subscription", { method, signal: controller.signal,
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(start) });
    expect(value.signal.aborted).toBe(true);
    expect((await fetch(value, f.env)).status).toBe(400);
    expect(value.bodyUsed).toBe(false);
    expect(f.seen.auth).toHaveLength(0);
    expect(f.seen.dashboard).toHaveLength(0);
  }
});

test("abort while fully buffered body resolves cannot lose a Promise.race and authorize a request", async () => {
  const f = fixture();
  const controller = new AbortController();
  const value = request(root + "/subscription", { method: "POST", signal: controller.signal,
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify(start) });
  // Direct handler entry starts its real reader before the next microtask;
  // all bytes already exist, so no network wait is needed for the race.
  const pending = handlePlatformBrowserBillingRequest(value, f.env, f.route);
  queueMicrotask(() => controller.abort());
  expect((await pending)?.status).toBe(400);
  expect(f.seen.auth).toHaveLength(0);
  expect(f.seen.dashboard).toHaveLength(0);
});

test("GET or completed POST aborted during actual identity await cannot dispatch a dashboard", async () => {
  for (const method of ["GET", "POST"]) {
    const f = fixture();
    const controller = new AbortController();
    let release!: () => void; let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.rpc.authenticateSharedAuth = async (value) => {
      f.seen.auth.push(value); entered(); await blocked;
      return { kind: "authenticated", accountId: "tsub_canonical" };
    };
    const value = method === "GET" ? request(undefined, { signal: controller.signal }) :
      request(root + "/subscription", { method, signal: controller.signal,
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(start) });
    const pending = fetch(value, f.env);
    await started;
    expect(value.bodyUsed).toBe(method === "POST");
    controller.abort(); release();
    expect((await pending).status).toBe(400);
    expect(f.seen.auth).toHaveLength(1);
    expect(f.seen.dashboard).toHaveLength(0);
  }
});

test("missing or foreign binding/method is unavailable without falling back to ordinary extension delivery", async () => {
  for (const change of ["missing", "foreign", "wrong-origin", "missing-route", "handler-auth", "header-auth"] as const) {
    const f = fixture();
    const env: Record<string, unknown> = { ...f.env };
    if (change === "missing") delete (env.HOSTED as Record<string, unknown>).fetchWorkspaceDashboard;
    if (change === "foreign") { env.OTHER = { ...f.rpc }; env.TAKOSUMI_PLATFORM_EXTENSIONS = JSON.stringify([{ ...f.route, handlerKey: "OTHER" }]); }
    if (change === "wrong-origin") env.TAKOSUMI_SHARED_AUTH_ORIGIN = "https://other.staging.example.test";
    if (change === "missing-route") env.TAKOSUMI_PLATFORM_EXTENSIONS = "[]";
    if (change === "handler-auth") env.TAKOSUMI_PLATFORM_EXTENSIONS = JSON.stringify([{ ...f.route, authMode: "handler" }]);
    if (change === "header-auth") env.TAKOSUMI_PLATFORM_EXTENSIONS = JSON.stringify([{ ...f.route, authDelivery: "headers" }]);
    expect((await platformWorker.fetch(request(), env as CloudflareWorkerEnv)).status).toBe(change === "wrong-origin" ? 404 : 503);
    expect(f.seen.auth).toHaveLength(0);
    expect(f.seen.dashboard).toHaveLength(0);
    expect(f.seen.generic).toHaveLength(0);
  }
});

test("actual RP unauthenticated/unavailable/malformed results and missing financial receiver fail closed", async () => {
  for (const identity of [{ kind: "unauthenticated" }, { kind: "unavailable" }, { kind: "authenticated", accountId: "unsafe/account" }, { kind: "authenticated", subject: "tsub_forged" }]) {
    const f = fixture();
    f.rpc.authenticateSharedAuth = async () => identity as SharedAuthIdentity;
    expect((await fetch(request(), f.env)).status).toBe(identity.kind === "unauthenticated" ? 401 : 503);
    expect(f.seen.dashboard).toHaveLength(0);
    expect(f.seen.generic).toHaveLength(0);
  }
  const f = fixture();
  f.rpc.fetchWorkspaceDashboard = async () => new Response("", { status: 503 });
  expect((await fetch(request(), f.env)).status).toBe(503);
  f.rpc.fetchWorkspaceDashboard = async () => { throw new Error("private exception must not escape"); };
  const result = await fetch(post(), f.env);
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain("private exception");
});

test("request headers, selected URL, binding methods, route and environment stay captured across authentication awaits", async () => {
  const f = fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.rpc.authenticateSharedAuth = async (value) => {
    f.seen.auth.push(value); entered(); await waiting;
    return { kind: "authenticated", accountId: "tsub_original" };
  };
  const original = post(root + "/top-up?workspaceId=ws_selected", topUp, { accept: "application/json" });
  const pending = handlePlatformBrowserBillingRequest(original, f.env, f.route);
  await started;
  original.headers.set("cookie", "attacker-cookie"); original.headers.set("origin", "https://evil.example.test");
  original.headers.set("content-type", "text/plain");
  const old = f.rpc.fetchWorkspaceDashboard;
  f.rpc.fetchWorkspaceDashboard = async () => { throw new Error("mutated method used"); };
  f.env.HOSTED = fixture().rpc; f.env.TAKOSUMI_SHARED_AUTH_ORIGIN = "https://evil.example.test";
  Reflect.set(f.route, "handlerKey", "OTHER"); Reflect.set(f.route, "basePath", "/api/v1/other");
  release();
  expect((await pending)?.status).toBe(200);
  expect(f.seen.dashboard).toHaveLength(1);
  const captured = f.seen.dashboard[0]!;
  expect(captured.request.headers.get("cookie")).toBe(cookie);
  expect(captured.request.headers.get("origin")).toBe(origin);
  expect(captured.request.headers.get("content-type")).toBe("application/json");
  expect(captured.request.url).toBe(origin + root + "/top-up?workspaceId=ws_selected");
  expect(await captured.request.json()).toEqual(topUp);
  expect(captured.session).toEqual({ authKind: "session", subject: "tsub_original" });
  expect(old).not.toBe(f.rpc.fetchWorkspaceDashboard);
});

test("concurrent requests never share a cookie, canonical assertion or action body closure", async () => {
  const f = fixture();
  f.rpc.authenticateSharedAuth = async (value) => {
    const which = value.headers.get("cookie");
    await Promise.resolve();
    return { kind: "authenticated", accountId: which === "A" ? "tsub_A" : "tsub_B" };
  };
  const values = [post(root + "/top-up", { ...topUp, workspaceId: "ws_A" }, { cookie: "A" }),
    post(root + "/subscription", { ...start, workspaceId: "ws_B" }, { cookie: "B" })];
  const results = await Promise.all(values.map((value) => fetch(value, f.env)));
  expect(results.map((result) => result.status)).toEqual([200, 200]);
  for (const { request: value, session } of f.seen.dashboard) {
    const which = value.headers.get("cookie");
    expect(session).toEqual({ authKind: "session", subject: "tsub_" + which });
    expect((await value.json()).workspaceId).toBe("ws_" + which);
  }
});

test("profile OFF preserves ordinary configured extension and unrelated/reserved roots remain outside the bridge", async () => {
  const f = fixture();
  expect(await handlePlatformBrowserBillingRequest(post(), { HOSTED: f.rpc }, f.route)).toBeUndefined();
  const off = { HOSTED: { fetch: async (value: Request) => {
    f.seen.generic.push(value); return new Response("existing handler-owned flow");
  } }, TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([{ basePath: root, handlerKey: "HOSTED", authMode: "handler" }]) };
  expect((await platformWorker.fetch(post(), off as CloudflareWorkerEnv)).status).toBe(200);
  expect(f.seen.generic[0]!.headers.get("cookie")).toBeNull(); // Existing handler-owned delivery strips local sessions.
  expect(await f.seen.generic[0]!.json()).toEqual(start);
  for (const path of ["/api/v1/billing-other", "/v1/hosted/workspaces/billing", "/api/v1/account/subscription", "/extensions/other"]) {
    expect(await handlePlatformBrowserBillingRequest(request(path), f.env, f.route)).toBeUndefined();
  }
  expect((await fetch(request("/v1/hosted/workspaces/billing"), f.env)).status).toBe(404);
  expect((await fetch(request("/api/v1/account/shared-workspaces/bootstrap"), f.env)).status).toBe(404);
  expect(f.seen.auth).toHaveLength(0);
  expect(f.seen.dashboard).toHaveLength(0);
});

const failurePhaseMarker = "takosumi_browser_billing_failure_phase";

async function captureFailurePhase(run: () => Promise<Response>, throwOnLog = false) {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
    if (throwOnLog) throw new Error("synthetic console failure");
  };
  try {
    return { result: await run(), calls };
  } finally {
    console.error = original;
  }
}

test("billing failure phase is a closed staging-only, error-only console event", async () => {
  const cases = [
    { phase: "preflight", setup: (f: ReturnType<typeof fixture>) => {
      f.rpc.fetchWorkspaceDashboard = undefined as unknown as typeof f.rpc.fetchWorkspaceDashboard;
    } },
    { phase: "auth-unavailable", setup: (f: ReturnType<typeof fixture>) => {
      f.rpc.authenticateSharedAuth = async () => ({ kind: "unavailable" });
    } },
    { phase: "auth-unavailable", setup: (f: ReturnType<typeof fixture>) => {
      f.rpc.authenticateSharedAuth = async () => { throw new Error("sensitive issuer exception"); };
    } },
    { phase: "dispatch-nonresponse", setup: (f: ReturnType<typeof fixture>) => {
      f.rpc.fetchWorkspaceDashboard = async () => undefined as unknown as Response;
    } },
    { phase: "dispatch-rejected", setup: (f: ReturnType<typeof fixture>) => {
      f.rpc.fetchWorkspaceDashboard = async () => { throw new Error("sensitive receiver exception"); };
    } },
    { phase: "receiver-returned503", setup: (f: ReturnType<typeof fixture>) => {
      f.rpc.fetchWorkspaceDashboard = async () => new Response("sensitive receiver body", {
        status: 503, headers: { "x-test-owner-response": "retained" },
      });
    } },
  ];
  for (const { phase, setup } of cases) {
    const f = fixture();
    setup(f);
    const { result, calls } = await captureFailurePhase(() => fetch(request(), f.env));
    expect(result.status, phase).toBe(503);
    expect(result.headers.get("x-takosumi-failure-phase"), phase).toBe(phase);
    expect(result.headers.get("cache-control"), phase).toBe("private, no-store");
    if (phase === "receiver-returned503") {
      expect(result.headers.get("x-test-owner-response")).toBe("retained");
      expect(await result.text()).toBe("sensitive receiver body");
    } else {
      expect(await result.json()).toEqual({ error: "billing_unavailable" });
    }
    expect(calls, phase).toEqual([[failurePhaseMarker, phase, expect.stringMatching(/^brpc_[0-9a-f]{32}$/u)]]);
    if (f.seen.auth.length === 1) {
      expect(calls[0]![2]).toBe(f.seen.auth[0]!.headers.get("x-takosumi-internal-billing-trace"));
    }
    expect(JSON.stringify(calls)).not.toContain("sensitive");
    expect(JSON.stringify(calls)).not.toContain("tsub_canonical");
    expect(JSON.stringify(calls)).not.toContain("ws_selected");
  }

  const success = fixture();
  const good = await captureFailurePhase(() => fetch(request(), success.env));
  expect(good.result.status).toBe(200);
  expect(good.result.headers.get("x-takosumi-failure-phase")).toBeNull();
  expect(good.calls).toEqual([]);

  const forbidden = fixture();
  const blocked = await captureFailurePhase(() => fetch(post(undefined, start, { origin: "null" }), forbidden.env));
  expect(blocked.result.status).toBe(403);
  expect(blocked.result.headers.get("x-takosumi-failure-phase")).toBeNull();
  expect(blocked.calls).toEqual([]);

  const unauthenticated = fixture();
  unauthenticated.rpc.authenticateSharedAuth = async () => ({ kind: "unauthenticated" });
  const denied = await captureFailurePhase(() => fetch(request(), unauthenticated.env));
  expect(denied.result.status).toBe(401);
  expect(denied.result.headers.get("x-takosumi-failure-phase")).toBeNull();
  expect(denied.calls).toEqual([]);

  const other = fixture();
  other.env.TAKOSUMI_ENVIRONMENT = "production";
  const nonstaging = await captureFailurePhase(() => fetch(request(), other.env));
  expect(nonstaging.result.status).toBe(503);
  expect(nonstaging.result.headers.get("x-takosumi-failure-phase")).toBeNull();
  expect(nonstaging.calls).toEqual([]);
});

test("only the selected staging base view 503 owns the failure phase header, never the receiver", async () => {
  for (const [value, status, expected] of [
    [request(), 200, null],
    [request(), 401, null],
    [request(), 403, null],
    [request(root + "/subscription?workspaceId=ws_selected"), 503, null],
    [post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected" }), 503, "receiver-returned503"],
    [request(), 503, "receiver-returned503"],
  ] as const) {
    const f = fixture();
    let dispatched = 0;
    f.rpc.fetchWorkspaceDashboard = async () => {
      dispatched++;
      return new Response("receiver body", { status, headers: {
        "cache-control": "public", "x-takosumi-failure-phase": "spoofed-receiver-value",
      } });
    };
    const result = await fetch(value, f.env);
    expect(result.status).toBe(status);
    expect(result.headers.get("x-takosumi-failure-phase")).toBe(expected);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.text()).toBe("receiver body");
    expect(dispatched).toBe(1);
  }

  const child = fixture();
  child.rpc.authenticateSharedAuth = async () => ({ kind: "unavailable" });
  const childResult = await fetch(request(root + "/subscription?workspaceId=ws_selected"), child.env);
  expect(childResult.status).toBe(503);
  expect(childResult.headers.get("x-takosumi-failure-phase")).toBeNull();
  expect(await childResult.json()).toEqual({ error: "billing_unavailable" });

  const action = fixture();
  action.rpc.fetchWorkspaceDashboard = undefined as unknown as typeof action.rpc.fetchWorkspaceDashboard;
  const actionResult = await fetch(post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected" }), action.env);
  expect(actionResult.status).toBe(503);
  expect(actionResult.headers.get("x-takosumi-failure-phase")).toBe("preflight");
  expect(await actionResult.json()).toEqual({ error: "billing_unavailable" });
});

test("base view timeout remains finite, traced and single-dispatch at 120 seconds", async () => {
  for (const value of [request(), post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected" })]) {
    const f = fixture();
    let dispatched = 0;
    let release!: (value: Response) => void;
    f.rpc.fetchWorkspaceDashboard = async () => {
      dispatched++;
      return await new Promise<Response>((resolve) => { release = resolve; });
    };
    const original = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      delays.push(delay ?? 0);
      return original(handler, delay === 120_000 || delay === 40_000 ? 0 : delay, ...args);
    }) as typeof setTimeout;
    try {
      const { result, calls } = await captureFailurePhase(() => fetch(value, f.env));
      expect(result.status).toBe(503);
      expect(result.headers.get("x-takosumi-failure-phase")).toBe("dispatch-timeout");
      expect(delays).toContain(120_000);
      expect(delays).not.toContain(40_000);
      expect(calls).toEqual([[failurePhaseMarker, "dispatch-timeout", expect.stringMatching(/^brpc_[0-9a-f]{32}$/u)]]);
      expect(calls[0]![2]).toBe(f.seen.auth[0]!.headers.get("x-takosumi-internal-billing-trace"));
      release(new Response("late result"));
      await Promise.resolve();
      expect(dispatched).toBe(1);
      expect(result.status).toBe(503);
    } finally {
      globalThis.setTimeout = original;
    }
  }
});

test("base view can receive its original navigation after the old 40-second boundary", async () => {
  for (const value of [request(), post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected" })]) {
    const f = fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (value: Response) => void;
    let dispatched = 0;
    f.rpc.fetchWorkspaceDashboard = async () => {
      dispatched++;
      entered();
      return await new Promise<Response>((resolve) => { release = resolve; });
    };
    const original = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    const pending = new Map<ReturnType<typeof setTimeout>, { delay: number; fire: () => void }>();
    globalThis.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
      const handle = original(() => {}, 60_000);
      pending.set(handle, { delay, fire: () => { (handler as (...args: unknown[]) => void)(...args); } });
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle);
      originalClear(handle);
    }) as typeof clearTimeout;
    try {
      const result = fetch(value, f.env);
      await started;
      // Advance the old product deadline, without waiting or widening a test timeout.
      for (const timer of pending.values()) if (timer.delay <= 40_000) timer.fire();
      release(new Response(null, { status: 303, headers: { location: "https://console.example.test/original-view" } }));
      const response = await result;
      expect(response.status).toBe(value.method === "POST" ? 200 : 303);
      if (value.method === "POST") {
        expect(response.headers.get("location")).toBeNull();
        expect(await response.text()).toContain('href="https://console.example.test/original-view"');
      } else {
        expect(response.headers.get("location")).toBe("https://console.example.test/original-view");
      }
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(dispatched).toBe(1);
      expect(pending.size).toBe(0);
    } finally {
      for (const handle of pending.keys()) originalClear(handle);
      globalThis.setTimeout = original;
      globalThis.clearTimeout = originalClear;
    }
  }
});

test("base POST keeps strict form CSP and exposes one escaped explicit Console GET link", async () => {
  const f = fixture();
  const destination = "https://console.example.test/billing/hosted-continuations/original_view?x=1&y=%22%3C";
  let dispatched = 0;
  f.rpc.fetchWorkspaceDashboard = async () => {
    dispatched++;
    return new Response(null, { status: 303, headers: {
      location: destination, "x-takosumi-failure-phase": "forged", "x-test-owner-response": "retained",
    } });
  };
  const result = await fetch(post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected" }), f.env);
  expect(result.status).toBe(200);
  expect(result.headers.get("location")).toBeNull();
  expect(result.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  expect(result.headers.get("content-security-policy")).toContain("form-action 'self'");
  expect(result.headers.get("x-takosumi-failure-phase")).toBeNull();
  expect(result.headers.get("x-test-owner-response")).toBe("retained");
  const html = await result.text();
  expect(html).toContain('href="https://console.example.test/billing/hosted-continuations/original_view?x=1&amp;y=%22%3C"');
  expect(html).toContain("Open billing in Takoserver Console");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<form");
  expect(dispatched).toBe(1);
  expect(f.seen.auth).toHaveLength(1);
});

test("base POST refuses malformed or non-HTTPS receiver navigation without exposing it", async () => {
  for (const location of [null, "javascript:alert(1)", "http://console.example.test/view", "//console.example.test/view", "https://user:password@console.example.test/view", "https://console.example.test/view#fragment", "https://console.example.test/a b"]) {
    const f = fixture();
    let dispatched = 0;
    f.rpc.fetchWorkspaceDashboard = async () => {
      dispatched++;
      return new Response(null, { status: 303, headers: location === null ? {} : { location } });
    };
    const { result, calls } = await captureFailurePhase(() => fetch(post(root + "?workspaceId=ws_selected", { workspaceId: "ws_selected" }), f.env));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "billing_unavailable" });
    expect(result.headers.get("location")).toBeNull();
    expect(result.headers.get("x-takosumi-failure-phase")).toBe("dispatch-invalid-redirect");
    expect(calls).toEqual([[failurePhaseMarker, "dispatch-invalid-redirect", expect.stringMatching(/^brpc_[0-9a-f]{32}$/u)]]);
    expect(dispatched).toBe(1);
  }
});

test("base GET and financial POST retain the receiver's original redirect", async () => {
  for (const value of [request(), post(root + "/subscription", start)]) {
    const f = fixture();
    f.rpc.fetchWorkspaceDashboard = async () => new Response(null, { status: 303, headers: { location: "https://console.example.test/original-view" } });
    const result = await fetch(value, f.env);
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe("https://console.example.test/original-view");
    expect(result.body).toBeNull();
  }
});

test("financial leaves retain their 40-second deadline and never retry", async () => {
  for (const value of [
    request(root + "/subscription?workspaceId=ws_selected"),
    request(root + "/top-up?workspaceId=ws_selected"),
    post(root + "/subscription", start), post(root + "/subscription/cancel", cancel),
    post(root + "/subscription/plan", plan), post(root + "/top-up", topUp),
  ]) {
    const f = fixture();
    let dispatched = 0;
    f.rpc.fetchWorkspaceDashboard = async () => { dispatched++; return await new Promise<Response>(() => {}); };
    const original = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      delays.push(delay ?? 0);
      return original(handler, delay === 40_000 ? 0 : delay, ...args);
    }) as typeof setTimeout;
    try {
      const { result, calls } = await captureFailurePhase(() => fetch(value, f.env));
      expect(result.status).toBe(503);
      expect(result.headers.get("x-takosumi-failure-phase")).toBeNull();
      expect(calls).toEqual([[failurePhaseMarker, "dispatch-timeout"]]);
      expect(delays).toContain(40_000);
      expect(delays).not.toContain(120_000);
      expect(dispatched).toBe(1);
    } finally {
      globalThis.setTimeout = original;
    }
  }
});

test("billing auth deadline returns a private unavailable response and ignores a late Hosted success", async () => {
  const f = fixture();
  let releaseAuth!: (identity: SharedAuthIdentity) => void;
  let enteredAuth!: () => void;
  const authStarted = new Promise<void>((resolve) => { enteredAuth = resolve; });
  const delayedAuth = new Promise<SharedAuthIdentity>((resolve) => { releaseAuth = resolve; });
  f.rpc.authenticateSharedAuth = async (value) => {
    f.seen.auth.push(value);
    enteredAuth();
    return await delayedAuth;
  };

  const original = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    delays.push(delay ?? 0);
    return original(handler, delay === 5_000 ? 0 : delay, ...args);
  }) as typeof setTimeout;
  let result: Response;
  let calls: unknown[][];
  try {
    const captured = await captureFailurePhase(async () => {
      const pending = fetch(request(), f.env);
      await authStarted;
      return await pending;
    });
    result = captured.result;
    calls = captured.calls;
  } finally {
    globalThis.setTimeout = original;
  }

  expect(delays).toContain(5_000);
  expect(result.status).toBe(503);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("x-takosumi-failure-phase")).toBe("auth-unavailable");
  expect(await result.json()).toEqual({ error: "billing_unavailable" });
  expect(calls).toEqual([[failurePhaseMarker, "auth-unavailable", expect.stringMatching(/^brpc_[0-9a-f]{32}$/u)]]);
  expect(calls[0]![2]).toBe(f.seen.auth[0]!.headers.get("x-takosumi-internal-billing-trace"));
  expect(f.seen.auth).toHaveLength(1);
  expect(f.seen.dashboard).toHaveLength(0);
  expect(f.seen.selected).toBe(0);
  expect(f.seen.generic).toHaveLength(0);

  releaseAuth({ kind: "authenticated", accountId: "tsub_late_success" });
  await new Promise<void>((resolve) => original(resolve, 0));
  expect(f.seen.dashboard).toHaveLength(0);
  expect(f.seen.selected).toBe(0);
  expect(f.seen.generic).toHaveLength(0);
});

test("billing phase logger failure cannot alter a preflight 503 or its closed phase header", async () => {
  const f = fixture();
  f.rpc.fetchWorkspaceDashboard = undefined as unknown as typeof f.rpc.fetchWorkspaceDashboard;
  const { result, calls } = await captureFailurePhase(() => fetch(request(), f.env), true);
  expect(calls).toEqual([[failurePhaseMarker, "preflight", expect.stringMatching(/^brpc_[0-9a-f]{32}$/u)]]);
  expect(result.status).toBe(503);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("x-takosumi-failure-phase")).toBe("preflight");
  expect(await result.json()).toEqual({ error: "billing_unavailable" });
});
