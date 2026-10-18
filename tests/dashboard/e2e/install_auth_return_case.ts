import { expect, test, type BrowserContext, type Request, type Response } from "@playwright/test";
import type { DashboardE2EMode } from "./traffic-policy.ts";
import { resolvePortableOrigin } from "./portable-origin.ts";
import { parseInstallPrefill } from "../../../dashboard/src/lib/install-link.ts";

/** The existing built SPA must reach the server-owned login route as a document. */
export function registerInstallAuthReturnCase(mode: DashboardE2EMode): void {
  test("installed app sign-in reaches the server with its complete local return", async ({ page, context }) => {
    test.skip(mode !== "portable", "This test supplies only local portable authentication responses.");
    const origin = resolvePortableOrigin();
    const query = "git=https%3A%2F%2Fgit.example.test%2Facme%2Fnotes.git&ref=v1&product=notes-app&return_uri=notesapp%3A%2F%2Fconnect";
    const destination = `/new?${query}`;
    const signInUrl = `${origin}/sign-in?return=${encodeURIComponent(destination)}`;
    const navigations: string[] = [];
    const writes: string[] = [];
    await context.clearCookies();
    await page.route("**/api/v1/dashboard/bootstrap**", (route) => route.fulfill({
      status: 401, contentType: "application/json", body: '{"error":"unauthenticated"}',
    }));
    await page.route("**/api/v1/account/session/me", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: '{"session":null}',
    }));
    // A response at this boundary proves a real document request. SPA URL-bar
    // changes cannot invoke this route or load the terminal document below.
    await page.route("**/sign-in?**", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: "<!doctype html><title>Login boundary reached</title>",
    }));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && url.pathname === "/sign-in") {
        navigations.push(request.url());
      }
      if (url.pathname.startsWith("/api/v1/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        writes.push(`${request.method()} ${url.pathname}`);
      }
    });
    await page.goto(`/install?${query}`, { waitUntil: "commit" });
    await expect.poll(() => navigations.length, {
      timeout: 5_000, message: "sign-in must be one main-frame document request, not a SPA URL change",
    }).toBe(1);
    expect(navigations).toEqual([signInUrl]);
    await expect(page).toHaveTitle("Login boundary reached");
    expect(page.url()).toBe(signInUrl);
    expect(writes, "login must not install an app or issue a payment").toEqual([]);
  });
  if (mode === "portable") registerInstallReturnInputCases();
  if (mode === "live") registerLiveInstallReturnCase();
}

// This is the published shared-account profile, not a configurable issuer router.
const sharedAppOrigin = "https://app-staging.takosumi.com";
const sharedIssuerOrigin = "https://auth-staging.takos.jp";
const sharedClientId = "takosumi-hosted-staging-v1";
const issuerSessionCookie = "__Host-takosumi_session";
const rpSessionCookie = "__Host-takosumi_hosted_session";
const rpAttemptCookie = "__Host-takosumi_oidc_attempt";
const versionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
type BrowserState = Awaited<ReturnType<BrowserContext["storageState"]>>;

function requireInput(value: string | undefined, label: string): string {
  if (!value || value !== value.trim()) throw new Error("live install return input missing or invalid: " + label);
  return value;
}

function parsedUrl(value: string): URL {
  try { return new URL(value); } catch { throw new Error("malformed install-return URL"); }
}

function exactKeys(params: URLSearchParams, allowed: readonly string[]): boolean {
  return [...params.keys()].every((key) => allowed.includes(key) && params.getAll(key).length === 1);
}

