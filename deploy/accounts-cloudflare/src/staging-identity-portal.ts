import type { ControlIdentityContext } from "../../../contract/identity-reconciliation.ts";

const stageIssuer = "https://auth-staging.takos.jp";
const sessionCookieName = "__Host-takosumi_session";
const browserCookieName = "__Host-takosumi-merge-browser";
const nonceCookieName = "__Host-takosumi-context-csrf";
const apiBase = "/api/v1/account/identity-merges";
const operationPattern = /^imrg_[a-f0-9-]{36}$/u;
const hexPattern = /^[a-f0-9]{64}$/u;

interface PublicOperation {
  operationId: string;
  status: string;
  revision: number;
  sourceSubject: string;
  targetSubject: string;
  sourceProved: boolean;
  targetProved: boolean;
  sourceContextAccepted: boolean;
  targetContextAccepted: boolean;
  sourceProviderId?: string;
  targetProviderId?: string;
  consented: boolean;
  expiresAt: number;
  contextPlan?: { planId: string; planDigest: string };
}

interface BrowserContext {
  session: string;
  browser: string;
  nonce?: string;
  apiCookie: string;
}

/** Only the dedicated staging entry composes this authenticated browser view. */
export function createStagingIdentityPortal(options: {
  issuer: string;
  accountsHandler: (request: Request) => Response | Promise<Response>;
  now?: () => number;
}): (request: Request) => Promise<Response | null> {
  const clock = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/identity-merges/")) return null;
    const match = /^\/identity-merges\/(imrg_[a-f0-9-]{36})\/contexts$/u.exec(url.pathname);
    const host = request.headers.get("host");
    if (!match || options.issuer !== stageIssuer || url.origin !== stageIssuer || url.username || url.password || url.hash ||
      (host !== null && host !== "auth-staging.takos.jp" && host !== "auth-staging.takos.jp:443")) {
      return page("Not found", 404);
    }
    if (url.search) return page("This confirmation link is invalid.", 400);
    if (request.method !== "GET" && request.method !== "POST") return page("Open this page with GET.", 405, "", { allow: "GET, POST" });
    if (request.method === "POST" && request.headers.get("origin") !== stageIssuer) return page("The confirmation origin is invalid.", 403);
    const operationId = match[1]!;
    const path = `/identity-merges/${operationId}/contexts`;
    const browser = readBrowser(request);
    if (!browser) return page("Sign in again with one of the two confirmed accounts in the same browser.", 401);
    let postedForm: ConsentForm | undefined;
    if (request.method === "POST") {
      try {
        postedForm = await readForm(request);
        if (!browser.nonce || !await validCsrf(browser, operationId, postedForm, clock())) {
          return page("This confirmation expired or the signed-in account changed. Reload this page before accepting.", 403);
        }
      } catch {
        return page("This confirmation form is invalid.", 400);
      }
    }
    const api = async (suffix: string, body?: Record<string, unknown>) => {
      const headers = new Headers({ cookie: browser.apiCookie, accept: "application/json" });
      const sourceIp = request.headers.get("cf-connecting-ip");
      if (sourceIp && /^[a-f0-9:.]{3,64}$/iu.test(sourceIp)) headers.set("cf-connecting-ip", sourceIp);
      if (body !== undefined) { headers.set("origin", stageIssuer); headers.set("content-type", "application/json"); }
      const response = await options.accountsHandler(new Request(`${stageIssuer}${suffix}`, {
        method: body === undefined ? "GET" : "POST", headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      if (response.status !== 200) throw new PortalFailure(response.status);
      return readJson(response, 96 * 1024);
    };
    try {
      const session = await api("/api/v1/account/session/me");
      if (!record(session) || !text(session.subject) || !Number.isFinite(session.expiresAt) || Number(session.expiresAt) <= clock()) {
        return page("Sign in again with one of the two confirmed accounts in the same browser.", 401);
      }
      let operation = readOperation(await api(`${apiBase}/${operationId}`), operationId);
      if (![operation.sourceSubject, operation.targetSubject].includes(session.subject)) return page("This operation is unavailable for the current account.", 404);
      const currentLeg = session.subject === operation.sourceSubject ? "source" : "target";
      if (operation.status === "active") return page("The account merge is complete. Your original Workspace and Organization records remain separate.", 200);
      if (operation.consented || operation.status === "reconciled") return page("The merge is pending owner reconciliation. It is not complete.", 409);
      if (operation.status !== "proved" || !operation.sourceProved || !operation.targetProved || operation.expiresAt <= clock()) {
        return page("Complete both account confirmations before viewing any Workspace or Organization details. Expired operations require a new reviewed confirmation.", 409);
      }
      if (request.method === "POST") {
        const form = postedForm!;
        if (!operation.contextPlan || operation.contextPlan.planDigest !== form.planDigest) return page("The context plan changed. Reload and review it again.", 409);
        if (form.action === "accept") {
          operation = readOperation(await api(`${apiBase}/${operationId}/context-accept`, { planDigest: form.planDigest, consent: true }), operationId);
          if (operation.status !== "proved" || (currentLeg === "source" ? !operation.sourceContextAccepted : !operation.targetContextAccepted)) {
            throw new PortalFailure(503);
          }
          return new Response(null, { status: 303, headers: { ...securityHeaders(), location: path } });
        }
        if (currentLeg !== "target" || !operation.sourceContextAccepted || !operation.targetContextAccepted) return page("Both accounts must accept this context plan before the target account confirms the merge.", 409);
        const result = readOperation(await api(`${apiBase}/${operationId}/consent`, { consent: true }), operationId);
        return result.status === "active"
          ? page("The account merge is complete. Your original Workspace and Organization records remain separate.", 200)
          : page("The merge is pending owner reconciliation. It is not complete.", 409);
      }
      // Neither peer inventory nor provider choices are read before both real
      // operation proofs, the genuine session and same-browser operation read.
      const prepared = await api(`${apiBase}/${operationId}/context-plan`, {});
      if (!record(prepared)) throw new PortalFailure(503);
      operation = readOperation(prepared.operation, operationId);
      if (operation.status !== "proved" || !operation.sourceProved || !operation.targetProved || operation.expiresAt <= clock() ||
        ![operation.sourceSubject, operation.targetSubject].includes(session.subject)) throw new PortalFailure(409);
      const plan = readPlan(prepared.plan, operation);
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      browser.nonce = hex(nonce);
      const expiresAt = Math.min(operation.expiresAt, clock() + 300_000);
      const accepted = currentLeg === "source" ? operation.sourceContextAccepted : operation.targetContextAccepted;
      const accept = accepted ? "<p>You have already accepted this exact plan.</p>" : await formHtml(browser, operationId, path, plan.digest, "accept", expiresAt, "Accept this context plan for my current account");
      const final = operation.sourceContextAccepted && operation.targetContextAccepted && currentLeg === "target"
        ? await formHtml(browser, operationId, path, plan.digest, "complete", expiresAt, "Confirm the account merge")
        : "<p>Both accounts must accept this plan. The target account then confirms the merge.</p>";
      const providers = await api("/api/v1/auth/providers");
      const switchLinks = providerLinks(providers, path, currentLeg === "source" ? operation.targetProviderId : operation.sourceProviderId);
      const rows = plan.contexts.map((context) => contextHtml(context, plan.personalWorkspaceId)).join("");
      const details = `<p>Signed in as <strong>${escapeHtml(session.subject)}</strong> (${currentLeg === "source" ? "retained source account B" : "canonical target account A"}).</p><p>Canonical personal Workspace: <strong>${escapeHtml(plan.personalWorkspaceId)}</strong>.</p>${rows}<p>These Organizations keep their existing separate wallets, balances, resources and pending billing operations. Acceptance does not combine balances or replace their references.</p><p>Source account accepted: ${operation.sourceContextAccepted ? "Yes" : "No"}. Target account accepted: ${operation.targetContextAccepted ? "Yes" : "No"}.</p>${accept}${final}<h2>Continue with the other account</h2><p>Sign in using the other confirmed account, return here, and review this same plan. Your current account alone determines which acceptance is recorded.</p>${switchLinks}<p><a href="${escapeHtml(path)}">Reload this operation</a></p>`;
      return page("Review exactly how your existing contexts will be retained before accepting.", 200, details, {
        "set-cookie": `${nonceCookieName}=${browser.nonce}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Strict`,
      });
    } catch (error) {
      const status = error instanceof PortalFailure && [400, 401, 403, 404, 409].includes(error.status) ? error.status : 503;
      return page(status === 409 ? "This operation or context plan is unavailable or changed. Reload and review it again. The merge is not complete." : "This identity operation is unavailable. The merge has not been confirmed here.", status);
    }
  };
}

function readBrowser(request: Request): BrowserContext | undefined {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((value) => value.trim());
  const one = (name: string) => {
    const values = cookies.filter((value) => value.startsWith(`${name}=`));
    return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
  };
  const session = one(sessionCookieName);
  const browser = one(browserCookieName);
  const nonce = one(nonceCookieName);
  if (!session || !/^sess_[A-Za-z0-9_-]{16,256}$/u.test(session) || !browser || !hexPattern.test(browser)) return undefined;
  return { session, browser, ...(nonce && hexPattern.test(nonce) ? { nonce } : {}), apiCookie: `${sessionCookieName}=${session}; ${browserCookieName}=${browser}` };
}

function readOperation(value: unknown, operationId: string): PublicOperation {
  if (!record(value) || value.operationId !== operationId || !operationPattern.test(operationId) || !text(value.status) ||
    !Number.isSafeInteger(value.revision) || !text(value.sourceSubject) || !text(value.targetSubject) || value.sourceSubject === value.targetSubject ||
    !["sourceProved", "targetProved", "sourceContextAccepted", "targetContextAccepted", "consented"].every((key) => typeof value[key] === "boolean") ||
    [value.sourceProviderId, value.targetProviderId].some((provider) => provider !== undefined && (typeof provider !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(provider))) ||
    !Number.isFinite(value.expiresAt) || (value.contextPlan !== undefined && (!record(value.contextPlan) || !text(value.contextPlan.planId) || !text(value.contextPlan.planDigest, 128)))) {
    throw new PortalFailure(503);
  }
  const contextPlan = record(value.contextPlan)
    ? { planId: String(value.contextPlan.planId), planDigest: String(value.contextPlan.planDigest) }
    : undefined;
  return {
    operationId, status: value.status, revision: Number(value.revision), sourceSubject: value.sourceSubject, targetSubject: value.targetSubject,
    sourceProved: value.sourceProved === true, targetProved: value.targetProved === true,
    sourceContextAccepted: value.sourceContextAccepted === true, targetContextAccepted: value.targetContextAccepted === true,
    ...(typeof value.sourceProviderId === "string" ? { sourceProviderId: value.sourceProviderId } : {}),
    ...(typeof value.targetProviderId === "string" ? { targetProviderId: value.targetProviderId } : {}),
    consented: value.consented === true, expiresAt: Number(value.expiresAt), ...(contextPlan ? { contextPlan } : {}),
  };
}

function readPlan(value: unknown, operation: PublicOperation): { digest: string; personalWorkspaceId: string; contexts: ControlIdentityContext[] } {
  if (!record(value) || value.operationId !== operation.operationId || value.sourceAccountId !== operation.sourceSubject ||
    value.targetAccountId !== operation.targetSubject || value.authorityVersion !== "control-identity-reconciliation/v1" ||
    value.supportedInventory !== "two-disjoint-personal-contexts/v1" || !text(value.digest, 128) || value.digest !== operation.contextPlan?.planDigest ||
    !text(value.personalWorkspaceId) || !Array.isArray(value.contexts) || value.contexts.length !== 2) throw new PortalFailure(503);
  const contexts: ControlIdentityContext[] = [];
  for (const context of value.contexts as unknown[]) {
    if (!record(context) || !["workspaceId", "workspaceRef", "billingAuthority", "organizationRef", "originalOwnerAccountId", "canonicalAccountId"].every((key) => text(context[key])) ||
      context.canonicalAccountId !== operation.targetSubject || !Array.isArray(context.roles) || context.roles.length < 1 || context.roles.length > 16 ||
      !context.roles.every((role: unknown) => text(role, 64)) || new Set(context.roles).size !== context.roles.length) throw new PortalFailure(503);
    if (context.disposition !== "retain-personal-anchor" && context.disposition !== "insert-additional-membership") throw new PortalFailure(503);
    contexts.push({ workspaceId: String(context.workspaceId), workspaceRef: String(context.workspaceRef), billingAuthority: String(context.billingAuthority),
      organizationRef: String(context.organizationRef), originalOwnerAccountId: String(context.originalOwnerAccountId), canonicalAccountId: String(context.canonicalAccountId),
      roles: context.roles.map(String), disposition: context.disposition });
  }
  const anchor = contexts.filter((context) => context.disposition === "retain-personal-anchor");
  const additional = contexts.filter((context) => context.disposition === "insert-additional-membership");
  if (anchor.length !== 1 || additional.length !== 1 || anchor[0].workspaceId !== value.personalWorkspaceId || anchor[0].originalOwnerAccountId !== operation.targetSubject ||
    additional[0].originalOwnerAccountId !== operation.sourceSubject || anchor[0].workspaceId === additional[0].workspaceId || anchor[0].organizationRef === additional[0].organizationRef) throw new PortalFailure(503);
  return { digest: value.digest, personalWorkspaceId: value.personalWorkspaceId, contexts };
}

function contextHtml(context: ControlIdentityContext, anchor: string): string {
  return `<section><h2>${context.workspaceId === anchor ? "Canonical personal anchor A" : "Retained additional context B"}</h2><dl><dt>Workspace</dt><dd>${escapeHtml(context.workspaceId)}</dd><dt>Existing Workspace reference</dt><dd>${escapeHtml(context.workspaceRef)}</dd><dt>Original owner retained</dt><dd>${escapeHtml(context.originalOwnerAccountId)}</dd><dt>Canonical account after merge</dt><dd>${escapeHtml(context.canonicalAccountId)}</dd><dt>Exact approved roles</dt><dd>${context.roles.map(escapeHtml).join(", ")}</dd><dt>Organization retained</dt><dd>${escapeHtml(context.organizationRef)}</dd><dt>Billing authority</dt><dd>${escapeHtml(context.billingAuthority)}</dd></dl><p>${context.workspaceId === anchor ? "This remains the canonical personal Workspace." : "The original owner and context are retained. The canonical account receives only this plan's exact additional membership."}</p></section>`;
}

function providerLinks(value: unknown, path: string, expectedProviderId: string | undefined): string {
  if (!expectedProviderId) throw new PortalFailure(503);
  if (!record(value) || !Array.isArray(value.providers) || value.providers.length > 16) throw new PortalFailure(503);
  const links: string[] = [];
  const seen = new Set<string>();
  for (const provider of value.providers) {
    if (!record(provider) || !text(provider.id, 128) || seen.has(provider.id) || !text(provider.label, 160) || typeof provider.enabled !== "boolean") throw new PortalFailure(503);
    seen.add(provider.id);
    if (!provider.enabled || provider.id !== expectedProviderId || !["google", "github"].includes(provider.id)) continue;
    if (provider.protocol !== (provider.id === "google" ? "oidc" : "oauth2")) throw new PortalFailure(503);
    const target = new URL("/oauth/upstream/authorize", stageIssuer);
    target.search = new URLSearchParams({ provider: provider.id, return_to: path }).toString();
    links.push(`<li><a href="${escapeHtml(target.pathname + target.search)}">Sign in with ${escapeHtml(provider.label)}</a></li>`);
  }
  return links.length ? `<ul>${links.join("")}</ul>` : "<p>Account switching is temporarily unavailable. Return here after signing in with the other confirmed account.</p>";
}

interface ConsentForm { action: "accept" | "complete"; planDigest: string; expiresAt: string; csrf: string }
async function readForm(request: Request): Promise<ConsentForm> {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? "")) throw new PortalFailure(400);
  const body = new URLSearchParams(await readText(request.body, 4096));
  if ([...body.keys()].length !== 4 || [...body.keys()].some((name) => !["action", "planDigest", "expiresAt", "csrf"].includes(name) || body.getAll(name).length !== 1) ||
    !["accept", "complete"].includes(body.get("action") ?? "") || !text(body.get("planDigest"), 128) || !/^\d{10,16}$/u.test(body.get("expiresAt") ?? "") || !hexPattern.test(body.get("csrf") ?? "")) throw new PortalFailure(400);
  return { action: body.get("action") as "accept" | "complete", planDigest: body.get("planDigest")!, expiresAt: body.get("expiresAt")!, csrf: body.get("csrf")! };
}

