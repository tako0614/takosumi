import {
  authenticateSharedAuthRequest,
  sharedAuthConfigured,
  type SharedAuthEnvironment,
  type SharedAuthRpc,
} from "../../worker/src/shared_auth_rpc.ts";
import type { PlatformExtensionRoute } from "./platform_extensions.ts";

const basePath = "/api/v1/billing";
const failurePhaseHeader = "x-takosumi-failure-phase";
const readPaths = new Set([basePath, `${basePath}/subscription`, `${basePath}/top-up`]);
const actionPaths = new Set([
  basePath,
  `${basePath}/subscription`, `${basePath}/subscription/cancel`,
  `${basePath}/subscription/plan`, `${basePath}/top-up`,
]);
const bodyLimit = 4096;
// Match the existing private identity-RPC budget; body ingestion cannot hold
// the unauthenticated ingress open indefinitely before that RPC starts.
const bodyReadTimeoutMs = 5_000;
// Base documents and their command-free view capture can outlive the ordinary
// financial RPC budget. Keep one finite wait for that original response; never
// retry it. Financial leaves retain their existing deadline.
const viewDispatchTimeoutMs = 120_000;
const financialDispatchTimeoutMs = 40_000;
const safeWorkspace = /^[A-Za-z0-9_.:-]{1,128}$/u;
const safeOperation = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u;
const safePlan = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
type BillingFailurePhase = "preflight" | "auth-unavailable" | "dispatch-nonresponse" |
  "dispatch-rejected" | "dispatch-timeout" | "dispatch-invalid-redirect" | "receiver-returned503";

function exactViewWorkspace(value: unknown): value is string {
  return typeof value === "string" && safeWorkspace.exec(value)?.[0] === value;
}

interface BrowserBillingRpc extends SharedAuthRpc {
  fetchWorkspaceDashboard(
    request: Request,
    session: { readonly authKind: "session"; readonly subject: string },
  ): Promise<Response>;
}

function response(status: number, code: string, allow?: string): Response {
  return Response.json({ error: code }, {
    status,
    headers: { "cache-control": "private, no-store", ...(allow ? { allow } : {}) },
  });
}