function liveInstallInputs(env: Readonly<Record<string, string | undefined>>) {
  const base = requireInput(env.TAKOSUMI_E2E_BASE_URL, "base URL");
  const issuer = requireInput(env.TAKOSUMI_E2E_SHARED_AUTH_ISSUER_ORIGIN, "issuer origin");
  if (![sharedAppOrigin, sharedAppOrigin + "/"].includes(base) || issuer !== sharedIssuerOrigin) {
    throw new Error("live install return requires the distinct published staging origins");
  }
  const workerVersion = requireInput(env.TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID, "Worker Version");
  const issuerVersion = requireInput(env.TAKOSUMI_E2E_EXPECTED_ISSUER_VERSION_ID, "issuer Version");
  if (!versionId.test(workerVersion) || !versionId.test(issuerVersion)) throw new Error("live install return Version must be a lowercase UUID");
  const account = requireInput(env.TAKOSUMI_E2E_EXPECTED_ACCOUNT_ID, "canonical account");
  const workspace = requireInput(env.TAKOSUMI_E2E_WORKSPACE_NAME, "Workspace name");
  if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(account) || workspace.length > 256) throw new Error("live install return identity input invalid");
  const query = requireInput(env.TAKOSUMI_E2E_INSTALL_RETURN_QUERY, "install query");
  if (/[\u0000-\u0020\u007f#?]/u.test(query) || new TextEncoder().encode("/new?" + query).length > 4096) {
    throw new Error("live install return query invalid");
  }
  const params = new URLSearchParams(query);
  if ([...params.values()].some((value) => /[\u0000-\u001f\u007f]/u.test(value)) ||
    !exactKeys(params, ["git", "ref", "sourcePath", "path", "name", "product", "return_uri"]) ||
    ["git", "ref", "name", "product", "return_uri"].some((key) => !params.get(key))) {
    throw new Error("live install return requires explicit prefill and app context only");
  }
  // Reuse the actual prefill boundary: no Git query/credentials, bounded and
  // trimmed ref/name, canonical directories, and the owning app-handoff parser.
  const prefill = parseInstallPrefill("?" + query);
  if (!prefill?.name) throw new Error("live install return source or nested app context invalid");
  return Object.freeze({
    app: sharedAppOrigin, issuer, workerVersion, issuerVersion, account, workspace,
    installPath: "/install?" + query, returnPath: "/new?" + query,
    name: prefill.name, git: prefill.git, ref: prefill.ref,
    sourcePath: prefill.sourcePath, modulePath: prefill.path || ".",
  });
}
type LiveInstallInputs = ReturnType<typeof liveInstallInputs>;

