import type { TakosumiAccountsAuthProvider } from "@takosjp/takosumi-accounts-contract";

const stagingIssuer = "https://auth-staging.takos.jp";
const providerBodyLimit = 16 * 1024;
const returnLimit = 8192;
const controlCharacters = /[\u0000-\u001f\u007f]/u;

/** Explicit stage-entry composition only; this is never the generic dashboard. */
export async function handleStagingLoginPortal(input: {
  request: Request;
  issuer: string;
  accountsHandler?: (request: Request) => Response | Promise<Response>;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname !== "/sign-in") return null;
  const host = input.request.headers.get("host");
  if (input.issuer !== stagingIssuer || url.origin !== stagingIssuer ||
    url.username || url.password || url.hash ||
    (host !== null && host !== "auth-staging.takos.jp" && host !== "auth-staging.takos.jp:443")) {
    return portalResponse(input.request, "Not found", 404);
  }
  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    return portalResponse(input.request, "Use a GET request to open sign-in.", 405, { allow: "GET, HEAD" });
  }

  let continuation: { returnTo?: string; fresh: boolean; maxAge?: string };
  try {
    continuation = validateContinuation(url);
  } catch {
    return portalResponse(input.request, "This sign-in link is invalid. Start sign-in again from Takosumi Hosted or Takoserver.", 400);
  }
  if (!input.accountsHandler) return unavailable(input.request);

  try {
    // The configured issuer and public in-process route are the only inputs.
    // Cookies, host forwarding and caller-supplied provider payloads are absent.
    const providerResponse = await input.accountsHandler(new Request(`${stagingIssuer}/api/v1/auth/providers`, {
      headers: { accept: "application/json" },
    }));
    const providers = await readProviders(providerResponse);
    if (providers.length === 0) return unavailable(input.request);
    const choices = providers.map((provider) => {
      const label = escapeHtml(provider.label);
      if (!continuation.returnTo) return `<li>${label}</li>`;
      if (continuation.fresh && provider.id === "github") {
        return `<li><button type="button" disabled>${label}</button><p>GitHub cannot confirm fresh credential entry for this request. Use Google to confirm your sign-in.</p></li>`;
      }
      const target = new URL("/oauth/upstream/authorize", stagingIssuer);
      target.searchParams.set("provider", provider.id);
      target.searchParams.set("return_to", continuation.returnTo);
      if (continuation.fresh) {
        target.searchParams.set("prompt", "login");
        target.searchParams.set("max_age", continuation.maxAge ?? "0");
      }
      return `<li><a href="${escapeHtml(target.pathname + target.search)}">Continue with ${label}</a></li>`;
    }).join("");
    const explanation = continuation.returnTo
      ? continuation.fresh
        ? "Confirm a fresh sign-in to continue to your application."
        : "Choose your sign-in provider to continue to your application."
      : "Start sign-in from Takosumi Hosted or Takoserver. This staging issuer provides the configured sign-in methods below.";
    return portalResponse(input.request, explanation, 200, {}, `<ul>${choices}</ul>`);
  } catch {
    return unavailable(input.request);
  }
}

