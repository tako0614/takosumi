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