function issuerOnlyState(state: BrowserState, input: LiveInstallInputs, nowSeconds: number): BrowserState {
  const host = new URL(input.issuer).hostname;
  const candidates = state.cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./u, "");
    return cookie.name === issuerSessionCookie && (domain === host || (cookie.domain.startsWith(".") && host.endsWith("." + domain)));
  });
  if (candidates.length !== 1) throw new Error("live install return requires one unambiguous existing issuer session");
  const cookie = candidates[0];
  if (cookie.domain !== host || cookie.path !== "/" || !cookie.secure || !cookie.httpOnly ||
    cookie.sameSite !== "Lax" || !cookie.value || cookie.value.length > 4096 || !Number.isFinite(cookie.expires) ||
    cookie.expires <= nowSeconds + 45 || ("partitionKey" in cookie && cookie.partitionKey !== undefined)) {
    throw new Error("live install return issuer session unavailable");
  }
  // Copy a legitimate saved cookie without creating or changing its value.
  // Neither an issuer cookie nor its name proves a current server-side session.
  return { cookies: [{ ...cookie }], origins: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knownAppRead(url: URL): boolean {
  const p = url.searchParams;
  if (["/.well-known/takosumi", "/api/v1/capabilities", "/__takosumi/platform/contributions", "/api/v1/account/session/me"].includes(url.pathname)) return url.search === "";
  if (url.pathname === "/api/v1/dashboard/bootstrap") {
    return exactKeys(p, ["includeWorkspaces", "workspaceLimit", "workspaceId", "includeNotifications"]) &&
      ["true", "false"].includes(p.get("includeWorkspaces") ?? "") &&
      (p.get("workspaceLimit") === null || p.get("workspaceLimit") === "50") &&
      (p.get("includeNotifications") === null || p.get("includeNotifications") === "true") &&
      (p.get("workspaceId") === null || /^[A-Za-z0-9_.:-]{1,128}$/u.test(p.get("workspaceId")!));
  }
  if (url.pathname === "/api/v1/workspaces") {
    return exactKeys(p, ["limit", "order", "cursor", "selectedWorkspaceId", "includeTotal", "includeArchived"]) &&
      p.get("limit") === "50" && [null, "created_asc", "updated_desc"].includes(p.get("order")) &&
      ["includeTotal", "includeArchived"].every((key) => [null, "true", "false"].includes(p.get(key))) &&
      (p.get("cursor")?.length ?? 0) <= 2048 && (p.get("selectedWorkspaceId") === null || /^[A-Za-z0-9_.:-]{1,128}$/u.test(p.get("selectedWorkspaceId")!));
  }
  return /^\/api\/v1\/workspaces\/[A-Za-z0-9_.:-]{1,128}\/activity$/u.test(url.pathname) &&
    exactKeys(p, ["limit"]) && p.get("limit") === "50";
}

function assertAuthorization(url: URL, input: LiveInstallInputs): void {
  const p = url.searchParams;
  if (url.origin !== input.issuer || url.pathname !== "/oauth/authorize" || url.hash ||
    !exactKeys(p, ["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method", "prompt"]) ||
    p.get("client_id") !== sharedClientId || p.get("redirect_uri") !== input.app + "/auth/oidc/callback" ||
    p.get("response_type") !== "code" || p.get("scope") !== "openid email offline_access" ||
    p.get("prompt") !== "consent" || p.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(p.get("code_challenge") ?? "") ||
    ["state", "nonce"].some((key) => !p.get(key) || p.get(key)!.length > 512)) {
    throw new Error("unexpected issuer authorization request");
  }
}

type TransportRequest = {
  readonly url: string; readonly method: string; readonly resourceType: string;
  readonly mainNavigation: boolean; readonly origin?: string; readonly contentType?: string;
  readonly body?: string | null;
};
type FlowCustody = { readonly authorization?: string; readonly transaction?: string };
function classifyTransport(r: TransportRequest, input: LiveInstallInputs, custody: FlowCustody): string {
  const url = parsedUrl(r.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("unexpected browser transport");
  const read = r.method === "GET" || r.method === "HEAD";
  if (url.origin === input.issuer) {
    assertAuthorization(url, input);
    if (!r.mainNavigation || r.resourceType !== "document") throw new Error("issuer authorization must be a main-frame document");
    if (r.method === "GET") return "issuer-authorization";
    const form = new URLSearchParams(r.body ?? "");
    if (r.method !== "POST" || r.url !== custody.authorization || !custody.transaction ||
      r.origin !== input.issuer || !/^application\/x-www-form-urlencoded(?:;|$)/u.test(r.contentType ?? "") ||
      !exactKeys(form, ["approve", "consent_transaction"]) || form.get("approve") !== "yes" ||
      form.get("consent_transaction") !== custody.transaction) throw new Error("unexpected issuer consent submission");
    return "issuer-consent";
  }
  if (url.origin === input.app) {
    if (r.method === "POST" && url.pathname === "/cdn-cgi/rum") return "telemetry";
    if (!read) throw new Error("unexpected app mutation or unknown RPC transport");
    if (r.mainNavigation) {
      if (r.method !== "GET") throw new Error("unexpected document method");
      if (url.href === input.app + input.installPath) return "install-document";
      if (url.href === input.app + input.returnPath) return "returned-document";
      if (url.pathname === "/sign-in" && exactKeys(url.searchParams, ["return"]) && url.searchParams.get("return") === input.returnPath) return "sign-in-document";
      if (url.pathname === "/auth/oidc/login" && exactKeys(url.searchParams, ["return"]) && url.searchParams.get("return") === input.returnPath) return "rp-login";
      if (url.pathname === "/auth/oidc/callback" && custody.authorization && exactKeys(url.searchParams, ["code", "state", "iss"]) &&
        url.searchParams.get("code") && url.searchParams.get("state") === new URL(custody.authorization).searchParams.get("state") &&
        (url.searchParams.get("iss") === null || url.searchParams.get("iss") === input.issuer)) return "rp-callback";
      throw new Error("unexpected app document or callback");
    }
    if (knownAppRead(url)) return "app-read";
    if (url.pathname === "/auth/oidc/session" && url.search === "") return "app-auth-read";
    if ((url.pathname.startsWith("/assets/") || url.pathname.startsWith("/brand/") || ["/favicon.ico", "/tako.png"].includes(url.pathname)) &&
      ["script", "stylesheet", "image", "font", "other"].includes(r.resourceType)) return "static";
    throw new Error("unknown app read transport");
  }
  throw new Error("unknown external browser transport");
}

function registerLiveInstallReturnCase(): void {
  test.describe("shared-account live install return", () => {
    // No raw cookies, authorization URLs, callback codes or hidden form values
    // belong in traces/screenshots. Failure messages below use fixed labels.
    test.use({ trace: "off", screenshot: "off" });
    test("a new RP login from existing issuer SSO returns the exact install context", async ({ browser, context }) => {
      const input = liveInstallInputs(process.env);
      const state = issuerOnlyState(await context.storageState(), input, Date.now() / 1000);
      const isolated = await browser.newContext({ baseURL: input.app, storageState: state, serviceWorkers: "block" });
      const pending = new Set<Promise<void>>();
      const failures: string[] = [];
      const counts = new Map<string, number>();
      let authorization: string | undefined;
      let transaction: string | undefined;
      let callbackSucceeded = false;
      let signedOutObserved = false;
      let authenticatedBootstrap = false;
      const earlyReads = new WeakSet<Request>();
      try {
        expect((await isolated.cookies(input.app)).length, "new RP context must have no app cookies").toBe(0);
        const page = await isolated.newPage();
        isolated.on("page", (other) => { if (other !== page) failures.push("unexpected additional page"); });
        isolated.on("request", (request) => {
          try {
            const kind = classifyTransport({
              url: request.url(), method: request.method(), resourceType: request.resourceType(),
              mainNavigation: request.isNavigationRequest() && request.frame() === page.mainFrame(),
              origin: request.headers()["origin"], contentType: request.headers()["content-type"], body: request.postData(),
            }, input, { authorization, transaction });
            counts.set(kind, (counts.get(kind) ?? 0) + 1);
            if (kind === "issuer-authorization") authorization = request.url();
            if (!callbackSucceeded) earlyReads.add(request);
          } catch (error) {
            failures.push(error instanceof Error ? error.message : "unknown request classification error");
          }
        });
        isolated.on("requestfailed", () => failures.push("browser request failed"));
        page.on("websocket", () => failures.push("unsupported WebSocket transport"));
        page.on("pageerror", () => failures.push("browser page error"));
        const observe = async (response: Response): Promise<void> => {
          const url = new URL(response.url());
          const request = response.request();
          const headers = response.headers();
          if (url.origin === input.issuer) {
            if (headers["x-takosumi-worker-version"] !== input.issuerVersion || ![200, 302, 303].includes(response.status())) failures.push("issuer response/version mismatch");
          }
          if (url.origin !== input.app) return;
          if ((request.resourceType() === "document" || url.pathname.startsWith("/api/v1/")) && headers["x-takosumi-version-id"] !== input.workerVersion) failures.push("app response Version mismatch");
          if (url.pathname === "/auth/oidc/callback") {
            if (response.status() !== 303 || headers.location !== input.returnPath) failures.push("callback did not return the saved local destination");
            else callbackSucceeded = true;
          }
          const sessionRead = url.pathname === "/api/v1/account/session/me";
          const bootstrap = url.pathname === "/api/v1/dashboard/bootstrap";
          if (!sessionRead && !bootstrap) {
            if (response.status() >= 400) failures.push("app document/required read failed");
            return;
          }
          if (earlyReads.has(request) && response.status() === 401) { signedOutObserved = true; return; }
          if (response.status() !== 200) { failures.push("session/bootstrap response failed"); return; }
          const body: unknown = await response.json();
          if (!isRecord(body)) { failures.push("invalid session/bootstrap body"); return; }
          if (earlyReads.has(request)) {
            if (body.session === null) signedOutObserved = true;
            else failures.push("RP was authenticated before the new callback");
            return;
          }
          const session = bootstrap ? body.session : body;
          if (!isRecord(session) || session.subject !== input.account || session.primaryAccountId !== input.account) { failures.push("authenticated account mismatch"); return; }
          if (bootstrap && url.searchParams.get("includeWorkspaces") === "true") {
            if (!Array.isArray(body.workspaces) || !body.workspaces.some((w: unknown) => isRecord(w) && w.displayName === input.workspace)) failures.push("expected authenticated Workspace missing");
            else authenticatedBootstrap = true;
          }
        };
        isolated.on("response", (response) => {
          const work = observe(response).catch(() => { failures.push("response observation unavailable"); });
          pending.add(work);
          void work.then(() => pending.delete(work));
        });
        await page.goto(input.installPath, { waitUntil: "commit" });
        await expect.poll(() => {
          const url = new URL(page.url()); return url.origin + url.pathname;
        }, { message: "issuer consent document must be reached" }).toBe(input.issuer + "/oauth/authorize");
        expect(failures, "pre-consent transport must match the declared flow").toEqual([]);
        expect(authorization !== undefined, "actual issuer authorization request required").toBe(true);
        const form = page.locator("form");
        await expect(page.getByRole("heading", { name: "Continue sign-in", exact: true })).toBeVisible();
        await expect(form).toHaveCount(1);
        const action = await form.getAttribute("action");
        expect(action !== null && new URL(action, input.issuer).href === authorization, "consent action must be the observed authorization").toBe(true);
        expect((await form.getAttribute("method"))?.toLowerCase(), "real consent form method").toBe("post");
        const hidden = form.locator('input[type="hidden"][name="consent_transaction"]');
        await expect(hidden).toHaveCount(1);
        transaction = await hidden.inputValue();
        expect(/^hcons_[A-Za-z0-9_-]+$/u.test(transaction), "real one-use consent transaction required").toBe(true);
        await form.getByRole("button", { name: "Continue", exact: true }).click({ noWaitAfter: true });
        await expect.poll(() => page.url() === input.app + input.returnPath, { message: "callback must restore the exact local install context" }).toBe(true);
        await expect(page.locator(".iv-workbench")).toBeVisible();
        const fields = page.locator(".iv-form input");
        for (const [index, value] of [input.name, input.git, input.ref, input.sourcePath, input.modulePath].entries()) await expect(fields.nth(index)).toHaveValue(value);
        await expect(page.getByRole("button", { name: /ワークスペースを切り替え|Switch workspace/u }).first()).toContainText(input.workspace);
        const session = await page.evaluate(async () => {
          const response = await fetch("/api/v1/account/session/me", { credentials: "include", headers: { accept: "application/json" } });
          const body: unknown = await response.json(); return { status: response.status, body };
        });
        expect(session.status, "real shared session response").toBe(200);
        expect(isRecord(session.body) && session.body.subject === input.account && session.body.primaryAccountId === input.account, "real canonical shared account required").toBe(true);
        await Promise.all([...pending]);
        expect(signedOutObserved, "signed-out entry must be observed before callback").toBe(true);
        expect(authenticatedBootstrap, "authenticated real Workspace bootstrap required").toBe(true);
        expect(callbackSucceeded, "actual successful callback required").toBe(true);
        for (const kind of ["install-document", "sign-in-document", "rp-login", "issuer-authorization", "issuer-consent", "rp-callback", "returned-document"]) expect(counts.get(kind), kind).toBe(1);
        const appCookies = await isolated.cookies(input.app);
        const rp = appCookies.filter((cookie) => cookie.name === rpSessionCookie);
        expect(rp.length, "server-issued RP session required").toBe(1);
        expect(rp[0]?.secure && rp[0]?.httpOnly && rp[0]?.sameSite === "Lax" && rp[0]?.path === "/" && rp[0]?.domain === new URL(input.app).hostname, "RP cookie must retain host-only security attributes").toBe(true);
        expect(appCookies.some((cookie) => cookie.name === rpAttemptCookie), "successful callback must clear the browser attempt").toBe(false);
        expect(failures, "browser-observed transport must remain within the declared scope").toEqual([]);
        // This observes browser requests, not private RPC/token exchanges or
        // server-side session/grant/personal-Workspace writes.
      } finally {
        await isolated.close();
        await Promise.all([...pending]);
      }
      expect(failures, "late browser transport must also remain within scope").toEqual([]);
    });
  });
}

function registerInstallReturnInputCases(): void {
  const environment = () => ({
    TAKOSUMI_E2E_BASE_URL: sharedAppOrigin,
    TAKOSUMI_E2E_SHARED_AUTH_ISSUER_ORIGIN: sharedIssuerOrigin,
    TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID: "00000000-0000-4000-8000-000000000001",
    TAKOSUMI_E2E_EXPECTED_ISSUER_VERSION_ID: "00000000-0000-4000-8000-000000000002",
    TAKOSUMI_E2E_EXPECTED_ACCOUNT_ID: "tsub_fixture_account",
    TAKOSUMI_E2E_WORKSPACE_NAME: "Owned fixture Workspace",
    TAKOSUMI_E2E_INSTALL_RETURN_QUERY: "git=https%3A%2F%2Fgit.example.test%2Facme%2Fnotes.git&ref=v1&name=notes&product=notes-app&return_uri=notesapp%3A%2F%2Fconnect",
  });
  const cookie = () => ({ name: issuerSessionCookie, value: "synthetic-selector-input-only", domain: "auth-staging.takos.jp", path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const, expires: 2000 });
  const authorization = () => sharedIssuerOrigin + "/oauth/authorize?client_id=takosumi-hosted-staging-v1&redirect_uri=https%3A%2F%2Fapp-staging.takosumi.com%2Fauth%2Foidc%2Fcallback&response_type=code&scope=openid+email+offline_access&state=original-state&nonce=original-nonce&code_challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code_challenge_method=S256&prompt=consent";
  const consent = (): TransportRequest => ({ url: authorization(), method: "POST", mainNavigation: true, resourceType: "document", origin: sharedIssuerOrigin, contentType: "application/x-www-form-urlencoded", body: "approve=yes&consent_transaction=hcons_actual_transaction" });
  test.describe("install-return isolated-input contracts", () => {
    test("issuer SSO selection excludes all RP cookies and origin storage", () => {
      const selected = issuerOnlyState({ cookies: [cookie(), { ...cookie(), name: rpSessionCookie, domain: "app-staging.takosumi.com" }], origins: [{ origin: sharedAppOrigin, localStorage: [{ name: "cached-session", value: "must-not-copy" }] }] }, liveInstallInputs(environment()), 1000);
      expect(selected.cookies.map((c) => c.name)).toEqual(["__Host-takosumi_session"]);
      expect(selected.origins).toEqual([]);
      expect(selected.cookies[0].value).toBe("synthetic-selector-input-only");
    });
    test("issuer SSO selection rejects missing, ambiguous and expired sessions", () => {
      for (const cookies of [[], [{ ...cookie(), domain: ".takos.jp" }], [cookie(), cookie()], [{ ...cookie(), expires: 1040 }], [{ ...cookie(), secure: false }], [{ ...cookie(), httpOnly: false }], [{ ...cookie(), path: "/oauth" }], [cookie(), { ...cookie(), domain: ".auth-staging.takos.jp" }], [{ ...cookie(), partitionKey: sharedAppOrigin }]]) {
        expect(() => issuerOnlyState({ cookies, origins: [] }, liveInstallInputs(environment()), 1000)).toThrow();
      }
    });
    test("live input refuses missing and arbitrary or swapped origins", () => {
      expect(() => liveInstallInputs({})).toThrow();
      expect(() => liveInstallInputs({ ...environment(), TAKOSUMI_E2E_SHARED_AUTH_ISSUER_ORIGIN: sharedAppOrigin })).toThrow();
      expect(() => liveInstallInputs({ ...environment(), TAKOSUMI_E2E_BASE_URL: "https://other.example.test" })).toThrow();
      expect(() => liveInstallInputs({ ...environment(), TAKOSUMI_E2E_SHARED_AUTH_ISSUER_ORIGIN: "https://auth-staging.takos.jp.evil.example" })).toThrow();
    });
    test("install prefill refuses duplicate fields, automatic work and credential URLs", () => {
      const base = environment();
      expect(liveInstallInputs(base).modulePath).toBe(".");
      expect(liveInstallInputs({ ...base, TAKOSUMI_E2E_INSTALL_RETURN_QUERY: base.TAKOSUMI_E2E_INSTALL_RETURN_QUERY + "&path=infra%2Fmain" }).modulePath).toBe("infra/main");
      for (const query of [base.TAKOSUMI_E2E_INSTALL_RETURN_QUERY + "&auto=1", base.TAKOSUMI_E2E_INSTALL_RETURN_QUERY + "&product=other", base.TAKOSUMI_E2E_INSTALL_RETURN_QUERY.replace("git.example.test", "user%3Apassword%40git.example.test")]) {
        expect(() => liveInstallInputs({ ...base, TAKOSUMI_E2E_INSTALL_RETURN_QUERY: query })).toThrow();
      }
      for (const [key, value] of [["git", "https://git.example.test/acme/notes.git?token=synthetic-invalid-query"], ["ref", "r".repeat(513)], ["ref", " v1"], ["name", "n".repeat(97)], ["name", "notes "], ["sourcePath", "../private"], ["path", "a/../b"]]) {
        const query = new URLSearchParams(base.TAKOSUMI_E2E_INSTALL_RETURN_QUERY);
        query.set(key, value);
        expect(() => liveInstallInputs({ ...base, TAKOSUMI_E2E_INSTALL_RETURN_QUERY: query.toString() })).toThrow("live install return source or nested app context invalid");
      }
    });
    test("browser transport separates consent from forbidden install and payment writes", () => {
      const input = liveInstallInputs(environment());
      expect(classifyTransport(consent(), input, { authorization: authorization(), transaction: "hcons_actual_transaction" })).toBe("issuer-consent");
      for (const path of ["/api/v1/sources", "/api/v1/workspaces/ws_owned/install-plans", "/api/v1/runs/run_owned/apply", "/api/v1/billing/top-up", "/v1/rpc", "/__takosumi/unknown"]) {
        expect(() => classifyTransport({ url: input.app + path, method: "POST", resourceType: "fetch", mainNavigation: false }, input, {})).toThrow();
      }
    });
    test("browser transport recognizes existing bootstrap and Workspace REST reads", () => {
      const input = liveInstallInputs(environment());
      for (const path of ["/api/v1/account/session/me", "/api/v1/dashboard/bootstrap?includeWorkspaces=false", "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50", "/api/v1/workspaces?limit=50&order=updated_desc", "/api/v1/workspaces/ws_owned/activity?limit=50", "/__takosumi/platform/contributions", "/.well-known/takosumi", "/api/v1/capabilities"]) {
        expect(classifyTransport({ url: input.app + path, method: "GET", resourceType: "fetch", mainNavigation: false }, input, {})).toBe("app-read");
      }
      expect(() => classifyTransport({ url: input.app + "/api/v1/workspaces?limit=all", method: "GET", resourceType: "fetch", mainNavigation: false }, input, {})).toThrow();
    });
    test("browser transport refuses unknown reads and foreign dynamic calls", () => {
      const input = liveInstallInputs(environment());
      for (const url of [input.app + "/api/v1/unknown", input.app + "/api/v1/account/session/me?unknown=1", "https://provider.example.test/oauth/token"]) {
        expect(() => classifyTransport({ url, method: "GET", resourceType: "fetch", mainNavigation: false }, input, {})).toThrow();
      }
      for (const resourceType of ["script", "stylesheet", "font", "image", "media"]) {
        expect(() => classifyTransport({ url: "https://unknown.example.test/arbitrary", method: "GET", resourceType, mainNavigation: false }, input, {})).toThrow();
      }
    });
    test("consent POST binds the real transaction, exact action and browser Origin", () => {
      const input = liveInstallInputs(environment());
      for (const request of [{ ...consent(), body: "approve=yes&consent_transaction=hcons_other" }, { ...consent(), origin: input.app }, { ...consent(), body: consent().body + "&extra=1" }, { ...consent(), body: consent().body + "&approve=yes" }, { ...consent(), url: authorization().replace("original-state", "other-state") }]) {
        expect(() => classifyTransport(request, input, { authorization: authorization(), transaction: "hcons_actual_transaction" })).toThrow();
      }
    });
    test("authorization and callback retain the fixed client and original state", () => {
      const input = liveInstallInputs(environment());
      expect(() => assertAuthorization(new URL(authorization()), input)).not.toThrow();
      expect(() => assertAuthorization(new URL(authorization().replace(sharedClientId, "another-client")), input)).toThrow();
      expect(() => classifyTransport({ url: input.app + "/auth/oidc/callback?code=hcode_actual&state=other-state", method: "GET", resourceType: "document", mainNavigation: true }, input, { authorization: authorization() })).toThrow();
      expect(classifyTransport({ url: input.app + "/auth/oidc/callback?code=hcode_actual&state=original-state", method: "GET", resourceType: "document", mainNavigation: true }, input, { authorization: authorization() })).toBe("rp-callback");
    });
  });
}