function validateContinuation(url: URL): { returnTo?: string; fresh: boolean; maxAge?: string } {
  if (url.href.length > 32 * 1024) throw new TypeError("sign-in URL exceeds the limit");
  for (const name of url.searchParams.keys()) {
    if (!["return", "prompt", "max_age"].includes(name) || url.searchParams.getAll(name).length !== 1) {
      throw new TypeError("invalid sign-in parameter");
    }
  }
  const prompt = url.searchParams.get("prompt");
  const maxAge = url.searchParams.get("max_age");
  if (prompt !== null && prompt !== "login") throw new TypeError("invalid sign-in prompt");
  if (maxAge !== null && (!/^\d{1,8}$/u.test(maxAge) || Number(maxAge) > 604800)) {
    throw new TypeError("invalid sign-in age");
  }
  const rawReturn = url.searchParams.get("return");
  if (rawReturn === null) {
    if (prompt !== null || maxAge !== null) throw new TypeError("missing sign-in continuation");
    return { fresh: false };
  }
  if (rawReturn.length > returnLimit || controlCharacters.test(rawReturn) || rawReturn.includes("\\") ||
    !/^\/oauth\/authorize(?:\?|$)/u.test(rawReturn)) {
    throw new TypeError("invalid sign-in continuation");
  }
  const target = new URL(rawReturn, stagingIssuer);
  if (target.origin !== stagingIssuer || target.pathname !== "/oauth/authorize" ||
    target.username || target.password || target.hash) throw new TypeError("invalid issuer continuation");
  let count = 0;
  for (const [name, value] of target.searchParams) {
    count++;
    if (count > 24 || name.length === 0 || name.length > 64 || value.length > 4096 ||
      controlCharacters.test(name) || controlCharacters.test(value) || target.searchParams.getAll(name).length !== 1) {
      throw new TypeError("invalid authorization parameter");
    }
  }
  const authorizationPrompt = (target.searchParams.get("prompt") ?? "").split(/\s+/u).filter(Boolean);
  const authorizationMaxAge = target.searchParams.get("max_age");
  if (authorizationPrompt.some((item) => !["none", "login", "consent"].includes(item)) ||
    (authorizationPrompt.includes("none") && authorizationPrompt.length > 1) ||
    (authorizationMaxAge !== null && (!/^\d+$/u.test(authorizationMaxAge) || !Number.isSafeInteger(Number(authorizationMaxAge))))) {
    throw new TypeError("invalid authorization freshness");
  }
  return {
    returnTo: target.pathname + target.search,
    fresh: prompt === "login" || maxAge !== null || authorizationPrompt.includes("login") || authorizationMaxAge === "0",
    ...(maxAge !== null ? { maxAge } : {}),
  };
}

async function readProviders(response: Response): Promise<TakosumiAccountsAuthProvider[]> {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    throw new TypeError("provider discovery is unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("provider response is empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > providerBodyLimit) {
        await reader.cancel();
        throw new TypeError("provider response exceeds the limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isRecord(body) || !Array.isArray(body.providers) || body.providers.length > 16) {
    throw new TypeError("invalid provider descriptors");
  }
  const result: TakosumiAccountsAuthProvider[] = [];
  const seen = new Set<string>();
  for (const provider of body.providers) {
    if (!isRecord(provider) || typeof provider.id !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(provider.id) ||
      seen.has(provider.id) || typeof provider.enabled !== "boolean" || typeof provider.label !== "string" ||
      provider.label.trim().length === 0 || provider.label.length > 160 || controlCharacters.test(provider.label) ||
      typeof provider.protocol !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(provider.protocol)) {
      throw new TypeError("invalid provider descriptor");
    }
    seen.add(provider.id);
    if ((provider.id === "google" && provider.protocol !== "oidc") ||
      (provider.id === "github" && provider.protocol !== "oauth2")) {
      throw new TypeError("stage provider protocol is not configured");
    }
    if (provider.enabled && (provider.id === "google" || provider.id === "github")) {
      result.push({ id: provider.id, enabled: true, label: provider.label.trim(), protocol: provider.protocol });
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function unavailable(request: Request): Response {
  return portalResponse(request, "Sign-in is temporarily unavailable. Try again later from your application.", 503);
}

function portalResponse(request: Request, message: string, status: number, extraHeaders: Record<string, string> = {}, choices = ""): Response {
  const nonce = crypto.randomUUID();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Takos staging sign-in</title><style nonce="${nonce}">body{font-family:system-ui,sans-serif;margin:3rem auto;padding:0 1.25rem;max-width:32rem;line-height:1.6;color:#202620;background:#f5f7f4}main{background:white;padding:1.5rem;border:1px solid #d8e0d5;border-radius:.75rem}h1{font-size:1.65rem;margin-top:0}ul{list-style:none;padding:0}li{margin-top:1rem}a,button{display:block;box-sizing:border-box;width:100%;padding:.7rem 1rem;border:1px solid #687b62;border-radius:.4rem;text-align:center;font:inherit}a{color:#203e23;text-decoration:none}a:focus-visible{outline:3px solid #355a36;outline-offset:3px}button:disabled{color:#626b5f;border-color:#c8d0c5;background:#edf0eb}li p{font-size:.9rem}small{color:#55604f}</style></head><body><main><small>Staging · auth-staging.takos.jp</small><h1>Sign in to Takos</h1><p>${escapeHtml(message)}</p>${choices}<noscript><p>This page works without JavaScript.</p></noscript></main></body></html>`;
  return new Response(request.method === "HEAD" ? null : html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "referrer-policy": "no-referrer",
      ...extraHeaders,
    },
  });
}