function viewNavigationConfirmation(result: Response): Response | null {
  const location = result.headers.get("location");
  if (!location || location.length > 4096 || result.body !== null) return null;
  try {
    const destination = new URL(location);
    if (destination.protocol !== "https:" || destination.username || destination.password ||
      destination.hash || destination.href !== location) return null;
  } catch { return null; }
  // The selected private receiver already owns this destination. A form's
  // cross-origin 303 is blocked by the original document's form-action 'self'.
  // Keep that policy and expose one explicit GET link to the same saved view.
  const escaped = location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;");
  const headers = new Headers(result.headers);
  for (const name of ["location", "content-length", "content-encoding", "content-disposition"]) headers.delete(name);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "private, no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("content-security-policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("x-content-type-options", "nosniff");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Continue to billing</title><main><h1>Continue to billing</h1><p>Your billing view is ready.</p><a href="${escaped}" referrerpolicy="no-referrer">Open billing in Takoserver Console</a></main></html>`, {
    status: 200, headers,
  });
}

/**
 * Optional browser-only private-RP bridge, before generic credential stripping.
 * The session is a canonical assertion, not membership or financial authority.
 * The receiver must independently authenticate this Request and qualify every
 * financial operation; an absent receiver never falls back to an extension.
 */
export async function handlePlatformBrowserBillingRequest(
  request: Request,
  env: SharedAuthEnvironment,
  route: PlatformExtensionRoute | undefined,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) ||
    !sharedAuthConfigured(env)) return undefined;
  const method = request.method;
  const headers = new Headers(request.headers);
  const signal = request.signal;
  if (!readPaths.has(url.pathname) && !actionPaths.has(url.pathname)) {
    return response(404, "not_found");
  }
  const allow = [readPaths.has(url.pathname) ? "GET" : "", actionPaths.has(url.pathname) ? "POST" : ""]
    .filter(Boolean).join(", ");
  if (!(method === "GET" && readPaths.has(url.pathname)) &&
    !(method === "POST" && actionPaths.has(url.pathname))) {
    return response(405, "method_not_allowed", allow);
  }

  // Capture all binding methods, configuration and original headers before any
  // await. No live env, route or request-header lookup can retarget this call.
  const binding = env.HOSTED;
  const selected = {
    TAKOSUMI_SHARED_AUTH_PROFILE: env.TAKOSUMI_SHARED_AUTH_PROFILE,
    TAKOSUMI_SHARED_AUTH_ORIGIN: env.TAKOSUMI_SHARED_AUTH_ORIGIN,
    TAKOSUMI_ENVIRONMENT: env.TAKOSUMI_ENVIRONMENT,
  };
  const selectedStaging = selected.TAKOSUMI_SHARED_AUTH_PROFILE === "shared-account" &&
    selected.TAKOSUMI_ENVIRONMENT === "staging";
  const baseView = url.pathname === basePath;
  // Generate a request-local log join only for the selected base view.
  // Public x-takosumi-* headers are rejected below and are never its source.
  let billingTrace: string | undefined;
  if (selectedStaging && baseView) {
    try { billingTrace = `brpc_${crypto.randomUUID().replaceAll("-", "")}`; } catch { /* diagnostics cannot block the request */ }
  }
  const logFailure = (phase: BillingFailurePhase): void => {
    if (!selectedStaging) return;
    try { console.error("takosumi_browser_billing_failure_phase", phase, ...(billingTrace ? [billingTrace] : [])); }
    catch { /* logging cannot change the reply */ }
  };
  const failed = (phase: BillingFailurePhase, result: Response): Response => {
    logFailure(phase);
    if (selectedStaging && baseView && result.status === 503) {
      try { result.headers.set(failurePhaseHeader, phase); } catch { /* diagnostics cannot change the reply */ }
    }
    return result;
  };
  if (!route || route.basePath !== basePath || route.matchMode === "exact" ||
    (route.authMode ?? "platform") !== "platform" || route.authDelivery !== "context" ||
    !binding || typeof binding !== "object" ||
    Reflect.get(env, route.handlerKey) !== binding) {
    return failed("preflight", response(503, "billing_unavailable"));
  }
  const candidate = binding as Partial<BrowserBillingRpc>;
  const authenticate = candidate.authenticateSharedAuth;
  const authFetch = candidate.fetchSharedAuth;
  const resolve = candidate.resolveSharedAuthWorkspace;
  const dashboard = candidate.fetchWorkspaceDashboard;
  if (typeof authenticate !== "function" || typeof authFetch !== "function" ||
    typeof resolve !== "function" || typeof dashboard !== "function") {
    return failed("preflight", response(503, "billing_unavailable"));
  }
  // RPC method properties are proxies: looking up their `.bind` would invoke
  // a remote method named "bind". Reflect.apply captures the real local call
  // target and receiver without traversing another RPC property.
  const rpc: SharedAuthRpc = Object.freeze({
    fetchSharedAuth: (value: Request) => Reflect.apply(authFetch, binding, [value]),
    authenticateSharedAuth: (value: Request) => Reflect.apply(authenticate, binding, [value]),
    resolveSharedAuthWorkspace: (value: Request, id: string) => Reflect.apply(resolve, binding, [value, id]),
  });
  const dispatch = (value: Request, session: Parameters<BrowserBillingRpc["fetchWorkspaceDashboard"]>[1]) =>
    Reflect.apply(dashboard, binding, [value, session]);
  const capturedEnv = Object.freeze({ ...selected, HOSTED: rpc });
  if (!selectedStaging) return response(503, "billing_unavailable");
  if (url.origin !== selected.TAKOSUMI_SHARED_AUTH_ORIGIN) return response(404, "not_found");
  // Explicit credentials cannot fall back to cookies. Public authority-shaped
  // headers are rejected, not interpreted as private caller identity.
  for (const name of headers.keys()) {
    if (name === "authorization" || name === "proxy-authorization" ||
      name.startsWith("x-auth-") || name.startsWith("x-takosumi-") ||
      name.startsWith("x-financial-") ||
      ["x-principal", "x-payer", "x-authority", "x-source-epoch", "x-organization-id", "x-workspace-ref"].includes(name)) {
      return response(401, "unauthenticated");
    }
  }
  const origin = headers.get("origin");
  const site = headers.get("sec-fetch-site");
  if ((origin !== null && origin !== url.origin) ||
    (method === "POST" && origin !== url.origin) ||
    (site !== null && site !== "same-origin" && site !== "none")) {
    return response(403, "csrf_failed");
  }
  const query = url.searchParams;
  const allowedQuery = method === "GET" ? ["workspaceId", "format"] : ["workspaceId"];
  if ([...query.keys()].some((key) => !allowedQuery.includes(key) || query.getAll(key).length !== 1) ||
    (query.has("format") && query.get("format") !== "json")) {
    return response(400, "invalid_billing_request");
  }
  const selectedWorkspace = query.get("workspaceId");
  if ((selectedWorkspace !== null && !safeWorkspace.test(selectedWorkspace)) ||
    (method === "GET" && selectedWorkspace === null) ||
    (method === "POST" && url.pathname === basePath && !exactViewWorkspace(selectedWorkspace))) {
    return response(400, "invalid_billing_request");
  }
  if (signal.aborted) return response(400, "invalid_billing_request");

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method === "POST") {
    const contentType = headers.get("content-type")?.split(";")[0];
    if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") {
      return response(415, "unsupported_media_type");
    }
    const length = headers.get("content-length");
    if (length !== null && (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) > bodyLimit)) {
      return response(413, "billing_body_too_large");
    }
    try {
      body = await readBoundedBody(request, signal);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const fields = contentType === "application/json" ? flatJson(text) : formFields(text);
      if (!validAction(url.pathname, fields, contentType === "application/x-www-form-urlencoded") ||
        (selectedWorkspace !== null && fields.workspaceId !== selectedWorkspace)) {
        return response(400, "invalid_billing_request");
      }
    } catch (error) {
      if (error instanceof BillingBodyTimeout) return response(408, "billing_body_timeout");
      return error instanceof RangeError
        ? response(413, "billing_body_too_large")
        : response(400, "invalid_billing_request");
    }
  }

  const privateHeaders = new Headers();
  for (const name of ["cookie", "origin", "sec-fetch-site", "accept", ...(method === "POST" ? ["content-type"] : [])]) {
    const value = headers.get(name);
    if (value !== null) privateHeaders.set(name, value);
  }
  // Authentication gets a headers-only snapshot, so no tee or duplicate body
  // read exists. Only the narrow dashboard RPC receives the bounded body bytes.
  if (signal.aborted) return response(400, "invalid_billing_request");
  const identity = await authenticateSharedAuthRequest(new Request(url, {
    method, headers: privateHeaders, redirect: "manual",
  }), capturedEnv, billingTrace);
  if (signal.aborted) return response(400, "invalid_billing_request");
  if (identity?.kind === "unauthenticated") return response(401, "unauthenticated");
  if (identity?.kind !== "authenticated") {
    return failed("auth-unavailable", response(503, "billing_unavailable"));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispatchDeadline = Symbol();
  try {
    const result = await Promise.race([
      dispatch(new Request(url, { method, headers: privateHeaders, body, redirect: "manual" }),
        Object.freeze({ authKind: "session", subject: identity.accountId })),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(dispatchDeadline),
          baseView ? viewDispatchTimeoutMs : financialDispatchTimeoutMs);
      }),
    ]);
    if (!(result instanceof Response)) {
      return failed("dispatch-nonresponse", response(503, "billing_unavailable"));
    }
    let selectedResult = result;
    if (baseView && method === "POST" && result.status === 303) {
      const confirmation = viewNavigationConfirmation(result);
      if (!confirmation) return failed("dispatch-invalid-redirect", response(503, "billing_unavailable"));
      selectedResult = confirmation;
    }
    const responseHeaders = new Headers(selectedResult.headers);
    responseHeaders.delete(failurePhaseHeader);
    responseHeaders.set("cache-control", "private, no-store");
    const returned = new Response(selectedResult.body, { status: selectedResult.status, statusText: selectedResult.statusText, headers: responseHeaders });
    return returned.status === 503 ? failed("receiver-returned503", returned) : returned;
  } catch (error) {
    // A lost response never retries or creates a new operation/reference.
    return failed(error === dispatchDeadline ? "dispatch-timeout" : "dispatch-rejected",
      response(503, "billing_unavailable"));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class BillingBodyTimeout extends Error {}

async function readBoundedBody(request: Request, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (signal.aborted || request.bodyUsed || !request.body) throw new TypeError("invalid body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new TypeError("request aborted"));
    timer = setTimeout(() => reject(new BillingBodyTimeout()), bodyReadTimeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), interrupted]);
      // Already-buffered read/done promises can win against an earlier abort
      // rejection by iterable order. Never interpret that as a live request.
      if (signal.aborted) throw new TypeError("request aborted");
      if (next.done) break;
      length += next.value.byteLength;
      if (length > bodyLimit) throw new RangeError("body too large");
      chunks.push(next.value);
    }
  } catch (error) {
    // A hostile underlying cancel() may itself never settle. Cancel ownership
    // immediately, handle its rejection, and never await it at this boundary.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function formFields(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of new URLSearchParams(text)) {
    if (Object.hasOwn(result, key)) throw new TypeError("duplicate field");
    result[key] = value;
  }
  return result;
}

// The published action DTOs are flat strings, except top-up's integer cash
// amount. Parse that closed grammar without JSON.parse's duplicate-key loss.
function flatJson(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  const string = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  let cursor = 0;
  const space = () => { while (/[ \t\r\n]/u.test(text[cursor] ?? "!") && cursor < text.length) cursor++; };
  const token = (pattern: RegExp) => {
    space(); pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (!match) throw new TypeError("invalid field");
    cursor = pattern.lastIndex;
    return JSON.parse(match[0]);
  };
  space();
  if (text[cursor++] !== "{") throw new TypeError("invalid object");
  space();
  if (text[cursor] !== "}") {
    for (;;) {
      const key: string = token(string);
      if (Object.hasOwn(result, key)) throw new TypeError("duplicate field");
      space();
      if (text[cursor++] !== ":") throw new TypeError("invalid field");
      space();
      result[key] = token(text[cursor] === '"' ? string : number);
      space();
      if (text[cursor] === "}") break;
      if (text[cursor++] !== ",") throw new TypeError("invalid object");
    }
  }
  cursor++; space();
  if (cursor !== text.length) throw new TypeError("invalid object");
  return result;
}

function validAction(path: string, fields: Record<string, unknown>, form: boolean): boolean {
  if (path === basePath) {
    return Object.keys(fields).length === 1 && Object.hasOwn(fields, "workspaceId") &&
      exactViewWorkspace(fields.workspaceId);
  }
  const topUp = path === `${basePath}/top-up`;
  const start = path === `${basePath}/subscription`;
  const cancel = path === `${basePath}/subscription/cancel`;
  const expected = Object.hasOwn(fields, "expectedOperationKey");
  const allowed = ["workspaceId", "operationKey", topUp ? "checkoutConsent" : "consent",
    ...(topUp ? [form ? "amountUsd" : "amountMinor"] : cancel ? [] : ["planKey"]),
    ...(expected ? ["expectedOperationKey", ...(start ? ["reconcileOriginalConsent"] : [])] : [])];
  if (Object.keys(fields).sort().join() !== allowed.sort().join() ||
    typeof fields.workspaceId !== "string" || !safeWorkspace.test(fields.workspaceId) ||
    typeof fields.operationKey !== "string" || !safeOperation.test(fields.operationKey) ||
    (expected && (typeof fields.expectedOperationKey !== "string" || !safeOperation.test(fields.expectedOperationKey)))) return false;
  if (topUp) {
    if (fields.checkoutConsent !== "interactive-checkout") return false;
    if (!form) return typeof fields.amountMinor === "number" && Number.isSafeInteger(fields.amountMinor) && fields.amountMinor > 0;
    if (typeof fields.amountUsd !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/u.test(fields.amountUsd)) return false;
    const [whole, fraction = ""] = fields.amountUsd.split(".");
    const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
    return minor > 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER);
  }
  if (fields.consent !== (start ? "subscription-checkout" : cancel ? "cancel-subscription" : "change-subscription-plan")) return false;
  if (!cancel && (typeof fields.planKey !== "string" || !safePlan.test(fields.planKey))) return false;
  return !start || !expected || ["retry-original-subscription", "check-original-subscription"].includes(String(fields.reconcileOriginalConsent));
}
