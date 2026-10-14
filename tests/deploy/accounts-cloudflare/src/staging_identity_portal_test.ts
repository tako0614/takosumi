import { expect, test } from "bun:test";
import { createStagingIdentityPortal } from "../../../../deploy/accounts-cloudflare/src/staging-identity-portal.ts";
import { createEphemeralAccountsHandler } from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore, type AccountSessionRecord } from "../../../../accounts/service/src/store.ts";
import { createIdentityMerge, proveIdentityMerge, type IdentityMergeReconciler } from "../../../../accounts/service/src/identity-merge.ts";
import type { IdentityMergeOperation, IdentityOperationReceiptRecord } from "../../../../accounts/service/src/identity-state.ts";
import { rotateAccountSession } from "../../../../accounts/service/src/account-session.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import type { ControlIdentityContextPlan } from "../../../../contract/identity-reconciliation.ts";

const issuer = "https://auth-staging.takos.jp";
const source = "tsub_context_B";
const target = "tsub_context_A";
const browserSecret = "b".repeat(64);
const browserCookie = `__Host-takosumi-merge-browser=${browserSecret}`;
const operationId = "imrg_12345678-1234-1234-1234-123456789abc";
const path = `/identity-merges/${operationId}/contexts`;
const nonceName = "__Host-takosumi-context-csrf";
const sessionName = "__Host-takosumi_session";

function planFor(operation: IdentityMergeOperation, maliciousNames = false): ControlIdentityContextPlan {
  return {
    operationId: operation.operationId, planId: "ictx_plan", digest: "sha256:exact-context-digest", authorityVersion: "control-identity-reconciliation/v1",
    planningRevision: operation.contextPlan?.planningRevision ?? operation.revision, sourceAccountId: source, targetAccountId: target,
    proofBindingDigest: "sha256:private-proof-binding", inventoryDigest: "sha256:complete-inventory", supportedInventory: "two-disjoint-personal-contexts/v1",
    personalWorkspaceId: "workspace_A", createdAt: new Date(operation.createdAt).toISOString(),
    contexts: [
      { workspaceId: "workspace_A", workspaceRef: "original-ref-A", organizationRef: "Org_A", billingAuthority: "takoserver", originalOwnerAccountId: target, canonicalAccountId: target, roles: ["owner"], disposition: "retain-personal-anchor" },
      { workspaceId: maliciousNames ? '<script>alert("B")</script>' : "workspace_B", workspaceRef: "original-ref-B", organizationRef: maliciousNames ? 'Org_B & "retained"' : "Org_B", billingAuthority: "takoserver", originalOwnerAccountId: source, canonicalAccountId: target, roles: ["owner"], disposition: "insert-additional-membership" },
    ],
  };
}