async function csrfKey(browser: BrowserContext): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(browser.session), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function csrfData(browser: BrowserContext, operationId: string, form: Omit<ConsentForm, "csrf">): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(["takosumi-stage-context-consent/v1", browser.browser, browser.nonce, operationId, form.action, form.planDigest, form.expiresAt]));
}
async function validCsrf(browser: BrowserContext, operationId: string, form: ConsentForm, now: number): Promise<boolean> {
  const expiresAt = Number(form.expiresAt);
  if (!browser.nonce || expiresAt <= now || expiresAt > now + 300_000) return false;
  const signature = new Uint8Array(form.csrf.match(/../gu)!.map((pair) => Number.parseInt(pair, 16)));
  return crypto.subtle.verify("HMAC", await csrfKey(browser), signature, csrfData(browser, operationId, form));
}
async function formHtml(browser: BrowserContext, operationId: string, path: string, planDigest: string, action: ConsentForm["action"], expiresAt: number, label: string): Promise<string> {
  const fields = { action, planDigest, expiresAt: String(expiresAt) };
  const csrf = hex(new Uint8Array(await crypto.subtle.sign("HMAC", await csrfKey(browser), csrfData(browser, operationId, fields))));
  return `<form method="post" action="${escapeHtml(path)}">${Object.entries({ ...fields, csrf }).map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("")}<button type="submit">${escapeHtml(label)}</button></form>`;
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) throw new PortalFailure(503);
  return JSON.parse(await readText(response.body, limit));
}
async function readText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  const reader = body?.getReader();
  if (!reader) throw new PortalFailure(400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new PortalFailure(400); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, limit = 512): value is string { return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value); }
function hex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function escapeHtml(value: string): string { return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;"); }
class PortalFailure extends Error { constructor(readonly status: number) { super("Identity context operation unavailable"); } }
function securityHeaders(): Record<string, string> {
  return { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
}
function page(message: string, status: number, content = "", extraHeaders: Record<string, string> = {}): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review your account contexts</title></head><body><main><p>Takos staging · auth-staging.takos.jp</p><h1>Review your account contexts</h1><p>${escapeHtml(message)}</p>${content}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", ...securityHeaders(), ...extraHeaders } });
}