async function fixture(options: { sourceProved?: boolean; targetProved?: boolean; noPlanPort?: boolean; maliciousNames?: boolean } = {}) {
  let now = Date.now();
  const store = new InMemoryAccountsStore();
  for (const [subject, providerId] of [[source, "github"], [target, "google"]] as const) {
    await store.saveAccount({ subject, email: "Owner@example.test", emailVerified: true, createdAt: now, updatedAt: now });
    const identity = { subject, providerId, upstreamIssuer: `https://${providerId}.example.test`, upstreamSubject: subject, createdAt: now, updatedAt: now };
    await store.linkUpstreamIdentity(identity);
    await store.saveAccountEmailProof!({ ...identity, address: "Owner@example.test", normalizedAddress: "Owner@example.test", verification: "provider", authoritative: true, observedAt: now, validUntil: now + 300_000 });
  }
  let current: AccountSessionRecord | undefined;
  async function login(subject: typeof source | typeof target) {
    const next = await rotateAccountSession({ store, subject, oldSessionId: current?.sessionId, now, ttlMs: 300_000, hostedPolicy: true });
    current = (await store.findAccountSession(next.sessionId))!;
    return current;
  }
  const sourceSession = await login(source);
  let operation = await createIdentityMerge({ store, actor: source, sourceSubject: source, targetSubject: target, browserBindingHash: await sha256Text(`merge-browser:${browserSecret}`), now });
  const privateReceiptIds: string[] = [];
  async function prove(role: "source" | "target", session: AccountSessionRecord) {
    const subject = role === "source" ? source : target;
    const providerId = role === "source" ? "github" : "google";
    const receipt: IdentityOperationReceiptRecord = {
      receiptId: `ircp_${crypto.randomUUID()}`, operationId: operation.operationId, role, subject, sourceSubject: source, targetSubject: target,
      providerId, upstreamIssuer: `https://${providerId}.example.test`, upstreamSubject: subject, browserBindingHash: operation.browserBindingHash,
      policyVersion: operation.policyVersion, identityGeneration: 0, transactionDigest: "sha256:fixture-transaction", startedAt: now, completedAt: now,
      expiresAt: operation.expiresAt, emailDigest: operation.addressDigest, legConsent: true, legConsentAt: now, method: "upstream-oauth-operation", issuerSessionHash: session.issuerSessionId!,
    };
    privateReceiptIds.push(receipt.receiptId);
    await store.createIdentityOperationReceipt!(receipt);
    operation = await proveIdentityMerge({ store, operation, session, receiptId: receipt.receiptId, now });
  }
  if (options.sourceProved !== false) await prove("source", sourceSession);
  const targetSession = await login(target);
  if (options.targetProved !== false) await prove("target", targetSession);
  let inventoryReads = 0;
  const reconciler: IdentityMergeReconciler = {
    reconcile: async () => undefined,
    ...(!options.noPlanPort ? { prepareContextPlan: async (op: IdentityMergeOperation) => { inventoryReads++; return planFor(op, options.maliciousNames); } } : {}),
  };
  const accounts = await createEphemeralAccountsHandler({ issuer, store, hostedSessionPolicy: true, allowEphemeralKeyOnHttpsIssuer: true, identityMergeReconciler: reconciler });
  const calls: { pathname: string; method: string; body?: unknown; cookie: string | null; authorization: string | null; sourceIp: string | null }[] = [];
  const portal = createStagingIdentityPortal({ issuer, now: () => now, accountsHandler: async (request) => {
    const pathname = new URL(request.url).pathname;
    calls.push({ pathname, method: request.method, ...(request.method === "POST" ? { body: await request.clone().json() } : {}), cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization"), sourceIp: request.headers.get("cf-connecting-ip") });
    if (pathname === "/api/v1/auth/providers") return Response.json({ providers: [{ id: "google", label: "Google", protocol: "oidc", enabled: true }, { id: "github", label: "GitHub", protocol: "oauth2", enabled: true }] });
    return accounts(request);
  } });
  let nonceCookie = "";
  const actualPath = `/identity-merges/${operation.operationId}/contexts`;
  function cookies() { return `${sessionName}=${current!.sessionId}; ${browserCookie}${nonceCookie ? `; ${nonceCookie}` : ""}`; }
  async function get() {
    const response = (await portal(new Request(`${issuer}${actualPath}`, { headers: { cookie: cookies(), "cf-connecting-ip": "192.0.2.45" } })))!;
    const value = response.headers.get("set-cookie");
    if (value) nonceCookie = value.split(";")[0]!;
    return response;
  }
  async function post(body: URLSearchParams, overrides: { cookie?: string; origin?: string } = {}) {
    return (await portal(new Request(`${issuer}${actualPath}`, { method: "POST", headers: { cookie: overrides.cookie ?? cookies(), origin: overrides.origin ?? issuer, "cf-connecting-ip": "192.0.2.45", "content-type": "application/x-www-form-urlencoded" }, body })))!;
  }
  return { store, portal, get, post, login, calls, cookies, privateReceiptIds, get operation() { return operation; }, current: () => current!, inventoryReads: () => inventoryReads, advance(ms: number) { now += ms; } };
}

function forms(html: string): URLSearchParams[] {
  return [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gu)].map((form) => {
    const values = new URLSearchParams();
    for (const match of form[1]!.matchAll(/name="([^"]+)" value="([^"]*)"/gu)) values.append(match[1]!, match[2]!.replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&"));
    return values;
  });
}

test("both operation proofs precede every Workspace/Organization inventory request", async () => {
  for (const [sourceProved, targetProved] of [[false, false], [true, false], [false, true]]) {
    const f = await fixture({ sourceProved, targetProved });
    const response = await f.get();
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).not.toContain("workspace_A");
    expect(html).not.toContain("Org_B");
    expect(f.inventoryReads()).toBe(0);
    expect(f.calls.some((call) => call.pathname.endsWith("/context-plan"))).toBe(false);
  }
});

test("real Accounts context plan displays exact retained authority without raw sessions or proof receipts", async () => {
  const f = await fixture();
  const response = await f.get();
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Canonical personal anchor A");
  expect(html).toContain("Retained additional context B");
  for (const expected of ["workspace_A", "workspace_B", "Org_A", "Org_B", "original-ref-A", "original-ref-B", source, target, "separate wallets"]) expect(html).toContain(expected);
  expect(html).not.toContain(f.current().sessionId);
  expect(html).not.toContain(browserSecret);
  for (const receipt of f.privateReceiptIds) expect(html).not.toContain(receipt);
  expect(html).not.toContain("<script");
  expect(forms(html)).toHaveLength(1);
  expect(forms(html)[0]!.get("action")).toBe("accept");
  expect(html).not.toContain("Confirm the account merge");
  expect(f.inventoryReads()).toBe(1);
  expect(f.calls.every((call) => call.authorization === null)).toBe(true);
  expect(f.calls.every((call) => call.sourceIp === "192.0.2.45")).toBe(true);
  expect(response.headers.get("set-cookie")).toContain(`${nonceName}=`);
  expect(response.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Strict");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const switching = [...html.matchAll(/href="([^"]*upstream[^"]*)"/gu)].map((match) => new URL(match[1]!.replace(/&amp;/gu, "&"), issuer));
  expect(switching).toHaveLength(1);
  expect(switching[0]!.searchParams.get("provider")).toBe("github");
  for (const link of switching) expect(link.searchParams.get("return_to")).toBe(`/identity-merges/${f.operation.operationId}/contexts`);
});

test("same browser rotates A to B and back to A; each current leg explicitly accepts without fake activation", async () => {
  const f = await fixture();
  const first = forms(await (await f.get()).text())[0]!;
  expect((await f.post(first)).status).toBe(303);
  let operation = (await f.store.findIdentityMergeOperation!(f.operation.operationId))!;
  expect(operation.targetContextAcceptance).toBeTruthy();
  expect(operation.sourceContextAcceptance).toBeUndefined();
  const firstReceipt = operation.targetContextAcceptance!.receiptId;
  expect((await f.post(first)).status).toBe(303);
  expect((await f.store.findIdentityMergeOperation!(operation.operationId))!.targetContextAcceptance!.receiptId).toBe(firstReceipt);
  const previousSession = f.current().sessionId;
  await f.login(source);
  expect(await f.store.findAccountSession(previousSession)).toBeUndefined();
  expect((await f.post(first)).status).toBe(403);
  const sourcePage = await f.get();
  expect(sourcePage.status).toBe(200);
  const sourceHtml = await sourcePage.text();
  expect(sourceHtml).toContain("retained source account B");
  expect(sourceHtml).toContain("Sign in with Google");
  expect(sourceHtml).not.toContain("Sign in with GitHub");
  expect(sourceHtml).not.toContain("Confirm the account merge");
  expect((await f.post(forms(sourceHtml)[0]!)).status).toBe(303);
  operation = (await f.store.findIdentityMergeOperation!(operation.operationId))!;
  expect(operation.sourceContextAcceptance).toBeTruthy();
  expect(operation.targetContextAcceptance!.receiptId).toBe(firstReceipt);
  await f.login(target);
  const targetPage = await f.get();
  const targetHtml = await targetPage.text();
  expect(targetHtml).toContain("You have already accepted this exact plan.");
  expect(targetHtml).toContain("Confirm the account merge");
  const complete = forms(targetHtml).find((form) => form.get("action") === "complete")!;
  const final = await f.post(complete);
  expect(final.status).toBe(409);
  expect(await final.text()).not.toContain("merge is complete");
  operation = (await f.store.findIdentityMergeOperation!(operation.operationId))!;
  expect(operation.status).toBe("proved");
  expect(operation.consentAt).toBeUndefined();
  expect(await f.store.isAccountAuthenticationFenced!(source)).toBe(false);
  expect(await f.store.isAccountAuthenticationFenced!(target)).toBe(false);
  expect(f.calls.filter((call) => call.pathname.endsWith("/context-accept")).every((call) => Object.keys(call.body as object).sort().join(",") === "consent,planDigest")).toBe(true);
});

test("CSRF, stale plan, duplicate form fields, chosen roles and altered consent are rejected before acceptance API", async () => {
  const f = await fixture();
  const original = forms(await (await f.get()).text())[0]!;
  const badOrigin = await f.post(original, { origin: "https://attacker.example.test" });
  expect(badOrigin.status).toBe(403);
  for (const [name, value] of [["planDigest", "sha256:tampered"], ["csrf", "0".repeat(64)], ["expiresAt", String(Date.now() + 400_000)], ["action", "complete"]]) {
    const tampered = new URLSearchParams(original);
    tampered.set(name!, value!);
    expect([400, 403]).toContain((await f.post(tampered)).status);
  }
  for (const key of ["csrf", "planDigest", "action", "expiresAt"]) {
    const duplicate = new URLSearchParams(original);
    duplicate.append(key, original.get(key)!);
    expect((await f.post(duplicate)).status).toBe(400);
  }
  const chosenRole = new URLSearchParams(original);
  chosenRole.set("role", "source");
  expect((await f.post(chosenRole)).status).toBe(400);
  const duplicateCookie = `${f.cookies()}; ${sessionName}=${f.current().sessionId}`;
  expect((await f.post(original, { cookie: duplicateCookie })).status).toBe(401);
  expect(f.calls.filter((call) => call.pathname.endsWith("/context-accept"))).toHaveLength(0);
  f.advance(300_001);
  expect((await f.post(original)).status).toBe(403);
});

test("a changed nonce refuses replay and a stored immutable plan cannot be replaced", async () => {
  const f = await fixture();
  const old = forms(await (await f.get()).text())[0]!;
  await f.get();
  expect((await f.post(old)).status).toBe(403);
  const fresh = forms(await (await f.get()).text())[0]!;
  const operation = (await f.store.findIdentityMergeOperation!(f.operation.operationId))!;
  const replaced = await f.store.compareAndSetIdentityMerge!({ expectedRevision: operation.revision, next: { ...operation, contextPlan: { ...operation.contextPlan!, planDigest: "sha256:changed-plan" }, revision: operation.revision + 1, mutationId: crypto.randomUUID(), updatedAt: Date.now() }, now: Date.now() });
  expect(replaced).toBe(false);
  expect((await f.store.findIdentityMergeOperation!(operation.operationId))!.contextPlan!.planDigest).toBe("sha256:exact-context-digest");
  expect((await f.post(fresh)).status).toBe(303);
});

test("unconfigured plan authority and incorrect browser do not expose inventory or report success", async () => {
  const f = await fixture({ noPlanPort: true });
  const response = await f.get();
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("workspace_A");
  expect(f.inventoryReads()).toBe(0);
  const wrongBrowser = f.cookies().replace(browserSecret, "c".repeat(64));
  const forbidden = await f.portal(new Request(`${issuer}/identity-merges/${f.operation.operationId}/contexts`, { headers: { cookie: wrongBrowser } }));
  expect(forbidden?.status).toBe(404);
  expect(f.inventoryReads()).toBe(0);
});

test("revoked genuine issuer session stops before reading the operation or its inventory", async () => {
  const f = await fixture();
  await f.store.deleteAccountSession(f.current().sessionId);
  const response = await f.get();
  expect(response.status).toBe(401);
  expect(f.calls.map((call) => call.pathname)).toEqual(["/api/v1/account/session/me"]);
  expect(f.inventoryReads()).toBe(0);
});

test("all context labels are escaped, without scripts or event handlers", async () => {
  const f = await fixture({ maliciousNames: true });
  const response = await f.get();
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("&lt;script&gt;alert(&quot;B&quot;)&lt;/script&gt;");
  expect(html).toContain("Org_B &amp; &quot;retained&quot;");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onclick=");
});

test("stage origin/path/method and genuine cookies are checked before any service call", async () => {
  let calls = 0;
  const portal = createStagingIdentityPortal({ issuer, accountsHandler: () => { calls++; return Response.json({}); } });
  expect(await portal(new Request(`${issuer}/sign-in`))).toBeNull();
  for (const url of [`https://auth.takos.jp${path}`, `http://auth-staging.takos.jp${path}`, `${issuer}/identity-merges/not-an-operation/contexts`]) expect((await portal(new Request(url)))?.status).toBe(404);
  expect((await portal(new Request(`${issuer}${path}?receiptId=forged`)))?.status).toBe(400);
  expect((await portal(new Request(`${issuer}${path}`, { method: "DELETE" })))?.status).toBe(405);
  expect((await portal(new Request(`${issuer}${path}`, { headers: { authorization: "Bearer fake-rp-grant" } })))?.status).toBe(401);
  expect(calls).toBe(0);
});

test("oversized POST bodies are bounded even with no trusted Content-Length", async () => {
  const f = await fixture();
  await f.get();
  const response = await f.portal(new Request(`${issuer}/identity-merges/${f.operation.operationId}/contexts`, { method: "POST", headers: { cookie: f.cookies(), origin: issuer, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${"a".repeat(8192)}` }));
  expect(response?.status).toBe(400);
  expect(f.calls.filter((call) => call.pathname.endsWith("/context-accept"))).toHaveLength(0);
});
